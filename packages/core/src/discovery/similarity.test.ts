import { describe, it, expect } from "vitest";
import { itemSimilarity, qualityScore, rankSimilarItems, type SimItem, type SimilarRankItem } from "./similarity";

describe("itemSimilarity", () => {
  it("returns 1.0 for identical items", () => {
    const item: SimItem = {
      genres: ["Action", "Sci-Fi"],
      keywords: ["robot", "future"],
      cast: ["Alice", "Bob"],
      director: "Director X",
    };
    expect(itemSimilarity(item, item)).toBeCloseTo(1.0, 10);
  });

  it("returns 0 for fully disjoint items with different directors", () => {
    const a: SimItem = {
      genres: ["Action"],
      keywords: ["robot"],
      cast: ["Alice"],
      director: "Director A",
    };
    const b: SimItem = {
      genres: ["Comedy"],
      keywords: ["cat"],
      cast: ["Bob"],
      director: "Director B",
    };
    expect(itemSimilarity(a, b)).toBe(0);
  });

  it("returns 0.1 for shared director only, everything else disjoint or empty", () => {
    const a: SimItem = {
      genres: ["Action"],
      keywords: ["robot"],
      cast: ["Alice"],
      director: "Director X",
    };
    const b: SimItem = {
      genres: ["Comedy"],
      keywords: ["cat"],
      cast: ["Bob"],
      director: "Director X",
    };
    expect(itemSimilarity(a, b)).toBeCloseTo(0.1, 10);
  });

  it("returns correct weighted value for partial overlap", () => {
    // a={genres:["Action","Sci-Fi"],keywords:["robot"],cast:["A","B"],director:"X"}
    // b={genres:["Action"],keywords:["robot","space"],cast:["A"],director:"Y"}
    // J(genres) = |{"Action"}| / |{"Action","Sci-Fi"}| = 1/2 = 0.5
    // J(keywords) = |{"robot"}| / |{"robot","space"}| = 1/2 = 0.5
    // J(cast) = |{"A"}| / |{"A","B"}| = 1/2 = 0.5
    // director: X != Y => 0
    // result = 0.4*0.5 + 0.3*0.5 + 0.2*0.5 + 0.1*0 = 0.2 + 0.15 + 0.1 = 0.45
    const a: SimItem = {
      genres: ["Action", "Sci-Fi"],
      keywords: ["robot"],
      cast: ["A", "B"],
      director: "X",
    };
    const b: SimItem = {
      genres: ["Action"],
      keywords: ["robot", "space"],
      cast: ["A"],
      director: "Y",
    };
    expect(itemSimilarity(a, b)).toBeCloseTo(0.45, 10);
  });

  it("returns 0 (not NaN) when both items have all-empty sets and no director", () => {
    const a: SimItem = { genres: [], keywords: [], cast: [] };
    const b: SimItem = { genres: [], keywords: [], cast: [] };
    const result = itemSimilarity(a, b);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it("normalises feature casing and duplicate values before comparing", () => {
    const a: SimItem = {
      genres: ["Action", "action"],
      keywords: ["Space"],
      cast: ["Alice"],
      director: "Director X",
    };
    const b: SimItem = {
      genres: ["action"],
      keywords: ["space"],
      cast: ["alice"],
      director: "director x",
    };
    expect(itemSimilarity(a, b)).toBeCloseTo(1, 10);
  });
});

describe("qualityScore", () => {
  it("normalises cached provider ratings into one local quality signal", () => {
    expect(qualityScore({ imdbRating: 8, tmdbScore: 7.5, rtRating: 90, metacritic: 70 })).toBeCloseTo(0.7875, 10);
  });

  it("uses a neutral fallback when no ratings are cached", () => {
    expect(qualityScore({})).toBe(0.55);
  });
});

describe("rankSimilarItems", () => {
  const anchor: SimilarRankItem = {
    id: "anchor",
    genres: ["Action", "Crime"],
    keywords: ["heist", "undercover"],
    cast: ["Actor A", "Actor B"],
    director: "Director A",
    year: 2020,
    runtimeSec: 7_200,
    rating: "PG-13",
  };

  it("ranks a specific keyword/director/runtime match above a broad same-genre-only match", () => {
    const ranked = rankSimilarItems({
      anchor,
      candidates: [
        {
          id: "broad-action",
          genres: ["Action"],
          keywords: [],
          cast: [],
          director: "Someone Else",
          year: 2020,
          runtimeSec: 7_200,
          rating: "PG-13",
          imdbRating: 8.5,
        },
        {
          id: "specific-heist",
          genres: ["Crime"],
          keywords: ["heist", "undercover"],
          cast: ["Actor C"],
          director: "Director A",
          year: 2021,
          runtimeSec: 7_500,
          rating: "PG-13",
          imdbRating: 7.1,
        },
      ],
    });

    expect(ranked.map((item) => item.id)).toEqual(["specific-heist", "broad-action"]);
  });

  it("does not return unrelated zero-score fallback filler", () => {
    const ranked = rankSimilarItems({
      anchor,
      candidates: [
        {
          id: "unrelated",
          genres: ["Romance"],
          keywords: ["wedding"],
          cast: ["Actor Z"],
          director: "Director Z",
          imdbRating: 10,
        },
      ],
    });

    expect(ranked).toEqual([]);
  });

  it("uses local embedding scores as one signal but still reranks with structured metadata", () => {
    const ranked = rankSimilarItems({
      anchor,
      candidates: [
        {
          id: "vector-only",
          genres: ["Romance"],
          keywords: ["wedding"],
          cast: [],
          vectorScore: 0.9,
        },
        {
          id: "hybrid-match",
          genres: ["Crime"],
          keywords: ["heist", "undercover"],
          cast: ["Actor A"],
          director: "Director A",
          year: 2020,
          runtimeSec: 7_200,
          rating: "PG-13",
          vectorScore: 0.8,
        },
      ],
    });

    expect(ranked.map((item) => item.id)).toEqual(["hybrid-match", "vector-only"]);
  });

  it("adds MMR-style diversity so near duplicates do not crowd out another relevant cluster", () => {
    const ranked = rankSimilarItems({
      anchor,
      limit: 2,
      diversityPenalty: 0.5,
      candidates: [
        {
          id: "franchise-1",
          genres: ["Action", "Crime"],
          keywords: ["heist", "undercover"],
          cast: ["Actor A"],
          director: "Director A",
        },
        {
          id: "franchise-2",
          genres: ["Action", "Crime"],
          keywords: ["heist", "undercover"],
          cast: ["Actor A"],
          director: "Director A",
        },
        {
          id: "other-cluster",
          genres: ["Action", "Crime"],
          keywords: ["undercover"],
          cast: ["Actor B"],
          director: "Director B",
          imdbRating: 8.8,
        },
      ],
    });

    expect(ranked.map((item) => item.id)).toEqual(["franchise-1", "other-cluster"]);
  });
});
