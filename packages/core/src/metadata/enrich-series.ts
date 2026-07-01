import type { TmdbSearchResult, TmdbTv, TmdbEpisode } from "./tmdb";
import type { ImageKind } from "./images";
import type { ExternalRatings } from "./omdb";
import type { EnrichResult, MetadataTranslation } from "./enrich";
import { isRealTranslation } from "./localize";

/** Minimal client surface needed to fetch localized series/season/episode text. */
export type TranslateSeriesClient = Pick<TmdbTvLike, "tv" | "tvSeason">;

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
  tvdbEpisodeId?: number;
  translations?: { language: string; title?: string; overview?: string }[];
}

export interface SaveSeriesSeason {
  seasonNumber: number;
  name?: string;
  overview?: string;
  posterPath?: string;
  airYear?: number;
  tmdbSeasonId?: number;
  tvdbSeasonId?: number;
  episodes: SaveSeriesEpisode[];
  translations?: { language: string; name?: string; overview?: string }[];
}

export interface SaveSeriesInput {
  itemId: string;
  tmdbId?: number;
  tvdbId?: number;
  metadataSource?: "tvdb" | "tmdb";
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
  /** Per-language localized series title/overview. */
  translations?: MetadataTranslation[];
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
    /** Per-language clients used to fetch localized series/season/episode text. */
    translateClients?: Map<string, TranslateSeriesClient>;
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

  // Localized series/season/episode text for each active content language.
  // A per-language failure must NOT fail enrichment — skip that language.
  const seriesTranslations: MetadataTranslation[] = [];
  if (deps.translateClients) {
    for (const [language, client] of deps.translateClients) {
      try {
        const ltv = await client.tv(tmdbId);
        // TMDB backfills name/overview with the ORIGINAL language when the
        // requested language has no translation. Skip the whole language so we
        // don't store e.g. a Language-2 title under Language 1 (the catalog then
        // falls back to the base/default title).
        if (!isRealTranslation(language, ltv)) continue;
        seriesTranslations.push({
          language,
          title: ltv.title,
          ...(ltv.overview != null ? { overview: ltv.overview } : {}),
        });

        // Season names/overviews, matched by seasonNumber to the saved seasons.
        const localizedSeasonByNumber = new Map(ltv.seasons.map((ls) => [ls.seasonNumber, ls]));
        for (const season of seasons) {
          const ls = localizedSeasonByNumber.get(season.seasonNumber);
          if (!ls || (ls.name == null && ls.overview == null)) continue;
          (season.translations ??= []).push({
            language,
            ...(ls.name != null ? { name: ls.name } : {}),
            ...(ls.overview != null ? { overview: ls.overview } : {}),
          });
        }

        // Episode titles/overviews, matched by episodeNumber within each season.
        for (const season of seasons) {
          let localizedEpisodes: TmdbEpisode[] = [];
          try {
            localizedEpisodes = await client.tvSeason(tmdbId, season.seasonNumber);
          } catch {
            localizedEpisodes = [];
          }
          const byNumber = new Map(localizedEpisodes.map((le) => [le.episodeNumber, le]));
          for (const ep of season.episodes) {
            const le = byNumber.get(ep.episodeNumber);
            if (!le || (le.title == null && le.overview == null)) continue;
            (ep.translations ??= []).push({
              language,
              ...(le.title != null ? { title: le.title } : {}),
              ...(le.overview != null ? { overview: le.overview } : {}),
            });
          }
        }
      } catch {
        // localized fetch failed for this language — fall back to base.
      }
    }
  }

  await deps.saveSeries({
    itemId: item.id,
    tmdbId,
    metadataSource: "tmdb",
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
    translations: seriesTranslations,
  });

  return { matched: true, tmdbId };
}
