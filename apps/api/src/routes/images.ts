import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import fs from "node:fs";
import path from "node:path";

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export function imagesRoute(env: Env) {
  return async function images(app: FastifyInstance) {
    app.get<{ Params: { "*": string } }>("/images/*", async (req, reply) => {
      const requested = req.params["*"];
      const root = path.resolve(env.METADATA_DIR);
      const abs = path.resolve(root, requested);

      // Reject path traversal
      if (!abs.startsWith(root + path.sep)) {
        return reply.code(404).send();
      }

      // Check existence
      try {
        await fs.promises.access(abs, fs.constants.R_OK);
      } catch {
        return reply.code(404).send();
      }

      reply.header("cache-control", "public, max-age=31536000, immutable");
      reply.type(contentType(abs));
      return reply.send(fs.createReadStream(abs));
    });
  };
}
