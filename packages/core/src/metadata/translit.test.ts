import { describe, it, expect } from "vitest";
import { looksRomanizedSlavic, reverseTransliterateRu } from "./translit";

// ---------------------------------------------------------------------------
// Corpus: real romanized filenames from the target library, asserted against
// what the mapping table actually produces. Where that differs from the true
// Russian title, the comment records the truth and the Levenshtein distance —
// every miss stays well inside the downstream fuzzy acceptance gate
// (ratio ≥ 0.85, or ≥ 0.55 with an exact year), which is the contract this
// module is held to.
// ---------------------------------------------------------------------------
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ["Zheleznyj chelovek 2", "Железный человек 2"], // exact
  ["Shag vpered 3", "Шаг вперед 3"], // exact
  ["Dvizhenie vverh", "Движение вверх"], // exact
  ["Hroniki Narnii", "Хроники Нарнии"], // exact
  ["Holop Velikolepnyj vek", "Холоп Великолепный век"], // exact
  ["Pobediteli Shou", "Победители Шоу"], // exact
  // true "Обитель зла Возмездие" — dist 1 (the source never encoded the ь)
  ["Obitel zla Vozmezdie", "Обител зла Возмездие"],
  ["Dnyuha", "Днюха"], // exact
  ["Kibertaksi", "Кибертакси"], // exact
  ["Dyhanie", "Дыхание"], // exact
  ["Hitrovka Znak chetyrekh", "Хитровка Знак четырех"], // exact
  ["Manyunya Priklyucheniya v derevne", "Манюня Приключения в деревне"], // exact
  // true "Большой год" — dist 1 (missing ь)
  ["Bolshoj god", "Болшой год"],
  // true "Ирония Судьбы Продолжение" — dist 1 (missing ь in "Судьбы";
  // j→ж before a vowel renders "Продолжение" itself exactly)
  ["Ironiya Sudby Prodoljenie", "Ирония Судбы Продолжение"],
  ["Obitaemiy Ostrov", "Обитаемый Остров"], // exact (word-final iy → ый)
  // true "Этерна Часть первая" — dist 1 (missing ь in "Часть";
  // word-initial e→э renders "Этерна" exactly)
  ["Eterna Chast pervaya", "Этерна Част первая"],
  // true "О чем говорят мужчины Простые удовольствия" — dist 1 (missing ь)
  [
    "O chem govoryat muzhchiny Prostye udovolstviya",
    "О чем говорят мужчины Простые удоволствия",
  ],
];

/** English titles that must NOT trip the romanization gate. */
const PLAIN_ENGLISH = ["The Matrix", "Inception", "Heat", "Interstellar", "The Godfather"];

describe("looksRomanizedSlavic", () => {
  it("flags digraph-heavy romanizations", () => {
    expect(looksRomanizedSlavic("Zheleznyj chelovek 2")).toBe(true);
    expect(looksRomanizedSlavic("Dvizhenie vverh")).toBe(true);
    expect(looksRomanizedSlavic("Kibertaksi")).toBe(true);
    expect(looksRomanizedSlavic("Holop Velikolepnyj vek")).toBe(true);
  });

  // The gate exists to decide whether the Cyrillic search is worth attempting,
  // so every romanized filename in the library corpus must pass it.
  for (const [input] of CORPUS) {
    it(`flags corpus filename "${input}"`, () => {
      expect(looksRomanizedSlavic(input)).toBe(true);
    });
  }

  for (const title of PLAIN_ENGLISH) {
    it(`does not flag plain English "${title}"`, () => {
      expect(looksRomanizedSlavic(title)).toBe(false);
    });
  }
});

describe("reverseTransliterateRu", () => {
  for (const [input, expected] of CORPUS) {
    it(`maps "${input}" → "${expected}"`, () => {
      expect(reverseTransliterateRu(input)).toBe(expected);
    });
  }

  it("returns null when there are no Latin letters to convert", () => {
    expect(reverseTransliterateRu("")).toBeNull();
    expect(reverseTransliterateRu("12345")).toBeNull();
    expect(reverseTransliterateRu("2010 — !?")).toBeNull();
  });

  it("passes digits and punctuation through unchanged", () => {
    expect(reverseTransliterateRu("Shag vpered 3")).toContain("3");
    expect(reverseTransliterateRu("Kin-dza-dza")).toBe("Кин-дза-дза");
  });

  it("preserves the capitalization of the source word", () => {
    expect(reverseTransliterateRu("Dnyuha")?.startsWith("Д")).toBe(true);
    expect(reverseTransliterateRu("dnyuha")).toBe("днюха");
  });

  it("maps an apostrophe to a soft sign", () => {
    expect(reverseTransliterateRu("Obitel'")).toBe("Обитель");
  });
});
