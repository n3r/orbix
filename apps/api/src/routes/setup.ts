import type { FastifyInstance } from "fastify";
import { createAdminAccount, isSetupComplete, createSession, SESSION_TTL_MS, SetupAlreadyCompleteError, ValidationError } from "@orbix/core";

export default async function setup(app: FastifyInstance) {
  app.get("/setup/status", async () => {
    const complete = await isSetupComplete({ countAccounts: () => app.prisma.account.count() });
    return { complete };
  });

  app.post<{ Body: { email: string; password: string } }>("/setup", async (req, reply) => {
    try {
      const { id } = await createAdminAccount(req.body, {
        hasAnyAccount: async () => (await app.prisma.account.count()) > 0,
        insert: (a) => app.prisma.account.create({ data: { ...a, isAdmin: true }, select: { id: true } }),
      });
      const session = await createSession(id, {
        insert: (s) => app.prisma.session.create({ data: { id: s.id, accountId: s.accountId, expiresAt: s.expiresAt }, select: { id: true, expiresAt: true } }),
      });
      reply.setCookie("orbix_session", session.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
      return { accountId: id };
    } catch (e) {
      if (e instanceof SetupAlreadyCompleteError) return reply.code(409).send({ error: "setup_complete" });
      if (e instanceof ValidationError) return reply.code(400).send({ error: "invalid" });
      throw e;
    }
  });
}
