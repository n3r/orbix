import type { FastifyInstance } from "fastify";

export default async function health(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    let db = false;
    try { await app.prisma.$queryRaw`SELECT 1`; db = true; } catch { db = false; }
    // Surface DB failure as 503 so container/orchestration healthchecks
    // (`curl -sf .../health`) actually fail when Postgres is unreachable.
    if (!db) reply.code(503);
    // `service`/`name` are a discovery marker: the tvOS app's LAN autodetect
    // scans `/health` across the subnet and matches on `service === "orbix"`
    // to tell a real Orbix server apart from any other host that answers 200.
    // `name` is a friendly label shown in the server picker (override via the
    // optional ORBIX_SERVER_NAME env; defaults to "Orbix").
    return {
      status: db ? "ok" : "error",
      db,
      service: "orbix",
      name: process.env.ORBIX_SERVER_NAME || "Orbix",
    };
  });
}
