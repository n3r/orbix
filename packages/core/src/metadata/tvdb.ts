const BASE = "https://api4.thetvdb.com/v4";
const ARTWORKS_BASE = "https://artworks.thetvdb.com";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class TvdbError extends Error {
  constructor(status: number) {
    super(`TVDB request failed with status ${status}`);
    this.name = "TvdbError";
  }
}

// ---------------------------------------------------------------------------
// Normalised shapes
// ---------------------------------------------------------------------------

export interface TvdbSearchResult {
  tvdbId: number;
  title: string;
  year?: number;
}

export interface TvdbSeasonRef {
  seasonNumber: number;
  posterUrl?: string;
  tvdbSeasonId?: number;
}

export interface TvdbSeries {
  tvdbId: number;
  title: string;
  year?: number;
  overview?: string;
  status?: string;
  posterUrl?: string;
  backdropUrl?: string;
  logoUrl?: string;
  imdbId?: string;
  tmdbId?: number;
  contentRating?: string;
  genres: { name: string }[];
  seasons: TvdbSeasonRef[];
}

export interface TvdbEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  overview?: string;
  stillUrl?: string;
  runtimeSec?: number;
  airDate?: string;
  tvdbEpisodeId: number;
}

// ---------------------------------------------------------------------------
// Raw shapes (only what we read)
// ---------------------------------------------------------------------------

interface RawLogin {
  data?: { token?: string };
}
interface RawSearchItem {
  tvdb_id?: string;
  name?: string;
  year?: string;
}
interface RawArtwork {
  image?: string;
  type?: number;
  language?: string | null;
  score?: number;
}
interface RawRemoteId {
  id?: string;
  sourceName?: string;
}
interface RawSeason {
  id?: number;
  number?: number;
  image?: string | null;
  type?: { type?: string };
}
interface RawSeriesExtended {
  id: number;
  name?: string;
  image?: string | null;
  overview?: string;
  year?: string;
  status?: { name?: string } | null;
  genres?: { name?: string }[];
  remoteIds?: RawRemoteId[];
  seasons?: RawSeason[];
  artworks?: RawArtwork[];
  contentRatings?: { name?: string; country?: string }[];
}
interface RawEpisode {
  id: number;
  seasonNumber?: number;
  number?: number;
  name?: string | null;
  overview?: string | null;
  image?: string | null;
  runtime?: number | null;
  aired?: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Normalise a TVDB image field to an absolute URL (v4 usually already is). */
export function absUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  if (u.startsWith("http")) return u;
  return `${ARTWORKS_BASE}${u.startsWith("/") ? "" : "/"}${u}`;
}

// Series artwork type ids (from /artwork/types). A wrong id simply yields no
// match and callers fall back to the TMDB logo, so this is safe to hardcode.
const ARTWORK_BACKDROP = 3;
const ARTWORK_CLEARLOGO = 23;

/**
 * Best artwork image URL of a given type: exact language match (by score desc)
 * → language-neutral (by score) → any of the type (by score). Pure.
 */
