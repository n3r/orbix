import { normalizeForMatch } from "./match-score";
import { dominantScript, tmdbLanguageForScript, scriptRuns } from "./script";
import { looksRomanizedSlavic, reverseTransliterateRu } from "./translit";

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
  /** True when this attempt sends TMDB's year filter. */
  yearFiltered: boolean;
  /**
   * TMDB language tag (e.g. "ru-RU") for this attempt. Localizes the RETURNED
   * titles so a same-language query can string-compare against them; the match
   * set itself is language-independent.
   */
  language?: string;
  /**
   * True for lossy, derived queries (first-N-tokens truncation). Derived
   * queries may SURFACE candidates but must never VERIFY one — an exact match
   * against a truncated string proves nothing about the full title.
   */
  derived?: boolean;
}

// Strong release-noise tokens (compared uppercased, punctuation-stripped).
// Deliberately excludes bare "WEB" (protects "The Web", "Charlotte's Web"),
// bare years, and lone "Cut" (protects "The Cut").
const NOISE_WORDS = new Set([
  // source / rip
  "REMUX", "BDREMUX", "BLURAY", "BDRIP", "BRRIP", "WEBRIP", "WEBDL", "HDTV",
  "DVDRIP", "HDRIP", "DVDSCR", "ISO", "BDMV", "DVD", "HDTVRIP",
  "SATRIP", "IPTVRIP", "TVRIP", "DVBRIP", "VHSRIP", "DCPRIP",
  "TC", "TS", "TELECINE", "TELESYNC", "HDTC", "HDCAM", "CAMRIP", "SCREENER",
  // resolution / quality
  "UHD", "HDR", "HDR10", "DV", "SDR", "4K", "2K", "HD",
  // codec
  "X264", "X265", "HEVC", "AVC", "MPEG4", "XVID", "DIVX", "VC1",
  // audio
  "DTS", "DTSHD", "AC3", "EAC3", "DDP", "DD", "AAC", "FLAC", "TRUEHD", "ATMOS", "MP3",
  // edition
  "UNRATED", "UNCUT", "REMASTERED", "REMASTER", "EXTENDED", "THEATRICAL", "IMAX",
  "DIRECTORS", "PROPER", "REPACK", "RERIP", "LIMITED", "UPSCALE", "UPSCALED",
]);

const NOISE_RE: RegExp[] = [
  /^\d{3,4}P$/, // 720P 1080P 2160P
  /^\d{3,4}I$/, // 1080I HDTV interlaced tags
  /^(?:480|576|720|1080|2160|4320)$/, // bare resolutions ("Darkwing Duck 1080 Upscale")
  /^X26[45]$/,
  /^H26[45]$/,
  /^DD[P+]?\d?\d?$/, // DD DDP DD5 DD51
  /^\d+BIT$/, // 10BIT
  /^T\d{2,3}$/, // MakeMKV-style disc title number (t05)
];

