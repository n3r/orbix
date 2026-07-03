import { describe, it, expect } from "vitest";
import { dominantScript, tmdbLanguageForScript, scriptRuns } from "./script";

describe("dominantScript", () => {
  it("detects Cyrillic", () => {
    expect(dominantScript("Побег из Шоушенка")).toBe("cyrillic");
  });

  it("detects Latin", () => {
    expect(dominantScript("The Matrix")).toBe("latin");
  });

  it("classifies a Han+Kana mix as kana (Japanese titles interleave kanji and kana)", () => {
    expect(dominantScript("千と千尋の神隠し")).toBe("kana");
  });

  it("classifies pure Han (no kana) as han (Chinese)", () => {
    expect(dominantScript("英雄")).toBe("han");
  });

  it("detects Hangul", () => {
    expect(dominantScript("기생충")).toBe("hangul");
  });

  it("detects Devanagari", () => {
    expect(dominantScript("दंगल")).toBe("devanagari");
  });

  it("detects Thai", () => {
    expect(dominantScript("สัปเหร่อ")).toBe("thai");
  });

  it("returns null when the string has no classifiable letters", () => {
    expect(dominantScript("")).toBeNull();
    expect(dominantScript("2049 — !!")).toBeNull();
  });
});

describe("tmdbLanguageForScript", () => {
  it("maps each script to its TMDB search-language tag", () => {
    expect(tmdbLanguageForScript("cyrillic")).toBe("ru-RU");
    expect(tmdbLanguageForScript("han")).toBe("zh-CN");
    expect(tmdbLanguageForScript("kana")).toBe("ja-JP");
    expect(tmdbLanguageForScript("hangul")).toBe("ko-KR");
    expect(tmdbLanguageForScript("devanagari")).toBe("hi-IN");
    expect(tmdbLanguageForScript("thai")).toBe("th-TH");
    expect(tmdbLanguageForScript("arabic")).toBe("ar-SA");
    expect(tmdbLanguageForScript("hebrew")).toBe("he-IL");
    expect(tmdbLanguageForScript("greek")).toBe("el-GR");
    expect(tmdbLanguageForScript("georgian")).toBe("ka-GE");
    expect(tmdbLanguageForScript("armenian")).toBe("hy-AM");
    expect(tmdbLanguageForScript("tamil")).toBe("ta-IN");
    expect(tmdbLanguageForScript("telugu")).toBe("te-IN");
    expect(tmdbLanguageForScript("bengali")).toBe("bn-BD");
  });

  it("returns null for latin — too ambiguous (en/pt/es/fr/de...)", () => {
    expect(tmdbLanguageForScript("latin")).toBeNull();
  });
});

describe("scriptRuns", () => {
  it("splits a Cyrillic title glued to its English one", () => {
    expect(scriptRuns("Майкл Клейтон Michael Clayton")).toEqual([
      { script: "cyrillic", text: "Майкл Клейтон" },
      { script: "latin", text: "Michael Clayton" },
    ]);
  });

  it("splits another bilingual title into 2 runs", () => {
    expect(scriptRuns("Шкатулка проклятия The Possession")).toEqual([
      { script: "cyrillic", text: "Шкатулка проклятия" },
      { script: "latin", text: "The Possession" },
    ]);
  });

  it("keeps a single-script title as one run", () => {
    expect(scriptRuns("The Matrix")).toEqual([{ script: "latin", text: "The Matrix" }]);
  });

  it("merges an interleaved Han+Kana title into a single kana run", () => {
    expect(scriptRuns("千と千尋の神隠し")).toEqual([{ script: "kana", text: "千と千尋の神隠し" }]);
  });

  it("does not fragment a 1-letter Latin word from a same-script neighbor separated only by a space", () => {
    // "v" and "derevne" are both Latin, separated only by a space. A run only
    // ever breaks on an actual script change (not on whitespace), so the two
    // are already a single run before the <2-letter merge pass ever runs —
    // the sensible, and simplest, outcome: 2 runs total, not 3.
    expect(scriptRuns("Приключения v derevne")).toEqual([
      { script: "cyrillic", text: "Приключения" },
      { script: "latin", text: "v derevne" },
    ]);
  });

  it("merges a 1-letter run sandwiched between same-script neighbors into one run", () => {
    // Chosen merge semantics: a run left with under 2 letters is absorbed
    // into a neighbor (the previous run, when one exists) instead of
    // surviving as its own fragment. Here the stray Latin "x" merges into the
    // preceding Cyrillic run, which then sits flush against more Cyrillic on
    // its other side, so the whole title collapses into one run.
    expect(scriptRuns("Это x Пример")).toEqual([{ script: "cyrillic", text: "Это x Пример" }]);
  });
});
