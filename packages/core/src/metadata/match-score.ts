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

/** Similarity floor granted to a numbered-sequel prefix match. */
const SEQUEL_PREFIX_SCORE = 0.9;

/**
 * True when the query is a numbered sequel that is a strict token-prefix of the
 * candidate — e.g. "step up 2" ⊂ "step up 2 the streets". Gated on the LAST
 * query token being a number so plain prefixes ("the matrix" → "the matrix
 * reloaded") are NOT treated as matches.
 */
function isNumberedSequelPrefix(qTokens: string[], tTokens: string[]): boolean {
  if (qTokens.length < 2 || tTokens.length <= qTokens.length) return false;
  if (!/^\d{1,3}$/.test(qTokens[qTokens.length - 1]!)) return false;
  for (let i = 0; i < qTokens.length; i++) {
    if (qTokens[i] !== tTokens[i]) return false;
  }
  return true;
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

  const qTokens = q.split(" ").filter(Boolean);
  let best = 0;
  for (const t of targets) {
    let s = Math.max(levRatio(q, t), tokenDice(q, t));
    if (isNumberedSequelPrefix(qTokens, t.split(" ").filter(Boolean))) {
      s = Math.max(s, SEQUEL_PREFIX_SCORE);
    }
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

/** Minimum votes for the long-official-title prefix rescue (rule D). */
export const PREFIX_VOTE_FLOOR = 100;

/** True when qTokens is a strict token-prefix of the candidate's title or original title. */
function isStrictTitlePrefix(qTokens: string[], candidate: ScoreCandidate): boolean {
  for (const title of [candidate.title, candidate.originalTitle]) {
    if (title == null) continue;
    const tTokens = normalizeForMatch(title).split(" ").filter(Boolean);
    if (tTokens.length <= qTokens.length) continue;
    if (qTokens.every((tok, i) => tok === tTokens[i])) return true;
  }
  return false;
}

/**
 * Acceptance gate — decides whether a scored candidate is trustworthy enough
 * to auto-match. Kept separate from ranking so a popular-but-wrong film can
 * never sneak in on its popularity tie-breaker.
 *
 * Deliberately has NO "exact year alone" rescue: a low-similarity candidate is
 * never accepted on year + popularity, because a title the filename parser
 * mangles could otherwise match a random same-year film.
 *
 * @param isTopResult true for the #1 result of the current search attempt.
 */
export function isAcceptable(
  query: string,
  candidate: ScoreCandidate,
  year: number | undefined,
  isTopResult: boolean,
): boolean {
  const sim = titleSimilarity(query, candidate);
  const exactYear = year != null && candidate.year != null && candidate.year === year;
  const votes = candidate.voteCount ?? 0;

  // Rule A — confident string match, any year.
  if (sim >= TITLE_STRONG) return true;

  // Rule B — decent string match backed by an exact year.
  if (sim >= TITLE_WEAK && exactYear) return true;

  // Rule C — prefix rescue: the query is the whole distinctive head of a much
  // longer official title ("The French Dispatch" ⊂ "The French Dispatch of the
  // Liberty, Kansas Evening Sun"). Trusted only as TMDB's #1 hit, with real
  // votes and ≥2 query tokens. When an exact title exists TMDB returns it #1
  // instead, so it wins via rule A and this never fires.
  const qTokens = normalizeForMatch(query).split(" ").filter(Boolean);
  if (isTopResult && qTokens.length >= 2 && votes >= PREFIX_VOTE_FLOOR && isStrictTitlePrefix(qTokens, candidate)) {
    return true;
  }

  return false;
}
