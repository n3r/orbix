/**
 * selectStaleItems
 *
 * Pure, deterministic helper — no I/O, fully unit-testable.
 * Returns the ids of items that should be refreshed:
 *   - matchState is NOT "unmatched" (i.e. "matched" or "manual")
 *   - tmdbId is non-null
 *   - updatedAt is older than (now - cadenceDays)
 */
export function selectStaleItems(
  items: {
    id: string;
    updatedAt: Date;
    matchState: string;
    tmdbId: number | null;
  }[],
  cadenceDays: number,
  now: Date,
): string[] {
  const cutoffMs = now.getTime() - cadenceDays * 24 * 60 * 60 * 1000;
  return items
    .filter(
      (item) =>
        item.matchState !== "unmatched" &&
        item.tmdbId !== null &&
        item.updatedAt.getTime() < cutoffMs,
    )
    .map((item) => item.id);
}
