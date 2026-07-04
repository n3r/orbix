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

  it("composes NFD input to NFC (macOS filenames decompose й — TMDB search wants NFC)", () => {
    const nfd = "Облачный атлас".normalize("NFD"); // й becomes и + combining breve
    expect(nfd).not.toBe(nfd.normalize("NFC")); // sanity: the forms differ
    expect(cleanSearchTitle(nfd)).toBe("Облачный атлас".normalize("NFC"));
  });

  it.each([
    ["ALIEN [TC, 40TH ANNIVERSARY REMASTER", "ALIEN"], // TC + trailing junk
    ["Robin Hood_t05", "Robin Hood"], // MakeMKV-style title-number suffix
    ["Some Movie TELESYNC", "Some Movie"],
    ["Some Movie HDTC", "Some Movie"],
  ])("strips rip-source noise: %s", (raw, expected) => {
    expect(cleanSearchTitle(raw)).toBe(expected);
  });

  it("keeps a leading dictionary-noise word that starts a real title (TC 2000)", () => {
    // Leading-position skipping is only safe for STRUCTURED tokens (1080p,
    // x264, t05) — a dictionary word like TC can legitimately start a title.
    expect(cleanSearchTitle("TC 2000")).toBe("TC 2000");
    // ...while a structured leading token is still dropped:
    expect(cleanSearchTitle("1080p The Matrix")).toBe("The Matrix");
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
    // clean === raw, so only the year and no-year variants remain (plus the
    // derived distinctive-token attempt, which never verifies a match)
    expect(ladder.filter((a) => !a.derived)).toHaveLength(2);
  });

  it("adds a first-3-tokens attempt only when the clean title is longer", () => {
    const ladder = buildQueryLadder({ title: "Indiana Jones and the Last Crusade UHD BDRemux" });
    expect(ladder.some((a) => a.query === "Indiana Jones and")).toBe(true);
  });

  it("marks the first-3-tokens attempt as derived (excluded from deep-check verification)", () => {
    const ladder = buildQueryLadder({ title: "Indiana Jones and the Last Crusade UHD BDRemux" });
    const truncated = ladder.find((a) => a.query === "Indiana Jones and");
    expect(truncated?.derived).toBe(true);
    // faithful queries are NOT derived
    expect(ladder[0]!.derived).toBeUndefined();
  });

  it("adds a derived distinctive-token attempt for short queries (surfaces ё-mismatched titles)", () => {
    // TMDB's search index is ё-sensitive: "Омерзительная восьмерка" (filename е)
    // returns zero for the real "Омерзительная восьмёрка". The longest token
    // still surfaces the film; the deep check verifies with the ё-folded full query.
    const ladder = buildQueryLadder({ title: "Омерзительная восьмерка", year: 2015 });
    const derived = ladder.find((a) => a.query === "Омерзительная");
    expect(derived?.derived).toBe(true);
    expect(derived?.language).toBe("ru-RU");
  });

  it("does not add a distinctive-token attempt for a single-token query", () => {
    const ladder = buildQueryLadder({ title: "Kibertaksi" });
    expect(ladder.filter((a) => a.derived).length).toBe(0);
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

  // ── Script-aware language attempts ────────────────────────────────────────
  it("tags Cyrillic queries with ru-RU so returned titles come back localized", () => {
    const ladder = buildQueryLadder({ title: "Побег из Шоушенка", year: 1994 });
    expect(ladder[0]).toEqual({
      query: "Побег из Шоушенка",
      year: 1994,
      yearFiltered: true,
      language: "ru-RU",
    });
  });

  it("does not emit a language-less duplicate of an identical clean query (no 2x API calls)", () => {
    // TMDB's match set is language-independent — when cleaning changed nothing,
    // a language-less raw rung is the same search twice.
    const ladder = buildQueryLadder({ title: "Побег из Шоушенка", year: 1994 });
    const fullQueryAttempts = ladder.filter((a) => a.query === "Побег из Шоушенка");
    expect(fullQueryAttempts.every((a) => a.language === "ru-RU")).toBe(true);
  });

  it("tags a Japanese query with ja-JP", () => {
    const ladder = buildQueryLadder({ title: "千と千尋の神隠し" });
    expect(ladder[0]!.language).toBe("ja-JP");
  });

  it("adds no language tag for Latin-script queries", () => {
    const ladder = buildQueryLadder({ title: "The Matrix", year: 1999 });
    expect(ladder.every((a) => a.language === undefined)).toBe(true);
  });

  // ── Mixed-script (bilingual) names ────────────────────────────────────────
  it("splits a bilingual name into per-script attempts", () => {
    const ladder = buildQueryLadder({ title: "Майкл Клейтон Michael Clayton", year: 2007 });
    expect(ladder).toContainEqual({
      query: "Michael Clayton",
      year: 2007,
      yearFiltered: true,
    });
    expect(ladder).toContainEqual({
      query: "Майкл Клейтон",
      year: 2007,
      yearFiltered: true,
      language: "ru-RU",
    });
  });

  // ── Leading in-title year ─────────────────────────────────────────────────
  it("uses a leading year as the year filter and strips it from the query", () => {
    const ladder = buildQueryLadder({ title: "2007. Майкл Клейтон. Michael Clayton" });
    expect(ladder).toContainEqual({
      query: "Michael Clayton",
      year: 2007,
      yearFiltered: true,
    });
  });

  it("does not treat a title-initial year as a filter when it IS the title", () => {
    // "2012" (the disaster movie) — a bare year-only title must not become a
    // year filter with an empty query.
    const ladder = buildQueryLadder({ title: "2012" });
    expect(ladder.every((a) => a.query.length > 0)).toBe(true);
  });

  // ── Reverse transliteration (romanized Slavic) ────────────────────────────
  it("adds a Cyrillic reverse-transliteration attempt for a romanized title", () => {
    const ladder = buildQueryLadder({ title: "Zheleznyj chelovek 2", year: 2010 });
    expect(ladder).toContainEqual({
      query: "Железный человек 2",
      year: 2010,
      yearFiltered: true,
      language: "ru-RU",
    });
  });

  it("adds no transliteration attempt for a plain English title", () => {
    const ladder = buildQueryLadder({ title: "The Matrix", year: 1999 });
    expect(ladder.some((a) => a.language === "ru-RU")).toBe(false);
  });

  // ── In-title year (last-resort) ───────────────────────────────────────────
  it("adds a year-stripped attempt when the title ends in a plausible year", () => {
    const ladder = buildQueryLadder({ title: "Taxi 1998" });
    expect(ladder).toContainEqual({ query: "Taxi", year: 1998, yearFiltered: true });
    // ...but the full title is still tried first (so an in-title number matches first)
    expect(ladder[0]!.query).toBe("Taxi 1998");
  });

  it("keeps a sci-fi in-title number as the first attempt (Blade Runner 2049)", () => {
    const ladder = buildQueryLadder({ title: "Blade Runner 2049" });
    expect(ladder[0]!.query).toBe("Blade Runner 2049");
    // the year-stripped variant, if present, is the LAST attempt (last resort)
    const stripped = ladder.find((a) => a.query === "Blade Runner");
    if (stripped) expect(ladder[ladder.length - 1]).toBe(stripped);
  });

  it("does not invent a year for a title without a trailing 4-digit year", () => {
    const ladder = buildQueryLadder({ title: "16 Blocks" });
    expect(ladder.every((a) => a.year === undefined)).toBe(true);
  });
});

