import { qualityScore } from "./similarity";

export interface RowCatalogItem {
  id: string;
  title: string;
  features: { genres: string[]; keywords: string[]; cast: string[]; director?: string };
  playedByProfile: boolean;
  kind?: string | null;
  year?: number | null;
  runtimeSec?: number | null;
  addedAt?: Date | string | number | null;
  tmdbScore?: number | null;
  imdbRating?: number | null;
  rtRating?: number | null;
  metacritic?: number | null;
}

export interface SmartRow {
  key: string;
  title: string;
  itemIds: string[];
}

export interface BuildRowsInput {
  /** Newest-first list of items in progress. */
  continueWatching: { mediaItemId: string }[];
  /** Newest-first watch history (most recent at index 0). */
  history: { mediaItemId: string; title: string }[];
  /** Newest-first wishlist entries for the active profile. */
  wishlist?: { mediaItemId: string }[];
  catalog: RowCatalogItem[];
  simOf: (a: RowCatalogItem["features"], b: RowCatalogItem["features"]) => number;
  /** Max items per recommendation row. Default 20. */
  limit?: number;
}

/**
 * Discovery rows below this size read as broken UI, so they are omitted.
 * Factual rows (continue, wishlist) render from a single item.
 */
const MIN_DISCOVERY_ROW = 4;

/** Return the max similarity of `item` to any item in `anchors`. Returns 0 if anchors is empty. */
function maxSim(
  item: RowCatalogItem,
  anchors: RowCatalogItem[],
  simOf: BuildRowsInput["simOf"],
): number {
  if (anchors.length === 0) return 0;
  let best = 0;
  for (const anchor of anchors) {
    const s = simOf(anchor.features, item.features);
    if (s > best) best = s;
  }
  return best;
}

function metadataRichness(item: RowCatalogItem): number {
  const featureCount =
    item.features.genres.length +
    item.features.keywords.length +
    Math.min(item.features.cast.length, 10) +
    (item.features.director ? 1 : 0);
  return Math.min(1, featureCount / 18);
}

