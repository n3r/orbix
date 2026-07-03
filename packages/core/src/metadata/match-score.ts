// ---------------------------------------------------------------------------
// Candidate scoring for TMDB movie matching.
//
// Pure, dependency-free. Given a search query and a TMDB search candidate,
// decide (a) how well they rank against each other (scoreCandidate) and
// (b) whether the match is trustworthy enough to accept (isAcceptable).
// ---------------------------------------------------------------------------

export interface ScoreCandidate {
  title: string;
  /** TMDB original-language title — lets a Cyrillic query match its own film. */
  originalTitle?: string;
  year?: number;
  popularity?: number;
  voteCount?: number;
}

/** Confident string match — accept at any year. */
export const TITLE_STRONG = 0.85;
/** Decent string match — accept only alongside an exact year. */
export const TITLE_WEAK = 0.55;
/** Minimum TMDB votes for the year-gated transliteration rescue (rule C). */
export const VOTE_FLOOR = 50;

/**
 * Fold accents, lowercase, and reduce runs of non-alphanumerics to single
 * spaces. Cyrillic is not decomposed by NFD, so it survives intact.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Classic two-row Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    const cur = new Array<number>(bl + 1);
    cur[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[bl]!;
}

function levRatio(a: string, b: string): number {
  if (a === b) return 1;
  const m = Math.max(a.length, b.length);
  return m === 0 ? 0 : 1 - levenshtein(a, b) / m;
}

function tokenDice(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * Similarity in [0,1] between a query and a candidate, taking the best of
 * edit-distance ratio and token-set overlap, across both the candidate's
 * display title and its original title.
 */
export function titleSimilarity(query: string, candidate: ScoreCandidate): number {
  const q = normalizeForMatch(query);
  const targets = [candidate.title, candidate.originalTitle]
    .filter((t): t is string => t != null && t.length > 0)
    .map(normalizeForMatch);

  let best = 0;
  for (const t of targets) {
    const s = Math.max(levRatio(q, t), tokenDice(q, t));
    if (s > best) best = s;
  }
  return best;
}

/**
 * Ranking score used to pick the best candidate. Title similarity dominates;
 * year proximity and popularity are small tie-breakers that can never, on
 * their own, clear an acceptance gate.
 */
export function scoreCandidate(
  query: string,
  candidate: ScoreCandidate,
  year?: number,
): number {
  const sim = titleSimilarity(query, candidate);

  let yearBonus = 0;
  if (year != null && candidate.year != null) {
    const d = Math.abs(year - candidate.year);
    yearBonus = d === 0 ? 1 : d <= 1 ? 0.4 : 0;
  }

  const popNorm = Math.min(candidate.voteCount ?? 0, 1000) / 1000;
  return sim + 0.12 * yearBonus + 0.05 * popNorm;
}

/**
 * Acceptance gate — decides whether a scored candidate is trustworthy enough
 * to auto-match. Kept separate from ranking so a popular-but-wrong film can
 * never sneak in on its popularity tie-breaker.
 *
 * @param isTopOfYearFilteredAttempt true only for the #1 result of a search
 *   that sent TMDB's year filter — required for the transliteration rescue.
 */
export function isAcceptable(
  sim: number,
  candidate: ScoreCandidate,
  year: number | undefined,
  isTopOfYearFilteredAttempt: boolean,
): boolean {
  const exactYear =
    year != null && candidate.year != null && candidate.year === year;

  // Rule A — confident string match, any year.
  if (sim >= TITLE_STRONG) return true;

  // Rule B — decent string match backed by an exact year.
  if (sim >= TITLE_WEAK && exactYear) return true;

  // Rule C — transliteration rescue: little string overlap, but TMDB returned
  // this as the top hit of a year-filtered query, the year is exact, and the
  // film has a real vote count. Strictly tighter than a blind results[0].
  if (exactYear && isTopOfYearFilteredAttempt && (candidate.voteCount ?? 0) >= VOTE_FLOOR) {
    return true;
  }

  return false;
}
