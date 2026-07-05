import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import {
  IMAGE_SUBTITLE_CODECS,
  normalizeToVtt,
  subtitleVttRelPath,
  buildSubtitleMediaPlaylist,
} from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { queryTokenAuth, tokenSuffix } from "../lib/device-auth";
import { assertFileAllowed } from "../lib/catalog-filter";

const execFileAsync = promisify(execFile);

/**
 * Codecs that produce image-based subtitle bitmaps (cannot be served as VTT).
 * Re-exported from core (the canonical set) for the routes that still reference
 * `IMAGE_CODECS` by name (playback.ts) and this route's own track list.
 */
export const IMAGE_CODECS = IMAGE_SUBTITLE_CODECS;

type SubTrack = {
  index: number;
  codec?: string;
  language?: string;
  title?: string;
};

/**
 * Apple HLS rule 3.5: a WebVTT rendition segment served inside an HLS stream
 * (as opposed to standalone) must map its internal (LOCAL) cue timestamps to
 * the stream's MPEG-TS timeline via an X-TIMESTAMP-MAP header on the very
 * first line, right after WEBVTT. Our segments are a single full-duration
 * "segment" starting at TS 0, so the mapping is always the trivial identity.
 */
export function injectTimestampMap(vtt: string): string {
  return vtt.replace(/^WEBVTT/, "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0");
}

/** Human-readable label for a subtitle track (title tag > language > index). */
function subtitleLabel(track: SubTrack): string {
  if (track.title?.trim()) return track.title.trim();
  if (track.language?.trim()) return track.language.trim().toUpperCase();
  return `Track ${track.index}`;
}

