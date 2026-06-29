import { basename, dirname } from "node:path";
import { filenameParse } from "@ctrl/video-filename-parser";

export interface ParsedMediaPath {
  title: string;
  year?: number;
  tmdbId?: number;
  imdbId?: string;
}

const YEAR_RE = /\((\d{4})\)/;
const TMDB_BRACKET_RE = /\[tmdbid-(\d+)\]/i;
const TMDB_BRACE_RE = /\{tmdb-(\d+)\}/i;
const IMDB_RE = /\[imdbid-(tt\d+)\]/i;

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

export function parseMediaPath(fullPath: string): ParsedMediaPath {
  const filename = basename(fullPath);
  const folder = basename(dirname(fullPath));

  // Strip extension from filename for the library parser
  const filenameNoExt = filename.replace(/\.[^.]+$/, "");

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
