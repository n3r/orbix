import { describe, it, expect } from "vitest";
import { buildSmartRows, type BuildRowsInput, type RowCatalogItem } from "./rows";

const features = (
  genres: string[],
  keywords: string[] = [],
  cast: string[] = [],
  director?: string,
): RowCatalogItem["features"] => ({ genres, keywords, cast, director });

const item = (input: {
  id: string;
  title?: string;
  played?: boolean;
  features: RowCatalogItem["features"];
  year?: number;
  runtimeMin?: number;
  addedAt?: string;
  imdbRating?: number;
  tmdbScore?: number;
  rtRating?: number;
  metacritic?: number;
}): RowCatalogItem => ({
  id: input.id,
  title: input.title ?? input.id,
  features: input.features,
  playedByProfile: input.played ?? false,
  year: input.year,
  runtimeSec: input.runtimeMin === undefined ? undefined : input.runtimeMin * 60,
  addedAt: input.addedAt,
  imdbRating: input.imdbRating,
  tmdbScore: input.tmdbScore,
  rtRating: input.rtRating,
  metacritic: input.metacritic,
});

const catalog: RowCatalogItem[] = [
  item({
    id: "seed",
    title: "Watched Space Movie",
    played: true,
    features: features(["Sci-Fi", "Adventure"], ["space", "rescue"], ["A", "B"], "Director One"),
    year: 2017,
    runtimeMin: 118,
    addedAt: "2025-01-01T00:00:00Z",
    imdbRating: 7.6,
  }),
  item({
    id: "because-1",
    features: features(["Sci-Fi", "Adventure"], ["space", "rescue"], ["A", "C"], "Director Two"),
    year: 2019,
    runtimeMin: 121,
    addedAt: "2025-01-02T00:00:00Z",
    imdbRating: 7.2,
  }),
  item({
    id: "because-2",
    features: features(["Sci-Fi"], ["space"], ["D"], "Director One"),
    year: 2015,
    runtimeMin: 110,
    addedAt: "2025-01-03T00:00:00Z",
    imdbRating: 6.9,
  }),
  item({
    id: "hidden-classic",
    features: features(["Drama"], ["melancholy", "memory"], ["E"], "Director Three"),
    year: 1984,
    runtimeMin: 142,
    addedAt: "2025-01-04T00:00:00Z",
    imdbRating: 9.1,
    rtRating: 97,
    metacritic: 92,
  }),
  item({
    id: "hidden-cult",
    features: features(["Crime"], ["heist", "neon"], ["F"], "Director Four"),
    year: 1992,
    runtimeMin: 128,
    addedAt: "2025-01-05T00:00:00Z",
    imdbRating: 8.7,
    rtRating: 95,
  }),
  item({
    id: "tonight-short",
    features: features(["Comedy"], ["weekend", "friends"], ["G"], "Director Five"),
    year: 2024,
    runtimeMin: 96,
    addedAt: "2025-02-01T00:00:00Z",
    imdbRating: 7.4,
  }),
  item({
    id: "tonight-new",
    features: features(["Thriller"], ["contained", "night"], ["H"], "Director Six"),
    year: 2023,
    runtimeMin: 104,
    addedAt: "2025-02-02T00:00:00Z",
    imdbRating: 7.1,
  }),
  item({
    id: "unrelated-weak",
    features: features([], [], []),
    year: 2001,
    runtimeMin: 180,
    addedAt: "2025-01-06T00:00:00Z",
  }),
];

const baseInput: BuildRowsInput = {
  continueWatching: [{ mediaItemId: "cw1" }, { mediaItemId: "cw1" }, { mediaItemId: "cw2" }],
  history: [{ mediaItemId: "seed", title: "Watched Space Movie" }],
  catalog,
  simOf: (a, b) => {
    const overlap = (left: string[], right: string[]) => {
      const set = new Set(left);
      return right.filter((value) => set.has(value)).length;
    };
    return (
      overlap(a.genres, b.genres) * 0.24 +
      overlap(a.keywords, b.keywords) * 0.18 +
      overlap(a.cast, b.cast) * 0.12 +
      (a.director && a.director === b.director ? 0.16 : 0)
    );
  },
  limit: 4,
};