function asMillis(value: RowCatalogItem["addedAt"]): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rangeScore(value: number | undefined, min: number, max: number): number {
  if (value === undefined || min === max) return 0.5;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

interface FreshnessBounds {
  addedCount: number;
  addedMin: number;
  addedMax: number;
  yearCount: number;
  yearMin: number;
  yearMax: number;
}

function freshnessBounds(catalog: RowCatalogItem[]): FreshnessBounds {
  const addedValues = catalog.map((c) => asMillis(c.addedAt)).filter((x): x is number => x !== undefined);
  const years = catalog
    .map((c) => c.year)
    .filter((year): year is number => year != null && Number.isFinite(year));
  return {
    addedCount: addedValues.length,
    addedMin: addedValues.length > 0 ? Math.min(...addedValues) : 0,
    addedMax: addedValues.length > 0 ? Math.max(...addedValues) : 0,
    yearCount: years.length,
    yearMin: years.length > 0 ? Math.min(...years) : 0,
    yearMax: years.length > 0 ? Math.max(...years) : 0,
  };
}

function freshnessScore(item: RowCatalogItem, bounds: FreshnessBounds): number {
  const added = asMillis(item.addedAt);
  if (bounds.addedCount > 1 && added !== undefined) {
    return rangeScore(added, bounds.addedMin, bounds.addedMax);
  }
  if (bounds.yearCount > 1 && item.year != null) {
    return rangeScore(item.year, bounds.yearMin, bounds.yearMax);
  }
  return 0.5;
}

function hasRatingSignal(item: RowCatalogItem): boolean {
  return (
    (item.imdbRating != null && Number.isFinite(item.imdbRating)) ||
    (item.tmdbScore != null && Number.isFinite(item.tmdbScore)) ||
    (item.rtRating != null && Number.isFinite(item.rtRating)) ||
    (item.metacritic != null && Number.isFinite(item.metacritic))
  );
}

function genreFrequency(items: RowCatalogItem[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of items) {
    for (const genre of entry.features.genres) {
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([genre]) => genre);
}

/**
 * Rank genre names for the profile: watch-history frequency first when the
 * history carries enough genre signal, then unplayed-catalog frequency for
 * the rest (and as the whole ranking for fresh profiles). Ties break
 * alphabetically for determinism.
 */
function rankGenres(historyItems: RowCatalogItem[], unplayed: RowCatalogItem[]): string[] {
  const genreBearingHistory = historyItems.filter((h) => h.features.genres.length > 0);
  const catalogRank = genreFrequency(unplayed);
  if (genreBearingHistory.length < 3) return catalogRank;
  const historyRank = genreFrequency(genreBearingHistory);
  const seen = new Set(historyRank);
  return [...historyRank, ...catalogRank.filter((genre) => !seen.has(genre))];
}

function catalogLatestYear(catalog: RowCatalogItem[]): number | undefined {
  const years = catalog
    .map((c) => c.year)
    .filter((year): year is number => year != null && Number.isFinite(year));
  return years.length > 0 ? Math.max(...years) : undefined;
}

function ageDiscoveryScore(item: RowCatalogItem, latestYear: number | undefined): number {
  if (item.year == null || latestYear === undefined) return 0.5;
  return Math.min(1, Math.max(0, (latestYear - item.year) / 40));
}

function runtimeComfortScore(runtimeSec: number | null | undefined): number {
  if (runtimeSec == null || !Number.isFinite(runtimeSec)) return 0.6;
  const minutes = runtimeSec / 60;
  if (minutes < 70) return 0.65;
  if (minutes <= 135) return 1;
  if (minutes <= 165) return 0.75;
  if (minutes <= 195) return 0.45;
  return 0.25;
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function selectDiverse(
  scored: { item: RowCatalogItem; score: number }[],
  input: {
    limit: number;
    simOf: BuildRowsInput["simOf"];
    excludeIds?: Set<string>;
    diversityPenalty?: number;
  },
): string[] {
  const { limit, simOf, excludeIds = new Set(), diversityPenalty = 0.1 } = input;
  const pool = scored
    .filter((entry) => !excludeIds.has(entry.item.id))
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const selected: { item: RowCatalogItem; score: number }[] = [];

  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestAdjusted = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const entry = pool[i]!;
      const diversityCost = diversityPenalty * maxSim(
        entry.item,
        selected.map((s) => s.item),
        simOf,
      );
      const adjusted = entry.score - diversityCost;
      const best = pool[bestIndex]!;
      if (
        adjusted > bestAdjusted ||
        (adjusted === bestAdjusted &&
          (entry.score > best.score ||
            (entry.score === best.score && entry.item.id.localeCompare(best.item.id) < 0)))
      ) {
        bestAdjusted = adjusted;
        bestIndex = i;
      }
    }
    const [next] = pool.splice(bestIndex, 1);
    if (next) selected.push(next);
  }

  return selected.map((entry) => entry.item.id);
}

/**
 * Build smart home-row recommendations from profile history + catalog.
 *
 * Pure and deterministic: identical input → identical output.
 * No Date.now / Math.random.
 *
 * Row order (emission = computation = priority): continue, wishlist,
 * becauseYouWatched, recentlyAdded, hiddenGems, genre #1, tonight, genre #2,
 * topRated, series. Factual rows (continue, wishlist, recentlyAdded) neither
 * consume nor feed the surfaced-id dedupe set; discovery rows exclude ids
 * surfaced by earlier rows and add their own picks, so earlier rows win
 * contested items.
 */
export function buildSmartRows(input: BuildRowsInput): SmartRow[] {
  const { continueWatching, history, wishlist = [], catalog, simOf, limit = 20 } = input;
  const rows: SmartRow[] = [];
  const surfacedRecommendationIds = new Set<string>();
  const topExposureLimit = Math.min(6, Math.max(3, Math.floor(limit / 2)));

  // Shared candidate pools/bounds for the discovery rows below.
  const unplayed = catalog.filter((c) => !c.playedByProfile);
  const historyItems = history
    .map((h) => catalog.find((c) => c.id === h.mediaItemId))
    .filter((c): c is RowCatalogItem => c !== undefined);
  const bounds = freshnessBounds(catalog);

  // ── 1. Continue Watching ──────────────────────────────────────────────────
  if (continueWatching.length > 0) {
    rows.push({
      key: "continue",
      title: "Continue Watching",
      itemIds: uniqueIds(continueWatching.map((c) => c.mediaItemId)).slice(0, limit),
    });
  }

  // ── 2. From Your Wishlist ─────────────────────────────────────────────────
  // Factual: stored order, played items kept (it's the user's explicit list).
  // Filtered to catalog membership so upstream filtering (kids caps, deleted
  // items) is honoured.
  if (wishlist.length > 0) {
    const catalogIds = new Set(catalog.map((c) => c.id));
    const wishlistIds = uniqueIds(wishlist.map((w) => w.mediaItemId))
      .filter((id) => catalogIds.has(id))
      .slice(0, limit);
    if (wishlistIds.length > 0) {
      rows.push({
        key: "wishlist",
        title: "From your wishlist",
        itemIds: wishlistIds,
      });
    }
  }

  // ── 3. Because You Watched ────────────────────────────────────────────────
  if (history.length > 0) {
    const seedEntry = history[0];
    const seed = catalog.find((c) => c.id === seedEntry.mediaItemId);

    if (seed !== undefined) {
      const candidates = catalog
        .filter((c) => !c.playedByProfile && c.id !== seed.id)
        .map((c) => {
          const contentScore = simOf(seed.features, c.features);
          return {
            id: c.id,
            contentScore,
            score:
              0.82 * contentScore +
              0.12 * qualityScore(c) +
              0.06 * metadataRichness(c),
          };
        })
        .filter((c) => c.contentScore > 0.05)
        // sort: score DESC, then id ASC (deterministic tiebreak)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((c) => c.id);

      if (candidates.length > 0) {
        for (const id of candidates.slice(0, topExposureLimit)) surfacedRecommendationIds.add(id);
        rows.push({
          key: "becauseYouWatched",
          title: `Because you watched ${seedEntry.title}`,
          itemIds: candidates,
        });
      }
    }
  }

  // ── 4. Recently Added ─────────────────────────────────────────────────────
  // Factual: newest unplayed additions. Missing addedAt sinks to the bottom.
  if (unplayed.length >= MIN_DISCOVERY_ROW) {
    const recentIds = unplayed
      .map((c) => ({ id: c.id, added: asMillis(c.addedAt) ?? Number.MIN_SAFE_INTEGER }))
      .sort((a, b) => b.added - a.added || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((c) => c.id);
    rows.push({
      key: "recentlyAdded",
      title: "Recently added",
      itemIds: recentIds,
    });
  }

  // ── 5. Hidden Gems ────────────────────────────────────────────────────────
  if (unplayed.length > 0) {
    const latestYear = catalogLatestYear(catalog);
    const hiddenLimit = Math.min(limit, 12, Math.max(1, Math.floor(unplayed.length * 0.55)));

    const hiddenScores = unplayed
      .map((c) => {
        const affinity = maxSim(c, historyItems, simOf);
        return {
          item: c,
          score:
            0.46 * qualityScore(c) +
            0.26 * affinity +
            0.18 * ageDiscoveryScore(c, latestYear) +
            0.1 * metadataRichness(c),
        };
      })
      .filter((entry) => entry.score >= 0.4);

    const hiddenGemIds = selectDiverse(
      hiddenScores,
      { limit: hiddenLimit, simOf, excludeIds: surfacedRecommendationIds, diversityPenalty: 0.08 },
    );

    if (hiddenGemIds.length > 0) {
      for (const id of hiddenGemIds) surfacedRecommendationIds.add(id);
      rows.push({
        key: "hiddenGems",
        title: "Hidden gems",
        itemIds: hiddenGemIds,
      });
    }
  }

  // ── 6/8. Genre rows ───────────────────────────────────────────────────────
  // Two genre rows straddle Tonight. Genres are tried in affinity order; a
  // genre only emits when its row (after exclusions) reaches the minimum size.
  const genreRank = rankGenres(historyItems, unplayed);
  let genreCursor = 0;
  const nextGenreRow = (): SmartRow | null => {
    while (genreCursor < genreRank.length) {
      const name = genreRank[genreCursor++]!;
      const candidates = unplayed.filter((c) => c.features.genres.includes(name));
      if (candidates.length < MIN_DISCOVERY_ROW) continue;

      const ids = selectDiverse(
        candidates.map((c) => ({
          item: c,
          score:
            0.5 * qualityScore(c) +
            0.3 * maxSim(c, historyItems, simOf) +
            0.2 * freshnessScore(c, bounds),
        })),
        {
          limit: Math.min(limit, 12),
          simOf,
          excludeIds: surfacedRecommendationIds,
          diversityPenalty: 0.12,
        },
      );
      if (ids.length < MIN_DISCOVERY_ROW) continue;

      for (const id of ids) surfacedRecommendationIds.add(id);
      return { key: `genre:${name}`, title: name, itemIds: ids };
    }
    return null;
  };

  const firstGenreRow = nextGenreRow();
  if (firstGenreRow) rows.push(firstGenreRow);

  // ── 7. Tonight ────────────────────────────────────────────────────────────
  if (unplayed.length > 0) {
    const tonightLimit = Math.min(limit, 10);

    const tonightIds = selectDiverse(
      unplayed.map((c) => {
        const affinity = maxSim(c, historyItems, simOf);
        return {
          item: c,
          score:
            0.38 * affinity +
            0.24 * qualityScore(c) +
            0.24 * runtimeComfortScore(c.runtimeSec) +
            0.14 * freshnessScore(c, bounds),
        };
      }),
      {
        limit: tonightLimit,
        simOf,
        excludeIds: surfacedRecommendationIds,
        diversityPenalty: 0.14,
      },
    );

    if (tonightIds.length > 0) {
      for (const id of tonightIds) surfacedRecommendationIds.add(id);
      rows.push({
        key: "tonight",
        title: "Pick something for tonight",
        itemIds: tonightIds,
      });
    }
  }

  const secondGenreRow = nextGenreRow();
  if (secondGenreRow) rows.push(secondGenreRow);

  // ── 9. Critically Acclaimed ───────────────────────────────────────────────
  // Requires a real rating signal (never the unrated 0.55 default) and a
  // genuinely-acclaimed score bar.
  {
    const topRatedIds = unplayed
      .filter((c) => hasRatingSignal(c) && !surfacedRecommendationIds.has(c.id))
      .map((c) => ({ id: c.id, score: qualityScore(c) }))
      .filter((entry) => entry.score >= 0.68)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Math.min(limit, 10))
      .map((entry) => entry.id);

    if (topRatedIds.length >= MIN_DISCOVERY_ROW) {
      for (const id of topRatedIds) surfacedRecommendationIds.add(id);
      rows.push({
        key: "topRated",
        title: "Critically acclaimed",
        itemIds: topRatedIds,
      });
    }
  }

  // ── 10. Binge-worthy Series ───────────────────────────────────────────────
  {
    const seriesCandidates = unplayed.filter((c) => c.kind === "series");
    const seriesIds = selectDiverse(
      seriesCandidates.map((c) => ({
        item: c,
        score:
          0.45 * qualityScore(c) +
          0.3 * maxSim(c, historyItems, simOf) +
          0.25 * freshnessScore(c, bounds),
      })),
      {
        limit: Math.min(limit, 10),
        simOf,
        excludeIds: surfacedRecommendationIds,
        diversityPenalty: 0.12,
      },
    );

    if (seriesIds.length >= MIN_DISCOVERY_ROW) {
      rows.push({
        key: "series",
        title: "Binge-worthy series",
        itemIds: seriesIds,
      });
    }
  }

  return rows;
}
