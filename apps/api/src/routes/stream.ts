import fs from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { decideStrategy, buildVodPlaylist } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { queryTokenAuth } from "../lib/device-auth";
import { activeProfile, profileAllowsItem, assertFileAllowed } from "../lib/catalog-filter";
import { SessionManager, SegmentTimeoutError } from "../playback/session";
import type { PlaySessionRegistry, PlaySessionEntry } from "../playback/registry";

const DEFAULT_PROFILE = "default";
const DEFAULT_SEG_SEC = 6;

function contentTypeForContainer(container: string | null | undefined): string {
  if (!container) return "application/octet-stream";
  const c = container.toLowerCase();
  if (/mp4|mov|m4v/.test(c)) return "video/mp4";
  if (/mkv|matroska/.test(c)) return "video/x-matroska";
  if (c === "webm") return "video/webm";
  return "application/octet-stream";
}

/**
 * Lookup MediaFile and return an active Session for the given fileId.
 * Returns null (+ sends reply) when file is not found, not probed, or blocked
 * by the active profile's maturity cap (kids-safety gate).
 */
async function resolveSession(
  app: FastifyInstance,
  manager: SessionManager,
  fileId: string,
  req: FastifyRequest,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  // Load the file (with its parent item's rating) and the active profile in
  // parallel so we can enforce the kids maturity cap before serving any bytes.
  const [file, profile] = await Promise.all([
    app.prisma.mediaFile.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        path: true,
        container: true,
        videoCodec: true,
        audioCodecs: true,
        durationSec: true,
        mediaItem: { select: { rating: true } },
      },
    }),
    activeProfile(app, req),
  ]);

  if (!file) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }

  // Kids-safety gate: block access before serving any playlist bytes.
  if (!profileAllowsItem(profile, { rating: file.mediaItem.rating })) {
    reply.code(403).send({ error: "blocked_by_rating" });
    return null;
  }

  if (!file.durationSec) {
    reply.code(409).send({ error: "not_probed" });
    return null;
  }

  const plan = decideStrategy({
    container: file.container ?? undefined,
    videoCodec: file.videoCodec ?? undefined,
    audioCodecs: file.audioCodecs,
  });

  const key = `${fileId}:${DEFAULT_PROFILE}`;
  const session = await manager.getOrCreate(key, {
    inputPath: file.path,
    plan,
    durationSec: file.durationSec,
    segSec: DEFAULT_SEG_SEC,
  });

  return session;
}

/** Echo the auth token query (if the request used one) into child playlist URIs. */
function tokenSuffix(req: FastifyRequest): string {
  const token = (req.query as { token?: unknown } | undefined)?.token;
  return typeof token === "string" && token.length > 0 ? `&token=${encodeURIComponent(token)}` : "";
}

/**
 * A registry entry is only servable by the HLS routes when it was negotiated
 * for an HLS mode (remux/transcode) with a known duration. `/playback/info`
 * also creates entries for direct-play files (mode "direct") and for
 * not-yet-probed files (durationSec <= 0) — those are legitimate registry
 * entries, just not ones the HLS playlist/segment routes know how to serve,
 * so they must 404 the same as an unknown id rather than emit a broken
 * playlist.
 */
function isPlayableEntry(entry: PlaySessionEntry | null, fileId: string): entry is PlaySessionEntry {
  return (
    !!entry &&
    entry.fileId === fileId &&
    entry.plan.mode !== "direct" &&
    // durationSec backstop: unreachable via /playback/info today (it 409s first); guards future callers.
    entry.durationSec > 0
  );
}

/**
 * Session-aware counterpart to resolveSession: resolves a registry entry by
 * playSessionId (instead of trusting the fileId alone) and hands the manager
 * a stable per-session key so each negotiated playback attempt gets its own
 * isolated ffmpeg + temp dir.
 */
async function resolveByPlaySession(
  app: FastifyInstance,
  deps: { manager: SessionManager; registry: PlaySessionRegistry },
  fileId: string,
  playSessionId: string,
  req: FastifyRequest,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  // Kids-safety gate: re-checked on every index/init/seg request (not just at
  // negotiation time) so a profile switch mid-playback can't keep streaming
  // blocked content off a still-valid playSessionId.
  if (!(await assertFileAllowed(app, req, fileId, reply))) return null;

  const entry = deps.registry.get(playSessionId);
  if (!isPlayableEntry(entry, fileId)) {
    reply.code(404).send({ error: "session_expired" });
    return null;
  }
  return deps.manager.getOrCreate(playSessionId, {
    inputPath: entry.inputPath,
    plan: entry.plan,
    durationSec: entry.durationSec,
    segSec: DEFAULT_SEG_SEC,
  });
}

