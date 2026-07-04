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
