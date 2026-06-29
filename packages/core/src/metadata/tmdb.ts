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

export interface TmdbGenreRef {
  tmdbId: number;
  name: string;
}

export interface TmdbMovie {
  tmdbId: number;
  title: string;
  year?: number;
  overview?: string;
  runtimeSec?: number;
  posterPath?: string;
  backdropPath?: string;
  imdbId?: string;
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
}

interface RawMovie {
  id: number;
  title: string;
  release_date?: string;
  overview?: string;
  runtime?: number | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  imdb_id?: string | null;
  genres?: { id: number; name: string }[];
}

interface RawCredits {
  cast: { id: number; name: string; character?: string; order: number }[];
  crew: { id: number; name: string; job: string; department: string }[];
}

interface RawKeywords {
  keywords: { id: number; name: string }[];
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

  async movie(id: number): Promise<TmdbMovie> {
    const raw = await this.get<RawMovie>(`${BASE}/movie/${id}`);

    return {
      tmdbId: raw.id,
      title: raw.title,
      ...(raw.release_date
        ? { year: Number(raw.release_date.slice(0, 4)) }
        : {}),
      ...(raw.overview != null ? { overview: raw.overview } : {}),
      ...(raw.runtime != null ? { runtimeSec: raw.runtime * 60 } : {}),
      ...(raw.poster_path != null ? { posterPath: raw.poster_path } : {}),
      ...(raw.backdrop_path != null ? { backdropPath: raw.backdrop_path } : {}),
      ...(raw.imdb_id != null ? { imdbId: raw.imdb_id } : {}),
      genres: (raw.genres ?? []).map((g) => ({ tmdbId: g.id, name: g.name })),
    };
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
}
