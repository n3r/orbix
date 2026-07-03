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
  "UNRATED", "UNCUT", "REMASTERED", "EXTENDED", "THEATRICAL", "IMAX",
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
 * Strip Plex-style release noise from a raw parsed title. Works by finding the
 * first strong-noise token that follows at least one real word and dropping
 * everything from there — so trailing release groups (`_HDCLUB`) fall off for
 * free without needing a group dictionary.
 */
export function cleanSearchTitle(raw: string): string {
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
  const cleaned = kept
    .join(" ")
    .replace(/^[\s([{\-–—:._]+/u, "")
    .replace(/[\s([{\-–—:._]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();

  // 7. Fallback: title was pure noise — return the whitespace-normalized raw.
  return cleaned || raw.replace(/\s+/g, " ").trim();
}

function firstNTokens(s: string, n: number): string {
  return s.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

function tokenCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
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
  raw.push(yearFiltered ? { query: clean, year, yearFiltered: true } : { query: clean, yearFiltered: false });
  raw.push({ query: clean, yearFiltered: false });
  raw.push(yearFiltered ? { query: title, year, yearFiltered: true } : { query: title, yearFiltered: false });
  if (tokenCount(clean) > 3) {
    raw.push({ query: firstNTokens(clean, 3), yearFiltered: false });
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