function rowByKey(rows: ReturnType<typeof buildSmartRows>, key: string) {
  return rows.find((row) => row.key === key);
}

describe("buildSmartRows", () => {
  it("dedupes continue-watching ids while preserving first-seen order", () => {
    const rows = buildSmartRows(baseInput);
    expect(rowByKey(rows, "continue")?.itemIds).toEqual(["cw1", "cw2"]);
  });

  it("uses strict relatedness for because-you-watched and does not fill with zero-similarity items", () => {
    const rows = buildSmartRows(baseInput);
    const because = rowByKey(rows, "becauseYouWatched");
    expect(because?.itemIds).toEqual(["because-1", "because-2"]);
    expect(because?.itemIds).not.toContain("unrelated-weak");
  });

  it("gives hidden gems and tonight distinct objectives instead of tie-break variants", () => {
    const rows = buildSmartRows(baseInput);
    const hidden = rowByKey(rows, "hiddenGems");
    const tonight = rowByKey(rows, "tonight");

    expect(hidden?.itemIds).toEqual(["hidden-classic", "hidden-cult"]);
    expect(tonight?.itemIds).toEqual(["tonight-short", "tonight-new", "unrelated-weak"]);
  });

  it("does not duplicate items between hidden gems and tonight", () => {
    const rows = buildSmartRows(baseInput);
    const hidden = rowByKey(rows, "hiddenGems")?.itemIds ?? [];
    const tonight = rowByKey(rows, "tonight")?.itemIds ?? [];
    expect(hidden.filter((id) => tonight.includes(id))).toEqual([]);
  });

  it("omits empty rows but keeps the remaining row order stable", () => {
    const allPlayed = catalog.map((entry) => ({ ...entry, playedByProfile: true }));
    const rows = buildSmartRows({
      ...baseInput,
      continueWatching: [],
      catalog: allPlayed,
    });
    expect(rows.map((row) => row.key)).toEqual([]);
  });

  it("is deterministic for identical input", () => {
    expect(buildSmartRows(baseInput)).toEqual(buildSmartRows(baseInput));
  });
});

describe("buildSmartRows — wishlist row", () => {
  it("emits wishlist ids in stored order, keeps played items, drops ids outside the catalog", () => {
    const rows = buildSmartRows({
      ...baseInput,
      wishlist: [
        { mediaItemId: "hidden-classic" },
        { mediaItemId: "seed" }, // played — stays: it's the user's explicit list
        { mediaItemId: "ghost" }, // not in catalog (deleted / kids-blocked) — dropped
        { mediaItemId: "hidden-classic" }, // duplicate — deduped
      ],
    });
    expect(rowByKey(rows, "wishlist")?.itemIds).toEqual(["hidden-classic", "seed"]);
  });

  it("omits the row when the wishlist is empty or absent", () => {
    expect(rowByKey(buildSmartRows(baseInput), "wishlist")).toBeUndefined();
    expect(rowByKey(buildSmartRows({ ...baseInput, wishlist: [] }), "wishlist")).toBeUndefined();
  });

  it("sits between continue and becauseYouWatched", () => {
    const keys = buildSmartRows({
      ...baseInput,
      wishlist: [{ mediaItemId: "hidden-classic" }],
    }).map((row) => row.key);
    expect(keys.indexOf("continue")).toBeLessThan(keys.indexOf("wishlist"));
    expect(keys.indexOf("wishlist")).toBeLessThan(keys.indexOf("becauseYouWatched"));
  });
});

describe("buildSmartRows — recently added row", () => {
  it("lists unplayed items newest-first by addedAt", () => {
    const rows = buildSmartRows(baseInput);
    expect(rowByKey(rows, "recentlyAdded")?.itemIds).toEqual([
      "tonight-new",
      "tonight-short",
      "unrelated-weak",
      "hidden-cult",
    ]);
  });

  it("omits the row when fewer than 4 unplayed items exist", () => {
    const tiny = catalog.slice(0, 4).map((entry, i) => ({ ...entry, playedByProfile: i > 2 }));
    const rows = buildSmartRows({ ...baseInput, catalog: tiny });
    expect(rowByKey(rows, "recentlyAdded")).toBeUndefined();
  });
});