describe("cartoon/documentary noise (library audit)", () => {
  it("cuts at bare resolutions and upscale tags", () => {
    expect(cleanSearchTitle("Darkwing Duck 1080 Upscale")).toBe("Darkwing Duck");
    expect(cleanSearchTitle("Утиные истории DVD AI Upscale")).toBe("Утиные истории");
  });

  it("keeps titles whose number is part of the name", () => {
    expect(cleanSearchTitle("Blade Runner 2049")).toBe("Blade Runner 2049");
    expect(cleanSearchTitle("Death Race 2000")).toBe("Death Race 2000");
  });

  it("cuts at SAT/IPTV/TV rip tags", () => {
    expect(cleanSearchTitle("Megafactories Supercars Lexus LFA SATRip by Alex Smit")).toBe(
      "Megafactories Supercars Lexus LFA",
    );
    expect(cleanSearchTitle("Дуэль титанов II IPTVRip")).toBe("Дуэль титанов II");
  });

  it("strips a leading [Group] release tag", () => {
    expect(cleanSearchTitle("[Beatrice-Raws] Tonari no Totoro")).toBe("Tonari no Totoro");
    expect(cleanSearchTitle("[DS27]Zootopia+")).toBe("Zootopia+");
  });

  it("never empties a fully bracketed title ([REC])", () => {
    expect(cleanSearchTitle("[REC]")).toBe("REC");
  });

  it("drops .ru / piracy-TLD domain brackets", () => {
    expect(cleanSearchTitle("Korolev-Braun [torrents.ru]")).toBe("Korolev-Braun");
    expect(cleanSearchTitle("Exo-Squad [cartoons.flybb.ru]")).toBe("Exo-Squad");
  });

  it("offers a channel-prefix-free ladder attempt (BBC / Культура)", () => {
    const attempts = buildQueryLadder({ title: "BBC Космос Руководство для начинающих" });
    expect(attempts.some((a) => a.query === "Космос Руководство для начинающих")).toBe(true);
    const ru = buildQueryLadder({ title: "Культура Тайна Млечного Пути" });
    expect(ru.some((a) => a.query === "Тайна Млечного Пути")).toBe(true);
  });

  it("does not invent a channel attempt for titles that merely start with a channel-like word", () => {
    // "Discovery" as the movie's actual first word with no separator context stays intact.
    const attempts = buildQueryLadder({ title: "Discovery" });
    expect(attempts[0]!.query).toBe("Discovery");
    expect(attempts).toHaveLength(1);
  });
});

