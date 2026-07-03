import { normalizeForMatch } from "./match-score";

// ---------------------------------------------------------------------------
// Search-title cleaning + query ladder.
//
// Turns a raw parsed movie title into the query (or ordered queries) we send to
// TMDB. Pure and side-effect free — used only to build searches, never to
// mutate the stored catalog, so an over-aggressive rule can at worst fail to
// match (never corrupt data).
// ---------------------------------------------------------------------------

export interface SearchAttempt {
  query: string;
  year?: number;
  /** True when this attempt sends TMDB's year filter (drives accept-rule C). */
  yearFiltered: boolean;
}

// Strong release-noise tokens (compared uppercased, punctuation-stripped).
// Deliberately excludes bare "WEB" (protects "The Web", "Charlotte's Web"),
// bare years, and lone "Cut" (protects "The Cut").
const NOISE_WORDS = new Set([
  // source / rip
  "REMUX", "BDREMUX", "BLURAY", "BDRIP", "BRRIP", "WEBRIP", "WEBDL", "HDTV",
  "DVDRIP", "HDRIP", "DVDSCR", "ISO", "BDMV",
  // resolution / quality
  "UHD", "HDR", "HDR10", "DV", "SDR", "4K", "2K",
  // codec
  "X264", "X265", "HEVC", "AVC", "MPEG4", "XVID", "DIVX", "VC1",
  // audio
  "DTS", "DTSHD", "AC3", "EAC3", "DDP", "DD", "AAC", "FLAC", "TRUEHD", "ATMOS", "MP3",
  // edition
  "UNRATED", "UNCUT", "REMASTERED", "REMASTER", "EXTENDED", "THEATRICAL", "IMAX",
  "DIRECTORS", "PROPER", "REPACK", "RERIP", "LIMITED",
]);

const NOISE_RE: RegExp[] = [
  /^\d{3,4}P$/, // 720P 1080P 2160P
  /^X26[45]$/,
  /^H26[45]$/,
  /^DD[P+]?\d?\d?$/, // DD DDP DD5 DD51
  /^\d+BIT$/, // 10BIT
];

// Bracket segments whose contents look like a tracker / release-site tag.
const TRACKER_WORDS = /(?:rutracker|nnmclub|kinozal|rarbg|hdclub|rutor|torrent)/i;
const DOMAIN_RE = /[\w-]+\.(?:org|com|net|to|se|me|tv|info)\b/i;
const BRACKET_SEGMENT_RE = /[[({][^[\]{}()]*[)\]}]/g;

function noiseKey(token: string): string {
  return token.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
}

function isNoise(key: string): boolean {
  if (key.length === 0) return false;
  if (NOISE_WORDS.has(key)) return true;
  return NOISE_RE.some((re) => re.test(key));
}

/**
 * Core noise-stripper. Finds the first strong-noise token that follows at least
 * one real word and drops everything from there — so trailing release groups
 * (`_HDCLUB`) fall off for free without needing a group dictionary. Returns an
 * empty string when the input is pure noise (no real word survives).
 */
