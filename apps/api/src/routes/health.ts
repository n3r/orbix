import type { FastifyInstance } from "fastify";

export default async function health(app: FastifyInstance) {
  app.get("/health", async () => {
    let db = false;
    try { await app.prisma.$queryRaw`SELECT 1`; db = true; } catch { db = false; }
    return { status: "ok", db };
  });
}