export default function subtitlesRoute(env: Env) {
  return async function (app: FastifyInstance) {
    // ------------------------------------------------------------------
    // GET /play/:fileId/subs — list subtitle tracks with burnIn flag
    // ------------------------------------------------------------------
    app.get<{ Params: { fileId: string } }>(
      "/play/:fileId/subs",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req, reply) => {
        const { fileId } = req.params;

        // Kids-safety gate: block subtitle track list for blocked titles.
        if (!await assertFileAllowed(app, req, fileId, reply)) return;

        const file = await app.prisma.mediaFile.findUnique({
          where: { id: fileId },
          select: { id: true, subtitleTracks: true },
        });

        if (!file) return reply.code(404).send({ error: "not_found" });

        const tracks = (file.subtitleTracks as SubTrack[] | null) ?? [];

        return tracks.map((t) => ({
          index: t.index,
          codec: t.codec ?? "unknown",
          language: t.language,
          label: subtitleLabel(t),
          burnIn: t.codec ? IMAGE_CODECS.has(t.codec) : false,
        }));
      },
    );

    // ------------------------------------------------------------------
    // GET /play/:fileId/subs/:index — serve WebVTT for a text sub track
    // The client requests "/play/<id>/subs/1.vtt"; Fastify captures "1.vtt"
    // as the :index param so we strip the ".vtt" suffix.
    // ------------------------------------------------------------------
    app.get<{ Params: { fileId: string; index: string } }>(
      "/play/:fileId/subs/:index",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req, reply) => {
        const { fileId } = req.params;

        // Kids-safety gate: block subtitle content for blocked titles.
        if (!await assertFileAllowed(app, req, fileId, reply)) return;

        // Strip optional ".vtt" suffix and validate it's a plain integer
        const raw = req.params.index.replace(/\.vtt$/i, "");
        if (!/^\d+$/.test(raw)) {
          return reply.code(400).send({ error: "invalid_index" });
        }
        const trackIndex = parseInt(raw, 10);

        const file = await app.prisma.mediaFile.findUnique({
          where: { id: fileId },
          select: { id: true, path: true, subtitleTracks: true },
        });

        if (!file) return reply.code(404).send({ error: "not_found" });

        const tracks = (file.subtitleTracks as SubTrack[] | null) ?? [];
        const track = tracks.find((t) => t.index === trackIndex);
        if (!track) return reply.code(404).send({ error: "track_not_found" });

        // Image-based subtitles cannot be served as VTT
        if (track.codec && IMAGE_CODECS.has(track.codec)) {
          return reply.code(415).send({ error: "image_subtitle_burn_in_required" });
        }

        // Serve the durable pre-extracted VTT (written at scan time, by the
        // backfill job, or by a previous on-demand extraction below) under
        // METADATA_DIR — persistent + offline-safe. Extracting a full-length
        // subtitle live is slow (ffmpeg demuxes the whole container — tens of
        // seconds for a feature film), so a persisted hit is what keeps a
        // selected subtitle from re-triggering that cost on every request.
        const cachePath = path.join(env.METADATA_DIR, subtitleVttRelPath(fileId, trackIndex));

        let vtt: string;
        try {
          vtt = await fs.promises.readFile(cachePath, "utf8");
        } catch {
          // Not pre-extracted yet — extract the subtitle stream live, then
          // persist to the SAME durable location so subsequent requests are
          // instant and the master playlist can flip this track to
          // AUTOSELECT=YES once the file exists.
          let stdout: string;
          try {
            const result = await execFileAsync(
              "ffmpeg",
              ["-v", "quiet", "-i", file.path, "-map", `0:${trackIndex}`, "-f", "webvtt", "-"],
              { maxBuffer: 10 * 1024 * 1024 },
            );
            stdout = result.stdout;
          } catch {
            return reply.code(500).send({ error: "extract_failed" });
          }

          vtt = normalizeToVtt(stdout);

          // Persist for next time (best-effort — a write failure just means the
          // next request re-extracts).
          try {
            await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.promises.writeFile(cachePath, vtt, "utf8");
          } catch {
            /* ignore */
          }
        }

        // The Apple subtitle-rendition playlist fetches this same VTT with
        // ?hls=1 and needs the X-TIMESTAMP-MAP header AVPlayer requires for
        // WebVTT delivered inside an HLS stream.
        const body = (req.query as { hls?: string }).hls === "1" ? injectTimestampMap(vtt) : vtt;

        return reply
          .code(200)
          .header("Content-Type", "text/vtt; charset=utf-8")
          .send(body);
      },
    );

    // ------------------------------------------------------------------
    // GET /play/:fileId/subs/:index/index.m3u8 — Apple subtitle rendition
    // playlist: a single full-duration VTT "segment" (HLS rule 5.5). Kept
    // alongside the sibling VTT route (not in stream.ts) so the /subs
    // validation logic stays colocated; this path is more specific than
    // stream.ts's generic /play/:fileId/:seg catch-all, so Fastify's router
    // matches it first regardless of registration order.
    // ------------------------------------------------------------------
    app.get<{ Params: { fileId: string; index: string } }>(
      "/play/:fileId/subs/:index/index.m3u8",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req, reply) => {
        const { fileId } = req.params;

        // Kids-safety gate: block the subtitle playlist for blocked titles.
        if (!await assertFileAllowed(app, req, fileId, reply)) return;

        if (!/^\d+$/.test(req.params.index)) {
          return reply.code(400).send({ error: "invalid_index" });
        }
        const trackIndex = parseInt(req.params.index, 10);

        const file = await app.prisma.mediaFile.findUnique({
          where: { id: fileId },
          select: { id: true, durationSec: true, subtitleTracks: true },
        });

        if (!file) return reply.code(404).send({ error: "not_found" });

        const tracks = (file.subtitleTracks as SubTrack[] | null) ?? [];
        const track = tracks.find((t) => t.index === trackIndex);
        if (!track) return reply.code(404).send({ error: "track_not_found" });

        // Image-based subtitles have no VTT rendition to point to.
        if (IMAGE_CODECS.has(track.codec ?? "")) {
          return reply.code(415).send({ error: "image_subtitle_burn_in_required" });
        }

        // The playlist declares an EXTINF spanning the whole file, so a
        // not-yet-probed duration can't produce a valid playlist.
        if (!file.durationSec) {
          return reply.code(409).send({ error: "not_probed" });
        }

        const vttUri = `/api/play/${fileId}/subs/${trackIndex}.vtt?hls=1${tokenSuffix(req)}`;

        return reply
          .code(200)
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .send(buildSubtitleMediaPlaylist(file.durationSec ?? 0, vttUri));
      },
    );
  };
}
