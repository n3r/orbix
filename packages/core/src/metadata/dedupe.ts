// Duplicate-item reconciliation. A single movie/series can land on disk as
// several files whose names parse to different titles/years (e.g. "I Robot.mkv"
// vs "I.Robot.2004.1080p.mkv", or an English vs a foreign-language copy). Each
// becomes its own MediaItem during the scan; only once enrichment resolves a
// canonical TMDB id do we learn they are the same title. This module decides,
// purely, how to collapse such collisions.

export interface DedupeCandidate {
  id: string;
  libraryId: string;
  kind: string;
  tmdbId: number | null;
  /** Epoch ms; earlier = smaller. The earliest-added item wins as canonical. */
  addedAt: number;
}

export type DedupePlan =
  | { action: "keep" }
  | { action: "merge"; canonicalId: string; obsoleteIds: string[] };

/**
 * Decide whether `item` — which has just resolved to a TMDB id — collides with
 * existing catalogue items and should be collapsed into a single entry.
 *
 * Dedup is keyed on `tmdbId` ONLY, never on title: distinct films legitimately
 * share a title (Hellboy 2004 vs 2019) but have different tmdbIds, while the same
 * film often appears under different filenames (different parsed title/year, or a
 * foreign-language name) yet resolves to one tmdbId. Collisions are scoped to a
 * single library and a single `kind`.
 *
 * `others` is every OTHER catalogue item. When a collision exists, the whole
 * group (this item + the matching siblings) collapses onto the earliest-added
 * item as canonical; the rest are returned as `obsoleteIds` for the caller to
 * reap (moving their files onto the canonical first).
 */
export function planTmdbDedup(
  item: DedupeCandidate,
  others: DedupeCandidate[],
): DedupePlan {
  if (item.tmdbId == null) return { action: "keep" };

  const group = [
    item,
    ...others.filter(
      (o) =>
        o.id !== item.id &&
        o.libraryId === item.libraryId &&
        o.kind === item.kind &&
        o.tmdbId === item.tmdbId,
    ),
  ];
  if (group.length < 2) return { action: "keep" };

  const sorted = [...group].sort(
    (a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const [canonical, ...rest] = sorted;
  return {
    action: "merge",
    canonicalId: canonical!.id,
    obsoleteIds: rest.map((c) => c.id),
  };
}

export interface SeriesDedupeCandidate {
  id: string;
  libraryId: string;
  tvdbId: number | null;
  tmdbId: number | null;
  /** Epoch ms; earlier = smaller. The earliest-added item wins as canonical. */
  addedAt: number;
}

/**
 * Series flavor of the dedupe plan. Season packs of one show routinely parse
 * to different pre-enrich titles ("Rick and Morty" / "Rick and Morty (2013)" /
 * "Rick.And.Morty.1080"), each becoming its own series row; enrichment is the
 * first point their shared identity is known. Series carry TWO provider ids —
 * a TVDB-first row and a TMDB-fallback row of the same show must still
 * collide — so the collision key is: same non-null tvdbId OR same non-null
 * tmdbId, within one library.
 */
export function planSeriesDedup(
  item: SeriesDedupeCandidate,
  others: SeriesDedupeCandidate[],
): DedupePlan {
  if (item.tvdbId == null && item.tmdbId == null) return { action: "keep" };

  const group = [
    item,
    ...others.filter(
      (o) =>
        o.id !== item.id &&
        o.libraryId === item.libraryId &&
        ((item.tvdbId != null && o.tvdbId === item.tvdbId) ||
          (item.tmdbId != null && o.tmdbId === item.tmdbId)),
    ),
  ];
  if (group.length < 2) return { action: "keep" };

  const sorted = [...group].sort(
    (a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const [canonical, ...rest] = sorted;
  return {
    action: "merge",
    canonicalId: canonical!.id,
    obsoleteIds: rest.map((c) => c.id),
  };
}
