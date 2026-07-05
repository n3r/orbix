import { describe, it, expect } from "vitest";
import { titleScriptBucket, compareDisplayTitles } from "./alpha-sort";

describe("titleScriptBucket", () => {
  it("buckets by the first letter/digit: Latin 0, Cyrillic 1, other scripts 2, digits/symbols 3", () => {
    expect(titleScriptBucket("Alien")).toBe(0);
    expect(titleScriptBucket("Андрей Рублёв")).toBe(1);
    expect(titleScriptBucket("アキラ")).toBe(2);
    expect(titleScriptBucket("1917")).toBe(3);
    expect(titleScriptBucket("···")).toBe(3);
    expect(titleScriptBucket("")).toBe(3);
  });

  it("skips leading whitespace and punctuation", () => {
    expect(titleScriptBucket("«Брат»")).toBe(1);
    expect(titleScriptBucket("'Round Midnight")).toBe(0);
    expect(titleScriptBucket("  #Alive")).toBe(0);
  });
});

describe("compareDisplayTitles", () => {
  const byEn = compareDisplayTitles("en");

  it("orders Latin before Cyrillic before other scripts before digits", () => {
    const titles = ["1917", "Зеркало", "Alien", "アキラ"];
    expect([...titles].sort(byEn)).toEqual(["Alien", "Зеркало", "アキラ", "1917"]);
  });

  it("is case-insensitive and accent-aware within a bucket", () => {
    expect([...["batman", "Alien"]].sort(byEn)).toEqual(["Alien", "batman"]);
    expect([...["Zodiac", "Émilie"]].sort(byEn)).toEqual(["Émilie", "Zodiac"]);
  });

  it("sorts Cyrillic alphabetically within its bucket", () => {
    const ru = compareDisplayTitles("ru");
    expect([...["Сталкер", "Брат", "Ирония судьбы"]].sort(ru)).toEqual([
      "Брат", "Ирония судьбы", "Сталкер",
    ]);
  });

  it("compares numeric titles numerically", () => {
    expect([...["10 Things I Hate About You", "2 Fast 2 Furious"]].sort(byEn)).toEqual([
      "2 Fast 2 Furious", "10 Things I Hate About You",
    ]);
  });
});
