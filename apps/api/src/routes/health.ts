import type { FastifyInstance } from "fastify";

export default async function health(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    let db = false;
    try { await app.prisma.$queryRaw`SELECT 1`; db = true; } catch { db = false; }
    // Surface DB failure as 503 so container/orchestration healthchecks
    // (`curl -sf .../health`) actually fail when Postgres is unreachable.
    if (!db) reply.code(503);
    return { status: db ? "ok" : "error", db };
  });
}
