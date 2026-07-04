import { titleSimilarity } from "./match-score";

// ---------------------------------------------------------------------------
// Season-shape verification.
//
// Ambiguous famous titles ("Shogun", "The Flash", "Ghosts", "Foundation") and
// identical localized names (a remake titled exactly like the original's
// translation) cannot be disambiguated by name or year when the path carries
// neither. What the library DOES know is its own structure: which seasons the
// files span and how many episodes each holds. Plex uses the same signal —
// the right candidate is the one whose real season structure explains the
// local files.
// ---------------------------------------------------------------------------

/** Shape of the LOCAL files: per season, file-backed episode count + max number. */
export interface LocalSeasonShape {
  seasonNumber: number;
  episodeCount: number;
  maxEpisode: number;
}

/** Shape of a PROVIDER candidate: per season, its real episode count. */
export interface ProviderSeasonShape {
  seasonNumber: number;
  episodeCount: number;
}

/**
 * How well a candidate's season structure explains the local files. Higher is
 * better; sign matters — a positive score means the structure broadly fits, a
 * negative one means it contradicts the files. Season 0 (specials) is ignored
 * on both sides: its numbering is provider-specific and local S0 rows carry
 * provisional numbers.
 *
 * Per local season: missing from the candidate −1.5; local episodes overflow
 * the candidate's count (beyond a +2 specials tolerance) −1; fits +1, with an
 * extra +0.5 when the size matches exactly — that bonus is what lets an
 * exact-fit candidate beat a superset (Doctor Who 2005 vs classic).
 */
export function seasonShapeScore(local: LocalSeasonShape[], provider: ProviderSeasonShape[]): number {
  const providerBySeason = new Map(provider.filter((s) => s.seasonNumber > 0).map((s) => [s.seasonNumber, s]));
  let score = 0;
  for (const l of local) {
    if (l.seasonNumber === 0) continue;
    const p = providerBySeason.get(l.seasonNumber);
    if (!p) {
      score -= 1.5;
      continue;
    }
    if (l.maxEpisode > p.episodeCount + 2) {
      score -= 1;
      continue;
    }
    score += 1;
    if (p.episodeCount === l.episodeCount || p.episodeCount === l.maxEpisode) score += 0.5;
  }
  return score;
}

/**
 * Pick the finalist whose season structure best explains the local files.
 * Shapes are fetched for at most `limit` finalists, in the given (best-first)
 * order; a failed fetch neither wins nor blocks the others, and an equal
 * score keeps the earlier (better-ranked) finalist. Returns undefined when
 * every fetch failed — the caller falls back to its own ranking.
 *
 * Five, not three: namesake pileups are real — "Ранчо" surfaces The Ranch
 * (2016), The Ranch (2012) and The Ranch (2004) above Le Ranch (2012), and
 * only the fourth candidate's shape explains the files.
 */
export async function pickBestByShape<T>(
  finalists: T[],
  local: LocalSeasonShape[],
  fetchShape: (finalist: T) => Promise<ProviderSeasonShape[]>,
  limit = 5,
): Promise<T | undefined> {
  let best: { finalist: T; shape: number } | undefined;
  for (const f of finalists.slice(0, limit)) {
    let shape: number;
    try {
      shape = seasonShapeScore(local, await fetchShape(f));
    } catch {
      continue;
    }
    if (!best || shape > best.shape) best = { finalist: f, shape };
  }
  return best?.finalist;
}

/** Threshold for accepting a specials title-hint match (hints are noisy). */
const SPECIAL_TITLE_SIM = 0.6;

/**
 * Resolve an unnumbered special (season 0) to a provider episode number.
 * Prefers a title-hint similarity match; falls back to a unique air year,
 * with "the christmas special of year X" disambiguated by a December air
 * date + a christmas-titled episode. Returns undefined when nothing is
 * conclusive — the provisional local number then stays.
 */
export function matchSpecialEpisode(
  local: { title?: string; year?: number; christmas?: boolean },
  candidates: { episodeNumber: number; title?: string; airDate?: string }[],
): number | undefined {
  if (local.title) {
    let best: { n: number; sim: number } | undefined;
    for (const c of candidates) {
      if (!c.title) continue;
      const sim = titleSimilarity(local.title, { title: c.title });
      if (sim >= SPECIAL_TITLE_SIM && (!best || sim > best.sim)) best = { n: c.episodeNumber, sim };
    }
    if (best) return best.n;
  }
  if (local.year != null) {
    const inYear = candidates.filter((c) => c.airDate?.startsWith(String(local.year)));
    if (inYear.length === 1) return inYear[0]!.episodeNumber;
    if (inYear.length > 1 && local.christmas) {
      const december = inYear.filter((c) => c.airDate!.slice(5, 7) === "12");
      const christmasTitled = december.filter((c) => /christmas/i.test(c.title ?? ""));
      if (christmasTitled.length === 1) return christmasTitled[0]!.episodeNumber;
      if (december.length === 1) return december[0]!.episodeNumber;
    }
  }
  return undefined;
}
