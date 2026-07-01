import { describe, it, expect } from "vitest";
import { parseMediaPath } from "./parse";

describe("parseMediaPath", () => {
  it("extracts title + year from 'Title (2010)/Title (2010).mkv'", () => {
    const r = parseMediaPath("/m/The Matrix (1999)/The Matrix (1999).mkv");
    expect(r.title).toBe("The Matrix");
    expect(r.year).toBe(1999);
  });

  it("prefers the folder year when filename year differs", () => {
    const r = parseMediaPath(
      "/m/Blade Runner (1982)/Blade Runner (1992 remaster).mkv"
    );
    expect(r.year).toBe(1982);
  });

  it("trusts an embedded tmdb id", () => {
    const r = parseMediaPath("/m/Some Movie (2020) [tmdbid-603]/file.mkv");
    expect(r.tmdbId).toBe(603);
  });

  it("extracts an embedded imdb id", () => {
    const r = parseMediaPath(
      "/m/The Godfather (1972) [imdbid-tt0068646]/The Godfather.mkv"
    );
    expect(r.imdbId).toBe("tt0068646");
    expect(r.year).toBe(1972);
  });

  it("handles a scene-style filename with no parens year", () => {
    const r = parseMediaPath(
      "/m/Interstellar (2014)/Interstellar.2014.1080p.BluRay.mkv"
    );
    expect(r.title).toBe("Interstellar");
    expect(r.year).toBe(2014);
  });

  it("does not flag a normal movie as an episode", () => {
    const r = parseMediaPath("/m/The Matrix (1999)/The Matrix (1999).mkv");
    expect(r.seasonNumber).toBeUndefined();
    expect(r.episodeNumber).toBeUndefined();
  });

  describe("TV episodes", () => {
    it("parses SxxExx with a Season folder, using the show folder for title+year", () => {
      const r = parseMediaPath("/tv/Arcane (2021)/Season 01/Arcane.S01E03.1080p.mkv");
      expect(r.title).toBe("Arcane");
      expect(r.year).toBe(2021);
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(3);
    });

    it("parses a flat SxxExx filename (no season folder)", () => {
      const r = parseMediaPath("/tv/Breaking Bad/Breaking.Bad.S05E14.mkv");
      expect(r.title).toBe("Breaking Bad");
      expect(r.seasonNumber).toBe(5);
      expect(r.episodeNumber).toBe(14);
    });

    it("parses the 1x02 form", () => {
      const r = parseMediaPath("/tv/The Office/The Office 3x07.mkv");
      expect(r.seasonNumber).toBe(3);
      expect(r.episodeNumber).toBe(7);
    });

    it("derives the episode from a Season folder + anime-style trailing number", () => {
      const r = parseMediaPath("/tv/Frieren (2023)/Season 01/Frieren - 12.mkv");
      expect(r.title).toBe("Frieren");
      expect(r.year).toBe(2023);
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(12);
    });

    it("treats a Specials folder as season 0", () => {
      const r = parseMediaPath("/tv/Show (2020)/Specials/Show - 02.mkv");
      expect(r.seasonNumber).toBe(0);
      expect(r.episodeNumber).toBe(2);
    });

    it("parses a Cyrillic 'NN сезон' folder + leading 'NN. Title' episode", () => {
      const r = parseMediaPath(
        "/tv/Сериал/Сериал.2010-2019.WEBRip 720p/02 сезон/100. Тест.mp4",
      );
      expect(r.title).toBe("Сериал");
      expect(r.seasonNumber).toBe(2);
      expect(r.episodeNumber).toBe(100);
    });

    it("parses the 'сезон N' order and a 'серия N' episode", () => {
      const r = parseMediaPath("/tv/Сериал/Сезон 3/Сериал серия 5.mp4");
      expect(r.seasonNumber).toBe(3);
      expect(r.episodeNumber).toBe(5);
    });
  });
});
