import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { activeProfile } from "./catalog-filter";

/**
 * preHandler for every non-admin /tv route: TV is absent for kids profiles in
 * v1, enforced server-side (UI-only hiding is a defect). Compose after
 * requireAuth; the 401 here is only a fail-safe for routes that forget.
 */
export function requireTvAccess(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
    const profile = await activeProfile(app, req);
    if (profile?.kind === "kids") {
      return reply.code(403).send({ error: "not_allowed_for_kids" });
    }
  };
}
