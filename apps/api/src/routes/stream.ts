import fs from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  buildVodPlaylist,
  buildMultivariantPlaylist,
  buildMediaPlaylistFromBoundaries,
  videoCodecString,
  audioCodecString,
  videoRange,
} from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { queryTokenAuth, tokenSuffix } from "../lib/device-auth";
import { assertFileAllowed } from "../lib/catalog-filter";
import { SessionManager, SegmentTimeoutError } from "../playback/session";
import type { PlaySessionRegistry, PlaySessionEntry } from "../playback/registry";
import { IMAGE_CODECS } from "./subtitles";

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
 * Resolves a registry entry by playSessionId (instead of trusting the fileId
 * alone) and hands the manager a stable per-session key so each negotiated
 * playback attempt gets its own isolated ffmpeg + temp dir.
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
    quality: entry.quality,
    audioMode: entry.audioMode,
    durationSec: entry.durationSec,
    segSec: DEFAULT_SEG_SEC,
    boundaries: entry.boundaries,
    forceKeyframes: entry.forceKeyframes,
  });
}

export default function streamRoute(
  env: { TRANSCODE_DIR: string; MAX_TRANSCODE_SESSIONS?: number },
  deps: { manager: SessionManager; registry: PlaySessionRegistry },
) {
  return async function (app: FastifyInstance) {
    const { manager, registry } = deps;

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
    // GET /play/:fileId/master.m3u8 — Apple-grade multivariant playlist
    // ------------------------------------------------------------------
    app.get<{ Params: { fileId: string } }>(
      "/play/:fileId/master.m3u8",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req, reply) => {
        const { fileId } = req.params;
        const playSessionId = (req.query as { playSessionId?: string }).playSessionId;

        // Kids-safety gate: check before serving the master playlist.
        if (!await assertFileAllowed(app, req, fileId, reply)) return;

        if (!playSessionId) {
          return reply.code(400).send({ error: "missing_session" });
        }

        const entry = registry.get(playSessionId);
        if (!isPlayableEntry(entry, fileId)) {
          return reply.code(404).send({ error: "session_expired" });
        }

        // isPlayableEntry guarantees plan.mode !== "direct" (remux | transcode);
        // narrow audioAction via the "in" check since PlaybackPlan is a union.
        const media = entry.media;
        // `leveled` re-encodes audio to AAC even on a copy plan (loudnorm filter).
        const audioAction: "copy" | "aac" =
          entry.audioMode === "leveled"
            ? "aac"
            : "audioAction" in entry.plan
              ? entry.plan.audioAction
              : "aac";

        // A non-source quality is a downscale rendition (single variant per
        // session): the video is re-encoded to the target height/bitrate, so
        // the STREAM-INF advertises the target resolution + bandwidth. The
        // client switches quality by re-negotiating /playback/info, which mints
        // a new session (and thus a new master reflecting that choice).
        const downscale = entry.quality.id !== "source" && entry.quality.targetVideoBitrate != null;

        // Video codec string: remux reports the SOURCE codec/profile/level;
        // transcode always emits libx264 High@4.1 today, so hardcode that.
        const videoCodec =
          entry.plan.mode === "transcode"
            ? videoCodecString("h264", "High", 41)
            : videoCodecString(media?.videoCodec ?? undefined, media?.videoProfile ?? undefined, media?.videoLevel ?? undefined);
        const audioCodec =
          audioAction === "copy" ? audioCodecString(media?.audioCodec ?? undefined) : audioCodecString("aac");
        const codecs = [videoCodec, audioCodec].filter((c): c is string => c !== null);

        const resolution = downscale
          ? entry.quality.width && entry.quality.height
            ? { width: entry.quality.width, height: entry.quality.height }
            : undefined
          : media?.width && media?.height
            ? { width: media.width, height: media.height }
            : undefined;

        // Subtitle renditions: only text-based tracks (image subs need burn-in, not HLS renditions).
        // Gated on the negotiated delivery preference (entry.subtitleRenditions,
        // set from ClientCapabilities.subtitleDelivery at negotiation time): a
        // client that declared "sidecar" (the web player) adds its own
        // <Track>s, so in-manifest renditions here would duplicate them —
        // omit the whole list for that client.
        const subtitles = entry.subtitleRenditions
          ? (media?.subtitleTracks ?? [])
              .filter((t) => !IMAGE_CODECS.has(t.codec ?? ""))
              .map((t) => ({
                name: t.language ?? `Track ${t.index}`,
                language: t.language,
                uri: `subs/${t.index}/index.m3u8?playSessionId=${playSessionId}${tokenSuffix(req)}`,
                // AUTOSELECT=NO: never let a subtitle rendition auto-load. The
                // WebVTT is extracted live by ffmpeg (`subtitles.ts`), which for
                // a feature-length file takes tens of seconds; if AVPlayer
                // auto-selects it, it blocks .readyToPlay on that fetch — the
                // item hangs at status=unknown (black screen + spinner) and
                // re-requests the VTT forever. Off by default → video plays
                // immediately; subtitles stay available for manual selection
                // (and are cached after first extraction, see subtitles.ts).
                autoselect: false,
              }))
          : [];

        const master = buildMultivariantPlaylist({
          mediaUri: `index.m3u8?playSessionId=${playSessionId}${tokenSuffix(req)}`,
          bandwidth: downscale ? entry.quality.bandwidth : media?.bitrate ?? 8_000_000,
          codecs,
          resolution,
          frameRate: media?.frameRate ?? undefined,
          // Transcode output is SDR H.264 today regardless of the source's color transfer.
          videoRange: entry.plan.mode === "remux" ? videoRange(media?.colorTransfer ?? undefined) : "SDR",
          subtitles,
        });

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
        if (!playSessionId) {
          return reply.code(400).send({ error: "missing_session" });
        }

        const session = await resolveByPlaySession(app, { manager, registry }, fileId, playSessionId, req, reply);
        if (!session) return;

        // Keyframe-derived boundaries (remux) give exact EXTINFs matching what
        // ffmpeg actually cuts; without them (transcode, or remux with no
        // extracted keyframes) fall back to the fixed-cadence VOD playlist.
        const q = `playSessionId=${playSessionId}${tokenSuffix(req)}`;
        const body =
          session.boundaries && session.boundaries.length > 0
            ? buildMediaPlaylistFromBoundaries(session.boundaries, q)
            : buildVodPlaylist(session.durationSec, session.segSec, q);

        return reply
          .code(200)
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .send(body);
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
        if (!playSessionId) {
          return reply.code(400).send({ error: "missing_session" });
        }
        const session = await resolveByPlaySession(app, { manager, registry }, fileId, playSessionId, req, reply);
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
        if (!playSessionId) {
          return reply.code(400).send({ error: "missing_session" });
        }
        const session = await resolveByPlaySession(app, { manager, registry }, fileId, playSessionId, req, reply);
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