// Bracket segments whose contents look like a tracker / release-site tag.
const TRACKER_WORDS = /(?:rutracker|nnmclub|kinozal|rarbg|hdclub|rutor|torrent)/i;
const DOMAIN_RE = /[\w-]+\.(?:org|com|net|to|se|me|tv|info|ru|su|ua|by|ws|cc|io|club|fun|top|pw|biz)\b/i;
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
  // 0. Compose to NFC: macOS filenames arrive decomposed (й as и + breve) and
  // TMDB's search index only matches the composed form.
  const composed = raw.normalize("NFC");

  // 0.5. A LEADING bracket group is a release tag ("[Beatrice-Raws] Tonari no
  // Totoro", "[DS27]Zootopia+") — but only when a title follows (a fully
  // bracketed name like "[REC]" survives) and the tag is whitespace-free (a
  // bracket-wrapped TITLE, "[Taxi 1998] [tags]", contains spaces).
  const untagged = composed.replace(/^\s*\[[^\]\s]*\][\s._-]*(?=\S)/, "");

  // 1. Drop bracket segments that are clearly tracker/site tags.
  const debracketed = untagged.replace(BRACKET_SEGMENT_RE, (seg) =>
    DOMAIN_RE.test(seg) || TRACKER_WORDS.test(seg) ? " " : seg,
  );

  // 2. Normalize separators (dots, underscores, remaining brackets) to spaces.
  const spaced = debracketed.replace(/[._[\]{}()]+/g, " ");

  // 3. Tokenize on whitespace (intra-word punctuation like ! ? ' - stays).
  const tokens = spaced.split(/\s+/).filter(Boolean);

  // 4/5. Truncate at the first strong-noise token that follows a real word.
  // BEFORE the first word, only STRUCTURED tokens (1080p, x264, t05) are
  // skipped — a dictionary word like "TC" can legitimately start a real title
  // ("TC 2000"), so leading dictionary noise is kept as part of the title.
  const kept: string[] = [];
  let seenWord = false;
  for (const token of tokens) {
    const key = noiseKey(token);
    if (isNoise(key)) {
      if (seenWord) break; // cut here
      if (NOISE_RE.some((re) => re.test(key))) continue; // structured leading junk
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
 * noise, so a query is always non-empty. Output is always NFC-composed.
 */
export function cleanSearchTitle(raw: string): string {
  return stripNoise(raw) || raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Ladder-dedup key: case/punctuation-insensitive but WITHOUT homoglyph
 * folding — a homoglyph-repaired query must survive as its own attempt (the
 * provider's index is what needs the exact spelling), while "Exo-Squad" and
 * "Exo Squad" still collapse into one search.
 */
export function queryKey(q: string): string {
  return q
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
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

// A leading broadcaster name with a separator and a real title after it.
const CHANNEL_PREFIX_RE =
  /^(?:bbc|discovery(?:[\s.]+(?:world|channel|science|civilization))?|national[\s.]+geographic|nat[\s.]?geo|ngc|history(?:[\s.]+channel)?|animal[\s.]+planet|pbs|nova|культура|первый[\s.]+канал|нтв|россия)[\s.:\-—_]+(?=\S)/i;

// Quality tokens that ride along with a channel prefix ("BBC HD Supervolcano").
const CHANNEL_QUALITY_RE = /^(?:(?:hd|uhd|sd|4k)[\s.:\-—_]+)+/i;

// ── Mixed-script homoglyph repair ────────────────────────────────────────────
// Release names splice visually identical letters across scripts ("Миньoны"
// with a Latin o, "Lilо" with a Cyrillic о). Provider search indexes do NOT
// fold homoglyphs, so the polluted spelling returns nothing — repair each
// mixed word toward its majority script and search that too.
const LAT_TO_CYR: Record<string, string> = {
  a: "а", e: "е", o: "о", p: "р", c: "с", y: "у", x: "х",
  A: "А", E: "Е", O: "О", P: "Р", C: "С", Y: "У", X: "Х", B: "В", H: "Н", K: "К", M: "М", T: "Т",
};
const CYR_TO_LAT: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x",
  А: "A", Е: "E", О: "O", Р: "P", С: "C", У: "Y", Х: "X", В: "B", Н: "H", К: "K", М: "M", Т: "T",
};

function repairHomoglyphs(s: string): string {
  return s
    .split(/(\s+)/)
    .map((word) => {
      const cyr = (word.match(/\p{Script=Cyrillic}/gu) ?? []).length;
      const lat = (word.match(/\p{Script=Latin}/gu) ?? []).length;
      if (!cyr || !lat) return word;
      const map = cyr >= lat ? LAT_TO_CYR : CYR_TO_LAT;
      return [...word].map((ch) => map[ch] ?? ch).join("");
    })
    .join("");
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
/** Shared plausibility window for a 4-digit token read as a release year. */
function plausibleYear(token: string): number | null {
  const year = parseInt(token, 10);
  return year >= 1900 && year <= 2099 ? year : null;
}

function extractTrailingYear(s: string): { base: string; year: number } | null {
  const m = /^(.*\S)\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const year = plausibleYear(m[2]!);
  if (year == null) return null;
  return { base: m[1]!.trim(), year };
}

/**
 * A leading 4-digit year prefix ("2007. Майкл Клейтон…") with the remaining
 * title text. Returns null when the year has nothing after it (a bare-year
 * title like "2012" IS the movie name, not a filter).
 */
function extractLeadingYear(s: string): { base: string; year: number } | null {
  const m = /^(\d{4})[\s._-]+(\S.*)$/.exec(s.trim());
  if (!m) return null;
  const year = plausibleYear(m[1]!);
  if (year == null) return null;
  if (!/\p{L}/u.test(m[2]!)) return null;
  return { base: m[2]!.trim(), year };
}

/** TMDB language tag for the dominant script of a query, if unambiguous. */
function languageForQuery(s: string): string | undefined {
  const script = dominantScript(s);
  return script ? (tmdbLanguageForScript(script) ?? undefined) : undefined;
}

/**
 * Ordered, de-duplicated list of TMDB search attempts derived from a parsed
 * (title, year). Escalates from most-specific to broadest:
 *   1. cleaned title + year filter — tagged with the query script's language
 *      (e.g. ru-RU for Cyrillic) so returned titles come back localized and
 *      string-compare against a same-language query
 *   2. cleaned title, no year filter
 *   3. parenthetical alternatives (original titles, director/edition notes)
 *   4. per-script runs of a bilingual name ("Майкл Клейтон Michael Clayton")
 *   5. raw title + year filter (never worse than the naive exact query)
 *   6. first 3 tokens of the cleaned title (only when it has more)
 *   7. last-resort in-title trailing year ("Taxi 1998" → "Taxi" + 1998)
 * A leading in-title year ("2007. Майкл Клейтон") supplies the year filter for
 * all attempts when no year was parsed.
 */
export function buildQueryLadder(input: { title: string; year?: number }): SearchAttempt[] {
  const title = input.title.normalize("NFC"); // TMDB search wants composed form
  const clean = cleanSearchTitle(title);

  // Leading in-title year supplies the filter when nothing was parsed.
  let year = input.year;
  let body = clean;
  if (year == null) {
    const lead = extractLeadingYear(clean);
    if (lead) {
      year = lead.year;
      body = lead.base;
    }
  }

  const raw: SearchAttempt[] = [];
  const push = (query: string, yr: number | undefined, language: string | undefined, derived = false) => {
    const q = query.trim();
    if (!q) return;
    raw.push({
      query: q,
      ...(yr != null ? { year: yr } : {}),
      yearFiltered: yr != null,
      ...(language ? { language } : {}),
      ...(derived ? { derived: true } : {}),
    });
  };

  const bodyLang = languageForQuery(body);
  push(body, year, bodyLang);
  push(body, undefined, bodyLang);

  // Mixed-script pollution: the repaired spelling is the FAITHFUL name.
  const repaired = repairHomoglyphs(body);
  if (repaired !== body) {
    const lang = languageForQuery(repaired);
    push(repaired, year, lang);
    push(repaired, undefined, lang);
  }

  // A hyphenated single name often lives unhyphenated in provider indexes
  // ("Exo-Squad" → "Exosquad"). The joined spelling is faithful, not derived —
  // dedup already collapses the space-separated reading.
  const joined = body.replace(/(?<=\p{L})-(?=\p{L})/gu, "");
  if (joined !== body) {
    push(joined, year, bodyLang);
    push(joined, undefined, bodyLang);
  }

  // Parenthetical alternatives (original titles, director/edition notes).
  for (const variant of parentheticalVariants(title)) {
    const lang = languageForQuery(variant);
    push(variant, year, lang);
    push(variant, undefined, lang);
  }

  // TV-channel prefix ("BBC. Космос…", "Discovery World-Return…",
  // "Культура_Тайна Млечного Пути") — documentaries are habitually filed
  // under their broadcaster. The prefix-free name is a separate attempt, not
  // a replacement: a title legitimately starting with the word keeps rung 1.
  // Runs against the RAW title: the noise cut may already have consumed
  // everything after the channel word ("BBC HD Supervolcano" cleans to "BBC").
  const rawSpaced = title.replace(/[._]+/g, " ");
  const chan = CHANNEL_PREFIX_RE.exec(rawSpaced);
  if (chan) {
    const rest = stripNoise(rawSpaced.slice(chan[0].length).replace(CHANNEL_QUALITY_RE, ""));
    if (rest) {
      const lang = languageForQuery(rest);
      push(rest, year, lang);
      push(rest, undefined, lang);
    }
  }

  // Bilingual names: each script run is its own query in its own language.
  const runs = scriptRuns(body);
  if (runs.length > 1) {
    for (const run of runs) {
      const lang = tmdbLanguageForScript(run.script) ?? undefined;
      push(run.text, year, lang);
      push(run.text, undefined, lang);
    }
  }

  // Raw-title fallback — only when cleaning actually changed the text. When
  // clean === raw a language-less rung would be the exact same TMDB search
  // (the match set is language-independent), doubling API calls for every
  // well-named foreign-script file.
  if (normalizeForMatch(title) !== normalizeForMatch(clean)) {
    push(title, input.year, undefined);
  }
  if (tokenCount(body) > 3) {
    push(firstNTokens(body, 3), undefined, bodyLang, /* derived */ true);
  } else if (tokenCount(body) >= 2) {
    // Short queries can fail TMDB's search on a single divergent character
    // (its index is ё-sensitive: filename "восьмерка" vs actual "восьмёрка").
    // Surface candidates with the most distinctive token; only the faithful
    // full query may VERIFY them in the deep check.
    const longest = body
      .split(/\s+/)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0]!;
    if (longest.length >= 5 && longest !== body) {
      push(longest, undefined, bodyLang, /* derived */ true);
    }
  }

  // Romanized Slavic ("Zheleznyj chelovek 2"): reverse-transliterate to
  // Cyrillic and search localized — TMDB can't match the romanization, but it
  // knows the Cyrillic title. The fuzzy gate absorbs imperfect transliteration.
  if (bodyLang === undefined && looksRomanizedSlavic(body)) {
    const cyr = reverseTransliterateRu(body);
    if (cyr && cyr !== body) {
      push(cyr, year, "ru-RU");
      push(cyr, undefined, "ru-RU");
    }
  }

  // Last resort: a year embedded in the title with no separate year parsed
  // ("Taxi 1998"). Tried last so a title whose number is part of its name
  // ("Blade Runner 2049", "Death Race 2000") matches on the full title first.
  if (input.year == null) {
    const trail = extractTrailingYear(clean);
    if (trail) push(trail.base, trail.year, languageForQuery(trail.base));
  }

  const seen = new Set<string>();
  const ladder: SearchAttempt[] = [];
  for (const attempt of raw) {
    const key = `${queryKey(attempt.query)}|${attempt.year ?? ""}|${attempt.language ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ladder.push(attempt);
  }
  return ladder;
}
