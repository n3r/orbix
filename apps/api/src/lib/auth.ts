import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function requireAuth(_app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
  };
}
