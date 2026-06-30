import { certsAtOrBelow, allowsRating } from "@orbix/core";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Prisma } from "@orbix/db";

// Note: all helpers below assume canonical-case ratings as written by the TMDB
// enrichment job (e.g. "G", "PG", "PG-13", "R", "NC-17").  Rating strings
// stored with different casing would silently bypass the kids cap check.

/**
 * Returns a Prisma WHERE clause restricting MediaItem.rating to the certs
 * allowed by the profile's maturityCap.  Returns null for standard /
 * unrestricted profiles — callers treat null as a no-op filter.
 *
 * Kids profiles exclude unrated items (rating = null) as the safer default:
 * Prisma's `{ in: [...] }` never matches NULL, so null-rated items are blocked
 * automatically.
 */
export function kidsRatingWhere(
  profile: { kind: string; maturityCap: number | null } | null,
): Prisma.MediaItemWhereInput | null {
  if (!profile || profile.kind !== "kids") return null;
  // Fail-safe: a kids profile with a null cap (DB tamper / future bug) defaults
  // to the most restrictive rating (G-only, cap index 0) rather than unrestricted.
  const cap = profile.maturityCap ?? 0;
  const allowed = certsAtOrBelow(cap);
  return { rating: { in: allowed } };
}

/**
 * Loads the active profile (kind + maturityCap) from the orbix_profile cookie.
 * Returns null when no cookie is set or the profile no longer exists.
 */
export async function activeProfile(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ id: string; kind: string; maturityCap: number | null } | null> {
  const profileId = req.cookies["orbix_profile"];
  if (!profileId) return null;
  return app.prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true, kind: true, maturityCap: true },
  });
}

/**
 * Returns true when the profile is allowed to see the given item.
 * Standard / unrestricted profiles can always see any item.
 * Kids profiles use allowsRating to enforce the maturityCap.
 */
export function profileAllowsItem(
  profile: { kind: string; maturityCap: number | null } | null,
  item: { rating: string | null },
): boolean {
  if (!profile || profile.kind !== "kids") return true;
  // Fail-safe: null cap on a kids profile → most restrictive (G-only, cap index 0).
  return allowsRating(profile.maturityCap ?? 0, item.rating);
}

/**
 * preHandler factory that blocks kids profiles from admin/management routes.
 * A kids session is an authenticated session where the orbix_profile cookie
 * points to a profile with kind="kids".  Standard profiles and no-profile
 * sessions (treated as unrestricted) pass through.
 *
 * Always combine with requireAuth so unauthenticated requests are rejected
 * before the profile lookup:
 *   { preHandler: [requireAuth(app), requireNonKids(app)] }
 */
export function requireNonKids(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const profile = await activeProfile(app, req);
    if (profile?.kind === "kids") {
      return reply.code(403).send({ error: "not_allowed_for_kids" });
    }
  };
}

/**
 * Shared kids-safety gate for streaming / subtitle endpoints.
 *
 * Loads the active profile and the MediaFile's parent MediaItem rating in
 * parallel.  Returns true if access is allowed (the file not existing is not
 * checked here — let each caller send its own 404).  Returns false and sends
 * a 403 `{error:"blocked_by_rating"}` when a kids profile would receive
 * content above its maturity cap (or unrated content).
 *
 * Usage:
 *   if (!await assertFileAllowed(app, req, fileId, reply)) return;
 */
export async function assertFileAllowed(
  app: FastifyInstance,
  req: FastifyRequest,
  fileId: string,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
): Promise<boolean> {
  const [file, profile] = await Promise.all([
    app.prisma.mediaFile.findUnique({
      where: { id: fileId },
      select: { mediaItem: { select: { rating: true } } },
    }),
    activeProfile(app, req),
  ]);
  if (!file) return true; // file not found — let the caller send the 404
  if (!profileAllowsItem(profile, { rating: file.mediaItem.rating })) {
    reply.code(403).send({ error: "blocked_by_rating" });
    return false;
  }
  return true;
}
