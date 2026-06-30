import type { FastifyInstance } from "fastify";
import { validateProfileInput, hashPin, verifyPin, ProfileValidationError } from "@orbix/core";
import { Prisma } from "@orbix/db";
import { requireAuth } from "../lib/auth";
import { activeProfile } from "../lib/catalog-filter";

export default async function profiles(app: FastifyInstance) {
  // GET /me/profile — returns {kind} for the active profile cookie (for UI gating)
  app.get("/me/profile", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.send({ kind: null });
    return reply.send({ kind: profile.kind });
  });

  // GET /profiles — omit pinHash from the select to never leak it to clients
  app.get("/profiles", { preHandler: requireAuth(app) }, async () =>
    app.prisma.profile.findMany({
      select: { id: true, name: true, avatar: true, kind: true, maturityCap: true },
    }));

  app.post<{ Body: unknown }>("/profiles", { preHandler: requireAuth(app) }, async (req, reply) => {
    try {
      const v = validateProfileInput(req.body);
      const pinHash = v.pin ? await hashPin(v.pin) : null;
      const p = await app.prisma.profile.create({
        data: { name: v.name, kind: v.kind, maturityCap: v.maturityCap ?? null, pinHash },
        select: { id: true, name: true, kind: true },
      });
      return p;
    } catch (e) {
      if (e instanceof ProfileValidationError) return reply.code(400).send({ error: "invalid_profile" });
      throw e;
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/profiles/:id", { preHandler: requireAuth(app) }, async (req, reply) => {
    try {
      const existing = await app.prisma.profile.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: "not_found" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const merged = validateProfileInput({
        name: body.name ?? existing.name,
        kind: body.kind ?? existing.kind,
        maturityCap: body.maturityCap ?? existing.maturityCap ?? undefined,
        ...(body.pin !== undefined ? { pin: body.pin } : {}),
      });
      const pinHash = body.pin !== undefined
        ? (body.pin ? await hashPin(String(body.pin)) : null)
        : undefined;
      const data: Record<string, unknown> = {
        name: merged.name,
        kind: merged.kind,
        maturityCap: merged.maturityCap ?? null,
      };
      if (pinHash !== undefined) data.pinHash = pinHash;
      const p = await app.prisma.profile.update({
        where: { id: req.params.id },
        data,
        select: { id: true, name: true, kind: true },
      });
      return p;
    } catch (e) {
      if (e instanceof ProfileValidationError) return reply.code(400).send({ error: "invalid_profile" });
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
      throw e;
    }
  });

  app.post<{ Params: { id: string }; Body: { pin?: string } }>("/profiles/:id/select", { preHandler: requireAuth(app) }, async (req, reply) => {
    const p = await app.prisma.profile.findUnique({ where: { id: req.params.id } });
    if (!p) return reply.code(404).send({ error: "not_found" });
    if (p.pinHash) {
      if (!req.body?.pin || !(await verifyPin(p.pinHash, req.body.pin))) {
        return reply.code(403).send({ error: "pin_required" });
      }
    }
    reply.setCookie("orbix_profile", p.id, { httpOnly: true, sameSite: "lax", path: "/" });
    return { profileId: p.id };
  });

  app.delete<{ Params: { id: string } }>("/profiles/:id", { preHandler: requireAuth(app) }, async (req, reply) => {
    try {
      await app.prisma.profile.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
      throw e;
    }
  });
}
