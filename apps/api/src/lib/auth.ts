import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function requireAuth(_app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
  };
}

export function requireAdmin(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
    const acct = await app.prisma.account.findUnique({
      where: { id: req.accountId },
      select: { isAdmin: true },
    });
    if (!acct?.isAdmin) return reply.code(403).send({ error: "forbidden" });
  };
}
