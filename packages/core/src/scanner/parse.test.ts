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

  describe("mangled Cyrillic titles", () => {
    // @ctrl/video-filename-parser collapses a multi-word Cyrillic title to its
    // first letter once a year is present — recover it from the raw name.
    it("recovers a Cyrillic title mangled to a single letter (parenthesized year)", () => {
      const r = parseMediaPath("/media/Films/Мажор в сочи (2022) (4K HDR, 5.1).mkv");
      expect(r.title).toBe("Мажор в сочи");
      expect(r.year).toBe(2022);
    });

    it("recovers a dot-separated Cyrillic title", () => {
      const r = parseMediaPath("/media/Films/Побег из Шоушенка.1994.Hybrid.UHD.Blu-Ray.Remux.2160p.mkv");
      expect(r.title).toBe("Побег из Шоушенка");
      expect(r.year).toBe(1994);
    });

    it("does not over-extend a legitimately short title", () => {
      const r = parseMediaPath("/media/Films/M (1931).mkv");
      expect(r.title).toBe("M");
      expect(r.year).toBe(1931);
    });

    it("leaves a normal Latin title untouched", () => {
      const r = parseMediaPath("/media/Films/Django Unchained (2012).mkv");
      expect(r.title).toBe("Django Unchained");
      expect(r.year).toBe(2012);
    });
  });

  describe("collection folders", () => {
    it("keeps per-file titles inside a year-bearing collection folder (no folder-title takeover)", () => {
      // "Властелин колец (2001)/1 Братство кольца.mkv" — preferring the folder
      // title would give every disc the same title and dedupe would collapse
      // the trilogy into one movie.
      const r = parseMediaPath("/m/Властелин колец (2001)/1 Братство кольца.mkv");
      expect(r.title).not.toBe("Властелин колец");
      expect(r.year).toBe(2001);
    });

    it("keeps the filename title when the filename itself has a year", () => {
      const r = parseMediaPath("/m/Interstellar (2014)/Interstellar.2014.1080p.BluRay.mkv");
      expect(r.title).toBe("Interstellar");
      expect(r.year).toBe(2014);
    });

    it("parses a root-level file without inventing a year", () => {
      const r = parseMediaPath("/media/Films/Body of Lies Remux.mkv");
      expect(r.title).toBe("Body of Lies Remux");
      expect(r.year).toBeUndefined();
    });
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

    it("NFC-composes an NFD show folder (macOS paths) for episodes in a Season folder", () => {
      const show = "Тайный город (2014)".normalize("NFD"); // й decomposes
      const r = parseMediaPath(`/tv/${show}/Season 01/S01E02.mkv`);
      expect(r.title).toBe("Тайный город".normalize("NFC"));
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(2);
    });

    it("detects a bare 'Серия N' mini-series (no season folder), defaulting season to 1", () => {
      const r = parseMediaPath("/m/Films/12 Стульев/12 Стульев. Серия 3.mkv");
      expect(r.title).toBe("12 Стульев");
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(3);
    });

    it("detects the first episode of a bare mini-series", () => {
      const r = parseMediaPath("/m/Films/12 Стульев/12 Стульев. Серия 1.mkv");
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(1);
    });

    it("detects the Ukrainian 'Серія' variant", () => {
      const r = parseMediaPath("/m/Films/Показ/Показ. Серія 2.mkv");
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(2);
    });

    it("lets an explicit Season folder override the default mini-series season", () => {
      const r = parseMediaPath("/tv/Show (2020)/Season 02/Show. Серия 5.mkv");
      expect(r.seasonNumber).toBe(2);
      expect(r.episodeNumber).toBe(5);
    });

    it("does not treat a bare trailing number as an episode", () => {
      const r = parseMediaPath("/m/Apollo 13 (1995)/Apollo 13.mkv");
      expect(r.seasonNumber).toBeUndefined();
      expect(r.episodeNumber).toBeUndefined();
    });

    it("does not treat 'Vol. N' as an episode", () => {
      const r = parseMediaPath("/m/Kill Bill Vol. 1 (2003)/Kill Bill Vol. 1.mkv");
      expect(r.seasonNumber).toBeUndefined();
      expect(r.episodeNumber).toBeUndefined();
    });
  });

  describe("anime episodes", () => {
    it("parses a fansub '[Group] Title - NN (quality)' file, titling from the show folder", () => {
      const r = parseMediaPath(
        "/media/Anime/Attack on Titan/[SubsPlease] Attack on Titan - 05 (1080p).mkv",
      );
      expect(r.title).toBe("Attack on Titan");
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(5);
    });

    it("accepts absolute episode numbers above 99", () => {
      const r = parseMediaPath(
        "/media/Anime/Attack on Titan/[SubsPlease] Attack on Titan - 137 (1080p).mkv",
      );
      expect(r.title).toBe("Attack on Titan");
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(137);
    });

    it("supports an en-dash episode marker and a bracketed v2 tag", () => {
      const r = parseMediaPath("/media/Anime/Frieren/[Erai-raws] Frieren – 12 [v2].mkv");
      expect(r.title).toBe("Frieren");
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(12);
    });

    it("tolerates a bare vN suffix glued to the episode number", () => {
      const r = parseMediaPath("/media/Anime/Frieren/[SubsPlease] Frieren - 03v2 (720p).mkv");
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(3);
    });

    it("detects a folder-echo episode with dot separators (no group tag)", () => {
      const r = parseMediaPath("/a/Vinland Saga/Vinland.Saga.-.03.mkv");
      expect(r.title).toBe("Vinland Saga");
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(3);
    });

    it("detects the canonical no-group anime layout '<Folder>/<Folder> - NN'", () => {
      const r = parseMediaPath("/media/Anime/Attack on Titan/Attack on Titan - 05.mkv");
      expect(r.title).toBe("Attack on Titan");
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(5);
    });

    it("falls back to the filename text between the group tag and the marker when no folder exists", () => {
      const r = parseMediaPath("/[SubsPlease] Neon Genesis - 07.mkv");
      expect(r.title).toBe("Neon Genesis");
      expect(r.seasonNumber).toBe(1);
      expect(r.episodeNumber).toBe(7);
    });

    it("does not treat a tracker/site bracket tag as a fansub group", () => {
      const r = parseMediaPath("/m/Films/[Taxi 1998] [BDRemux Rutracker.org].mkv");
      expect(r.seasonNumber).toBeUndefined();
      expect(r.episodeNumber).toBeUndefined();
    });

    it("ignores a '- NN' marker behind a leading tracker/domain tag", () => {
      const r = parseMediaPath("/m/Downloads/[Rutracker.org] Taxi - 98.mkv");
      expect(r.seasonNumber).toBeUndefined();
      expect(r.episodeNumber).toBeUndefined();
    });

    it("keeps a plain movie without any episode marker a movie", () => {
      const r = parseMediaPath("/m/Heat (1995)/Heat.mkv");
      expect(r.seasonNumber).toBeUndefined();
      expect(r.episodeNumber).toBeUndefined();
    });

    it("does not fire folder-echo when the folder does not echo the filename", () => {
      const r = parseMediaPath("/m/Movies/Heat - 2.mkv");
      expect(r.seasonNumber).toBeUndefined();
      expect(r.episodeNumber).toBeUndefined();
    });

    it("keeps a year-titled movie a movie (no '- NN' marker at all)", () => {
      const r = parseMediaPath("/m/Blade Runner 2049/Blade Runner 2049.mkv");
      expect(r.seasonNumber).toBeUndefined();
      expect(r.episodeNumber).toBeUndefined();
    });

    it("treats a trailing 4-digit '- NNNN' as a year, never an episode", () => {
      const r = parseMediaPath("/m/Blade Runner/Blade Runner - 2049.mkv");
      expect(r.seasonNumber).toBeUndefined();
      expect(r.episodeNumber).toBeUndefined();
    });

    it("lets an explicit SxxExx win over the fansub rule", () => {
      const r = parseMediaPath("/tv/Show/[Group] Show S02E05.mkv");
      expect(r.title).toBe("Show");
      expect(r.seasonNumber).toBe(2);
      expect(r.episodeNumber).toBe(5);
    });

    it("lets a Season folder win over the fansub rule (en-dash episode included)", () => {
      const r = parseMediaPath("/tv/Frieren (2023)/Season 02/[Erai-raws] Frieren – 12.mkv");
      expect(r.seasonNumber).toBe(2);
      expect(r.episodeNumber).toBe(12);
    });
  });
});

