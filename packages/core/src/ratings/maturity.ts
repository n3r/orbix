/**
 * Maturity rating model — pure functions mapping US content ratings to ordinal
 * tiers and enforcing a kids profile's maturity cap.
 *
 * Tier scale:  G=0  PG=1  PG-13=2  R=3  NC-17=4  (unknown/unrated = 99)
 */

export const CERT_TIERS: Record<string, number> = {
  G: 0,
  PG: 1,
  "PG-13": 2,
  R: 3,
  "NC-17": 4,
};

export const UNRATED_TIER = 99;

/** Canonical order for iterating certs from least to most restrictive. */
const CERT_ORDER: string[] = ["G", "PG", "PG-13", "R", "NC-17"];

/** Known variants that must be normalised before lookup. */
const VARIANTS: Record<string, string> = {
  PG13: "PG-13",
  NC17: "NC-17",
};

/**
 * Returns the ordinal tier for a US rating string.
 * Trims and uppercases before lookup; accepts common variants.
 * Returns UNRATED_TIER (99) for null, undefined, or unrecognised strings.
 */
export function ratingTier(rating: string | null | undefined): number {
  if (rating == null) return UNRATED_TIER;

  const normalised = rating.trim().toUpperCase();
  const resolved = VARIANTS[normalised] ?? normalised;

  return CERT_TIERS[resolved] ?? UNRATED_TIER;
}

/**
 * Returns true when the given maturity cap permits the given rating.
 *
 * - A null/undefined cap means the profile is unrestricted → always true.
 * - Otherwise returns true only when ratingTier(rating) <= maturityCap.
 *   Unrated content (tier 99) is blocked by any finite cap.
 */
export function allowsRating(
  maturityCap: number | null | undefined,
  rating: string | null | undefined,
): boolean {
  if (maturityCap == null) return true;
  return ratingTier(rating) <= maturityCap;
}

/**
 * Returns the cert strings (in tier order) whose tier is <= maturityCap.
 * Never includes the unrated sentinel — only real cert labels.
 */
export function certsAtOrBelow(maturityCap: number): string[] {
  return CERT_ORDER.filter((cert) => (CERT_TIERS[cert] ?? UNRATED_TIER) <= maturityCap);
}
