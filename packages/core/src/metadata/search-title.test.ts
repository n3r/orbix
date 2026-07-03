import { describe, it, expect } from "vitest";
import { cleanSearchTitle, buildQueryLadder } from "./search-title";

describe("cleanSearchTitle", () => {
  // ── Release noise stripped (bucket ①) ─────────────────────────────────────
  it.each([
    ["Django Unchained MPEG-4 AVC BDRemux", "Django Unchained"],
    ["Body of Lies Remux", "Body of Lies"],
    ["16 Blocks (Remux)", "16 Blocks"],
    ["ARMY_OF_ONE_REMUX_HDCLUB", "ARMY OF ONE"],
    ["Indiana Jones and the Last Crusade UHD BDRemux", "Indiana Jones and the Last Crusade"],
    ["The French Dispatch BDRemux", "The French Dispatch"],
  ])("strips trailing release noise: %s", (raw, expected) => {
    expect(cleanSearchTitle(raw)).toBe(expected);
  });

  it("removes a tracker bracket segment", () => {
    expect(cleanSearchTitle("[Taxi 1998] [BDRemux Rutracker.org]")).toBe("Taxi 1998");
  });

  it("strips a trailing 'Remaster' token", () => {
    expect(cleanSearchTitle("Blade Runner Remaster")).toBe("Blade Runner");
  });

  // ── Cyrillic titles truncated at (1080p) (bucket ③) ───────────────────────
  it.each([
    ["Горько! 2 Blu-Ray (", "Горько! 2"],
    ["О чём говорят мужчины Blu-Ray (", "О чём говорят мужчины"],
    ["Пятьдесят оттенков серого Unrated Cut", "Пятьдесят оттенков серого"],
  ])("cleans a Cyrillic noisy title: %s", (raw, expected) => {
    expect(cleanSearchTitle(raw)).toBe(expected);
  });

  // ── Over-cleaning guards ──────────────────────────────────────────────────
  it.each([
    ["The Matrix", "The Matrix"],
    ["Step Up 2 the Streets", "Step Up 2 the Streets"],
    ["Blade Runner 2049", "Blade Runner 2049"], // bare year is NOT noise
    ["The Cut", "The Cut"], // lone "Cut" is NOT an edition trigger
    ["Zheleznyj chelovek 2", "Zheleznyj chelovek 2"], // transliteration untouched
  ])("does not over-clean a real title: %s", (raw, expected) => {
    expect(cleanSearchTitle(raw)).toBe(expected);
  });
});

describe("buildQueryLadder", () => {
  it("puts the cleaned+year attempt first, then drops the year", () => {
    const ladder = buildQueryLadder({ title: "Zheleznyj chelovek 2", year: 2010 });
    expect(ladder[0]).toEqual({ query: "Zheleznyj chelovek 2", year: 2010, yearFiltered: true });
    expect(ladder[1]).toEqual({ query: "Zheleznyj chelovek 2", yearFiltered: false });
  });

  it("includes the raw title as a no-regression fallback when cleaning changed it", () => {
    const ladder = buildQueryLadder({ title: "Body of Lies Remux" });
    const queries = ladder.map((a) => a.query);
    expect(queries).toContain("Body of Lies"); // cleaned
    expect(queries).toContain("Body of Lies Remux"); // raw fallback
  });

  it("dedupes when the cleaned title equals the raw title", () => {
    const ladder = buildQueryLadder({ title: "The Matrix", year: 1999 });
    const keys = ladder.map((a) => `${a.query}|${a.year ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
    // clean === raw, so only the year and no-year variants remain
    expect(ladder).toHaveLength(2);
  });

  it("adds a first-3-tokens attempt only when the clean title is longer", () => {
    const ladder = buildQueryLadder({ title: "Indiana Jones and the Last Crusade UHD BDRemux" });
    expect(ladder.some((a) => a.query === "Indiana Jones and")).toBe(true);
  });

  // ── Parenthetical variants ────────────────────────────────────────────────
  it("adds the parenthesized original title as its own attempt", () => {
    const q = buildQueryLadder({ title: "Экзистенция (eXistenZ) (BDRemux)" }).map((a) => a.query);
    expect(q).toContain("eXistenZ");
  });

  it("adds the outside-parens text as an attempt (drops a director/edition note)", () => {
    const leon = buildQueryLadder({ title: "Леон (авторская версия)" }).map((a) => a.query);
    expect(leon).toContain("Леон");
    const stilyagi = buildQueryLadder({ title: "Стиляги (Валерий Тодоровский)" }).map((a) => a.query);
    expect(stilyagi).toContain("Стиляги");
  });

  it("extracts an English alt-title from a second parenthetical", () => {
    const q = buildQueryLadder({
      title: "Шкатулка проклятия (Одержимость) (The Possession)",
    }).map((a) => a.query);
    expect(q).toContain("The Possession");
  });

  it("never emits a pure-noise parenthetical as a query", () => {
    const q = buildQueryLadder({ title: "Foo (1080p)" }).map((a) => a.query);
    expect(q).not.toContain("1080p");
    expect(q).not.toContain("");
  });
});