describe("real-world season layouts", () => {
  it("recognizes a season folder with junk suffix and a parenthetical", () => {
    const r = parseMediaPath(
      "/media/Series/Лексс (LEXX)/Сезон 4 (Season 4) 2001-2002/1. Маленькая голубая планета (Little Blue Planet).mkv",
    );
    expect(r.title).toBe("Лексс");
    expect(r.seasonNumber).toBe(4);
    expect(r.episodeNumber).toBe(1);
  });

  it("recognizes 'Season NN (junk)' and a leading-number episode", () => {
    const r = parseMediaPath("/media/Series/Family Guy/Family Guy Season 11 (WEB-DL 1080p)/05. Joe's Revenge.mkv");
    expect(r.title).toBe("Family Guy");
    expect(r.seasonNumber).toBe(11);
    expect(r.episodeNumber).toBe(5);
  });

  it("recognizes a number-first '(3 season)' pack and decodes a combined 305 episode", () => {
    const r = parseMediaPath(
      "/media/Series/Rick and Morty/Rick and Morty (3 season) [Blu-ray Remux 1080p]/Rick and Morty - 305 - The Whirly Dirly Conspiracy.mkv",
    );
    expect(r.title).toBe("Rick and Morty");
    expect(r.seasonNumber).toBe(3);
    expect(r.episodeNumber).toBe(5); // 305 = S03E05 under a season-3 folder
  });

  it("parses S05_15-style markers (underscore, no E)", () => {
    const r = parseMediaPath(
      "/media/Series/Друзья/Сезон 5/S05_15. Эпизод с драчливой подругой Джо ( The One with the Girl Who Hits Joey).mkv",
    );
    expect(r.title).toBe("Друзья");
    expect(r.seasonNumber).toBe(5);
    expect(r.episodeNumber).toBe(15);
  });

  it("parses an SS-EE episode pair when the folder carries a bare season number", () => {
    const r = parseMediaPath("/media/Series/Greys Anatomy/Greys Anatomy 8 FOX Life 720p/Greys Anatomy 08-06 FOX.mkv");
    expect(r.seasonNumber).toBe(8);
    expect(r.episodeNumber).toBe(6);
    expect(r.title).toBe("Greys Anatomy");
  });

  it("parses transliterated 'N.sezon' + 'NN.serija' names", () => {
    const r = parseMediaPath(
      "/media/Series/Family Guy/Family Guy-Season. 1-3/Season.2/Griffini.2.sezon.09.serija.iz.21.1999-2000.XviD.DVDRip.avi",
    );
    expect(r.seasonNumber).toBe(2);
    expect(r.episodeNumber).toBe(9);
  });

  it("treats a season-pack folder (Show S04 BDRemux) as the season, titling from the episode file", () => {
    const r = parseMediaPath("/media/Series/Friends S04 BDRemux/Friends.S04E07.1080p.BluRay.mkv");
    expect(r.title).toBe("Friends");
    expect(r.seasonNumber).toBe(4);
    expect(r.episodeNumber).toBe(7);
  });

  it("titles a season-pack from the PARENT folder when one exists", () => {
    const r = parseMediaPath(
      "/media/Series/Altered Carbon/Altered.Carbon.S01.2160p.NF.WEB-DL.DDP5.1.Atmos.DoVi.HEVC.by.DVT/Altered.Carbon.S01E04.Force.of.Evil.2160p.mp4",
    );
    expect(r.title).toBe("Altered Carbon");
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(4);
  });

  it("groups 'Show N сезон' packs under one series title", () => {
    const r = parseMediaPath("/media/Series/Большое Шоу/Большое Шоу 7 сезон/Большое шоу 7 сезон 3 серия.avi");
    expect(r.title).toBe("Большое Шоу");
    expect(r.seasonNumber).toBe(7);
    expect(r.episodeNumber).toBe(3);
  });

  it("does not misread a movie edition tag as a season pack", () => {
    // "S" tokens in movie names must not flip movies into episodes.
    const r = parseMediaPath("/media/Films/Superman (1978)/Superman.1978.BluRay.mkv");
    expect(r.seasonNumber).toBeUndefined();
    expect(r.title).toBe("Superman");
  });
});
