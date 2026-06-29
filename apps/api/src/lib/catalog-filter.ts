import { certsAtOrBelow, allowsRating } from "@orbix/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@orbix/db";

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
  if (!profile || profile.kind !== "kids" || profile.maturityCap == null) return null;
  const allowed = certsAtOrBelow(profile.maturityCap);
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
  return allowsRating(profile.maturityCap, item.rating);
}
