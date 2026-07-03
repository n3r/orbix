import { describe, it, expect } from "vitest";
import {
  normalizeForMatch,
  levenshtein,
  titleSimilarity,
  scoreCandidate,
  isAcceptable,
  TITLE_STRONG,
} from "./match-score";

describe("normalizeForMatch", () => {
  it("folds accents, lowercases, and collapses punctuation", () => {
    expect(normalizeForMatch("Léon (Director's Cut)")).toBe("leon director s cut");
  });

  it("keeps Cyrillic script intact", () => {
    expect(normalizeForMatch("Горько! 2")).toBe("горько 2");
  });
});

describe("levenshtein", () => {
  it("computes edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("titleSimilarity", () => {
  it("is 1 for an exact (normalized) match", () => {
    expect(titleSimilarity("16 Blocks", { title: "16 Blocks" })).toBe(1);
  });

  it("matches a Cyrillic query against the candidate's originalTitle", () => {
    expect(
      titleSimilarity("Горько! 2", { title: "Gorko 2", originalTitle: "Горько! 2" }),
    ).toBe(1);
  });

  it("scores an unrelated title low", () => {
    expect(titleSimilarity("16 Blocks", { title: "Blocks" })).toBeLessThan(TITLE_STRONG);
  });

  it("boosts a numbered sequel that is a prefix of the candidate's subtitle", () => {
    // "Step Up 2" ⊂ "Step Up 2: The Streets", last query token is the sequel number
    expect(titleSimilarity("Step Up 2", { title: "Step Up 2: The Streets" })).toBeGreaterThanOrEqual(
      TITLE_STRONG,
    );
  });

  it("does NOT boost a non-numbered prefix (guards against Matrix → Matrix Reloaded)", () => {
    expect(titleSimilarity("The Matrix", { title: "The Matrix Reloaded" })).toBeLessThan(TITLE_STRONG);
  });

  it("does NOT boost when the query lacks the sequel number", () => {
    expect(titleSimilarity("Step Up", { title: "Step Up 2: The Streets" })).toBeLessThan(TITLE_STRONG);
  });
});

describe("scoreCandidate", () => {
  it("ranks the correct title above a more-popular wrong one", () => {
    const right = scoreCandidate("16 Blocks", { title: "16 Blocks", voteCount: 2000 });
    const decoy = scoreCandidate("16 Blocks", {
      title: "Blocks",
      popularity: 9999,
      voteCount: 5,
    });
    expect(right).toBeGreaterThan(decoy);
  });

  it("rewards an exact year match", () => {
    const withYear = scoreCandidate("Foo", { title: "Foo", year: 2010 }, 2010);
    const noYear = scoreCandidate("Foo", { title: "Foo", year: 1990 }, 2010);
    expect(withYear).toBeGreaterThan(noYear);
  });
});

describe("isAcceptable", () => {
  const ironMan2 = { title: "Iron Man 2", originalTitle: "Iron Man 2", year: 2010, voteCount: 15000 };
  const frenchDispatch = {
    title: "The French Dispatch of the Liberty, Kansas Evening Sun",
    voteCount: 2000,
  };

  it("accepts a confident string match regardless of year (rule A)", () => {
    expect(isAcceptable("16 Blocks", { title: "16 Blocks" }, undefined, false, false)).toBe(true);
  });

  it("accepts a decent string match with an exact year (rule B)", () => {
    expect(
      isAcceptable("Some Movie", { title: "Some Movie Extended Thing", year: 2010 }, 2010, false, false),
    ).toBe(true);
  });

  it("rejects a decent string match when the year does not match (rule B)", () => {
    expect(
      isAcceptable("Some Movie", { title: "Some Movie Extended Thing", year: 1999 }, 2010, false, false),
    ).toBe(false);
  });

  it("rescues a transliteration on exact year + votes as the top year-filtered hit (rule C)", () => {
    expect(isAcceptable("Zheleznyj chelovek 2", ironMan2, 2010, true, true)).toBe(true);
  });

  it("does NOT rescue a transliteration when the year is absent (rule C)", () => {
    expect(isAcceptable("Zheleznyj chelovek 2", { ...ironMan2, year: undefined }, undefined, true, true)).toBe(
      false,
    );
  });

  it("does NOT rescue below the vote floor (rule C)", () => {
    expect(isAcceptable("Zheleznyj chelovek 2", { ...ironMan2, voteCount: 10 }, 2010, true, true)).toBe(false);
  });

  it("does NOT rescue when it is not the top year-filtered hit (rule C)", () => {
    expect(isAcceptable("Zheleznyj chelovek 2", ironMan2, 2010, false, true)).toBe(false);
  });

  // ── Rule D: prefix rescue (long official titles) ──────────────────────────
  it("accepts a query that is the head of a longer official title as the #1 hit (rule D)", () => {
    expect(isAcceptable("The French Dispatch", frenchDispatch, undefined, true, false)).toBe(true);
  });

  it("does NOT prefix-rescue when the candidate is not the top result (rule D)", () => {
    expect(isAcceptable("The French Dispatch", frenchDispatch, undefined, false, false)).toBe(false);
  });

  it("does NOT prefix-rescue below the vote floor (rule D)", () => {
    expect(isAcceptable("The French Dispatch", { ...frenchDispatch, voteCount: 5 }, undefined, true, false)).toBe(
      false,
    );
  });

  it("does NOT prefix-rescue a single-word query (rule D)", () => {
    expect(isAcceptable("The", { title: "The Matrix", voteCount: 9000 }, undefined, true, false)).toBe(false);
  });

  it("does NOT prefix-rescue when the top result is not a prefix extension (rule D)", () => {
    expect(isAcceptable("Foo Bar", { title: "Completely Different", voteCount: 9000 }, undefined, true, false)).toBe(
      false,
    );
  });
});
