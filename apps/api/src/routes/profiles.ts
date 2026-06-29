import type { FastifyInstance } from "fastify";
import { validateProfileInput, hashPassword, verifyPassword, ProfileValidationError } from "@orbix/core";

// In the single-account MVP, authenticated == admin.
function requireAdmin(app: FastifyInstance) {
  return async (req: any, reply: any) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
  };
}

export default async function profiles(app: FastifyInstance) {
  // GET /profiles — omit pinHash from the select to never leak it to clients
  app.get("/profiles", async () =>
    app.prisma.profile.findMany({
      select: { id: true, name: true, avatar: true, kind: true, maturityCap: true },
    }));

  app.post<{ Body: unknown }>("/profiles", { preHandler: requireAdmin(app) }, async (req, reply) => {
    try {
      const v = validateProfileInput(req.body);
      const pinHash = v.pin ? await hashPassword(v.pin) : null;
      const p = await app.prisma.profile.create({
        data: { name: v.name, kind: v.kind, maturityCap: v.maturityCap ?? null, pinHash },
        select: { id: true, name: true, kind: true },
      });
      return p;
    } catch (e) {
      if (e instanceof ProfileValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post<{ Params: { id: string }; Body: { pin?: string } }>("/profiles/:id/select", async (req, reply) => {
    const p = await app.prisma.profile.findUnique({ where: { id: req.params.id } });
    if (!p) return reply.code(404).send({ error: "not_found" });
    if (p.pinHash) {
      if (!req.body?.pin || !(await verifyPassword(p.pinHash, req.body.pin))) {
        return reply.code(403).send({ error: "pin_required" });
      }
    }
    reply.setCookie("orbix_profile", p.id, { httpOnly: true, sameSite: "lax", path: "/" });
    return { profileId: p.id };
  });

  app.delete<{ Params: { id: string } }>("/profiles/:id", { preHandler: requireAdmin(app) }, async (req, reply) => {
    await app.prisma.profile.delete({ where: { id: req.params.id } });
    return reply.code(204).send();
  });
}
