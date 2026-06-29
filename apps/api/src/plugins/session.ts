import fp from "fastify-plugin";
import { isSessionValid } from "@orbix/core";

export default fp(async (app) => {
  // Resolves the current account from the "orbix_session" cookie.
  app.decorateRequest("accountId", null);
  app.addHook("preHandler", async (req) => {
    const sid = req.cookies["orbix_session"];
    if (!sid) return;
    const session = await app.prisma.session.findUnique({ where: { id: sid } });
    if (session && isSessionValid(session)) {
      (req as { accountId: string | null }).accountId = session.accountId;
    }
  });
});

declare module "fastify" {
  interface FastifyRequest { accountId: string | null; }
}
