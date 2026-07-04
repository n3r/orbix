import { basename, dirname, sep } from "node:path";
import { filenameParse } from "@ctrl/video-filename-parser";
import type { ScanContext } from "./scan-context";

export interface ParsedMediaPath {
  title: string;
  year?: number;
  tmdbId?: number;
  imdbId?: string;
  /** Present (with episodeNumber) when the file is a TV episode. */
  seasonNumber?: number;
  episodeNumber?: number;
  /**
   * Additional faithful series-title candidates (episode-filename prefix, pack
   * title, umbrella folder) for the matcher's query ladder. Never derived junk.
   */
  titleVariants?: string[];
  /** Specials (S0): the local episode title, for provider title-matching. */
  episodeTitleHint?: string;
  /** Specials (S0): the episode's own air year (≠ the series year). */
  episodeYear?: number;
  /** Extras/trailers/samples — the scanner must not ingest this file. */
  skip?: boolean;
}

const YEAR_RE = /\((\d{4})\)/;
const TMDB_BRACKET_RE = /\[tmdbid-(\d+)\]/i;
const TMDB_BRACE_RE = /\{tmdb-(\d+)\}/i;
const IMDB_RE = /\[imdbid-(tt\d+)\]/i;

// TV episode patterns.
const SE_RE = /[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/; //  S01E02 / s1.e2
const X_RE = /\b(\d{1,2})x(\d{1,3})\b/; //               1x02
const S_SEP_RE = /[sS](\d{1,2})[._](\d{1,3})(?=\D|$)/; // S05_15 / S05.15 (no E)
// "08-06" two-digit season-episode pair ("Greys Anatomy 08-06 FOX"). Both sides
// exactly 2 digits and separator-delimited, so year ranges ("1999-2000") and
// single digits ("9-11") never match; season capped at a sane 40.
const SS_EE_RE = /(?:^|[\s._-])(\d{2})[-–](\d{2})(?=[\s._-]|$)/;
// Bare episode tag without a season: ".e01." / " E05 " (digits required, both
// sides separator-delimited, so "WALL-E", "E.T." and hex tags never match).
const BARE_E_RE = /(?:^|[\s._-])[eE](\d{1,3})(?=[\s._-]|$)/;
const SPECIALS_FOLDER_RE = /^(?:specials?|спец[\s._-]?выпуски?)$/i;
const SPECIAL_KEYWORD_RE = /(?:^|[\s._-])specials?(?=[\s._-]|$)/i;

// Library-root-ish folder names that can never be a show title — used when a
// season pack sits directly under the library root and has no show parent.
// Composable: optional genre words ("Documentary", "Cartoons", "Детские")
// before a media word ("Series", "Фильмы"), plus bare genre roots — so
// "Documentary Series" / "Cartoons Series" / "TV Shows" are all generic.
// A library-root-ish name that can never be a show title. Genre words may
// precede a media word ("Documentary Series", "Cartoons Series", "TV Shows").
// Deliberately excludes "library"/"collection" — those are plausible real
// show-folder names, and blanking them would strip a legitimate title.
const GENERIC_ROOT_RE =
  /^(?:(?:documentary|documentaries|cartoons?|animations?|animated|anime|kids?|children'?s?|детск(?:ие|ое)|аниме|документальн\w*|мульт\w*|познавательн\w*|tv|hd|uhd|4k)[\s._-]+)*(?:series|serials?|tv(?:[\s._-]?shows?)?|shows?|сериалы|кино|movies?|films?|фильмы|мультфильмы|мультсериалы|документалки|video|видео|media)$|^(?:documentary|documentaries|cartoons?|anime|аниме|мульт(?:ики|фильмы|сериалы)?|документалистика|документальное)$/i;

// Season markers ANYWHERE in a folder name — real libraries wrap the season in
// junk ("Сезон 4 (Season 4) 2001-2002", "Family Guy Season 11 (WEB-DL 1080p)",
// "Rick and Morty (3 season) [Blu-ray]", "Friends S04 BDRemux", "2.sezon").
const SEASON_MARKER_RES: RegExp[] = [
  /(?:^|[\s._([-])(?:season|сезон|sezon)[\s._#№-]*(\d{1,2})(?=\D|$)/iu, // word-first
  /(?:^|[\s._([-])(\d{1,2})[\s._-]*(?:season|сезон|sezon)(?=\W|$)/iu, //  number-first
  /(?:^|[\s._([-])[sS](\d{1,2})(?=[\s._)\]-]|$)/, //                      bare pack token "S04"
  /^(\d{1,2})x\d{2,3}(?=[\s._-]|$)/, //                                   "1x52 (1991)" — season x episode-count
];

/** Season number from a season marker anywhere in a folder name, if present. */
function folderSeasonNumber(folder: string): number | undefined {
  for (const re of SEASON_MARKER_RES) {
    const m = re.exec(folder);
    if (m) return parseInt(m[1]!, 10);
  }
  return undefined;
}

function extractYear(s: string): number | undefined {
  const m = YEAR_RE.exec(s);
  return m ? parseInt(m[1], 10) : undefined;
}

// Unparenthesized year in a folder/prefix ("Doctor.Who.2005.S01", "Sliders.1995-2000").
// 19xx/20xx only, separator-delimited, so resolutions ("2160p") never match.
const BARE_YEAR_RE = /(?:^|[\s._([-])((?:19|20)\d{2})(?=[\s._)\]-]|$)/;

function extractBareYear(s: string): number | undefined {
  const m = BARE_YEAR_RE.exec(s);
  return m ? parseInt(m[1], 10) : undefined;
}

// ── Extras (never library items) ─────────────────────────────────────────────
// Plex-style skip folders: bonus material shipped inside show/movie folders.
// These names are only reserved INSIDE an item folder — a library-root
// collection legitimately named "Shorts"/"Trailers" is real content, so the
// caller additionally requires a non-generic ancestor above the extras dir.
const EXTRAS_FOLDER_RE =
  /^(?:extras?|featurettes?|behind[\s._-]+the[\s._-]+scenes?|deleted[\s._-]+(?:and[\s._-]+alternate[\s._-]+)?scenes?|interviews?|samples?|shorts?|trailers?|bonus(?:es)?|бонусы?|special[\s._-]+features?)$/i;
const PROMO_FOLDER_RE = /(?:^|[\s._-])promos?$/i;

function isExtrasFolder(name: string): boolean {
  return EXTRAS_FOLDER_RE.test(name) || PROMO_FOLDER_RE.test(name);
}

// File-level extras keywords — only consulted for marker-less files inside a
// season pack, so a real episode titled "…Sample…" can never be skipped.
// "Film o filme" / "фильм о фильме" is the RU making-of featurette convention.
const EXTRAS_FILE_RE =
  /deleted[\s._-]*scenes?|featurettes?|film[\s._-]+o[\s._-]+fil'?me|фильм[\s._-]+о[\s._-]+фильме|(?:^|[\s._-])(?:sample|trailer)(?=[\s._-]|$)/i;

function extractTmdbId(s: string): number | undefined {
  const m = TMDB_BRACKET_RE.exec(s) ?? TMDB_BRACE_RE.exec(s);
  return m ? parseInt(m[1], 10) : undefined;
}

function extractImdbId(s: string): string | undefined {
  const m = IMDB_RE.exec(s);
  return m ? m[1] : undefined;
}

/**
 * Episode number from an E-tag, "Episode N", the Cyrillic "серия N" (either order),
 * a leading "NN." (common in localized releases), or an anime-style trailing "- NN".
 * Only called once a season/specials folder is confirmed, so a leading number is
 * unambiguously an episode index.
 */
function extractEpisodeNum(s: string): number | undefined {
  const m =
    /[eE](\d{1,3})/.exec(s) ??
    /\bep(?:isode)?[\s._-]*(\d{1,3})/i.exec(s) ??
    // NB: no \b — JS word boundaries are ASCII-only and never fire next to Cyrillic.
    /(?:^|[\s._-])сери[ияюей][\s._-]*(\d{1,3})/i.exec(s) ?? //  "серия 5"
    /(\d{1,3})[\s._-]*сери[ияюей]/i.exec(s) ?? //              "5 серия"
    /(\d{1,3})[\s._-]*serij/i.exec(s) ?? //                    translit "09.serija"
    /^(\d{1,3})[.)\s_-]/.exec(s) ?? //                         leading "100. Title"
    /[-–—][\s._]*(\d{1,3})(?:[\s._)\]-]|$)/.exec(s);
  return m ? parseInt(m[1], 10) : undefined;
}

// Explicit "серия N" (RU) / "серія N" (UK) marker, in either order. Used to
// detect a bare mini-series episode ("Title. Серия 3") that lives directly in a
// (movie) library with no season folder. Unlike extractEpisodeNum this ONLY
// matches the explicit keyword — never a leading/trailing bare number — so real
// movies with numbers ("Apollo 13", "Kill Bill Vol. 1") stay movies.
const SERIYA_LEADING_RE = /(?:^|[\s._-])сер(?:и[ияюей]|і[яї])[\s._-]*(\d{1,3})/i;
const SERIYA_TRAILING_RE = /(\d{1,3})[\s._-]*сер(?:и[ияюей]|і[яї])(?:[\s._-]|$)/i;

function seriyaEpisode(s: string): number | undefined {
  const m = SERIYA_LEADING_RE.exec(s) ?? SERIYA_TRAILING_RE.exec(s);
  return m ? parseInt(m[1], 10) : undefined;
}

// ── "(N из M)" episode counters ──────────────────────────────────────────────
// The RU broadcast convention for mini-series parts, in filenames as
// "(1 из 6)", "(2.serija.iz.5)", "(seria.1.iz.4)" or a range "(1-2.serii.iz.4)"
// (ranges attach to their first episode). The из/iz/of word is mandatory, and
// the number needs a separator in front, so "CD1 of 2" (letter before the
// digit) can never match.
const SERIYA_WORD = "(?:сери[ияй]|серии|seri[jy]?[aiy]|serij)";
const IZ_NUM_FIRST_RE = new RegExp(
  `(?:^|[\\s._([-])(\\d{1,3})(?:[\\s._-]*[-–][\\s._-]*\\d{1,3})?[\\s._-]*${SERIYA_WORD}?[\\s._-]*(?:из|iz|of)[\\s._-]*\\d{1,3}(?=[\\s._)\\]-]|$)`,
  "iu",
);
const IZ_WORD_FIRST_RE = new RegExp(`(?:^|[\\s._([-])${SERIYA_WORD}[\\s._-]*(\\d{1,3})[\\s._-]*(?:из|iz|of)[\\s._-]*\\d{1,3}`, "iu");
// A "N of M" whose number belongs to a CD/part split of one movie.
const IZ_SPLIT_GUARD_RE = /(?:cd|dis[ck]|dvd|pt|part|часть|chast)[\s._-]*\d{1,3}[\s._-]*(?:из|iz|of)[\s._-]*\d/i;

function izEpisode(s: string): number | undefined {
  if (IZ_SPLIT_GUARD_RE.test(s)) return undefined;
  const m = IZ_WORD_FIRST_RE.exec(s) ?? IZ_NUM_FIRST_RE.exec(s);
  return m ? parseInt(m[1]!, 10) : undefined;
}

// Standalone "Episode N" / "Ep. N" keyword ("Planet.Earth.II.Episode.1.1080p").
// Only trusted on year-less names: a movie rip virtually always carries its
// release year, and franchise titles do use the word ("Star Wars Episode 3
// 2005" must stay a movie).
const EPISODE_WORD_RE = /(?:^|[\s._-])ep(?:isode)?[\s._]*(\d{1,3})(?=\D|$)/i;

// ── Anime-style episodes (no season folder) ──────────────────────────────────
// Canonical fansub layouts number episodes absolutely, directly in the show
// folder: "[SubsPlease] Attack on Titan - 05 (1080p).mkv". Two rules, lowest
// precedence (checked next to the Серия rule) so explicit SxxExx / 1x02 /
// season-folder markers always win.

// Trailing "- NN" episode marker: an episode dash (-, – or —) + 1-3 digits,
// then only version/quality junk ("v2", "(1080p)", "[F00F]") up to the end.
// \d{1,3} plus the junk-only anchored tail means a 4-digit "- 2049" can never
// match — no partial-digit split survives the tail.
const ANIME_EP_TAIL_RE = /[-–—][\s._]*(\d{1,3})(?:\s*v\d+)?(?:[\s._]*[([][^()[\]]*[)\]])*[\s._]*$/i;

// Leading "[Group]" fansub tag.
const GROUP_TAG_RE = /^\[([^\]]+)\]\s*/;

// Bracket contents that are a tracker/release-site tag, not a fansub group
// ("[BDRemux Rutracker.org]"). Same idea as metadata/search-title.ts, kept
// local: scanner/ and metadata/ deliberately don't import from each other.
const TRACKER_TAG_RE = /rutracker|nnmclub|kinozal|rarbg|hdclub|rutor|torrent/i;
// Piracy-tracker TLDs only. Deliberately NOT the generic new-gTLDs
// (.fun/.club/.io/.top…) — those collide with real fansub group names
// ("[Judas.fun]") and title words.
const DOMAIN_TAG_RE = /[\w-]+\.(?:org|com|net|to|se|me|tv|info|ru|su|ua|by)\b/i;

/** Case- and separator-insensitive key for the folder-echo comparison. */
function echoKey(s: string): string {
  return s.replace(/[\s._]+/g, " ").trim().toLowerCase();
}

/**
 * RULE 1 — fansub bracket-group: "[Group] Title - NN [junk]" → season 1,
 * episode NN (absolute numbering). A tracker/site bracket tag is not a fansub
 * group — those wrap movies ("[Taxi 1998] [BDRemux Rutracker.org]").
 * RULE 2 — folder-echo: the filename is "<Folder> - NN" inside <Folder> →
 * season 1, episode NN.
 */
function detectAnimeEpisode(filenameNoExt: string, folder: string): EpisodeMarker | null {
  const tail = ANIME_EP_TAIL_RE.exec(filenameNoExt);
  if (!tail) return null;
  const episodeNumber = parseInt(tail[1], 10);

  const groupTag = GROUP_TAG_RE.exec(filenameNoExt);
  if (groupTag) {
    if (TRACKER_TAG_RE.test(groupTag[1]) || DOMAIN_TAG_RE.test(groupTag[1])) return null;
    // Fallback series title: the text between the group tag and the "- NN".
    // The caller still prefers the show folder (stable across episodes).
    const between = filenameNoExt.slice(groupTag[0].length, tail.index).replace(/[._]+/g, " ").trim();
    const marker: EpisodeMarker = { seasonNumber: 1, episodeNumber };
    if (between) marker.seriesTitleHint = between;
    return marker;
  }

  // Folder-echo needs a real folder to vouch for the series — a missing/root
  // folder can't, and a non-echoing one ("Movies/Heat - 2.mkv") must not.
  const folderKey = echoKey(folder);
  if (!folderKey || echoKey(filenameNoExt.slice(0, tail.index)) !== folderKey) return null;
  return { seasonNumber: 1, episodeNumber };
}

interface EpisodeMarker {
  seasonNumber: number;
  episodeNumber: number;
  /** Fansub fallback title: filename text between the [Group] tag and "- NN". */
  seriesTitleHint?: string;
  /** Specials: local episode title for provider title-matching at enrich. */
  episodeTitleHint?: string;
  /** Specials: the episode's own air year. */
  episodeYear?: number;
}

/**
 * Season-0 numbers at or above this base are PROVISIONAL: assigned to
 * unnumbered specials at scan time (base + air-year), renumbered at enrich by
 * matching against the provider's real specials list. Real provider specials
 * number far below it.
 */
export const PROVISIONAL_SPECIAL_BASE = 900;

/**
 * Unnumbered special episode: a file in a Specials folder, or a file carrying
 * the "special" keyword inside a season pack ("doctor.who.2005.christmas.
 * special.the.snowmen.2012…"). Mapped to season 0 with a provisional number
 * (base + air-year, so re-scans are stable); enrichment renumbers it by
 * matching the title hint / air year against the provider's specials list.
 */
function detectSpecial(filenameNoExt: string, folder: string): EpisodeMarker | null {
  const inSpecialsFolder = SPECIALS_FOLDER_RE.test(folder);
  const kw = SPECIAL_KEYWORD_RE.exec(filenameNoExt);
  if (!inSpecialsFolder && !(kw && folderSeasonNumber(folder) != null)) return null;

  const years = [...filenameNoExt.matchAll(new RegExp(BARE_YEAR_RE, "g"))].map((m) => parseInt(m[1]!, 10));
  const episodeYear = years.at(-1);

  let hint: string | undefined;
  if (kw) {
    // The subtitle lives between the keyword and the episode's year.
    let tail = filenameNoExt.slice(kw.index + kw[0].length);
    const yIdx = tail.search(BARE_YEAR_RE);
    if (yIdx >= 0) tail = tail.slice(0, yIdx);
    hint = tail.replace(/[._]+/g, " ").replace(/[\s\-–—:,([]+$/u, "").trim() || undefined;
  } else {
    hint = titleBeforeYear(filenameNoExt) || undefined;
  }

  return {
    seasonNumber: 0,
    episodeNumber: PROVISIONAL_SPECIAL_BASE + (episodeYear != null ? episodeYear % 100 : 99),
    ...(hint ? { episodeTitleHint: hint } : {}),
    ...(episodeYear != null ? { episodeYear } : {}),
  };
}

// ── Series-title derivation helpers ──────────────────────────────────────────

// Episode markers usable as a "cut here" point when deriving the series title
// from an episode filename ("Farmacia de Guardia - 001 - 1x01 - …" → text
// before the 1x01). Keyword rules included; bare-number rules excluded (their
// index is not a reliable title boundary).
const PREFIX_MARKER_RES: RegExp[] = [
  SE_RE,
  X_RE,
  S_SEP_RE,
  BARE_E_RE,
  SS_EE_RE,
  /\(\s*\d{1,3}\s*\)\s*$/, //                     trailing "(NN)" episode
  /(?:^|[\s._-])ep(?:isode)?[\s._-]*\d{1,3}/i,
  /(?:^|[\s._-])сери[ияюей][\s._-]*\d{1,3}/i,
  /\d{1,3}[\s._-]*сери[ияюей]/i,
  /\d{1,3}[\s._-]*serij/i,
  IZ_NUM_FIRST_RE,
  IZ_WORD_FIRST_RE,
];

/**
 * Series title embedded in an episode filename: the text before the first
 * episode marker, minus trailing separators, an absolute episode number
 * ("- 001") and a release year ("Billions.2016"). The most specific local
 * name we have — release files repeat the real title where folders are often
 * hand-typed (typos) or franchise umbrellas.
 */
function episodePrefixTitle(filenameNoExt: string): { title: string; year?: number } | undefined {
  let cut = -1;
  for (const re of PREFIX_MARKER_RES) {
    const m = re.exec(filenameNoExt);
    if (m && (cut < 0 || m.index < cut)) cut = m.index;
  }
  if (cut <= 0) return undefined;
  let s = filenameNoExt.slice(0, cut).replace(/[._]+/g, " ").trim();
  s = s.replace(/[\s\-–—:,([]+$/u, "").trim();
  const noAbs = s.replace(/[\s\-–—]+\d{1,3}$/u, "").trim();
  if (noAbs) s = noAbs;
  const year = extractBareYear(s);
  const noYear = s.replace(/[\s]+(?:19|20)\d{2}$/u, "").trim();
  if (noYear) s = noYear;
  if (!s) return undefined;
  return { title: s, ...(year != null ? { year } : {}) };
}

/**
 * Space out dots/underscores between word characters while preserving
 * initialisms: a separator is collapsed when EITHER side has 2+ alnum chars
 * ("Malysh.i.Karlson" → "Malysh i Karlson"), and kept only between two
 * single-letter tokens (S.W.A.T, A.I.). Underscores are never meaningful in
 * titles and always become spaces.
 */
function spaceSeparators(s: string): string {
  return s
    .replace(/_+/g, " ")
    .replace(/(?<=[\p{L}\p{N}]{2})\.(?=[\p{L}\p{N}])/gu, " ")
    .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}]{2})/gu, " ")
    // A dotted single LOWERCASE letter is a transliterated preposition the
    // release parser dotted ("Malysh i. Karlson", "idyot v. gosti") — an
    // uppercase one is a real initial (J. Edgar) and keeps its dot.
    .replace(/(?<=(?:^|\s)\p{Ll})\.(?=\s?[\p{L}\p{N}])/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Release-noise tail inside a would-be SERIES title (movie titles go through
// the release parser, but a show folder like "Тайная жизнь птиц 720p
// -ukraine-" reaches us raw). Cut at the first noise token.
const SERIES_NOISE_TAIL_RE =
  /[\s._([-]+(?:\d{3,4}[pi]|4k|uhd|hdr(?:10)?|bd(?:rip|remux)?|remux|blu-?ray|web[\s._-]?(?:dl|rip)|hdtv(?:rip)?|dvd(?:rip)?|sat[\s._-]?rip|iptv[\s._-]?rip|tv[\s._-]?rip|vhs[\s._-]?rip|hd[\s._-]?rip|x26[45]|h[\s._-]?26[45]|hevc|avc|xvid|divx|upscaled?|10bit|8bit|multi)(?=[\s._)\]-]|$).*$/iu;

/**
 * Strip season-pack phrasing from a would-be series title: "Season. 1-3",
 * "5 sezonov iz 5", "The Complete Series", "(Все сезоны)", trailing year
 * ranges, release-noise tails, tracker-domain brackets and a leading [Group]
 * tag. Applied to every series-title candidate; falls back to the input when
 * it would empty it.
 */
function cleanSeriesTitle(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  s = s.replace(/^\s*\[[^\]\s]*\][\s._-]*(?=\p{L})/u, "");
  s = s.replace(/[[({][^[\]{}()]*[)\]}]/g, (seg) => (DOMAIN_TAG_RE.test(seg) || TRACKER_TAG_RE.test(seg) ? " " : seg));
  s = s.replace(/[([]\s*(?:все[\s._-]*сезоны|all[\s._-]*seasons?)\s*[)\]]/gi, " ");
  s = s.replace(/(?:^|[\s._-])(?:the[\s._-]+)?complete[\s._-]+(?:series|collection|edition|seasons?)(?=[\s._-]|$)/gi, " ");
  s = s.replace(/(?:^|[\s._-])(?:seasons?|сезоны?|sezony?)[\s.]*\d{1,2}(?:[\s._-]*[-–][\s._-]*\d{1,2})?(?=[\s._-]|$)/gi, " ");
  s = s.replace(/(?:^|[\s._-])\d{1,2}[\s._-]*(?:seasons?|сезон(?:а|ов)?|sezon(?:a|ov)?)(?:[\s._-]*(?:iz|из)[\s._-]*\d{1,2})?(?=[\s._-]|$)/giu, " ");
  s = s.replace(/(?:^|[\s._-])(?:19|20)\d{2}[\s._-]*[-–][\s._-]*(?:19|20)\d{2}(?=[\s._-]|$)/g, " ");
  s = s.replace(SERIES_NOISE_TAIL_RE, "");
  s = s.replace(/\s{2,}/g, " ").replace(/^[\s._-]+/u, "").replace(/[\s._-]+$/u, "").trim();
  return s || raw.trim();
}

/** Folder text before its first season marker ("Не сработало.S01.WEB-DL…" → "Не сработало"). */
function titleBeforeSeasonMarker(name: string): string {
  let cut = -1;
  for (const re of SEASON_MARKER_RES) {
    const m = re.exec(name);
    if (m && (cut < 0 || m.index < cut)) cut = m.index;
  }
  if (cut <= 0) return "";
  return name.slice(0, cut).replace(/[._]+/g, " ").replace(/[\s\-–—:,([]+$/u, "").trim();
}

const normTitleKey = (s: string): string => s.toLowerCase().replace(/[\s._-]+/g, " ").trim();

/** True when `longer` starts with every token of `shorter` and adds more. */
function tokenExtends(longer: string, shorter: string): boolean {
  const a = normTitleKey(longer).split(" ").filter(Boolean);
  const b = normTitleKey(shorter).split(" ").filter(Boolean);
  if (!b.length || a.length <= b.length) return false;
  return b.every((t, i) => a[i] === t);
}

/** Detect TV season/episode from the filename and its folder, or null for movies. */
function detectEpisode(filenameNoExt: string, folder: string): EpisodeMarker | null {
  const se = SE_RE.exec(filenameNoExt);
  if (se) return { seasonNumber: parseInt(se[1], 10), episodeNumber: parseInt(se[2], 10) };

  const x = X_RE.exec(filenameNoExt);
  if (x) return { seasonNumber: parseInt(x[1], 10), episodeNumber: parseInt(x[2], 10) };

  // "S05_15" — season+episode with a separator instead of E.
  const su = S_SEP_RE.exec(filenameNoExt);
  if (su) return { seasonNumber: parseInt(su[1], 10), episodeNumber: parseInt(su[2], 10) };

  // Bare ".e01." / " E05 " — an episode tag without a season ("Epidemia.e01.2019",
  // "The.Pillars.of.the.Earth.E01.Anarchy"). Season from the folder, else 1 —
  // the Plex/Jellyfin convention for season-less markers.
  const bareE = BARE_E_RE.exec(filenameNoExt);
  if (bareE) {
    return { seasonNumber: folderSeasonNumber(folder) ?? 1, episodeNumber: parseInt(bareE[1], 10) };
  }

  // "08-06" — a two-digit pair reads as S08E06 (season sanity-capped).
  const pair = SS_EE_RE.exec(filenameNoExt);
  if (pair) {
    const seasonNumber = parseInt(pair[1], 10);
    if (seasonNumber >= 1 && seasonNumber <= 40) {
      return { seasonNumber, episodeNumber: parseInt(pair[2], 10) };
    }
  }

  const folderSeason = folderSeasonNumber(folder);
  if (folderSeason != null) {
    let ep = extractEpisodeNum(filenameNoExt);
    // Combined numbering under a season folder: "Rick and Morty - 305" in a
    // season-3 pack is episode 5, not 305.
    if (ep != null && ep >= 100 && Math.floor(ep / 100) === folderSeason) ep = ep % 100;
    if (ep !== undefined) return { seasonNumber: folderSeason, episodeNumber: ep };
  }

  if (SPECIALS_FOLDER_RE.test(folder)) {
    const ep = extractEpisodeNum(filenameNoExt);
    if (ep !== undefined) return { seasonNumber: 0, episodeNumber: ep };
  }

  // "01.<pack name>.mkv" inside <pack name> — numbered mini-series parts
  // ("Batya.2021…/01.Batya.2021….mkv"). The echo requirement keeps numbered
  // discs with their own titles ("1 Братство кольца.mkv") movies.
  const lead = /^(\d{1,2})[.)\s_-]+/.exec(filenameNoExt);
  if (lead) {
    const rest = filenameNoExt.slice(lead[0].length);
    if (echoKey(rest) && echoKey(rest) === echoKey(folder)) {
      return { seasonNumber: 1, episodeNumber: parseInt(lead[1], 10) };
    }
  }

  // "<title> <season> (NN).mkv" echoing a "<title> <season>" folder
  // ("OITNB 5/OITNB 5 (01).mkv" → S5E01). Two digits minimum: "(1)"/"(2)"
  // are browser-duplicate/disc suffixes on movies, and the 3-digit cap keeps
  // a parenthesized year ("Heat (1995).mkv") a movie.
  const trailParen = /^(.*?)[\s._-]*\((\d{2,3})\)\s*$/.exec(filenameNoExt);
  if (trailParen && echoKey(trailParen[1]!) && echoKey(trailParen[1]!) === echoKey(folder)) {
    const seasonTail = /(?:^|\s)(\d{1,2})$/.exec(folder.replace(/[._]+/g, " ").trim());
    if (seasonTail) {
      return { seasonNumber: parseInt(seasonTail[1], 10), episodeNumber: parseInt(trailParen[2]!, 10) };
    }
  }

  // Anime layouts without a season folder: "[Group] Title - NN" (fansub) or
  // "<Folder> - NN" (folder-echo). Lowest precedence, beside the Серия rule.
  const anime = detectAnimeEpisode(filenameNoExt, folder);
  if (anime) return anime;

  // Bare mini-series with no season folder: "Title. Серия 3" → season 1, ep 3.
  // Lowest precedence, so an explicit SxxExx / season folder always wins.
  const seriya = seriyaEpisode(filenameNoExt);
  if (seriya !== undefined) return { seasonNumber: 1, episodeNumber: seriya };

  // "(N из M)" mini-series counters, both word orders. Deliberately NOT
  // year-guarded (unlike the bare "Episode N" keyword below): the counter is
  // an explicit serialization marker and real localized doc series carry a
  // year with it ("Chudesa.Solnechnoj.Sistemy.(2.serija.iz.5).2010"). A
  // franchise mislabeled "Рэмбо.1982.(1.из.4)" is the rare cost.
  const iz = izEpisode(filenameNoExt);
  if (iz !== undefined) return { seasonNumber: folderSeason ?? 1, episodeNumber: iz };

  // "Episode N" keyword without any other marker — year-less names only.
  const epWord = EPISODE_WORD_RE.exec(filenameNoExt);
  if (epWord && !YEAR_RE.test(filenameNoExt) && !BARE_YEAR_RE.test(filenameNoExt)) {
    return { seasonNumber: folderSeason ?? 1, episodeNumber: parseInt(epWord[1]!, 10) };
  }

  return null;
}

/** Count of letters/digits — used to detect a mangled (degenerate) title. */
function alnumLen(s: string): number {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/**
 * Recover a title from the raw filename when the library mangles it: the text
 * before the first 4-digit year or bracket group. `@ctrl/video-filename-parser`
 * collapses a multi-word Cyrillic title (e.g. "Мажор в сочи (2022)") to its
 * first letter, so we fall back to this when its output is degenerate.
 */
function titleBeforeYear(nameNoExt: string): string {
  const s = nameNoExt.replace(/[._]+/g, " ");
  const yearIdx = s.search(/(?:^|[\s([{])\d{4}(?:\D|$)/);
  const brIdx = s.search(/[([{]/);
  let cut = s.length;
  if (yearIdx >= 0) cut = Math.min(cut, yearIdx);
  if (brIdx >= 0) cut = Math.min(cut, brIdx);
  return s.slice(0, cut).replace(/[\s([{\-–—:,]+$/u, "").trim();
}

/** BDMV/AVCHD disc structures — stream fragments, not library items. */
const DISC_STRUCTURE_RE = /[/\\](?:BDMV|CERTIFICATE|VIDEO_TS|AVCHD)[/\\]/i;

/**
 * Ancestor folder names nearest-first, bounded by the source root when known.
 * With a root the list covers every level below it plus a "" sentinel (the
 * walk may legitimately consume ALL of them — a flat pack directly under the
 * root has no show folder); without one, the legacy three levels.
 */
function ancestorChain(fullPath: string, root: string | undefined): string[] {
  if (root) {
    const normalizedRoot = root.replace(/[/\\]+$/, "");
    if (fullPath.startsWith(normalizedRoot + sep)) {
      const segments = fullPath
        .slice(normalizedRoot.length + 1)
        .split(sep)
        .slice(0, -1) // drop the filename
        .map((s) => s.normalize("NFC"))
        .reverse();
      return [...segments, ""];
    }
  }
  return [
    basename(dirname(fullPath)).normalize("NFC"),
    basename(dirname(dirname(fullPath))).normalize("NFC"),
    basename(dirname(dirname(dirname(fullPath)))).normalize("NFC"),
  ];
}

export function parseMediaPath(fullPath: string, ctx?: ScanContext): ParsedMediaPath {
  // Compose to NFC first: macOS filesystems hand out decomposed names (й as
  // и + combining breve), which breaks TMDB search and dedup keys downstream.
  const filename = basename(fullPath).normalize("NFC");

  // Strip extension from filename for the library parser
  const filenameNoExt = filename.replace(/\.[^.]+$/, "");

  if (DISC_STRUCTURE_RE.test(fullPath)) {
    return { title: filenameNoExt, skip: true };
  }

  const ancestors = ancestorChain(fullPath, ctx?.root);
  const folder = ancestors[0] ?? "";
  const grandparent = ancestors[1] ?? "";

  // Extras/bonus folders are never library items — but ONLY inside an item
  // folder. A root-level collection named "Shorts"/"Trailers" (grandparent is
  // a generic library root — or the source root itself) is real content and
  // must ingest normally.
  const insideItemFolder = ctx?.root
    ? !!grandparent
    : !!grandparent && !GENERIC_ROOT_RE.test(grandparent) && grandparent !== "/";
  if (isExtrasFolder(folder) && insideItemFolder) {
    return { title: filenameNoExt, skip: true };
  }

  // A "Specials" dir is a season-0 marker only in the same item-folder
  // context — a movie library's own "/Specials/" collection (standup specials
  // are movies) must stay in the movie branch.
  let episode =
    detectEpisode(filenameNoExt, folder) ??
    (insideItemFolder || !SPECIALS_FOLDER_RE.test(folder) ? detectSpecial(filenameNoExt, folder) : null);

  // Sibling context: a marker-less file inside a detected ordinal run IS an
  // episode — the folder's numbering scheme vouches for it (Plex/Jellyfin
  // read "Show/001 - Title.mkv" the same way).
  const dirInfo = ctx?.dirs?.get(dirname(fullPath));
  if (!episode && dirInfo?.run) {
    const entry = dirInfo.run.get(filename);
    if (entry) {
      episode = {
        seasonNumber: folderSeasonNumber(folder) ?? dirInfo.seasonHint ?? 1,
        episodeNumber: entry.episodeNumber,
      };
    }
  }

  // Marker-less extras files in a series context: inside a season pack
  // ("Family.Guy.Deleted.Scenes…") or carrying a season token themselves
  // ("Sestry.S01.Film.o.filme…" in an unmarked pack).
  if (
    !episode &&
    EXTRAS_FILE_RE.test(filenameNoExt) &&
    (folderSeasonNumber(folder) != null || folderSeasonNumber(filenameNoExt) != null)
  ) {
    return { title: filenameNoExt, skip: true };
  }

  // ── TV episode ────────────────────────────────────────────────────────────
  if (episode) {
    // Walk up past season-pack / Specials folders to the show folder — real
    // layouts nest up to Show/Pack/Specials/file. A folder is a season pack
    // when it carries a season marker anywhere ("Friends S04 BDRemux", "Сезон
    // 4 (Season 4) 2001-2002") — or, once the filename itself supplied the
    // season, when it merely mentions that season as a standalone number
    // ("Greys Anatomy 8 FOX Life 720p" + 08-06).
    const standaloneSeason = new RegExp(`(?:^|[\\s._-])0?${episode.seasonNumber}(?:[\\s._-]|$)`);
    // The loose standalone-number reading only applies to the file's own
    // folder — a deeper ancestor ("…5.sezonov.iz.5…" for a season-5 file) may
    // legitimately contain the digit and must only skip on explicit markers.
    // A folder carrying a full episode marker is a per-episode folder
    // ("Doctor.Who.2005.S09E13…") — never the show.
    const isPackName = (name: string, immediate: boolean): boolean =>
      folderSeasonNumber(name) != null ||
      SPECIALS_FOLDER_RE.test(name) ||
      SE_RE.test(name) ||
      X_RE.test(name) ||
      (immediate && episode.seasonNumber > 0 && standaloneSeason.test(name));
    let idx = 0;
    let packFolder = "";
    while (idx < ancestors.length - 1 && ancestors[idx] && isPackName(ancestors[idx]!, idx === 0)) {
      // Keep the first pack level that carries actual title text — a bare
      // "S01" dir must not shadow its named parent ("Le ranch S01-02/S01").
      const level = ancestors[idx]!;
      if (!SPECIALS_FOLDER_RE.test(level) && (!packFolder || !titleBeforeSeasonMarker(packFolder))) {
        packFolder = level;
      }
      idx++;
    }
    let showFolder = ancestors[idx] ?? "";
    // A pack directly under the library root has no usable parent — fall back
    // to the episode-filename title below instead of "Series"/"TV".
    if (idx > 0 && GENERIC_ROOT_RE.test(showFolder)) showFolder = "";
    // A leading whitespace-free "[Group]" release tag before a letter-led title
    // is never part of a show folder's name.
    showFolder = showFolder.replace(/^\[[^\]\s]*\][\s._-]*(?=\p{L})/u, "");

    let folderTitle = showFolder ? filenameParse(showFolder, false).title?.trim() || "" : "";
    // Same library mangling as the movie branch: a multi-word Cyrillic show
    // folder with a year collapses to its first letter — recover from the raw name.
    if (showFolder && alnumLen(folderTitle) <= 2) {
      const recovered = titleBeforeSeasonMarker(showFolder) || titleBeforeYear(showFolder);
      if (recovered && alnumLen(recovered) >= alnumLen(folderTitle)) folderTitle = recovered;
    }
    const tvTitle = filenameParse(filenameNoExt, true).title?.trim() || "";
    const prefix = episodePrefixTitle(filenameNoExt);
    const prefixTitle = prefix ? cleanSeriesTitle(prefix.title) : "";
    // Pack-folder text before its season marker — a title candidate when the
    // pack is named and the show folder is absent/umbrella ("Не сработало.S01…").
    const packTitle = packFolder ? cleanSeriesTitle(titleBeforeSeasonMarker(packFolder)) : "";

    // Title precedence: the show folder is the stable name across all episodes
    // of the series — EXCEPT when the episode files carry a strictly longer
    // name ("Dune/Dune.Prophecy.S01E01…"): then the folder is a franchise
    // umbrella and the file prefix is the real series. Folders are never
    // preferred the other way around (a lazy file prefix must not shorten).
    const cleanTail = (s: string): string =>
      s
        .replace(/[\s._-]+\d{4}$/, "")
        .replace(/\s*\([^)]*\)\s*$/, "")
        .trim() || s;
    const folderCleaned = cleanTail(cleanSeriesTitle(folderTitle));
    let seriesTitle: string;
    if (folderCleaned && prefixTitle && tokenExtends(prefixTitle, folderCleaned)) {
      seriesTitle = prefixTitle;
    } else {
      seriesTitle = folderCleaned || episode.seriesTitleHint || prefixTitle || packTitle || tvTitle || showFolder || folder;
    }
    seriesTitle = cleanTail(cleanSeriesTitle(seriesTitle));
    // Space out dots/underscores between word tokens ("Rick.And.Morty",
    // "Masha_i_Medved") while preserving initialisms (S.W.A.T).
    seriesTitle = spaceSeparators(seriesTitle);

    // Every materially different faithful name is a matcher variant.
    const variants: string[] = [];
    const addVariant = (v: string | undefined): void => {
      if (!v) return;
      const key = normTitleKey(v);
      if (!key || key === normTitleKey(seriesTitle)) return;
      if (variants.some((x) => normTitleKey(x) === key)) return;
      if (variants.length < 3) variants.push(v);
    };
    addVariant(folderCleaned);
    addVariant(prefixTitle);
    addVariant(packTitle ? cleanTail(packTitle) : "");

    // A show-folder year is premiere-grade. A SEASON PACK's year is only the
    // premiere for season 1 — later packs carry that season's AIR year
    // ("Сезон 5 2002-2003" of a 1998 show), which would poison exact-year
    // gates; such packs stay year-less and converge onto their season-1
    // sibling via title grouping. Specials (S0) never date the series.
    const packYearTrusted = episode.seasonNumber === 1;
    const year =
      extractYear(showFolder) ??
      (packYearTrusted ? extractYear(packFolder || folder) : undefined) ??
      (packYearTrusted ? extractBareYear(packFolder || folder) : undefined) ??
      extractBareYear(showFolder) ??
      (packYearTrusted ? prefix?.year : undefined);
    const tmdbId = extractTmdbId(showFolder) ?? extractTmdbId(filename);
    const imdbId = extractImdbId(showFolder) ?? extractImdbId(filename);

    const result: ParsedMediaPath = {
      title: seriesTitle,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
    };
    if (year !== undefined && !Number.isNaN(year)) result.year = year;
    if (tmdbId !== undefined) result.tmdbId = tmdbId;
    if (imdbId !== undefined) result.imdbId = imdbId;
    if (variants.length) result.titleVariants = variants;
    if (episode.episodeTitleHint) result.episodeTitleHint = episode.episodeTitleHint;
    if (episode.episodeYear !== undefined) result.episodeYear = episode.episodeYear;
    return result;
  }

  // ── Movie ───────────────────────────────────────────────────────────────
  // In a numbered collection ("1.Vinni-Pukh.1969…" next to "2.Karlson…1970"),
  // the leading ordinal is a list index, not part of the title.
  const movieName = dirInfo?.listIndex?.has(filename) ? filenameNoExt.replace(/^\d{1,3}[.)\s_-]+/, "") : filenameNoExt;

  // Use the library to parse the filename
  const parsed = filenameParse(movieName, false);
  let filenameTitle = parsed.title?.trim() || "";
  const filenameYear = parsed.year != null ? parseInt(String(parsed.year), 10) : undefined;

  // The library mangles some titles (notably multi-word Cyrillic + year) down to
  // a single letter. When its output is degenerate, recover from the raw name.
  if (alnumLen(filenameTitle) <= 2) {
    const recovered = titleBeforeYear(movieName);
    if (recovered && alnumLen(recovered) >= alnumLen(filenameTitle)) filenameTitle = recovered;
  }

  // Also try parsing the folder name as fallback for title
  const folderParsed = filenameParse(folder, false);
  const folderTitle = folderParsed.title?.trim() || "";

  // Regex pass: extract year from folder and filename strings
  const folderYear = extractYear(folder);
  const filenameYearParens = extractYear(filename);

  // Determine the final year: folder year wins over filename year
  const yearFromFilename = filenameYearParens ?? (Number.isNaN(filenameYear as number) ? undefined : filenameYear);
  const year = folderYear ?? yearFromFilename;

  // Extract embedded provider IDs (folder takes priority, then filename)
  const tmdbId = extractTmdbId(folder) ?? extractTmdbId(filename);
  const imdbId = extractImdbId(folder) ?? extractImdbId(filename);

  // Title: prefer filename parser result, fallback to folder parser result.
  // NOTE: deliberately NO "prefer the folder title when it looks like a movie
  // folder" heuristic — in a collection folder ("Властелин колец (2001)/1
  // Братство кольца.mkv") it would give every disc the folder's title and the
  // tmdbId dedupe would collapse a trilogy into one movie.
  let title = spaceSeparators(filenameTitle || folderTitle);

  // A duplicated in-title year ("Лука.2021.2021") leaves one copy inside the
  // parsed title — strip the echo. Only when the year token appears at least
  // twice: a single occurrence may BE the title ("Wonder Woman 1984").
  if (year != null && title.endsWith(String(year))) {
    const occurrences = movieName.split(String(year)).length - 1;
    const stripped = title.replace(new RegExp(`[\\s._-]+${year}$`), "").trim();
    if (occurrences >= 2 && stripped) title = stripped;
  }

  const result: ParsedMediaPath = { title };
  if (year !== undefined && !Number.isNaN(year)) result.year = year;
  if (tmdbId !== undefined) result.tmdbId = tmdbId;
  if (imdbId !== undefined) result.imdbId = imdbId;

  return result;
}
