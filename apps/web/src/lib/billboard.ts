import type { HomeCard, HomeRow } from "./types";

/**
 * Deterministic billboard pick for the home page:
 *   1. a backdrop-bearing card of the first non-"continue" row (the billboard
 *      is a discovery surface, not a resume prompt) — `seed` rotates which one,
 *      so the feature changes day to day but is stable within a day,
 *   2. else the first card with backdrop art in any row,
 *   3. else the first card of the first non-empty row (tiny libraries),
 *   4. null when there is nothing to feature.
 */
export function pickBillboard(rows: HomeRow[], seed = 0): HomeCard | null {
  const discovery = rows.find((r) => r.key !== "continue" && r.items.length > 0);
  if (discovery) {
    const candidates = discovery.items.filter((c) => !!c.backdropPath);
    if (candidates.length > 0) return candidates[Math.abs(seed) % candidates.length];
  }
  for (const row of rows) {
    const hit = row.items.find((c) => !!c.backdropPath);
    if (hit) return hit;
  }
  return rows.find((r) => r.items.length > 0)?.items[0] ?? null;
}

/** Day index used to rotate the billboard pick once per day. */
export function dailySeed(now = new Date()): number {
  return Math.floor(now.getTime() / 86_400_000);
}
