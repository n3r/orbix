import { describe, it, expect } from "vitest";
import { itemSimilarity, type SimItem } from "./similarity";

const EPSILON = 1e-10;

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
});