function stripNoise(raw: string): string {
  // 1. Drop bracket segments that are clearly tracker/site tags.
  const debracketed = raw.replace(BRACKET_SEGMENT_RE, (seg) =>
    DOMAIN_RE.test(seg) || TRACKER_WORDS.test(seg) ? " " : seg,
  );

  // 2. Normalize separators (dots, underscores, remaining brackets) to spaces.
  const spaced = debracketed.replace(/[._[\]{}()]+/g, " ");

  // 3. Tokenize on whitespace (intra-word punctuation like ! ? ' - stays).
  const tokens = spaced.split(/\s+/).filter(Boolean);

  // 4/5. Truncate at the first strong-noise token that follows a real word.
  const kept: string[] = [];
  let seenWord = false;
  for (const token of tokens) {
    const key = noiseKey(token);
    if (isNoise(key)) {
      if (seenWord) break; // cut here
      continue; // leading noise before any word — skip it
    }
    if (key.length > 0) seenWord = true;
    kept.push(token);
  }

  // 6. Trim stray leading/trailing separators; collapse whitespace.
  return kept
    .join(" ")
    .replace(/^[\s([{\-–—:._]+/u, "")
    .replace(/[\s([{\-–—:._]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip Plex-style release noise from a raw parsed title, producing a search
 * query. Falls back to the whitespace-normalized raw when the title is pure
 * noise, so a query is always non-empty.
 */
export function cleanSearchTitle(raw: string): string {
  return stripNoise(raw) || raw.replace(/\s+/g, " ").trim();
}

/**
 * Alternative queries derived from parenthetical segments. A parenthesized part
 * is usually an original/alt title (`(eXistenZ)`, `(The Possession)`) or a
 * director/edition note (`(авторская версия)`) — so both the outside text and
 * each inner segment make useful independent searches. Pure-noise segments
 * (`(1080p)`) and empties are dropped.
 */
function parentheticalVariants(title: string): string[] {
  if (!title.includes("(")) return [];
  const variants: string[] = [];

  const outside = stripNoise(title.replace(/\([^()]*\)/g, " "));
  if (outside) variants.push(outside);

  const inner = /\(([^()]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = inner.exec(title)) !== null) {
    const cleaned = stripNoise(m[1]!);
    if (cleaned) variants.push(cleaned);
  }
  return variants;
}

function firstNTokens(s: string, n: number): string {
  return s.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

function tokenCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * A trailing 4-digit year embedded in the title (e.g. "Taxi 1998"), with the
 * title text before it. Returns null when the title has no such suffix or no
 * word precedes the number. The plausibility range (1900–2099) is generous;
 * safety comes from this being a LAST-RESORT ladder attempt with a year filter.
 */
function extractTrailingYear(s: string): { base: string; year: number } | null {
  const m = /^(.*\S)\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const year = parseInt(m[2]!, 10);
  if (year < 1900 || year > 2099) return null;
  return { base: m[1]!.trim(), year };
}

/**
 * Ordered, de-duplicated list of TMDB search attempts derived from a parsed
 * (title, year). Escalates from most-specific to broadest:
 *   1. cleaned title + year filter
 *   2. cleaned title, no year filter (main lever for foreign/alt-title matches)
 *   3. raw title + year filter (never worse than today's exact query)
 *   4. first 3 tokens of the cleaned title (only when it has more)
 */
export function buildQueryLadder(input: { title: string; year?: number }): SearchAttempt[] {
  const { title, year } = input;
  const clean = cleanSearchTitle(title);

  const raw: SearchAttempt[] = [];
  const yearFiltered = year != null;
  const add = (query: string, withYear: boolean) => {
    if (!query) return;
    raw.push(withYear && yearFiltered ? { query, year, yearFiltered: true } : { query, yearFiltered: false });
  };

  add(clean, true);
  add(clean, false);
  // Parenthetical alternatives (original titles, director/edition notes).
  for (const variant of parentheticalVariants(title)) {
    add(variant, true);
    add(variant, false);
  }
  add(title, true);
  if (tokenCount(clean) > 3) add(firstNTokens(clean, 3), false);
  // Last resort: a year embedded in the title with no separate year parsed
  // ("Taxi 1998"). Tried last so a title whose number is part of its name
  // ("Blade Runner 2049", "Death Race 2000") matches on the full title first.
  if (year == null) {
    const inTitle = extractTrailingYear(clean);
    if (inTitle) raw.push({ query: inTitle.base, year: inTitle.year, yearFiltered: true });
  }

  const seen = new Set<string>();
  const ladder: SearchAttempt[] = [];
  for (const attempt of raw) {
    const q = attempt.query.trim();
    if (!q) continue;
    const key = `${normalizeForMatch(q)}|${attempt.year ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ladder.push(attempt);
  }
  return ladder;
}