describe("mixed-script and spelling-variant rescue rungs", () => {
  it("repairs Latin homoglyphs inside a Cyrillic word (Миньoны)", () => {
    const attempts = buildQueryLadder({ title: "Миньoны", year: 2015 });
    expect(attempts.some((a) => a.query === "Миньоны")).toBe(true);
  });

  it("repairs Cyrillic homoglyphs inside a Latin word (Lilо)", () => {
    const attempts = buildQueryLadder({ title: "Lilо and Stitch 2 Stitch Has a Glitch", year: 2005 });
    expect(attempts.some((a) => a.query === "Lilo and Stitch 2 Stitch Has a Glitch")).toBe(true);
  });

  it("adds no repair attempt for clean single-script titles", () => {
    const attempts = buildQueryLadder({ title: "Миньоны", year: 2015 });
    expect(attempts.filter((a) => a.query === "Миньоны" && a.yearFiltered)).toHaveLength(1);
  });

  it("consumes quality tokens after a channel prefix (BBC HD Supervolcano)", () => {
    const attempts = buildQueryLadder({ title: "BBC HD Supervolcano" });
    expect(attempts.some((a) => a.query === "Supervolcano")).toBe(true);
  });

  it("tries the joined spelling of a hyphenated name (Exo-Squad → ExoSquad)", () => {
    const attempts = buildQueryLadder({ title: "Exo-Squad" });
    expect(attempts.some((a) => a.query === "ExoSquad")).toBe(true);
  });

  it("does not join hyphens in multi-word titles beyond the hyphenated word", () => {
    const attempts = buildQueryLadder({ title: "Spider-Man Homecoming" });
    expect(attempts.some((a) => a.query === "SpiderMan Homecoming")).toBe(true);
  });
});

describe("review hardening — bracket titles, dedup, channel tails", () => {
  it("preserves a bracket-title sequel where a bare number follows ([REC] 2)", () => {
    // Must not strip "[REC]" leaving a bare "2" as the primary query.
    const attempts = buildQueryLadder({ title: "[REC] 2", year: 2009 });
    expect(attempts[0]!.query).toBe("REC 2");
    expect(attempts.some((a) => a.query === "2")).toBe(false);
  });

  it("still strips a leading [group] before a letter-led title", () => {
    expect(cleanSearchTitle("[DS27]Zootopia+")).toBe("Zootopia+");
    expect(cleanSearchTitle("[Beatrice-Raws] Tonari no Totoro")).toBe("Tonari no Totoro");
  });

  it("dedups accent/fullwidth variants but keeps a homoglyph-repaired attempt distinct", () => {
    const q = buildQueryLadder({ title: "Миньoны", year: 2015 }).map((a) => `${a.query}|${a.year ?? ""}`);
    // repaired all-Cyrillic attempt survives the dedup
    expect(q).toContain("Миньоны|2015");
    expect(q).toContain("Миньoны|2015");
  });
});
