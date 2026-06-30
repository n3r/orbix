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
const SEASON_FOLDER_RE = /^(?:season|series|s)[\s._-]*(\d{1,2})$/i; // "Season 01"
const SPECIALS_FOLDER_RE = /^specials$/i;

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

/** Episode number from an E-tag, "Episode N", or an anime-style trailing "- NN". */
function extractEpisodeNum(s: string): number | undefined {
  const m =
    /[eE](\d{1,3})/.exec(s) ??
    /\bep(?:isode)?[\s._-]*(\d{1,3})/i.exec(s) ??
    /-[\s._]*(\d{1,3})(?:[\s._)\]-]|$)/.exec(s);
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
    if (ep !== undefined) return { seasonNumber: parseInt(seasonFolder[1], 10), episodeNumber: ep };
  }

  if (SPECIALS_FOLDER_RE.test(folder)) {
    const ep = extractEpisodeNum(filenameNoExt);
    if (ep !== undefined) return { seasonNumber: 0, episodeNumber: ep };
  }

  return null;
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
    const seriesTitle = folderTitle || tvTitle || showFolder;

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
  const filenameTitle = parsed.title?.trim() || "";
  const filenameYear = parsed.year != null ? parseInt(String(parsed.year), 10) : undefined;

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
