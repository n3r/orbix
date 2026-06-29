import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { srtToVtt } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { assertFileAllowed } from "../lib/catalog-filter";

const execFileAsync = promisify(execFile);

/** Codecs that produce image-based subtitle bitmaps (cannot be served as VTT). */
const IMAGE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "pgssub",
  "pgs",
  "dvd_subtitle",
  "dvdsub",
  "vobsub",
  "xsub",
]);

type SubTrack = {
  index: number;
  codec: string;
  language?: string;
};

export default async function subtitlesRoute(app: FastifyInstance) {
  // ------------------------------------------------------------------
  // GET /play/:fileId/subs — list subtitle tracks with burnIn flag
  // ------------------------------------------------------------------
  app.get<{ Params: { fileId: string } }>(
    "/play/:fileId/subs",
    { preHandler: requireAuth(app) },
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
        codec: t.codec,
        language: t.language,
        burnIn: IMAGE_CODECS.has(t.codec),
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
    { preHandler: requireAuth(app) },
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
      if (IMAGE_CODECS.has(track.codec)) {
        return reply.code(415).send({ error: "image_subtitle_burn_in_required" });
      }

      // Extract subtitle stream to WebVTT via ffmpeg piped to stdout
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

      // ffmpeg emits native WebVTT when codec is already webvtt; for subrip it
      // outputs WebVTT format directly (ffmpeg's webvtt muxer handles the
      // comma→dot conversion). But if somehow it comes back as SRT-like text
      // (no WEBVTT header), run our converter as a fallback.
      const vtt = stdout.trimStart().startsWith("WEBVTT") ? stdout : srtToVtt(stdout);

      return reply
        .code(200)
        .header("Content-Type", "text/vtt; charset=utf-8")
        .send(vtt);
    },
  );
}
