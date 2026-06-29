import type { FastifyInstance } from "fastify";
import { verifyPassword, createSession, SESSION_TTL_MS } from "@orbix/core";

export default async function auth(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string } }>("/auth/login", async (req, reply) => {
    const acct = await app.prisma.account.findUnique({ where: { email: req.body.email } });
    if (!acct || !(await verifyPassword(acct.passwordHash, req.body.password))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const session = await createSession(acct.id, {
      insert: (s) => app.prisma.session.create({ data: s, select: { id: true, expiresAt: true } }),
    });
    reply.setCookie("orbix_session", session.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
    return { accountId: acct.id };
  });

  app.post("/auth/logout", async (req, reply) => {
    const sid = req.cookies["orbix_session"];
    if (sid) await app.prisma.session.deleteMany({ where: { id: sid } });
    reply.clearCookie("orbix_session", { path: "/" });
    return reply.code(204).send();
  });

  app.get("/auth/me", async (req, reply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
    return { accountId: req.accountId };
  });
}
