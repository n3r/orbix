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

export interface TmdbSeasonRef {
  seasonNumber: number;
  episodeCount: number;
  name?: string;
  overview?: string;
  posterPath?: string;
  airYear?: number;
  tmdbSeasonId?: number;
}

export interface TmdbTv {
  tmdbId: number;
  title: string;
  year?: number;
  overview?: string;
  tagline?: string;
  posterPath?: string;
  backdropPath?: string;
  imdbId?: string;
  tmdbScore?: number;
  status?: string;
  genres: TmdbGenreRef[];
  seasons: TmdbSeasonRef[];
}

export interface TmdbEpisode {
  episodeNumber: number;
  title?: string;
  overview?: string;
  stillPath?: string;
  runtimeSec?: number;
  airDate?: string;
  tmdbEpisodeId?: number;
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

interface RawTvSearchResult {
  id: number;
  name: string;
  first_air_date?: string;
}

interface RawTv {
  id: number;
  name: string;
  first_air_date?: string;
  overview?: string;
  tagline?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number | null;
  status?: string | null;
  genres?: { id: number; name: string }[];
  seasons?: {
    season_number: number;
    episode_count: number;
    name?: string;
    overview?: string;
    poster_path?: string | null;
    air_date?: string | null;
    id?: number;
  }[];
  external_ids?: { imdb_id?: string | null };
}

interface RawTvSeason {
  episodes?: {
    episode_number: number;
    name?: string;
    overview?: string;
    still_path?: string | null;
    runtime?: number | null;
    air_date?: string | null;
    id?: number;
  }[];
}

interface RawContentRatings {
  results: { iso_3166_1: string; rating: string }[];
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
  private readonly language?: string;

  /**
   * @param language Optional TMDB language tag (e.g. "es-ES"). When set, it is
   *   appended as `&language=<tag>` to localized requests (movie, search,
   *   genreList). Omit for TMDB's default (English) responses.
   */
  constructor(token: string, fetchImpl?: typeof fetch, language?: string) {
    this.token = token;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.language = language;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
  }

  /** Append the configured language tag to a URL, if any. */
  private withLang(url: string): string {
    if (!this.language) return url;
    return url + (url.includes("?") ? "&" : "?") + `language=${this.language}`;
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

    const data = await this.get<{ results: RawSearchResult[] }>(this.withLang(url));
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

    const data = await this.get<{ results: RawSearchResult[] }>(this.withLang(url));
    return data.results.slice(0, 8).map((r) => ({
      tmdbId: r.id,
      title: r.title,
      ...(r.release_date ? { year: Number(r.release_date.slice(0, 4)) } : {}),
      ...(r.poster_path != null ? { posterPath: r.poster_path } : {}),
    }));
  }

  async movie(id: number): Promise<TmdbMovie> {
    const raw = await this.get<RawMovie>(this.withLang(`${BASE}/movie/${id}`));

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

  // ── TV ────────────────────────────────────────────────────────────────────

  async searchTv(title: string, year?: number): Promise<TmdbSearchResult | null> {
    let url = `${BASE}/search/tv?query=${encodeURIComponent(title)}`;
    if (year != null) url += `&first_air_date_year=${year}`;
    const data = await this.get<{ results: RawTvSearchResult[] }>(url);
    const first = data.results[0];
    if (!first) return null;
    return {
      tmdbId: first.id,
      title: first.name,
      ...(first.first_air_date ? { year: Number(first.first_air_date.slice(0, 4)) } : {}),
    };
  }

  async tv(id: number): Promise<TmdbTv> {
    const raw = await this.get<RawTv>(`${BASE}/tv/${id}?append_to_response=external_ids`);
    return {
      tmdbId: raw.id,
      title: raw.name,
      ...(raw.first_air_date ? { year: Number(raw.first_air_date.slice(0, 4)) } : {}),
      ...(raw.overview != null ? { overview: raw.overview } : {}),
      ...(raw.tagline ? { tagline: raw.tagline } : {}),
      ...(raw.poster_path != null ? { posterPath: raw.poster_path } : {}),
      ...(raw.backdrop_path != null ? { backdropPath: raw.backdrop_path } : {}),
      ...(raw.external_ids?.imdb_id ? { imdbId: raw.external_ids.imdb_id } : {}),
      ...(raw.vote_average != null && raw.vote_average > 0 ? { tmdbScore: raw.vote_average } : {}),
      ...(raw.status ? { status: raw.status } : {}),
      genres: (raw.genres ?? []).map((g) => ({ tmdbId: g.id, name: g.name })),
      seasons: (raw.seasons ?? []).map((s) => ({
        seasonNumber: s.season_number,
        episodeCount: s.episode_count,
        ...(s.name ? { name: s.name } : {}),
        ...(s.overview ? { overview: s.overview } : {}),
        ...(s.poster_path != null ? { posterPath: s.poster_path } : {}),
        ...(s.air_date ? { airYear: Number(s.air_date.slice(0, 4)) } : {}),
        ...(s.id != null ? { tmdbSeasonId: s.id } : {}),
      })),
    };
  }

  async tvSeason(id: number, seasonNumber: number): Promise<TmdbEpisode[]> {
    const raw = await this.get<RawTvSeason>(`${BASE}/tv/${id}/season/${seasonNumber}`);
    return (raw.episodes ?? []).map((e) => ({
      episodeNumber: e.episode_number,
      ...(e.name ? { title: e.name } : {}),
      ...(e.overview ? { overview: e.overview } : {}),
      ...(e.still_path != null ? { stillPath: e.still_path } : {}),
      ...(e.runtime != null ? { runtimeSec: e.runtime * 60 } : {}),
      ...(e.air_date ? { airDate: e.air_date } : {}),
      ...(e.id != null ? { tmdbEpisodeId: e.id } : {}),
    }));
  }

  async tvContentRating(id: number): Promise<string | undefined> {
    const raw = await this.get<RawContentRatings>(`${BASE}/tv/${id}/content_ratings`);
    const us = raw.results.find((r) => r.iso_3166_1 === "US");
    return us?.rating || undefined;
  }

  async tvLogoPath(id: number, lang = "en"): Promise<string | undefined> {
    const raw = await this.get<RawImages>(`${BASE}/tv/${id}/images`);
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

  /**
   * The localized genre list for the configured language. TMDB returns a fixed
   * set of genres per language; used to populate GenreTranslation rows.
   */
  async genreList(kind: "movie" | "tv"): Promise<TmdbGenreRef[]> {
    const raw = await this.get<{ genres: { id: number; name: string }[] }>(
      this.withLang(`${BASE}/genre/${kind}/list`),
    );
    return raw.genres.map((g) => ({ tmdbId: g.id, name: g.name }));
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
