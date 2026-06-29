import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { scanEvents, scanDoneCache } from "../plugins/queue";

function requireAdmin(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
  };
}

export default async function scanRoute(app: FastifyInstance) {
  // POST /sections/:id/scan — enqueue a scan job, return { jobId }
  app.post<{ Params: { id: string } }>(
    "/sections/:id/scan",
    { preHandler: requireAdmin(app) },
    async (req, reply) => {
      const sectionId = req.params.id;

      const sources = await app.prisma.source.findMany({
        where: { sectionId, enabled: true },
        select: { id: true, path: true },
      });

      if (sources.length === 0) {
        return reply.code(400).send({ error: "no_sources" });
      }

      const jobId = randomUUID();
      await app.scanQueue.add("scan", { jobId, sectionId, sources });

      return { jobId };
    },
  );

  // GET /scan/:jobId/stream — SSE; forward scanEvents for this jobId until "done"
  app.get<{ Params: { jobId: string } }>(
    "/scan/:jobId/stream",
    async (req, reply) => {
      const { jobId } = req.params;

      // Take raw control of the response so Fastify does not touch it again
      reply.hijack();
      const res = reply.raw;

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      // If the job finished before the client connected, send the cached done event
      const cached = scanDoneCache.get(jobId);
      if (cached) {
        res.write(`data: ${JSON.stringify(cached)}\n\n`);
        res.end();
        return;
      }

      const listener = (event: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event["phase"] === "done") {
          scanEvents.off(jobId, listener);
          res.end();
        }
      };

      // Clean up if the client disconnects early
      req.raw.on("close", () => {
        scanEvents.off(jobId, listener);
      });

      scanEvents.on(jobId, listener);
    },
  );
}
