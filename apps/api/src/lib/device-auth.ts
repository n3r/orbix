import type { FastifyInstance } from "fastify";
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
