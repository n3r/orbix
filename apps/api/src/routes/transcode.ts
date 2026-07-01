import type { FastifyInstance } from "fastify";
import { requireAuth, requireAdmin } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import { scanTranscodeCapabilities } from "../lib/transcode-capabilities";

/**
 * POST /transcode/test — admin-only. Scans this server's ffmpeg for encoder
 * availability (see scanTranscodeCapabilities) and returns a CapabilityReport.
 * Results are advisory and not persisted.
 */
export default async function transcodeRoute(app: FastifyInstance) {
  app.post(
    "/transcode/test",
    { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] },
    async (_req, reply) => {
      const report = await scanTranscodeCapabilities();
      return reply.send(report);
    },
  );
}
