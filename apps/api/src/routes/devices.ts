import type { FastifyInstance } from "fastify";
import { generateDeviceToken, hashDeviceToken } from "@orbix/core";
import { Prisma } from "@orbix/db";
import { requireAuth, requireAdmin } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import { PairingStore } from "../lib/pairing";

const PLATFORMS = new Set(["tvos", "ios", "android", "web", "other"]);

function validName(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 64;
}

export default async function devicesRoute(app: FastifyInstance) {
  const store = new PairingStore();

  // ── Pairing (the TV side is unauthenticated by nature) ──────────────────

  app.post<{ Body: { name?: unknown; platform?: unknown } }>("/pair/initiate", async (req, reply) => {
    const name = req.body?.name;
    const platform = req.body?.platform;
    if (!validName(name) || typeof platform !== "string" || !PLATFORMS.has(platform)) {
      return reply.code(400).send({ error: "invalid" });
    }
    const res = store.initiate({ name: name.trim(), platform, ip: req.ip });
    if (res === "rate_limited") return reply.code(429).send({ error: "rate_limited" });
    return res;
  });

  app.get<{ Querystring: { token?: string } }>("/pair/poll", async (req, reply) => {
    if (!store.allowPoll(req.ip)) return reply.code(429).send({ error: "rate_limited" });
    const token = req.query.token;
    if (!token) return reply.code(400).send({ error: "invalid" });
    const res = store.redeem(token);
    if (!res) return reply.code(404).send({ error: "unknown_or_expired" });
    return res;
  });

  // ── Approval + registry (web side, signed-in) ────────────────────────────

  app.get<{ Params: { code: string } }>(
    "/pair/pending/:code",
    { preHandler: [requireAuth(app), requireNonKids(app)] },
    async (req, reply) => {
      const info = store.lookup(req.params.code.toUpperCase());
      if (!info) return reply.code(404).send({ error: "unknown_or_expired" });
      return info;
    },
  );

  app.post<{ Body: { code?: unknown } }>(
    "/pair/approve",
    { preHandler: [requireAuth(app), requireNonKids(app)] },
    async (req, reply) => {
      const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
      const info = store.lookup(code);
      if (!info) return reply.code(404).send({ error: "unknown_or_expired" });

      const { token, tokenHash } = generateDeviceToken();
      const device = await app.prisma.deviceToken.create({
        data: { tokenHash, name: info.name, platform: info.platform },
      });
      // markApproved only fails if the entry expired between lookup and now —
      // in that case the device row is orphaned but revocable from the registry.
      store.markApproved(code, { deviceToken: token, deviceId: device.id });
      return { ok: true, name: info.name, platform: info.platform };
    },
  );

  app.get(
    "/devices",
    { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] },
    async () => {
      const devices = await app.prisma.deviceToken.findMany({
        select: {
          id: true, name: true, platform: true, activeProfileId: true,
          lastSeenAt: true, createdAt: true, revokedAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
      return { devices };
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    "/devices/:id",
    { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] },
    async (req, reply) => {
      if (!validName(req.body?.name)) return reply.code(400).send({ error: "invalid" });
      try {
        await app.prisma.deviceToken.update({
          where: { id: req.params.id },
          data: { name: (req.body.name as string).trim() },
        });
        return { ok: true };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
          return reply.code(404).send({ error: "not_found" });
        }
        if ((e as { code?: string }).code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/devices/:id/revoke",
    { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] },
    async (req, reply) => {
      try {
        await app.prisma.deviceToken.update({
          where: { id: req.params.id },
          data: { revokedAt: new Date() },
        });
        return { ok: true };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
          return reply.code(404).send({ error: "not_found" });
        }
        if ((e as { code?: string }).code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    },
  );
}