export function pickArtwork(
  artworks: { image?: string; type?: number; language?: string | null; score?: number }[],
  type: number,
  lang?: string,
): string | undefined {
  const pool = artworks.filter((a) => a.type === type && a.image);
  if (pool.length === 0) return undefined;
  const byScore = (a: { score?: number }, b: { score?: number }) => (b.score ?? 0) - (a.score ?? 0);
  if (lang) {
    const inLang = pool.filter((a) => a.language === lang).sort(byScore);
    if (inLang[0]?.image) return inLang[0].image;
  }
  const neutral = pool.filter((a) => a.language == null).sort(byScore);
  if (neutral[0]?.image) return neutral[0].image;
  return [...pool].sort(byScore)[0]?.image;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TvdbClient {
  private readonly apiKey: string;
  private readonly pin?: string;
  private readonly fetchImpl: typeof fetch;
  /** 3-letter ISO 639-2 language for localized endpoints; undefined = English. */
  readonly language?: string;
  private token?: string;

  constructor(apiKey: string, fetchImpl?: typeof fetch, pin?: string, language?: string) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.pin = pin;
    this.language = language;
  }

  private async login(): Promise<string> {
    const res = await this.fetchImpl(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(this.pin ? { apikey: this.apiKey, pin: this.pin } : { apikey: this.apiKey }),
    });
    if (!res.ok) throw new TvdbError(res.status);
    const raw = (await res.json()) as RawLogin;
    const token = raw.data?.token;
    if (!token) throw new TvdbError(res.status);
    this.token = token;
    return token;
  }

  /** GET a path (already including BASE) with the Bearer token; one re-login on 401. */
  private async get<T>(path: string): Promise<T> {
    if (!this.token) await this.login();
    let res = await this.fetchImpl(path, {
      headers: { Authorization: `Bearer ${this.token}`, accept: "application/json" },
    });
    if (res.status === 401) {
      await this.login();
      res = await this.fetchImpl(path, {
        headers: { Authorization: `Bearer ${this.token}`, accept: "application/json" },
      });
    }
    if (!res.ok) throw new TvdbError(res.status);
    return res.json() as Promise<T>;
  }

  async searchSeries(title: string, year?: number): Promise<TvdbSearchResult | null> {
    const url = `${BASE}/search?query=${encodeURIComponent(title)}&type=series`;
    const data = await this.get<{ data?: RawSearchItem[] }>(url);
    const items = data.data ?? [];
    // Prefer an exact-year match when a year is known; else the first result.
    const pick =
      (year != null && items.find((i) => Number(i.year) === year)) || items[0];
    if (!pick || pick.tvdb_id == null) return null;
    return {
      tvdbId: Number(pick.tvdb_id),
      title: pick.name ?? title,
      ...(pick.year ? { year: Number(pick.year) } : {}),
    };
  }

  async series(id: number): Promise<TvdbSeries> {
    const raw = (await this.get<{ data: RawSeriesExtended }>(`${BASE}/series/${id}/extended`)).data;

    const remote = raw.remoteIds ?? [];
    const imdb = remote.find((r) => /imdb/i.test(r.sourceName ?? "") || /^tt\d+$/.test(r.id ?? ""));
    const tmdb = remote.find((r) => /moviedb|tmdb/i.test(r.sourceName ?? ""));
    const artworks = raw.artworks ?? [];
    const us = (raw.contentRatings ?? []).find((c) => (c.country ?? "").toLowerCase() === "usa");

    // Official (aired) seasons only, de-duped by number, first-wins.
    const seasons: TvdbSeasonRef[] = [];
    const seen = new Set<number>();
    for (const s of raw.seasons ?? []) {
      if (s.type?.type !== "official" || s.number == null || seen.has(s.number)) continue;
      seen.add(s.number);
      seasons.push({
        seasonNumber: s.number,
        ...(absUrl(s.image) ? { posterUrl: absUrl(s.image) } : {}),
        ...(s.id != null ? { tvdbSeasonId: s.id } : {}),
      });
    }
    seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);

    return {
      tvdbId: raw.id,
      title: raw.name ?? "",
      ...(raw.year ? { year: Number(raw.year) } : {}),
      ...(raw.overview != null ? { overview: raw.overview } : {}),
      ...(raw.status?.name ? { status: raw.status.name } : {}),
      ...(absUrl(raw.image) ? { posterUrl: absUrl(raw.image) } : {}),
      ...(pickArtwork(artworks, ARTWORK_BACKDROP) ? { backdropUrl: pickArtwork(artworks, ARTWORK_BACKDROP) } : {}),
      ...(pickArtwork(artworks, ARTWORK_CLEARLOGO, "eng") ? { logoUrl: pickArtwork(artworks, ARTWORK_CLEARLOGO, "eng") } : {}),
      ...(imdb?.id ? { imdbId: imdb.id } : {}),
      ...(tmdb?.id && Number.isFinite(Number(tmdb.id)) ? { tmdbId: Number(tmdb.id) } : {}),
      ...(us?.name ? { contentRating: us.name } : {}),
      genres: (raw.genres ?? []).filter((g) => g.name).map((g) => ({ name: g.name as string })),
      seasons,
    };
  }

  private mapEpisode(e: RawEpisode): TvdbEpisode {
    return {
      seasonNumber: e.seasonNumber ?? 0,
      episodeNumber: e.number ?? 0,
      ...(e.name ? { title: e.name } : {}),
      ...(e.overview ? { overview: e.overview } : {}),
      ...(absUrl(e.image) ? { stillUrl: absUrl(e.image) } : {}),
      ...(e.runtime != null ? { runtimeSec: e.runtime * 60 } : {}),
      ...(e.aired ? { airDate: e.aired } : {}),
      tvdbEpisodeId: e.id,
    };
  }

  /** All episodes in aired (default) order, following pagination. */
  async seasonEpisodes(id: number): Promise<TvdbEpisode[]> {
    const lang = this.language ? `/${this.language}` : "";
    const out: TvdbEpisode[] = [];
    let page = 0;
    // Bounded to avoid a runaway loop on a misbehaving API.
    for (let guard = 0; guard < 100; guard++) {
      const raw = await this.get<{ data?: { episodes?: RawEpisode[] }; links?: { next?: string | null } }>(
        `${BASE}/series/${id}/episodes/default${lang}?page=${page}`,
      );
      for (const e of raw.data?.episodes ?? []) out.push(this.mapEpisode(e));
      if (!raw.links?.next) break;
      page++;
    }
    return out;
  }
}
