// OMDb ratings adapter. Pure parser (`parseOmdbRatings`) + a thin fetch wrapper
// (`fetchOmdbRatings`) that takes an injected fetch so it stays testable and the
// core package never reaches for the real network on its own.

export interface ExternalRatings {
  imdbRating?: number;
  imdbVotes?: number;
  rtRating?: number;
  metacritic?: number;
}

export interface RawOmdb {
  Response?: string;
  imdbRating?: string;
  imdbVotes?: string;
  Metascore?: string;
  Ratings?: { Source: string; Value: string }[];
}

function num(value: string | undefined): number | undefined {
  if (!value || value === "N/A") return undefined;
  const n = Number.parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalise an OMDb response into the ratings we display. Reads imdbRating /
 * imdbVotes / Metascore directly and pulls the Rotten Tomatoes percentage from
 * the Ratings array. Returns only the fields that were present and valid.
 */
export function parseOmdbRatings(raw: RawOmdb): ExternalRatings {
  if (raw.Response === "False") return {};
  const out: ExternalRatings = {};

  const imdb = num(raw.imdbRating);
  if (imdb !== undefined) out.imdbRating = imdb;

  const votes = num(raw.imdbVotes);
  if (votes !== undefined) out.imdbVotes = Math.round(votes);

  const meta = num(raw.Metascore);
  if (meta !== undefined) out.metacritic = Math.round(meta);

  const rt = raw.Ratings?.find((r) => r.Source === "Rotten Tomatoes");
  const rtNum = num(rt?.Value?.replace("%", ""));
  if (rtNum !== undefined) out.rtRating = Math.round(rtNum);

  return out;
}

/**
 * Fetch + parse OMDb ratings for an IMDb id. Returns undefined when the request
 * fails or OMDb reports no data, so enrichment degrades gracefully.
 */
export async function fetchOmdbRatings(
  imdbId: string,
  deps: { fetchImpl: typeof fetch; apiKey: string },
): Promise<ExternalRatings | undefined> {
  if (!deps.apiKey || !imdbId) return undefined;
  const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(deps.apiKey)}&i=${encodeURIComponent(imdbId)}&tomatoes=true`;
  const res = await deps.fetchImpl(url);
  if (!res.ok) return undefined;
  const raw = (await res.json()) as RawOmdb;
  if (raw.Response === "False") return undefined;
  const parsed = parseOmdbRatings(raw);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}
