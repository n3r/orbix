const BASE = "https://api.themoviedb.org/3";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class TmdbError extends Error {
  constructor(status: number) {
    super(`TMDB request failed with status ${status}`);
    this.name = "TmdbError";
  }
}

// ---------------------------------------------------------------------------
// Normalised shapes
// ---------------------------------------------------------------------------

export interface TmdbSearchResult {
  tmdbId: number;
  title: string;
  year?: number;
}

export interface TmdbSearchCandidate {
  tmdbId: number;
  title: string;
  year?: number;
  posterPath?: string;
}

export interface TmdbGenreRef {
  tmdbId: number;
  name: string;
}

export interface TmdbMovie {
  tmdbId: number;
  title: string;
  year?: number;
  overview?: string;
  tagline?: string;
  runtimeSec?: number;
  posterPath?: string;
  backdropPath?: string;
  imdbId?: string;
  tmdbScore?: number;
  genres: TmdbGenreRef[];
}

export interface TmdbCredits {
  cast: { tmdbId: number; name: string; character?: string; order: number }[];
  crew: { tmdbId: number; name: string; job: string; department: string }[];
}

export interface TmdbKeyword {
  tmdbId: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Raw TMDB shapes (only what we need)
// ---------------------------------------------------------------------------

interface RawSearchResult {
  id: number;
  title: string;
  release_date?: string;
  poster_path?: string | null;
}

interface RawMovie {
  id: number;
  title: string;
  release_date?: string;
  overview?: string;
  tagline?: string | null;
  runtime?: number | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  imdb_id?: string | null;
  vote_average?: number | null;
  genres?: { id: number; name: string }[];
}

interface RawImages {
  logos?: { file_path: string; iso_639_1: string | null; vote_average?: number }[];
}

interface RawCredits {
  cast: { id: number; name: string; character?: string; order: number }[];
  crew: { id: number; name: string; job: string; department: string }[];
}

interface RawKeywords {
  keywords: { id: number; name: string }[];
}

interface RawReleaseDates {
  results: {
    iso_3166_1: string;
    release_dates: { certification: string }[];
  }[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Choose the best logo file_path from a TMDB images.logos list. Preference:
 * exact language match (by vote desc) → language-neutral (iso null) → any.
 * Pure — unit-tested without the network.
 */
export function pickLogoPath(
  logos: { file_path: string; iso_639_1: string | null; vote_average?: number }[],
  lang = "en",
): string | undefined {
  if (logos.length === 0) return undefined;
  const byVote = (a: { vote_average?: number }, b: { vote_average?: number }) =>
    (b.vote_average ?? 0) - (a.vote_average ?? 0);
  const inLang = logos.filter((l) => l.iso_639_1 === lang).sort(byVote);
  if (inLang[0]) return inLang[0].file_path;
  const neutral = logos.filter((l) => l.iso_639_1 == null).sort(byVote);
  if (neutral[0]) return neutral[0].file_path;
  return [...logos].sort(byVote)[0]?.file_path;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TmdbClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string, fetchImpl?: typeof fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(path, { headers: this.headers() });
    if (!res.ok) {
      throw new TmdbError(res.status);
    }
    return res.json() as Promise<T>;
  }

  async searchMovie(title: string, year?: number): Promise<TmdbSearchResult | null> {
    let url = `${BASE}/search/movie?query=${encodeURIComponent(title)}`;
    if (year != null) url += `&year=${year}`;

    const data = await this.get<{ results: RawSearchResult[] }>(url);
    const first = data.results[0];
    if (!first) return null;

    return {
      tmdbId: first.id,
      title: first.title,
      ...(first.release_date
        ? { year: Number(first.release_date.slice(0, 4)) }
        : {}),
    };
  }

  /** Return the top 8 search results, each including a posterPath for thumbnail display. */
  async searchMovies(query: string, year?: number): Promise<TmdbSearchCandidate[]> {
    let url = `${BASE}/search/movie?query=${encodeURIComponent(query)}`;
    if (year != null) url += `&year=${year}`;

    const data = await this.get<{ results: RawSearchResult[] }>(url);
    return data.results.slice(0, 8).map((r) => ({
      tmdbId: r.id,
      title: r.title,
      ...(r.release_date ? { year: Number(r.release_date.slice(0, 4)) } : {}),
      ...(r.poster_path != null ? { posterPath: r.poster_path } : {}),
    }));
  }

  async movie(id: number): Promise<TmdbMovie> {
    const raw = await this.get<RawMovie>(`${BASE}/movie/${id}`);

    return {
      tmdbId: raw.id,
      title: raw.title,
      ...(raw.release_date
        ? { year: Number(raw.release_date.slice(0, 4)) }
        : {}),
      ...(raw.overview != null ? { overview: raw.overview } : {}),
      ...(raw.tagline ? { tagline: raw.tagline } : {}),
      ...(raw.runtime != null ? { runtimeSec: raw.runtime * 60 } : {}),
      ...(raw.poster_path != null ? { posterPath: raw.poster_path } : {}),
      ...(raw.backdrop_path != null ? { backdropPath: raw.backdrop_path } : {}),
      ...(raw.imdb_id != null ? { imdbId: raw.imdb_id } : {}),
      ...(raw.vote_average != null && raw.vote_average > 0
        ? { tmdbScore: raw.vote_average }
        : {}),
      genres: (raw.genres ?? []).map((g) => ({ tmdbId: g.id, name: g.name })),
    };
  }

  /**
   * Best title-treatment logo file_path for a movie, preferring the requested
   * language then language-neutral art, ordered by TMDB vote. Returns undefined
   * when the movie has no logo images. The caller caches it via image kind "logo".
   */
  async movieLogoPath(id: number, lang = "en"): Promise<string | undefined> {
    const raw = await this.get<RawImages>(`${BASE}/movie/${id}/images`);
    return pickLogoPath(raw.logos ?? [], lang);
  }

  async credits(id: number): Promise<TmdbCredits> {
    const raw = await this.get<RawCredits>(`${BASE}/movie/${id}/credits`);

    return {
      cast: raw.cast.map((c) => ({
        tmdbId: c.id,
        name: c.name,
        ...(c.character != null ? { character: c.character } : {}),
        order: c.order,
      })),
      crew: raw.crew.map((c) => ({
        tmdbId: c.id,
        name: c.name,
        job: c.job,
        department: c.department,
      })),
    };
  }

  async keywords(id: number): Promise<TmdbKeyword[]> {
    const raw = await this.get<RawKeywords>(`${BASE}/movie/${id}/keywords`);
    return raw.keywords.map((k) => ({ tmdbId: k.id, name: k.name }));
  }

  async releaseCertification(id: number): Promise<string | undefined> {
    const raw = await this.get<RawReleaseDates>(`${BASE}/movie/${id}/release_dates`);
    const usEntry = raw.results.find((r) => r.iso_3166_1 === "US");
    if (!usEntry) return undefined;
    for (const rd of usEntry.release_dates) {
      if (rd.certification) return rd.certification;
    }
    return undefined;
  }
}
