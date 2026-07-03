import { basename, dirname } from "node:path";
import { filenameParse } from "@ctrl/video-filename-parser";

export interface ParsedMediaPath {
  title: string;
  year?: number;
  tmdbId?: number;
  imdbId?: string;
  /** Present (with episodeNumber) when the file is a TV episode. */
  seasonNumber?: number;
  episodeNumber?: number;
}

const YEAR_RE = /\((\d{4})\)/;
const TMDB_BRACKET_RE = /\[tmdbid-(\d+)\]/i;
const TMDB_BRACE_RE = /\{tmdb-(\d+)\}/i;
const IMDB_RE = /\[imdbid-(tt\d+)\]/i;

// TV episode patterns.
const SE_RE = /[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/; //  S01E02 / s1.e2
const X_RE = /\b(\d{1,2})x(\d{1,3})\b/; //               1x02
// "Season 01" / "S1" (word-first, group 1) or "02 сезон" / "2 season" (number-first,
// group 2). Also accepts the Cyrillic "сезон" keyword in either order.
const SEASON_FOLDER_RE =
  /^(?:(?:season|series|s|сезон)[\s._-]*(\d{1,2})|(\d{1,2})[\s._-]*(?:season|series|сезон))$/i;
const SPECIALS_FOLDER_RE = /^(?:specials|спецвыпуски)$/i;

/** Season number from a SEASON_FOLDER_RE match (word-first or number-first). */
function seasonFromFolderMatch(m: RegExpExecArray): number {
  return parseInt(m[1] ?? m[2], 10);
}

function extractYear(s: string): number | undefined {
  const m = YEAR_RE.exec(s);
  return m ? parseInt(m[1], 10) : undefined;
}

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
    /^(\d{1,3})[.)\s_-]/.exec(s) ?? //                         leading "100. Title"
    /-[\s._]*(\d{1,3})(?:[\s._)\]-]|$)/.exec(s);
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

interface EpisodeMarker {
  seasonNumber: number;
  episodeNumber: number;
}

/** Detect TV season/episode from the filename and its folder, or null for movies. */
function detectEpisode(filenameNoExt: string, folder: string): EpisodeMarker | null {
  const se = SE_RE.exec(filenameNoExt);
  if (se) return { seasonNumber: parseInt(se[1], 10), episodeNumber: parseInt(se[2], 10) };

  const x = X_RE.exec(filenameNoExt);
  if (x) return { seasonNumber: parseInt(x[1], 10), episodeNumber: parseInt(x[2], 10) };

  const seasonFolder = SEASON_FOLDER_RE.exec(folder);
  if (seasonFolder) {
    const ep = extractEpisodeNum(filenameNoExt);
    if (ep !== undefined) return { seasonNumber: seasonFromFolderMatch(seasonFolder), episodeNumber: ep };
  }

  if (SPECIALS_FOLDER_RE.test(folder)) {
    const ep = extractEpisodeNum(filenameNoExt);
    if (ep !== undefined) return { seasonNumber: 0, episodeNumber: ep };
  }

  // Bare mini-series with no season folder: "Title. Серия 3" → season 1, ep 3.
  // Lowest precedence, so an explicit SxxExx / season folder always wins.
  const seriya = seriyaEpisode(filenameNoExt);
  if (seriya !== undefined) return { seasonNumber: 1, episodeNumber: seriya };

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

export function parseMediaPath(fullPath: string): ParsedMediaPath {
  const filename = basename(fullPath);
  const folder = basename(dirname(fullPath));

  // Strip extension from filename for the library parser
  const filenameNoExt = filename.replace(/\.[^.]+$/, "");

  const episode = detectEpisode(filenameNoExt, folder);

  // ── TV episode ────────────────────────────────────────────────────────────
  if (episode) {
    // The "show folder" is the series root: skip a Season NN / Specials folder.
    const isSeasonFolder = SEASON_FOLDER_RE.test(folder) || SPECIALS_FOLDER_RE.test(folder);
    const showFolder = isSeasonFolder ? basename(dirname(dirname(fullPath))) : folder;

    const folderTitle = filenameParse(showFolder, false).title?.trim() || "";
    const tvTitle = filenameParse(filenameNoExt, true).title?.trim() || "";
    // Prefer the show-folder title (stable across all episodes of the series).
    const rawSeriesTitle = folderTitle || tvTitle || showFolder;
    // Show folders often carry a release year/range ("Show Name 2010-2019 WEBRip")
    // that the filename parser leaves as a trailing year — drop it so the series
    // matches cleanly. Only a *trailing* year, so titles like "2012" are kept.
    const seriesTitle = rawSeriesTitle.replace(/[\s._-]+\d{4}$/, "").trim() || rawSeriesTitle;

    const year = extractYear(showFolder) ?? extractYear(folder);
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
    return result;
  }

  // ── Movie ───────────────────────────────────────────────────────────────
  // Use the library to parse the filename
  const parsed = filenameParse(filenameNoExt, false);
  let filenameTitle = parsed.title?.trim() || "";
  const filenameYear = parsed.year != null ? parseInt(String(parsed.year), 10) : undefined;

  // The library mangles some titles (notably multi-word Cyrillic + year) down to
  // a single letter. When its output is degenerate, recover from the raw name.
  if (alnumLen(filenameTitle) <= 2) {
    const recovered = titleBeforeYear(filenameNoExt);
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

  // Title: prefer filename parser result, fallback to folder parser result
  const title = filenameTitle || folderTitle;

  const result: ParsedMediaPath = { title };
  if (year !== undefined && !Number.isNaN(year)) result.year = year;
  if (tmdbId !== undefined) result.tmdbId = tmdbId;
  if (imdbId !== undefined) result.imdbId = imdbId;

  return result;
}
