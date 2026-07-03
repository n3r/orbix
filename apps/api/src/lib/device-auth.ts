import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashDeviceToken } from "@orbix/core";

const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * Resolves a raw device bearer token to its device + the (single) admin
 * account. Returns null for unknown or revoked tokens. Touches lastSeenAt at
 * most once per minute, fire-and-forget — liveness metadata must never fail
 * or slow a request.
 */
export async function resolveDeviceToken(
  app: FastifyInstance,
  rawToken: string,
): Promise<{ deviceId: string; accountId: string } | null> {
  const device = await app.prisma.deviceToken.findUnique({
    where: { tokenHash: hashDeviceToken(rawToken) },
    select: { id: true, revokedAt: true, lastSeenAt: true },
  });
  if (!device || device.revokedAt) return null;

  // Single-household: every device belongs to the sole (admin) account.
  const account = await app.prisma.account.findFirst({ select: { id: true } });
  if (!account) return null;

  if (Date.now() - device.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    void app.prisma.deviceToken
      .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
      .catch(() => {});
  }

  return { deviceId: device.id, accountId: account.id };
}

/**
 * preHandler for streaming/subtitle routes: AVPlayer fetches playlists,
 * segments, and subtitle renditions with no cookies and no headers, so these
 * routes also accept the device token as a ?token= query param (embedded in
 * generated playlist URIs). Runs before requireAuth in the preHandler array;
 * does nothing when the request is already authenticated.
 */
export function queryTokenAuth(app: FastifyInstance) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (req.accountId) return;
    const token = (req.query as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token.length === 0) return;
    try {
      const resolved = await resolveDeviceToken(app, token);
      if (resolved) {
        req.accountId = resolved.accountId;
        req.deviceId = resolved.deviceId;
      }
    } catch (err) {
      req.log.error({ err }, "query token lookup failed");
    }
  };
}

/**
 * Echo the auth token query (if the request used one) into child playlist /
 * segment / subtitle-rendition URIs. AVPlayer and other native players follow
 * generated URIs verbatim with no header/cookie support, so a `?token=` on
 * the parent request must be propagated to every child URI it links to.
 */
export function tokenSuffix(req: FastifyRequest): string {
  const token = (req.query as { token?: unknown } | undefined)?.token;
  return typeof token === "string" && token.length > 0 ? `&token=${encodeURIComponent(token)}` : "";
}
