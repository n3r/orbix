import { buildQueryLadder, type SearchAttempt } from "./search-title";
import {
  scoreCandidate,
  isAcceptable,
  titleSimilarity,
  acronymMatches,
  normalizeForMatch,
  TITLE_STRONG,
  TITLE_WEAK,
} from "./match-score";
import { seasonShapeScore, type LocalSeasonShape, type ProviderSeasonShape } from "./season-shape";

// ---------------------------------------------------------------------------
// Generic title → provider-id resolver.
//
// Media-agnostic: the query ladder, candidate scoring, acceptance gates and
// alt-title deep check are identical for movies and TV series — only the two
// provider calls differ, so they are injected. `enrich.ts` wraps this for
// TMDB movies; `enrich-series.ts` for TMDB TV.
// ---------------------------------------------------------------------------

/** A provider search hit, in the shape the scorer understands (plus its id). */
export interface ResolveCandidate {
  id: number;
  title: string;
  originalTitle?: string;
  year?: number;
  popularity?: number;
  voteCount?: number;
}

export interface ResolveDeps {
  /** Candidate search — `language` localizes RETURNED titles (match set is language-independent). */
  search(query: string, year?: number, language?: string): Promise<ResolveCandidate[]>;
  /** Every known title for a candidate (display/original/alternative/translated). */
  allTitles(id: number): Promise<string[]>;
}

export interface ResolveOpts {
  /**
   * Alternative faithful titles for the same item (episode-filename prefix,
   * pack title, umbrella folder). Each gets its own full ladder, appended
   * after the primary's — they are real names, so they may accept and verify.
   */
  variants?: string[];
  /** Local file-backed season structure — enables shape disambiguation (TV). */
  localShape?: LocalSeasonShape[];
  /** Provider season structure for a candidate — enables shape disambiguation (TV). */
  seasonShape?: (id: number) => Promise<ProviderSeasonShape[]>;
}

/** How many unaccepted candidates the deep-check phase may fetch titles for. */
const DEEP_CHECK_LIMIT = 3;

/** Minimum votes for a WEAK-tier deep-check acceptance (translated-title data is noisy). */
const DEEP_WEAK_VOTE_FLOOR = 50;

/** How many gate-clearing candidates the shape phase may fetch seasons for. */
const SHAPE_CHECK_LIMIT = 3;

/** Single definition of "the candidate's year exactly matches the item's". */
export function yearMatches(itemYear: number | undefined, candidateYear: number | undefined): boolean {
  return itemYear != null && candidateYear != null && candidateYear === itemYear;
}

/**
 * Alt-title (deep-check) verification only trusts a STRONG match when the
 * candidate's year is within a year of the item's: alternative-title data is
 * crowd-sourced and a namesake decades away ("Batya" 2020 vs "Batya't
 * Palu-Palo" 1974 carrying the alt title "Batya") must not verify.
 */
function deepYearSane(itemYear: number | undefined, candidateYear: number | undefined): boolean {
  return itemYear == null || candidateYear == null || Math.abs(candidateYear - itemYear) <= 1;
}