export default function streamRoute(
  env: { TRANSCODE_DIR: string; MAX_TRANSCODE_SESSIONS?: number },
  deps: { manager: SessionManager; registry: PlaySessionRegistry },
) {
  return async function (app: FastifyInstance) {
    const { manager, registry } = deps;

    // ------------------------------------------------------------------
    // GET /play/:fileId/decision
    // ------------------------------------------------------------------
    app.get<{ Params: { fileId: string } }>(
      "/play/:fileId/decision",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req, reply) => {
        const { fileId } = req.params;

        // Load the file (with its parent item's rating) and the active profile
        // in parallel so we can enforce the kids maturity cap before issuing a
        // play URL.
        const [file, profile] = await Promise.all([
          app.prisma.mediaFile.findUnique({
            where: { id: fileId },
            select: {
              id: true,
              container: true,
              videoCodec: true,
              audioCodecs: true,
              mediaItem: { select: { rating: true } },
            },
          }),
          activeProfile(app, req),
        ]);

        if (!file) return reply.code(404).send({ error: "not_found" });

        // Kids-safety gate: a kids profile must not receive a play URL for a
        // blocked title.
        if (!profileAllowsItem(profile, { rating: file.mediaItem.rating })) {
          return reply.code(403).send({ error: "blocked_by_rating" });
        }

        const plan = decideStrategy({
          container: file.container ?? undefined,
          videoCodec: file.videoCodec ?? undefined,
          audioCodecs: file.audioCodecs,
        });

        const url =
          plan.mode === "direct"
            ? `/api/play/${file.id}/direct`
            : `/api/play/${file.id}/master.m3u8`;

        return { mode: plan.mode, url };
      },
    );

    // ------------------------------------------------------------------
    // GET /play/:fileId/direct
    // ------------------------------------------------------------------
    app.get<{ Params: { fileId: string } }>(
      "/play/:fileId/direct",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req, reply) => {
        const { fileId } = req.params;

        // Kids-safety gate: check before serving any bytes.
        if (!await assertFileAllowed(app, req, fileId, reply)) return;

        const file = await app.prisma.mediaFile.findUnique({
          where: { id: fileId },
          select: {
            id: true,
            path: true,
            container: true,
          },
        });

        if (!file) return reply.code(404).send({ error: "not_found" });

        // Verify file exists on disk
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(file.path);
        } catch {
          return reply.code(404).send({ error: "file_not_found" });
        }

        const total = stat.size;
        const contentType = contentTypeForContainer(file.container);
        const rangeHeader = req.headers["range"];

        if (rangeHeader) {
          // Parse Range header: bytes=START-END or bytes=START-
          const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());

          if (!match) {
            // Invalid range format — serve full file
            return reply
              .code(200)
              .header("Accept-Ranges", "bytes")
              .header("Content-Length", total)
              .header("Content-Type", contentType)
              .send(fs.createReadStream(file.path));
          }

          const start = parseInt(match[1], 10);
          const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;

          // Validate range
          if (start > end || start >= total) {
            return reply
              .code(416)
              .header("Content-Range", `bytes */${total}`)
              .send();
          }

          const chunkSize = end - start + 1;

          return reply
            .code(206)
            .header("Content-Range", `bytes ${start}-${end}/${total}`)
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", chunkSize)
            .header("Content-Type", contentType)
            .send(fs.createReadStream(file.path, { start, end }));
        }

        // No Range header — serve full file
        return reply
          .code(200)
          .header("Accept-Ranges", "bytes")
          .header("Content-Length", total)
          .header("Content-Type", contentType)
          .send(fs.createReadStream(file.path));
      },
    );

    // ------------------------------------------------------------------
    // GET /play/:fileId/master.m3u8 — tiny HLS master playlist
    // ------------------------------------------------------------------
    app.get<{ Params: { fileId: string } }>(
      "/play/:fileId/master.m3u8",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req, reply) => {
        const { fileId } = req.params;
        const playSessionId = (req.query as { playSessionId?: string }).playSessionId;

        // Kids-safety gate: check before serving the master playlist.
        if (!await assertFileAllowed(app, req, fileId, reply)) return;

        if (playSessionId) {
          const entry = registry.get(playSessionId);
          if (!isPlayableEntry(entry, fileId)) {
            return reply.code(404).send({ error: "session_expired" });
          }
          const master = [
            "#EXTM3U",
            "#EXT-X-STREAM-INF:BANDWIDTH=2000000",
            `index.m3u8?playSessionId=${playSessionId}${tokenSuffix(req)}`,
          ].join("\n");

          return reply
            .code(200)
            .header("Content-Type", "application/vnd.apple.mpegurl")
            .send(master);
        }

        const file = await app.prisma.mediaFile.findUnique({
          where: { id: fileId },
          select: { id: true },
        });
        if (!file) return reply.code(404).send({ error: "not_found" });

        const master = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=2000000", "index.m3u8"].join(
          "\n",
        );

        return reply
          .code(200)
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .send(master);
      },
    );

    // ------------------------------------------------------------------
    // GET /play/:fileId/index.m3u8 — VOD segment playlist (instant)
    // ------------------------------------------------------------------
    app.get<{ Params: { fileId: string } }>(
      "/play/:fileId/index.m3u8",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req, reply) => {
        const { fileId } = req.params;
        const playSessionId = (req.query as { playSessionId?: string }).playSessionId;

        if (playSessionId) {
          const session = await resolveByPlaySession(app, { manager, registry }, fileId, playSessionId, req, reply);
          if (!session) return;

          return reply
            .code(200)
            .header("Content-Type", "application/vnd.apple.mpegurl")
            .send(
              buildVodPlaylist(
                session.durationSec,
                session.segSec,
                `playSessionId=${playSessionId}${tokenSuffix(req)}`,
              ),
            );
        }

        const session = await resolveSession(app, manager, fileId, req, reply);
        if (!session) return;

        return reply
          .code(200)
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .send(manager.playlist(session));
      },
    );

    // ------------------------------------------------------------------
    // GET /play/:fileId/init.mp4 — fMP4 init segment
    // ------------------------------------------------------------------
    app.get<{ Params: { fileId: string } }>(
      "/play/:fileId/init.mp4",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req, reply) => {
        const { fileId } = req.params;
        const playSessionId = (req.query as { playSessionId?: string }).playSessionId;
        const session = playSessionId
          ? await resolveByPlaySession(app, { manager, registry }, fileId, playSessionId, req, reply)
          : await resolveSession(app, manager, fileId, req, reply);
        if (!session) return;

        let initPath: string;
        try {
          initPath = await manager.ensureInit(session);
        } catch (err) {
          if (err instanceof SegmentTimeoutError) {
            return reply.code(504).send({ error: "timeout", message: err.message });
          }
          throw err;
        }

        return reply
          .code(200)
          .header("Content-Type", "video/mp4")
          .send(fs.createReadStream(initPath));
      },
    );

    // ------------------------------------------------------------------
    // GET /play/:fileId/:seg — fMP4 media segments (seg<N>.m4s)
    // ------------------------------------------------------------------
    app.get<{ Params: { fileId: string; seg: string } }>(
      "/play/:fileId/:seg",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req, reply) => {
        const { fileId, seg } = req.params;

        const m = /^seg(\d+)\.m4s$/.exec(seg);
        if (!m) return reply.code(400).send({ error: "bad_segment" });
        const n = parseInt(m[1], 10);

        const playSessionId = (req.query as { playSessionId?: string }).playSessionId;
        const session = playSessionId
          ? await resolveByPlaySession(app, { manager, registry }, fileId, playSessionId, req, reply)
          : await resolveSession(app, manager, fileId, req, reply);
        if (!session) return;

        let segPath: string;
        try {
          segPath = await manager.ensureSegment(session, n);
        } catch (err) {
          if (err instanceof SegmentTimeoutError) {
            return reply.code(504).send({ error: "timeout", message: err.message });
          }
          throw err;
        }

        return reply
          .code(200)
          .header("Content-Type", "video/iso.segment")
          .send(fs.createReadStream(segPath));
      },
    );
  };
}
