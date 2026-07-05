import { describe, it, expect } from "vitest";
import { buildLibraryGenreRows, compareByRating, LIBRARY_ROW_CAP } from "./library-rows";

const COMEDY = { id: 35, name: "Comedy" };
const HORROR = { id: 27, name: "Horror" };
const DRAMA = { id: 18, name: "Drama" };

/** Minimal item; ratings default to unrated. */
const item = (
  id: string,
  genres: { id: number; name: string }[],
  ratings: { imdbRating?: number | null; tmdbScore?: number | null } = {},
) => ({
  id,
  sortTitle: id,
  imdbRating: ratings.imdbRating ?? null,
  tmdbScore: ratings.tmdbScore ?? null,
  genres,
});

describe("buildLibraryGenreRows", () => {
  it("groups by genre and orders rows by item count desc, base name asc on ties", () => {
    const rows = buildLibraryGenreRows([
      item("a", [COMEDY, DRAMA]),
      item("b", [COMEDY]),
      item("c", [HORROR]),
    ]);
    // Comedy(2) first; Drama(1) vs Horror(1) tie → Drama before Horror by name
    expect(rows.map((r) => [r.name, r.total])).toEqual([
      ["Comedy", 2], ["Drama", 1], ["Horror", 1],
    ]);
  });

  it("ranks items within a row by imdbRating ?? tmdbScore desc, unrated last, sortTitle tiebreak", () => {
    const rows = buildLibraryGenreRows([
      item("unrated", [COMEDY]),
      item("imdb-low", [COMEDY], { imdbRating: 6.1, tmdbScore: 9.9 }), // imdb wins the coalesce
      item("tmdb-high", [COMEDY], { tmdbScore: 8.2 }),
      item("imdb-high", [COMEDY], { imdbRating: 8.9 }),
    ]);
    expect(rows[0].itemIds).toEqual(["imdb-high", "tmdb-high", "imdb-low", "unrated"]);
  });

  it("caps itemIds at the row cap but reports the full total", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      item(`m${String(i).padStart(2, "0")}`, [COMEDY]),
    );
    const rows = buildLibraryGenreRows(many);
    expect(rows[0].itemIds).toHaveLength(LIBRARY_ROW_CAP);
    expect(rows[0].total).toBe(30);
  });

  it("excludes items with no genres and returns [] for an empty catalog", () => {
    expect(buildLibraryGenreRows([item("nogenre", [])])).toEqual([]);
    expect(buildLibraryGenreRows([])).toEqual([]);
  });
});

describe("compareByRating", () => {
  it("sorts rated desc before unrated, tie by sortTitle", () => {
    const list = [
      { id: "1", sortTitle: "b", imdbRating: null, tmdbScore: null },
      { id: "2", sortTitle: "a", imdbRating: null, tmdbScore: null },
      { id: "3", sortTitle: "c", imdbRating: 7, tmdbScore: null },
    ];
    expect([...list].sort(compareByRating).map((x) => x.id)).toEqual(["3", "2", "1"]);
  });
});