/** Primary + variant ladders, deduped by (query, year-filter, language, derived). */
export function buildLadders(title: string, year: number | undefined, variants: string[] | undefined): SearchAttempt[] {
  const out: SearchAttempt[] = [];
  const seen = new Set<string>();
  for (const t of [title, ...(variants ?? [])]) {
    if (!t.trim()) continue;
    for (const attempt of buildQueryLadder({ title: t, year })) {
      const key = `${normalizeForMatch(attempt.query)}|${attempt.year ?? ""}|${attempt.language ?? ""}|${attempt.derived ? 1 : 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(attempt);
    }
  }
  return out;
}

/**
 * Resolve a title's provider id from a raw parsed title + optional year.
 *
 * Phase 1 — query ladder: cleaned title → drop year → parenthetical/script
 * variants → raw → derived attempts, scoring every candidate and accepting the
 * best that clears the gate. Short-circuits on a confident (rule-A) match,
 * keeping the common clean-title case at a single API call.
 *
 * Phase 1b — season shape (TV, year-less items only): when several distinct
 * candidates clear the gate on name alone, the name cannot decide (namesakes,
 * remakes with identical localized titles). The candidate whose real season
 * structure explains the local files wins.
 *
 * Phase 2 — deep check: the provider's search index matches alternative and
 * translated titles in ANY language, but returns only the display title — so a
 * foreign query can surface the right item yet fail the cheap string gate. For
 * the top-ranked unaccepted candidates, fetch every known title and verify the
 * faithful queries against them directly.
 */
export async function resolveTitle(
  title: string,
  year: number | undefined,
  deps: ResolveDeps,
  opts?: ResolveOpts,
): Promise<number | undefined> {
  const ladder = buildLadders(title, year, opts?.variants);
  // Shape disambiguation only applies when the year cannot arbitrate.
  const shapeMode = year == null && !!opts?.seasonShape && !!opts?.localShape?.length;
  let best: { id: number; rank: number; sim: number; exactYear: boolean } | undefined;
  /** Every gate-clearing candidate (shape mode), best rank/sim kept. */
  const accepted = new Map<number, { candidate: ResolveCandidate; rank: number; sim: number }>();
  /** Candidates seen but not accepted — the deep-check pool, best rank kept. */
  const pool = new Map<number, { candidate: ResolveCandidate; rank: number }>();

  for (const attempt of ladder) {
    let candidates: ResolveCandidate[];
    try {
      candidates = await deps.search(attempt.query, attempt.year, attempt.language);
    } catch {
      continue; // one failed attempt (rate limit, transient) must not abort the ladder
    }
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const sim = titleSimilarity(attempt.query, candidate);
      const rank = scoreCandidate(attempt.query, candidate, attempt.year ?? year);
      const exactYear = yearMatches(year, candidate.year);
      // Derived (truncated) attempts may only SURFACE candidates for the deep
      // check — an exact match against a lossy query proves nothing.
      if (!attempt.derived && isAcceptable(attempt.query, candidate, attempt.year, i === 0)) {
        if (shapeMode) {
          const prev = accepted.get(candidate.id);
          if (!prev || rank > prev.rank) {
            accepted.set(candidate.id, { candidate, rank, sim: Math.max(sim, prev?.sim ?? 0) });
          }
          continue;
        }
        // When the item has a year, year agreement dominates — but only within
        // the same SIMILARITY tier (rank would conflate: its year/popularity
        // bonuses can push a weak-sim candidate over the strong bar). A weak
        // exact-year candidate must not displace a STRONG match whose year is
        // merely off (festival vs wide release); a strong-sim wrong-year
        // candidate (an unreleased reboot titled exactly like the query) must
        // not beat an exact-year acceptance of the real item.
        const strong = sim >= TITLE_STRONG;
        const bestStrong = best != null && best.sim >= TITLE_STRONG;
        const better =
          !best ||
          (exactYear && !best.exactYear && (strong || !bestStrong)) ||
          (exactYear === best.exactYear && rank > best.rank);
        if (better) best = { id: candidate.id, rank, sim, exactYear };
      } else {
        const prev = pool.get(candidate.id);
        if (!prev || rank > prev.rank) pool.set(candidate.id, { candidate, rank });
      }
    }
    // A confidently-similar, year-consistent match is as good as it gets.
    if (!shapeMode && best && best.sim >= TITLE_STRONG && (year == null || best.exactYear)) break;
  }

  // ── Phase 1b: season-shape disambiguation ─────────────────────────────────
  if (shapeMode && accepted.size) {
    const ranked = [...accepted.values()].sort((a, b) => b.sim - a.sim || b.rank - a.rank);
    if (ranked.length === 1) return ranked[0]!.candidate.id;
    const finalists = ranked.slice(0, SHAPE_CHECK_LIMIT);
    let bestShaped: { id: number; shape: number; rank: number } | undefined;
    for (const f of finalists) {
      let shape: number;
      try {
        shape = seasonShapeScore(opts!.localShape!, await opts!.seasonShape!(f.candidate.id));
      } catch {
        continue; // an unshapeable candidate neither wins nor blocks the others
      }
      if (!bestShaped || shape > bestShaped.shape || (shape === bestShaped.shape && f.rank > bestShaped.rank)) {
        bestShaped = { id: f.candidate.id, shape, rank: f.rank };
      }
    }
    if (bestShaped) return bestShaped.id;
    return ranked[0]!.candidate.id; // every shape fetch failed — rank order
  }
  if (best) return best.id;

  // ── Phase 2: deep check ────────────────────────────────────────────────────
  // Only FAITHFUL queries may verify a candidate — a derived (truncated) query
  // matching an alt title exactly proves nothing about the full title.
  const deepQueries = [...new Set(ladder.filter((a) => !a.derived).map((a) => a.query))];
  // Exact-year candidates are verified first: franchise alt-title data is often
  // polluted (a sequel carrying the opener's title), and the item's own year is
  // the strongest disambiguator we have.
  const top = [...pool.values()]
    .sort((a, b) => {
      const ay = yearMatches(year, a.candidate.year) ? 1 : 0;
      const by = yearMatches(year, b.candidate.year) ? 1 : 0;
      if (ay !== by) return by - ay;
      return b.rank - a.rank;
    })
    .slice(0, DEEP_CHECK_LIMIT);

  for (const { candidate } of top) {
    if (!deepYearSane(year, candidate.year)) continue;
    let titles: string[];
    try {
      titles = await deps.allTitles(candidate.id);
    } catch {
      continue; // a failed titles fetch must not fail enrichment
    }
    const exactYear = yearMatches(year, candidate.year);
    // WEAK-tier acceptance scans dozens of noisy crowd-sourced translations —
    // require a real vote count so a random zero-vote item sharing the year
    // can't sneak in on partial overlap. STRONG and acronym matches are
    // precise enough to stand alone (obscure local titles ARE the zero-vote ones).
    const weakAllowed = exactYear && (candidate.voteCount ?? 0) >= DEEP_WEAK_VOTE_FLOOR;
    for (const q of deepQueries) {
      for (const t of titles) {
        const sim = titleSimilarity(q, { title: t });
        if (sim >= TITLE_STRONG || (sim >= TITLE_WEAK && weakAllowed) || acronymMatches(q, t)) {
          return candidate.id;
        }
      }
    }
  }

  return undefined;
}
