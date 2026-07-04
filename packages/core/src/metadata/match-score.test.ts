import { describe, it, expect } from "vitest";
import {
  normalizeForMatch,
  repairHomoglyphs,
  levenshtein,
  titleSimilarity,
  scoreCandidate,
  isAcceptable,
  acronymMatches,
  TITLE_STRONG,
} from "./match-score";

describe("normalizeForMatch", () => {
  it("folds accents, lowercases, and collapses punctuation", () => {
    expect(normalizeForMatch("Léon (Director's Cut)")).toBe("leon director s cut");
  });

  it("keeps a pure-Cyrillic title in Cyrillic (no cross-script fold)", () => {
    // Homoglyph folding is MIXED-script only, so a pure-Cyrillic title is left
    // in Cyrillic and can never collide with a Latin lookalike.
    expect(normalizeForMatch("Горько! 2")).toBe("горько 2");
    expect(normalizeForMatch("Горько! 2")).toBe(normalizeForMatch("горько 2"));
  });

  it("folds fullwidth characters (common in CJK filenames)", () => {
    expect(normalizeForMatch("Ｇｏｄｚｉｌｌａ！ ２０１４")).toBe("godzilla 2014");
  });
});

describe("acronymMatches", () => {
  const HAT = "Dungeons & Dragons: Honor Among Thieves";

  it("matches trailing initials against the candidate's subtitle words", () => {
    expect(acronymMatches("Dungeons and Dragons H A T", HAT)).toBe(true);
  });

  it("does not fire without initials", () => {
    expect(acronymMatches("Dungeons and Dragons", HAT)).toBe(false);
  });

  it("does not fire when an initial mismatches", () => {
    expect(acronymMatches("Dungeons and Dragons H A X", HAT)).toBe(false);
  });

  it("requires all remaining candidate words to be consumed by initials", () => {
    expect(acronymMatches("Dungeons and Dragons H A", HAT)).toBe(false);
  });

  it("requires at least one word token before the initials", () => {
    expect(acronymMatches("H A T", HAT)).toBe(false);
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

  it("caps similarity when the query's leading disc/part number is absent from the candidate", () => {
    // "3 Возвращение Короля" is disc 3 of a trilogy folder — the bare-titled
    // 1980 animated "Возвращение Короля" must NOT be a confident match.
    expect(
      titleSimilarity("3 Возвращение Короля", { title: "Возвращение Короля" }),
    ).toBeLessThan(TITLE_STRONG);
  });

  it("does not cap when the candidate carries the same leading number", () => {
    expect(
      titleSimilarity("12 разгневанных мужчин", { title: "12 разгневанных мужчин" }),
    ).toBe(1);
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
    expect(isAcceptable("16 Blocks", { title: "16 Blocks" }, undefined, false)).toBe(true);
  });

  it("accepts a decent string match with an exact year (rule B)", () => {
    expect(isAcceptable("Some Movie", { title: "Some Movie Extended Thing", year: 2010 }, 2010, false)).toBe(true);
  });

  it("rejects a decent string match when the year does not match (rule B)", () => {
    expect(isAcceptable("Some Movie", { title: "Some Movie Extended Thing", year: 1999 }, 2010, false)).toBe(false);
  });

  it("does NOT accept a low-similarity candidate on an exact year alone (no year-only rescue)", () => {
    // Formerly "rule C". Removed: it matched garbage — a title the parser mangled
    // to one letter would be accepted against a random same-year film.
    expect(isAcceptable("Zheleznyj chelovek 2", ironMan2, 2010, true)).toBe(false);
    expect(isAcceptable("М", { title: "Some 2022 Film", year: 2022, voteCount: 500 }, 2022, true)).toBe(false);
  });

  // ── Rule D: prefix rescue (long official titles) ──────────────────────────
  it("accepts a query that is the head of a longer official title as the #1 hit (rule D)", () => {
    expect(isAcceptable("The French Dispatch", frenchDispatch, undefined, true)).toBe(true);
  });

  it("does NOT prefix-rescue when the candidate is not the top result (rule D)", () => {
    expect(isAcceptable("The French Dispatch", frenchDispatch, undefined, false)).toBe(false);
  });

  it("does NOT prefix-rescue below the vote floor (rule D)", () => {
    expect(isAcceptable("The French Dispatch", { ...frenchDispatch, voteCount: 5 }, undefined, true)).toBe(false);
  });

  it("does NOT prefix-rescue a single-word query (rule D)", () => {
    expect(isAcceptable("The", { title: "The Matrix", voteCount: 9000 }, undefined, true)).toBe(false);
  });

  it("does NOT prefix-rescue when the top result is not a prefix extension (rule D)", () => {
    expect(isAcceptable("Foo Bar", { title: "Completely Different", voteCount: 9000 }, undefined, true)).toBe(false);
  });
});

describe("degenerate numeric queries", () => {
  it("never accepts a single-digit or zero-led query without a year (episode-leak garbage)", () => {
    expect(isAcceptable("9", { title: "9", year: 2009, voteCount: 2000 }, undefined, true)).toBe(false);
    expect(isAcceptable("01", { title: "01", year: 2003, voteCount: 100 }, undefined, true)).toBe(false);
    expect(isAcceptable("(09)", { title: "09", year: 2014, voteCount: 50 }, undefined, true)).toBe(false);
  });

  it("accepts a short numeric title when the year corroborates it", () => {
    const nine = { title: "9", year: 2009, voteCount: 2000 };
    expect(isAcceptable("9", nine, 2009, true)).toBe(true);
  });

  it("keeps two-digit titles matchable without a year (shows and films named 24/86/10)", () => {
    expect(isAcceptable("24", { title: "24", year: 2001, voteCount: 3000 }, undefined, true)).toBe(true);
    expect(isAcceptable("86", { title: "86", year: 2021, voteCount: 800 }, undefined, true)).toBe(true);
  });

  it("leaves longer numeric titles alone (1917, 2012)", () => {
    const m1917 = { title: "1917", year: 2019, voteCount: 9000 };
    expect(isAcceptable("1917", m1917, undefined, true)).toBe(true);
  });
});

describe("Latin/Cyrillic homoglyph folding", () => {
  it("treats a mixed-script title as equal to its pure-Cyrillic form", () => {
    // "Миньoны" from the NAS carries a LATIN "o" — visually identical.
    expect(normalizeForMatch("Миньoны")).toBe(normalizeForMatch("Миньоны"));
    expect(titleSimilarity("Миньoны", { title: "Миньоны" })).toBe(1);
  });

  it("folds the common homoglyph set both ways", () => {
    expect(normalizeForMatch("Lilо and Stitch")).toBe(normalizeForMatch("Lilo and Stitch"));
  });

  it("does not conflate genuinely different Cyrillic words with Latin ones", () => {
    expect(normalizeForMatch("щит")).not.toBe(normalizeForMatch("shield"));
  });
});

describe("mixed-script homoglyph repair (review hardening)", () => {
  it("repairs a lone Latin twin inside a Cyrillic word toward Cyrillic", () => {
    expect(repairHomoglyphs("Миньoны")).toBe("Миньоны"); // Latin o → Cyrillic о
    expect(normalizeForMatch("Миньoны")).toBe(normalizeForMatch("Миньоны"));
  });

  it("repairs a lone Cyrillic twin inside a Latin word toward Latin", () => {
    expect(repairHomoglyphs("Lilо")).toBe("Lilo"); // Cyrillic о → Latin o
  });

  it("leaves a genuine bilingual token intact (minority > 2 letters)", () => {
    expect(repairHomoglyphs("BBC-Космос")).toBe("BBC-Космос");
  });

  it("never folds a pure single-script token", () => {
    expect(repairHomoglyphs("сор")).toBe("сор");
    expect(normalizeForMatch("сор")).not.toBe(normalizeForMatch("cop"));
  });
});
