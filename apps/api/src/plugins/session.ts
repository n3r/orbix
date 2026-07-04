import fp from "fastify-plugin";
import { isSessionValid } from "@orbix/core";
import { resolveDeviceToken } from "../lib/device-auth";

export default fp(async (app) => {
  // Resolves the current account from either a device bearer token
  // (Authorization: Bearer orb_...) or the "orbix_session" cookie.
  app.decorateRequest("accountId", null);
  app.decorateRequest("deviceId", null);
  app.addHook("preHandler", async (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      try {
        const resolved = await resolveDeviceToken(app, auth.slice("Bearer ".length));
        if (resolved) {
          req.accountId = resolved.accountId;
          req.deviceId = resolved.deviceId;
        }
      } catch (err) {
        req.log.error({ err }, "device token lookup failed");
      }
      return; // bearer present = device semantics; never fall back to cookies
    }

    const sid = req.cookies["orbix_session"];
    if (!sid) return;
    try {
      const session = await app.prisma.session.findUnique({ where: { id: sid } });
      if (session && isSessionValid(session)) {
        req.accountId = session.accountId;
      }
    } catch (err) {
      req.log.error({ err }, "session lookup failed");
    }
  });
});

declare module "fastify" {
  interface FastifyRequest { accountId: string | null; deviceId: string | null; }
}
