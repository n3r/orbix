import type { TmdbSearchResult, TmdbTv, TmdbEpisode } from "./tmdb";
import type { ImageKind } from "./images";
import type { ExternalRatings } from "./omdb";
import type { EnrichResult } from "./enrich";

// ---------------------------------------------------------------------------
// Structural interface — the real TmdbClient satisfies this.
// ---------------------------------------------------------------------------

export interface TmdbTvLike {
  searchTv(title: string, year?: number): Promise<TmdbSearchResult | null>;
  tv(id: number): Promise<TmdbTv>;
  tvSeason(id: number, seasonNumber: number): Promise<TmdbEpisode[]>;
  tvContentRating(id: number): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Persist shape
// ---------------------------------------------------------------------------

export interface SaveSeriesEpisode {
  episodeNumber: number;
  title?: string;
  overview?: string;
  stillPath?: string;
  runtimeSec?: number;
  airDate?: string;
  tmdbEpisodeId?: number;
}

export interface SaveSeriesSeason {
  seasonNumber: number;
  name?: string;
  overview?: string;
  posterPath?: string;
  airYear?: number;
  tmdbSeasonId?: number;
  episodes: SaveSeriesEpisode[];
}

export interface SaveSeriesInput {
  itemId: string;
  tmdbId: number;
  title: string;
  year?: number;
  overview?: string;
  tagline?: string;
  status?: string;
  posterPath?: string;
  backdropPath?: string;
  logoPath?: string;
  imdbId?: string;
  tmdbScore?: number;
  imdbRating?: number;
  imdbVotes?: number;
  rtRating?: number;
  metacritic?: number;
  rating?: string;
  genres: { tmdbId: number; name: string }[];
  seasons: SaveSeriesSeason[];
}

// ---------------------------------------------------------------------------
// enrichSeries
// ---------------------------------------------------------------------------

/**
 * Enrich a TV series from TMDB: details + US content rating + hero logo +
 * external ratings, then per-season episode lists (stills cached). Only the
 * seasons listed in `localSeasonNumbers` are fetched when provided, so a 20-season
 * show with two local seasons doesn't trigger 20 season requests.
 */
export async function enrichSeries(
  item: { id: string; title: string; year?: number; tmdbId?: number },
  deps: {
    client: TmdbTvLike;
    cacheImage: (tmdbPath: string, kind: ImageKind) => Promise<string>;
    saveSeries: (input: SaveSeriesInput) => Promise<void>;
    resolveLogo?: (input: { tmdbId: number; imdbId?: string }) => Promise<string | undefined>;
    fetchRatings?: (imdbId: string) => Promise<ExternalRatings | undefined>;
    localSeasonNumbers?: number[];
  },
): Promise<EnrichResult> {
  const tmdbId = item.tmdbId ?? (await deps.client.searchTv(item.title, item.year))?.tmdbId;
  if (!tmdbId) return { matched: false };

  const tv = await deps.client.tv(tmdbId);

  let rating: string | undefined;
  try {
    rating = await deps.client.tvContentRating(tmdbId);
  } catch {
    rating = undefined;
  }

  const posterPath = tv.posterPath ? await deps.cacheImage(tv.posterPath, "poster") : undefined;
  const backdropPath = tv.backdropPath ? await deps.cacheImage(tv.backdropPath, "backdrop") : undefined;

  let logoPath: string | undefined;
  if (deps.resolveLogo) {
    try {
      logoPath = await deps.resolveLogo({ tmdbId, imdbId: tv.imdbId });
    } catch {
      logoPath = undefined;
    }
  }

  let extraRatings: ExternalRatings | undefined;
  if (deps.fetchRatings && tv.imdbId) {
    try {
      extraRatings = await deps.fetchRatings(tv.imdbId);
    } catch {
      extraRatings = undefined;
    }
  }

  // Which seasons to fetch: those present locally (if known), else all real seasons.
  const local = deps.localSeasonNumbers ? new Set(deps.localSeasonNumbers) : null;
  const wantedSeasons = tv.seasons.filter((s) =>
    local ? local.has(s.seasonNumber) : s.episodeCount > 0,
  );

  const seasons: SaveSeriesSeason[] = [];
  for (const s of wantedSeasons) {
    let episodes: TmdbEpisode[] = [];
    try {
      episodes = await deps.client.tvSeason(tmdbId, s.seasonNumber);
    } catch {
      episodes = [];
    }

    const savedEpisodes: SaveSeriesEpisode[] = [];
    for (const e of episodes) {
      const stillPath = e.stillPath ? await deps.cacheImage(e.stillPath, "still") : undefined;
      savedEpisodes.push({
        episodeNumber: e.episodeNumber,
        title: e.title,
        overview: e.overview,
        stillPath,
        runtimeSec: e.runtimeSec,
        airDate: e.airDate,
        tmdbEpisodeId: e.tmdbEpisodeId,
      });
    }

    seasons.push({
      seasonNumber: s.seasonNumber,
      name: s.name,
      overview: s.overview,
      posterPath: s.posterPath ? await deps.cacheImage(s.posterPath, "poster") : undefined,
      airYear: s.airYear,
      tmdbSeasonId: s.tmdbSeasonId,
      episodes: savedEpisodes,
    });
  }

  await deps.saveSeries({
    itemId: item.id,
    tmdbId,
    title: tv.title,
    year: tv.year,
    overview: tv.overview,
    tagline: tv.tagline,
    status: tv.status,
    posterPath,
    backdropPath,
    logoPath,
    imdbId: tv.imdbId,
    tmdbScore: tv.tmdbScore,
    imdbRating: extraRatings?.imdbRating,
    imdbVotes: extraRatings?.imdbVotes,
    rtRating: extraRatings?.rtRating,
    metacritic: extraRatings?.metacritic,
    rating,
    genres: tv.genres,
    seasons,
  });

  return { matched: true, tmdbId };
}
