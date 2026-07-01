import { describe, it, expect } from "vitest";
import { localizeItem, localizeName, localizeGenres, tmdbLanguageTag, tvdbLanguageTag } from "./localize";

describe("tmdbLanguageTag", () => {
  it("maps known codes", () => {
    expect(tmdbLanguageTag("en")).toBe("en-US");
    expect(tmdbLanguageTag("es")).toBe("es-ES");
    expect(tmdbLanguageTag("pt")).toBe("pt-BR");
    expect(tmdbLanguageTag("ru")).toBe("ru-RU");
  });
  it("defaults unknown codes to en-US", () => {
    expect(tmdbLanguageTag("zz")).toBe("en-US");
  });
});

describe("tvdbLanguageTag", () => {
  it("maps known 2-letter codes to 3-letter ISO 639-2", () => {
    expect(tvdbLanguageTag("en")).toBe("eng");
    expect(tvdbLanguageTag("es")).toBe("spa");
    expect(tvdbLanguageTag("de")).toBe("deu");
    expect(tvdbLanguageTag("pt")).toBe("por");
    expect(tvdbLanguageTag("ru")).toBe("rus");
    expect(tvdbLanguageTag("fr")).toBe("fra");
  });
  it("defaults unknown codes to eng", () => {
    expect(tvdbLanguageTag("zz")).toBe("eng");
  });
});

describe("localizeItem", () => {
  it("prefers a non-empty translation, else base", () => {
    expect(localizeItem({ title: "A", overview: "o" }, { title: "Á", overview: null }))
      .toEqual({ title: "Á", overview: "o" });
  });
  it("ignores empty/whitespace translation strings", () => {
    expect(localizeItem({ title: "A", overview: "o" }, { title: "  " }).title).toBe("A");
  });
  it("returns base unchanged when there is no translation", () => {
    expect(localizeItem({ title: "A", overview: "o" })).toEqual({ title: "A", overview: "o" });
  });
  it("preserves extra fields on the base", () => {
    expect(localizeItem({ id: "x", title: "A", overview: "o", year: 1999 }, { title: "Á" }))
      .toEqual({ id: "x", title: "Á", overview: "o", year: 1999 });
  });
});

describe("localizeName", () => {
  it("prefers a non-empty translation name/overview, else base", () => {
    expect(localizeName({ name: "Season 1", overview: "o" }, { name: "Temporada 1", overview: null }))
      .toEqual({ name: "Temporada 1", overview: "o" });
  });
  it("returns base when no translation", () => {
    expect(localizeName({ name: "S1", overview: null })).toEqual({ name: "S1", overview: null });
  });
  it("ignores empty translation strings", () => {
    expect(localizeName({ name: "S1", overview: "o" }, { name: "  " }).name).toBe("S1");
  });
});

describe("localizeGenres", () => {
  it("localizes by tmdbId, falling back to base name", () => {
    expect(
      localizeGenres(
        [
          { tmdbId: 1, name: "Action" },
          { tmdbId: 2, name: "Drama" },
          { tmdbId: null, name: "Custom" },
        ],
        new Map([[1, "Acción"]]),
      ),
    ).toEqual([{ name: "Acción" }, { name: "Drama" }, { name: "Custom" }]);
  });
});