describe("buildSmartRows — genre rows", () => {
  const noSim: BuildRowsInput["simOf"] = () => 0;
  // Unrated, year-less items score below every discovery threshold except
  // genre/tonight membership, keeping these fixtures surgical.
  const plain = (id: string, genre: string, runtimeMin = 100): RowCatalogItem =>
    item({ id, features: features([genre]), runtimeMin });

  it("falls back to catalog frequency for a fresh profile", () => {
    const freshCatalog = [
      ...Array.from({ length: 5 }, (_, i) => plain(`com-${i}`, "Comedy")),
      ...Array.from({ length: 3 }, (_, i) => plain(`hor-${i}`, "Horror")),
    ];
    const rows = buildSmartRows({
      continueWatching: [],
      history: [],
      catalog: freshCatalog,
      simOf: noSim,
      limit: 20,
    });
    const genreRow = rows.find((row) => row.key.startsWith("genre:"));
    expect(genreRow?.key).toBe("genre:Comedy");
    expect(genreRow?.title).toBe("Comedy");
    expect(genreRow?.itemIds).toHaveLength(5);
  });

  it("prefers watch-history genres over denser catalog genres", () => {
    const historyItems = Array.from({ length: 3 }, (_, i) =>
      item({ id: `seen-${i}`, played: true, features: features(["Drama"]) }),
    );
    const dramaCatalog = [
      ...historyItems,
      ...Array.from({ length: 6 }, (_, i) => plain(`dra-${i}`, "Drama")),
      ...Array.from({ length: 8 }, (_, i) => plain(`com-${i}`, "Comedy")),
    ];
    const rows = buildSmartRows({
      continueWatching: [],
      history: historyItems.map((h) => ({ mediaItemId: h.id, title: h.title })),
      catalog: dramaCatalog,
      simOf: noSim,
      // Small limit keeps Tonight from draining the comedy pocket before the
      // second genre row computes.
      limit: 4,
    });
    const genreRows = rows.filter((row) => row.key.startsWith("genre:"));
    expect(genreRows[0]?.key).toBe("genre:Drama");
    // Catalog-frequency genres still backfill the second slot.
    expect(genreRows[1]?.key).toBe("genre:Comedy");
  });

  it("skips genres whose row would fall below the minimum size", () => {
    const sparse = [
      ...Array.from({ length: 3 }, (_, i) => plain(`hor-${i}`, "Horror")),
      ...Array.from({ length: 4 }, (_, i) => plain(`com-${i}`, "Comedy")),
    ];
    const rows = buildSmartRows({
      continueWatching: [],
      history: [],
      catalog: sparse,
      simOf: noSim,
      limit: 20,
    });
    const genreKeys = rows.filter((row) => row.key.startsWith("genre:")).map((row) => row.key);
    expect(genreKeys).toEqual(["genre:Comedy"]);
  });
});

describe("buildSmartRows — critically acclaimed row", () => {
  const noSim: BuildRowsInput["simOf"] = () => 0;

  it("ranks by rating and never includes titles below the acclaim bar", () => {
    // Unique genres → no genre rows; limit 4 keeps hiddenGems/tonight from
    // consuming every acclaimed title before this row computes.
    const acclaimed = Array.from({ length: 12 }, (_, i) =>
      item({
        id: `top-${String(i).padStart(2, "0")}`,
        features: features([`G${i}`]),
        imdbRating: 9 - i * 0.05,
        runtimeMin: 100,
      }),
    );
    const mediocre = Array.from({ length: 3 }, (_, i) =>
      item({ id: `meh-${i}`, features: features([`M${i}`]), imdbRating: 6, runtimeMin: 100 }),
    );
    const rows = buildSmartRows({
      continueWatching: [],
      history: [],
      catalog: [...acclaimed, ...mediocre],
      simOf: noSim,
      limit: 4,
    });
    const top = rowByKey(rows, "topRated");
    expect(top).toBeDefined();
    expect(top!.itemIds.length).toBeGreaterThanOrEqual(4);
    for (const id of top!.itemIds) expect(id).toMatch(/^top-/);
    // No overlap with earlier discovery rows.
    const earlier = new Set(
      rows.filter((r) => r.key !== "topRated" && r.key !== "recentlyAdded").flatMap((r) => r.itemIds),
    );
    for (const id of top!.itemIds) expect(earlier.has(id)).toBe(false);
  });

  it("is omitted when too few acclaimed titles remain", () => {
    const rows = buildSmartRows(baseInput);
    expect(rowByKey(rows, "topRated")).toBeUndefined();
  });
});

