import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { decideStrategy } from "@orbix/core";
import { requireAuth } from "../lib/auth";

function contentTypeForContainer(container: string | null | undefined): string {
  if (!container) return "application/octet-stream";
  const c = container.toLowerCase();
  if (/mp4|mov|m4v/.test(c)) return "video/mp4";
  if (/mkv|matroska/.test(c)) return "video/x-matroska";
  if (c === "webm") return "video/webm";
  return "application/octet-stream";
}

export default async function streamRoute(app: FastifyInstance) {
  // GET /play/:fileId/decision
  app.get<{ Params: { fileId: string } }>(
    "/play/:fileId/decision",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const { fileId } = req.params;

      const file = await app.prisma.mediaFile.findUnique({
        where: { id: fileId },
        select: {
          id: true,
          container: true,
          videoCodec: true,
          audioCodecs: true,
        },
      });

      if (!file) return reply.code(404).send({ error: "not_found" });

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

  // GET /play/:fileId/direct
  app.get<{ Params: { fileId: string } }>(
    "/play/:fileId/direct",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const { fileId } = req.params;

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
}
