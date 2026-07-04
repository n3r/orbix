import type { TvdbSeries, TvdbEpisode, TvdbSearchCandidate, TvdbTranslation } from "./tvdb";
import type { ImageKind } from "./images";
import type { ExternalRatings } from "./omdb";
import type { EnrichResult, MetadataTranslation } from "./enrich";
import type { SaveSeriesInput, SaveSeriesSeason, SaveSeriesEpisode } from "./enrich-series";
import { titleSimilarity, acronymMatches, TITLE_STRONG, TITLE_WEAK } from "./match-score";
import { yearMatches, buildLadders } from "./resolve";
import { queryKey } from "./search-title";
import { pickBestByShape, type LocalSeasonShape, type ProviderSeasonShape } from "./season-shape";

/** Structural surface of TvdbClient needed to enrich a series. */
export interface TvdbLike {
  searchSeriesCandidates(query: string): Promise<TvdbSearchCandidate[]>;
  series(id: number): Promise<TvdbSeries>;
  seasonEpisodes(id: number): Promise<TvdbEpisode[]>;
}

/** Best similarity of any faithful query against any of the candidate's names. */
function bestNameSimilarity(queries: string[], names: string[]): number {
  let best = 0;
  for (const q of queries) {
    for (const n of names) {
      if (acronymMatches(q, n)) return 1;
      const sim = titleSimilarity(q, { title: n });
      if (sim > best) best = sim;
      if (best >= 1) return best;
    }
  }
  return best;
}

export interface ResolveTvdbOpts {
  /** Alternative faithful titles (filename prefix, pack title, umbrella folder). */
  variants?: string[];
  /** Local file-backed season structure — enables shape disambiguation. */
  localShape?: LocalSeasonShape[];
}

/** Season structure of a TVDB candidate, from its full episode list. */
async function tvdbSeasonShape(
  client: Pick<TvdbLike, "seasonEpisodes">,
  tvdbId: number,
): Promise<ProviderSeasonShape[]> {
  const episodes = await client.seasonEpisodes(tvdbId);
  const counts = new Map<number, number>();
  for (const e of episodes) counts.set(e.seasonNumber, (counts.get(e.seasonNumber) ?? 0) + 1);
  return [...counts].map(([seasonNumber, episodeCount]) => ({ seasonNumber, episodeCount }));
}

/**
 * Resolve a series' TVDB id. TVDB's search response carries every known name
 * (display + aliases + translated) inline, so — unlike the TMDB resolver —
 * verification needs no follow-up calls: each candidate is gated by the best
 * similarity between the FAITHFUL ladder queries and any of its names, with
 * the same year-tiered preference as the movie resolver.
 *
 * When the item has no year and several distinct candidates clear the name
 * gate (namesakes — "Shogun", "Ghosts"; remakes titled exactly like the
 * original's translation), names cannot decide: the candidate whose real
 * season structure explains the local files wins.
 */
export async function resolveTvdbId(
  title: string,
  year: number | undefined,
  client: Pick<TvdbLike, "searchSeriesCandidates"> & Partial<Pick<TvdbLike, "seasonEpisodes">>,
  opts?: ResolveTvdbOpts,
): Promise<number | undefined> {
  const ladder = buildLadders(title, year, opts?.variants);
  const faithful = [...new Set(ladder.filter((a) => !a.derived).map((a) => a.query))];
  const shapeMode = year == null && !!client.seasonEpisodes && !!opts?.localShape?.length;
  // TVDB search has no year/language params — dedupe attempts by query text.
  // queryKey (not normalizeForMatch) so a homoglyph-repaired spelling stays a
  // distinct search: normalizeForMatch folds the twins and would collapse the
  // repaired attempt into the polluted original TVDB can't match.
  const seen = new Set<string>();
  let best: { tvdbId: number; sim: number; exactYear: boolean } | undefined;
  const accepted = new Map<number, { tvdbId: number; sim: number }>();

  for (const attempt of ladder) {
    const key = queryKey(attempt.query);
    if (seen.has(key)) continue;
    seen.add(key);

    let candidates: TvdbSearchCandidate[];
    try {
      candidates = await client.searchSeriesCandidates(attempt.query);
    } catch {
      continue; // one failed attempt must not abort the ladder
    }
    for (const candidate of candidates) {
      const sim = bestNameSimilarity(faithful, candidate.names);
      const exactYear = yearMatches(year, candidate.year);
      if (!(sim >= TITLE_STRONG || (sim >= TITLE_WEAK && exactYear))) continue;
      if (shapeMode) {
        const prev = accepted.get(candidate.tvdbId);
        if (!prev || sim > prev.sim) accepted.set(candidate.tvdbId, { tvdbId: candidate.tvdbId, sim });
        continue;
      }
      const strong = sim >= TITLE_STRONG;
      const bestStrong = best != null && best.sim >= TITLE_STRONG;
      const better =
        !best ||
        (exactYear && !best.exactYear && (strong || !bestStrong)) ||
        (exactYear === best.exactYear && sim > best.sim);
      if (better) best = { tvdbId: candidate.tvdbId, sim, exactYear };
    }
    if (!shapeMode && best && best.sim >= TITLE_STRONG && (year == null || best.exactYear)) break;
  }

  if (shapeMode && accepted.size) {
    // Insertion order preserves TVDB's own relevance ranking within equal sims.
    const ranked = [...accepted.values()].sort((a, b) => b.sim - a.sim);
    if (ranked.length === 1) return ranked[0]!.tvdbId;
    const winner = await pickBestByShape(ranked, opts!.localShape!, (f) =>
      tvdbSeasonShape(client as Pick<TvdbLike, "seasonEpisodes">, f.tvdbId),
    );
    return (winner ?? ranked[0]!).tvdbId;
  }
  return best?.tvdbId;
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
  item: { id: string; title: string; year?: number; tvdbId?: number; titleVariants?: string[] },
  deps: {
    client: TvdbLike;
    cacheImageUrl: (url: string, kind: ImageKind) => Promise<string>;
    saveSeries: (input: SaveSeriesInput) => Promise<void>;
    /** Resolve + cache a hero logo (TVDB clearlogo → TMDB fallback); metadata-relative path. */
    resolveLogo?: (input: { tvdbId: number; tmdbId?: number; logoUrl?: string }) => Promise<string | undefined>;
    fetchRatings?: (imdbId: string) => Promise<ExternalRatings | undefined>;
    localSeasonNumbers?: number[];
    /** File-backed local season structure — enables namesake disambiguation. */
    localShape?: LocalSeasonShape[];
    translateClients?: Map<string, TvdbTranslateClient>;
  },
): Promise<EnrichResult> {
  const tvdbId =
    item.tvdbId ??
    (await resolveTvdbId(item.title, item.year, deps.client, {
      ...(item.titleVariants ? { variants: item.titleVariants } : {}),
      ...(deps.localShape ? { localShape: deps.localShape } : {}),
    }));
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