describe("buildSmartRows — binge-worthy series row", () => {
  const noSim: BuildRowsInput["simOf"] = () => 0;

  it("only surfaces kind=series items", () => {
    const series = Array.from({ length: 6 }, (_, i) => ({
      ...item({ id: `ser-${i}`, features: features([`S${i}`]) }),
      kind: "series",
    }));
    const movies = Array.from({ length: 4 }, (_, i) =>
      item({ id: `mov-${i}`, features: features([`M${i}`]), runtimeMin: 100 }),
    );
    const rows = buildSmartRows({
      continueWatching: [],
      history: [],
      catalog: [...series, ...movies],
      simOf: noSim,
      limit: 4,
    });
    const seriesRow = rowByKey(rows, "series");
    expect(seriesRow).toBeDefined();
    for (const id of seriesRow!.itemIds) expect(id).toMatch(/^ser-/);
  });

  it("is omitted when the catalog has no series", () => {
    expect(rowByKey(buildSmartRows(baseInput), "series")).toBeUndefined();
  });
});

describe("buildSmartRows — full row ordering", () => {
  it("emits rows in the canonical order on a rich catalog", () => {
    // Sci-fi pocket linked to history by keywords, plus dense genre pockets
    // and a series shelf — enough supply that every row can fill.
    const seedKeywords = ["space", "rescue"];
    const played = Array.from({ length: 3 }, (_, i) =>
      item({
        id: `seen-${i}`,
        title: `Seen ${i}`,
        played: true,
        features: features(["Sci-Fi"], seedKeywords),
        imdbRating: 8,
      }),
    );
    const sciFi = Array.from({ length: 5 }, (_, i) =>
      item({
        id: `sci-${i}`,
        features: features(["Sci-Fi"], seedKeywords),
        imdbRating: 9,
        runtimeMin: 110,
        addedAt: `2025-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const pocket = (prefix: string, genre: string, count: number, imdbRating = 9) =>
      Array.from({ length: count }, (_, i) =>
        item({
          id: `${prefix}-${String(i).padStart(2, "0")}`,
          features: features([genre]),
          imdbRating,
          runtimeMin: 100,
          year: 2000 + i,
          addedAt: `2025-01-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      );
    // Series rate slightly lower so topRated prefers the movie pockets and
    // leaves series supply for the final row.
    const series = pocket("ser", "Action", 20, 8.8).map((entry) => ({ ...entry, kind: "series" }));
    const bigCatalog = [
      ...played,
      ...sciFi,
      ...pocket("com", "Comedy", 20),
      ...pocket("dra", "Drama", 20),
      ...pocket("thr", "Thriller", 20),
      ...series,
    ];

    const rows = buildSmartRows({
      continueWatching: [{ mediaItemId: "seen-0" }],
      history: played.map((h) => ({ mediaItemId: h.id, title: h.title })),
      wishlist: [{ mediaItemId: "com-00" }],
      catalog: bigCatalog,
      simOf: baseInput.simOf,
      limit: 20,
    });

    const keys = rows.map((row) => row.key);
    const genreKeys = keys.filter((key) => key.startsWith("genre:"));
    expect(genreKeys).toHaveLength(2);
    expect(keys).toEqual([
      "continue",
      "wishlist",
      "becauseYouWatched",
      "recentlyAdded",
      "hiddenGems",
      genreKeys[0],
      "tonight",
      genreKeys[1],
      "topRated",
      "series",
    ]);

    // Discovery rows never repeat an item surfaced by an earlier discovery row.
    const discovery = rows.filter((row) => !["continue", "wishlist", "recentlyAdded"].includes(row.key));
    const seenIds = new Set<string>();
    for (const row of discovery) {
      for (const id of row.itemIds.slice(0, row.key === "becauseYouWatched" ? 6 : undefined)) {
        expect(seenIds.has(id)).toBe(false);
      }
      const surfaced = row.key === "becauseYouWatched" ? row.itemIds.slice(0, 6) : row.itemIds;
      for (const id of surfaced) seenIds.add(id);
    }
  });
});
