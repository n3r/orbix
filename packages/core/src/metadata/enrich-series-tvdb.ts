import type { TvdbSeries, TvdbEpisode, TvdbSearchResult, TvdbTranslation } from "./tvdb";
import type { ImageKind } from "./images";
import type { ExternalRatings } from "./omdb";
import type { EnrichResult, MetadataTranslation } from "./enrich";
import type { SaveSeriesInput, SaveSeriesSeason, SaveSeriesEpisode } from "./enrich-series";

/** Structural surface of TvdbClient needed to enrich a series. */
export interface TvdbLike {
  searchSeries(title: string, year?: number): Promise<TvdbSearchResult | null>;
  series(id: number): Promise<TvdbSeries>;
  seasonEpisodes(id: number): Promise<TvdbEpisode[]>;
}

/** Per-language client used to fetch localized series/episode text. */
export interface TvdbTranslateClient {
  seriesTranslated(id: number): Promise<TvdbTranslation>;
}

/**
 * Enrich a TV series from TVDB. Returns { matched: false } when TVDB cannot
 * match the title — the caller then falls back to the TMDB path. On a match,
 * persists via the shared saveSeries adapter with metadataSource "tvdb".
 */
export async function enrichSeriesTvdb(
  item: { id: string; title: string; year?: number; tvdbId?: number },
  deps: {
    client: TvdbLike;
    cacheImageUrl: (url: string, kind: ImageKind) => Promise<string>;
    saveSeries: (input: SaveSeriesInput) => Promise<void>;
    /** Resolve + cache a hero logo (TVDB clearlogo → TMDB fallback); metadata-relative path. */
    resolveLogo?: (input: { tvdbId: number; tmdbId?: number; logoUrl?: string }) => Promise<string | undefined>;
    fetchRatings?: (imdbId: string) => Promise<ExternalRatings | undefined>;
    localSeasonNumbers?: number[];
    translateClients?: Map<string, TvdbTranslateClient>;
  },
): Promise<EnrichResult> {
  const tvdbId = item.tvdbId ?? (await deps.client.searchSeries(item.title, item.year))?.tvdbId;
  if (!tvdbId) return { matched: false };

  const series = await deps.client.series(tvdbId);

  const posterPath = series.posterUrl ? await deps.cacheImageUrl(series.posterUrl, "poster") : undefined;
  const backdropPath = series.backdropUrl ? await deps.cacheImageUrl(series.backdropUrl, "backdrop") : undefined;

  // Hero logo: prefer a caller-provided resolver (TVDB clearlogo → TMDB), else
  // cache the TVDB clearlogo directly. Never fail enrichment on the logo.
  let logoPath: string | undefined;
  try {
    if (deps.resolveLogo) {
      logoPath = await deps.resolveLogo({ tvdbId, tmdbId: series.tmdbId, logoUrl: series.logoUrl });
    } else if (series.logoUrl) {
      logoPath = await deps.cacheImageUrl(series.logoUrl, "logo");
    }
  } catch {
    logoPath = undefined;
  }

  let extraRatings: ExternalRatings | undefined;
  if (deps.fetchRatings && series.imdbId) {
    try {
      extraRatings = await deps.fetchRatings(series.imdbId);
    } catch {
      extraRatings = undefined;
    }
  }

  // Episodes (aired order), grouped by season; restricted to local seasons if known.
  const allEpisodes = await deps.client.seasonEpisodes(tvdbId);
  const local = deps.localSeasonNumbers ? new Set(deps.localSeasonNumbers) : null;
  const metaBySeason = new Map(series.seasons.map((s) => [s.seasonNumber, s]));

  const bySeason = new Map<number, TvdbEpisode[]>();
  for (const e of allEpisodes) {
    if (local && !local.has(e.seasonNumber)) continue;
    let arr = bySeason.get(e.seasonNumber);
    if (!arr) {
      arr = [];
      bySeason.set(e.seasonNumber, arr);
    }
    arr.push(e);
  }

  const seasons: SaveSeriesSeason[] = [];
  for (const seasonNumber of [...bySeason.keys()].sort((a, b) => a - b)) {
    const eps = bySeason.get(seasonNumber)!;
    const meta = metaBySeason.get(seasonNumber);
    const savedEpisodes: SaveSeriesEpisode[] = [];
    for (const e of eps) {
      const stillPath = e.stillUrl ? await deps.cacheImageUrl(e.stillUrl, "still") : undefined;
      savedEpisodes.push({
        episodeNumber: e.episodeNumber,
        ...(e.title != null ? { title: e.title } : {}),
        ...(e.overview != null ? { overview: e.overview } : {}),
        ...(stillPath ? { stillPath } : {}),
        ...(e.runtimeSec != null ? { runtimeSec: e.runtimeSec } : {}),
        ...(e.airDate != null ? { airDate: e.airDate } : {}),
        tvdbEpisodeId: e.tvdbEpisodeId,
      });
    }
    seasons.push({
      seasonNumber,
      ...(meta?.posterUrl ? { posterPath: await deps.cacheImageUrl(meta.posterUrl, "poster") } : {}),
      ...(meta?.tvdbSeasonId != null ? { tvdbSeasonId: meta.tvdbSeasonId } : {}),
      episodes: savedEpisodes,
    });
  }

  // Localized series/episode text per active language. A per-language failure
  // must NOT fail enrichment — skip that language.
  const seriesTranslations: MetadataTranslation[] = [];
  if (deps.translateClients) {
    for (const [language, client] of deps.translateClients) {
      try {
        const tr = await client.seriesTranslated(tvdbId);
        if (tr.title) {
          seriesTranslations.push({
            language,
            title: tr.title,
            ...(tr.overview != null ? { overview: tr.overview } : {}),
          });
        }
        for (const season of seasons) {
          for (const ep of season.episodes) {
            const le = tr.episodes.get(`${season.seasonNumber}:${ep.episodeNumber}`);
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
    metadataSource: "tvdb",
    tvdbId,
    ...(series.tmdbId != null ? { tmdbId: series.tmdbId } : {}),
    title: series.title,
    ...(series.year != null ? { year: series.year } : {}),
    ...(series.overview != null ? { overview: series.overview } : {}),
    ...(series.status != null ? { status: series.status } : {}),
    ...(posterPath ? { posterPath } : {}),
    ...(backdropPath ? { backdropPath } : {}),
    ...(logoPath ? { logoPath } : {}),
    ...(series.imdbId != null ? { imdbId: series.imdbId } : {}),
    ...(extraRatings?.imdbRating != null ? { imdbRating: extraRatings.imdbRating } : {}),
    ...(extraRatings?.imdbVotes != null ? { imdbVotes: extraRatings.imdbVotes } : {}),
    ...(extraRatings?.rtRating != null ? { rtRating: extraRatings.rtRating } : {}),
    ...(extraRatings?.metacritic != null ? { metacritic: extraRatings.metacritic } : {}),
    ...(series.contentRating != null ? { rating: series.contentRating } : {}),
    genres: series.genres.map((g) => ({ tmdbId: 0, name: g.name })),
    seasons,
    translations: seriesTranslations,
  });

  return { matched: true, tvdbId };
}
