/**
 * Genre-grouped rails for the library "Categories" tab.
 *
 * Every genre present in the catalog gets a row, biggest genre first. Rows
 * are capped (the API's "See all" grid serves the remainder) and ranked
 * top-rated-first so each rail reads as a best-of. Pure: takes plain data,
 * the API supplies items and localizes genre names.
 */

export const LIBRARY_ROW_CAP = 24;

export interface RatedTitle {
  id: string;
  sortTitle: string;
  imdbRating: number | null;
  tmdbScore: number | null;
}

/** Rated desc (imdbRating ?? tmdbScore), unrated last, sortTitle then id ties. */
export function compareByRating(a: RatedTitle, b: RatedTitle): number {
  const ra = a.imdbRating ?? a.tmdbScore;
  const rb = b.imdbRating ?? b.tmdbScore;
  if (ra !== null && rb !== null && ra !== rb) return rb - ra;
  if (ra === null && rb !== null) return 1;
  if (ra !== null && rb === null) return -1;
  return a.sortTitle.localeCompare(b.sortTitle) || a.id.localeCompare(b.id);
}

export interface LibraryRowItem extends RatedTitle {
  genres: { id: number; name: string }[];
}

export interface LibraryGenreRow {
  genreId: number;
  /** Base (English) genre name; the API localizes headings per profile. */
  name: string;
  /** Full genre size — itemIds is capped, this is not. */
  total: number;
  itemIds: string[];
}

export function buildLibraryGenreRows(
  items: LibraryRowItem[],
  cap = LIBRARY_ROW_CAP,
): LibraryGenreRow[] {
  const byGenre = new Map<number, { name: string; members: LibraryRowItem[] }>();
  for (const it of items) {
    for (const genre of it.genres) {
      const bucket = byGenre.get(genre.id) ?? { name: genre.name, members: [] };
      bucket.members.push(it);
      byGenre.set(genre.id, bucket);
    }
  }

  return [...byGenre.entries()]
    .map(([genreId, { name, members }]) => ({
      genreId,
      name,
      total: members.length,
      itemIds: [...members].sort(compareByRating).slice(0, cap).map((m) => m.id),
    }))
    .sort(
      (a, b) =>
        b.total - a.total || a.name.localeCompare(b.name) || a.genreId - b.genreId,
    );
}
