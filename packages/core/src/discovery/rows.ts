export interface RowCatalogItem {
  id: string;
  title: string;
  features: { genres: string[]; keywords: string[]; cast: string[]; director?: string };
  playedByProfile: boolean;
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
  catalog: RowCatalogItem[];
  simOf: (a: RowCatalogItem["features"], b: RowCatalogItem["features"]) => number;
  /** Max items per recommendation row. Default 20. */
  limit?: number;
}

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

/**
 * Build smart home-row recommendations from profile history + catalog.
 *
 * Pure and deterministic: identical input → identical output.
 * No Date.now / Math.random.
 */
export function buildSmartRows(input: BuildRowsInput): SmartRow[] {
  const { continueWatching, history, catalog, simOf, limit = 20 } = input;
  const rows: SmartRow[] = [];

  // ── 1. Continue Watching ──────────────────────────────────────────────────
  if (continueWatching.length > 0) {
    rows.push({
      key: "continue",
      title: "Continue Watching",
      itemIds: continueWatching.map((c) => c.mediaItemId),
    });
  }

  // ── 2. Because You Watched ────────────────────────────────────────────────
  if (history.length > 0) {
    const seedEntry = history[0];
    const seed = catalog.find((c) => c.id === seedEntry.mediaItemId);

    if (seed !== undefined) {
      const candidates = catalog
        .filter((c) => !c.playedByProfile && c.id !== seed.id)
        .map((c) => ({ id: c.id, score: simOf(seed.features, c.features) }))
        // sort: score DESC, then id ASC (deterministic tiebreak)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((c) => c.id);

      if (candidates.length > 0) {
        rows.push({
          key: "becauseYouWatched",
          title: `Because you watched ${seedEntry.title}`,
          itemIds: candidates,
        });
      }
    }
  }

  // ── 3. Hidden Gems ────────────────────────────────────────────────────────
  const unplayed = catalog.filter((c) => !c.playedByProfile);

  if (unplayed.length > 0) {
    // Resolve catalog entries for history items (for sim scoring).
    const historyItems = history
      .map((h) => catalog.find((c) => c.id === h.mediaItemId))
      .filter((c): c is RowCatalogItem => c !== undefined);

    const gemIds = [...unplayed]
      .map((c) => ({ item: c, score: maxSim(c, historyItems, simOf) }))
      // sort: score DESC, then id ASC (deterministic tiebreak)
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
      .slice(0, limit)
      .map((x) => x.item.id);

    rows.push({
      key: "hiddenGems",
      title: "Hidden gems",
      itemIds: gemIds,
    });
  }

  // ── 4. Tonight ────────────────────────────────────────────────────────────
  if (unplayed.length > 0) {
    const tonightLimit = Math.min(limit, 10);

    const historyItems = history
      .map((h) => catalog.find((c) => c.id === h.mediaItemId))
      .filter((c): c is RowCatalogItem => c !== undefined);

    const tonightIds = [...unplayed]
      .map((c) => ({ item: c, score: maxSim(c, historyItems, simOf) }))
      // sort: score DESC, then id DESC (reverse tiebreak — feels curated vs gems)
      .sort((a, b) => b.score - a.score || b.item.id.localeCompare(a.item.id))
      .slice(0, tonightLimit)
      .map((x) => x.item.id);

    rows.push({
      key: "tonight",
      title: "Pick something for tonight",
      itemIds: tonightIds,
    });
  }

  return rows;
}
