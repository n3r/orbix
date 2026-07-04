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

// ─── Library-audit real-world cases (fix/tv-recognition-v2) ──────────────────
// Every path below is verbatim from the NAS library that produced wrong
// matches, episode-as-movie leaks, or junk series titles.

describe("NxMM season folders (Farmacia de Guardia layout)", () => {
  it("treats '1x52 (1991)' as a season folder, titling from the pack above", () => {
    const r = parseMediaPath(
      "/media/Series/Dezhurnaja.apteka.5.sezonov.iz.5.1991-1995.XviD.SATRip/1x52 (1991)/Farmacia de Guardia - 001 - 1x01 - Farmacia de guardia [Дежурная аптека].avi",
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("Dezhurnaja apteka");
    expect(r.titleVariants).toContain("Farmacia de Guardia");
  });

  it("keeps the file's own NxMM season when the folder pair agrees", () => {
    const r = parseMediaPath(
      "/media/Series/Dezhurnaja.apteka.5.sezonov.iz.5.1991-1995.XviD.SATRip/3x41 (1993)/Farmacia de Guardia - 107 - 3x31 - Postales para Fani [Открытки для Фани].avi",
    );
    expect(r.seasonNumber).toBe(3);
    expect(r.episodeNumber).toBe(31);
    expect(r.title).toBe("Dezhurnaja apteka");
  });
});

describe("bare eNN / Exx episode markers", () => {
  it("parses '.e01.' as an episode in an unmarked pack (season 1)", () => {
    const r = parseMediaPath(
      "/media/Series/Epidemia/Epidemia.2019.WEB-DL.(1080p).Getty/Epidemia.e01.2019.WEB-DL.(1080p).Getty.mkv",
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("Epidemia");
    expect(r.year).toBe(2019);
  });

  it("parses '.E01.' in a root pack, titling from the file prefix", () => {
    const r = parseMediaPath(
      "/media/Series/The.Pillars.of.the.Earth.2010.720p.BluRay.x264-CtrlHD/The.Pillars.of.the.Earth.E01.Anarchy.2010.720p.BluRay.x264-CtrlHD.mkv",
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("The Pillars of the Earth");
    expect(r.year).toBe(2010);
  });

  it("does not misread Wall-E or E.T. as episodes", () => {
    expect(parseMediaPath("/media/Films/WALL-E.2008.1080p.mkv").episodeNumber).toBeUndefined();
    expect(parseMediaPath("/media/Films/E.T.the.Extra-Terrestrial.1982.mkv").episodeNumber).toBeUndefined();
  });
});

describe("leading NN. episode with folder echo (Batya layout)", () => {
  it("parses '01.<pack name>.mkv' inside its pack as S1E01", () => {
    const r = parseMediaPath(
      "/media/Series/Batya.2021.WEB-DL.1080p/01.Batya.2021.WEB-DL.1080p.mkv",
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("Batya");
    expect(r.year).toBe(2021);
  });

  it("keeps a numbered disc file with a DIFFERENT tail a movie (trilogy folder)", () => {
    const r = parseMediaPath("/media/Films/Властелин колец (2001)/1 Братство кольца.mkv");
    expect(r.seasonNumber).toBeUndefined();
  });
});

describe("trailing (NN) episode with season-numbered folder echo (OITNB layout)", () => {
  it("parses 'OITNB 5 (01).mkv' in folder 'OITNB 5' as S5E01 of the show above", () => {
    const r = parseMediaPath(
      "/media/Series/Orange is the new Black/OITNB 5/OITNB 5 (01).mkv",
    );
    expect(r.seasonNumber).toBe(5);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("Orange is the new Black");
    expect(r.titleVariants).toContain("OITNB");
  });

  it("does not turn a parenthesized-year movie into an episode", () => {
    const r = parseMediaPath("/media/Films/Heat (1995)/Heat (1995).mkv");
    expect(r.seasonNumber).toBeUndefined();
  });
});

describe("series-title junk stripping", () => {
  it("strips a 'Season. 1-3' range from the show title", () => {
    const r = parseMediaPath(
      "/media/Series/Family Guy/Family Guy-Season. 1-3/Season.2/Griffini.2.sezon.02.serija.iz.21.1999-2000.XviD.DVDRip.avi",
    );
    expect(r.seasonNumber).toBe(2);
    expect(r.episodeNumber).toBe(2);
    expect(r.title).toBe("Family Guy");
  });

  it("strips 'The Complete Series' and release junk from a root pack", () => {
    const r = parseMediaPath(
      "/media/Series/House.of.Cards.US.The.Complete.Series.1080p.BDRemux.2xRus.Eng.TeamHD/House.of.Cards.US.S01.1080p.BDRemux.2xRus.Eng.TeamHD/House.of.Cards.US.S01E01.1080p.BDRemux.2xRus.Eng.TeamHD.mkv",
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("House of Cards US");
  });
});

describe("degenerate Cyrillic recovery in the TV branch", () => {
  it("recovers a Cyrillic series title from a root pack with an S01 marker", () => {
    const r = parseMediaPath(
      "/media/Series/Не сработало.S01.WEB-DL.2160p.HDR/Не сработало.S01E01.WEB-DL.2160p.mkv",
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("Не сработало");
  });
});

describe("episode-filename title variants (umbrella folders / folder typos)", () => {
  it("prefers the longer file prefix over an umbrella folder (Dune → Dune Prophecy)", () => {
    const r = parseMediaPath(
      "/media/Series/Dune/Dune.Prophecy.S01.MAX.DV.HDR.WEB-DL.2160p.by.AKTEP/Dune.Prophecy.S01E01.The.Hidden.Hand.MAX.DV.HDR.WEB-DL.2160p.by.AKTEP.mkv",
    );
    expect(r.title).toBe("Dune Prophecy");
    expect(r.titleVariants).toContain("Dune");
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
  });

  it("keeps the folder title primary but offers the differing file prefix as a variant", () => {
    const r = parseMediaPath(
      "/media/Series/House of Dragons/House.of.the.Dragon.S01.WEB-DL.2160p.HMAX/House.of.the.Dragon.S01E01.WEB-DL.2160p.RGzsRutracker.mkv",
    );
    expect(r.title).toBe("House of Dragons");
    expect(r.titleVariants).toContain("House of the Dragon");
  });

  it("offers no variant when the file prefix equals the folder title", () => {
    const r = parseMediaPath(
      "/media/Series/Billions/Billions.2016.S04.1080p.AMZN.WEB-DL.H.264.RUS.LF.DDP5.1.SRT-EniaHD/Billions.2016.S04E01.1080p.AMZN.WEB-DL.mkv",
    );
    expect(r.title).toBe("Billions");
    // A season-4 pack's year is not premiere-grade — left unset; the group
    // converges onto a year-carrying sibling at ingest.
    expect(r.year).toBeUndefined();
    expect(r.titleVariants ?? []).toHaveLength(0);
  });

  it("does not shorten the title when the file prefix is lazier than the folder", () => {
    const r = parseMediaPath(
      "/media/Series/Dune Prophecy/Dune.S01E01.WEB-DL.mkv",
    );
    expect(r.title).toBe("Dune Prophecy");
    expect(r.titleVariants).toContain("Dune");
  });
});

describe("extras skipping", () => {
  it("skips files inside a Promos folder within a season pack", () => {
    const r = parseMediaPath(
      "/media/Series/Family Guy/1 Season (SerGoLeOne)/FOX.com Promos/Don't Vote.mkv",
    );
    expect(r.skip).toBe(true);
  });

  it("skips files inside a Special Feature folder", () => {
    const r = parseMediaPath(
      "/media/Series/Family Guy/Family Guy Season 11 (WEB-DL 1080p)/Special Feature/Family Guy 200 Episodes Later.mkv",
    );
    expect(r.skip).toBe(true);
  });

  it("skips a Deleted Scenes file sitting directly in a season pack", () => {
    const r = parseMediaPath(
      "/media/Series/Family Guy/Family Guy - Season 5/Family.Guy.Deleted.Scenes.[filiza.ru].mkv",
    );
    expect(r.skip).toBe(true);
  });

  it("never skips a movie just because its name mentions a trailer-ish word", () => {
    const r = parseMediaPath("/media/Films/The Sample (2022)/The Sample (2022).mkv");
    expect(r.skip).toBeUndefined();
    expect(r.title).toBe("The Sample");
  });
});

describe("specials routed to season 0 with a title hint", () => {
  it("maps a Specials-folder file under a season pack to S0 of the show", () => {
    const r = parseMediaPath(
      "/media/Series/Doctor Who/Doctor.Who.2005.S07.1080p.BluRay.x264.Rus.Eng/Specials/The.Day.Of.The.Doctor.2013.1080p.BluRay.x264-WiKi.mkv",
    );
    expect(r.title).toBe("Doctor Who");
    // Specials never date the series — the S0 group joins its year-carrying
    // siblings at ingest instead.
    expect(r.year).toBeUndefined();
    expect(r.seasonNumber).toBe(0);
    expect(r.episodeNumber).toBeGreaterThanOrEqual(900);
    expect(r.episodeTitleHint).toBe("The Day Of The Doctor");
    expect(r.episodeYear).toBe(2013);
  });

  it("routes an in-pack 'christmas special' file to S0 with the subtitle as hint", () => {
    const r = parseMediaPath(
      "/media/Series/Doctor Who/Doctor.Who.2005.S07.1080p.BluRay.x264.Rus.Eng/Specials/doctor.who.2005.christmas.special.the.snowmen.2012.1080p.bluray.x264-shortbrehd.mkv",
    );
    expect(r.title).toBe("Doctor Who");
    expect(r.seasonNumber).toBe(0);
    expect(r.episodeTitleHint).toBe("the snowmen");
    expect(r.episodeYear).toBe(2012);
  });

  it("routes a subtitle-less christmas special inside a season pack to S0 on year alone", () => {
    const r = parseMediaPath(
      "/media/Series/Doctor Who/Doctor.Who.2005.S03.1080p.BluRay.x264-SHORTBREHD/doctor.who.2005.christmas.special.2006.1080p.bluray.x264-shortbrehd.mkv",
    );
    expect(r.title).toBe("Doctor Who");
    expect(r.seasonNumber).toBe(0);
    expect(r.episodeTitleHint).toBeUndefined();
    expect(r.episodeYear).toBe(2006);
  });

  it("keeps a movie with 'special' in its name a movie outside series context", () => {
    const r = parseMediaPath("/media/Films/The Special (2020)/The Special (2020).mkv");
    expect(r.seasonNumber).toBeUndefined();
  });
});

describe("series year from unparenthesized folder names", () => {
  it("takes a bare year from the season pack for the series", () => {
    const r = parseMediaPath(
      "/media/Series/Doctor Who/Doctor.Who.2005.S01.1080p.BluRay.x264-SHORTBREHD/Doctor.Who.2005.S01E01.1080p.BluRay.mkv",
    );
    expect(r.title).toBe("Doctor Who");
    expect(r.year).toBe(2005);
  });

  it("never mistakes a 2160p resolution for a year", () => {
    const r = parseMediaPath(
      "/media/Series/Paradise.S01.2160p.DSNP.WEB-DL.DV.HDR.H.265/Paradise.S01E01.2160p.mkv",
    );
    expect(r.title).toBe("Paradise");
    expect(r.year).toBeUndefined();
  });

  it("takes the first year of a trailing year-range", () => {
    const r = parseMediaPath(
      "/media/Series/Sliders.1995-2000.dvdrip_[teko]/Season 1/Sliders.1x01.mkv",
    );
    expect(r.title).toBe("Sliders");
    expect(r.year).toBe(1995);
  });
});

describe("dry-run regressions (full-library parse audit)", () => {
  it("does not skip a root pack whose name merely contains the season digit", () => {
    // ".5.sezonov.iz.5." contains a bare "5" — the walk must not treat the
    // ROOT PACK as another season folder for season-5 files and lose the title.
    const r = parseMediaPath(
      "/media/Series/Dezhurnaja.apteka.5.sezonov.iz.5.1991-1995.XviD.SATRip/5x13 (1995)/Farmacia de Guardia - 169 - 5x13 - La Voz de la Noche [Голос ночи].avi",
    );
    expect(r.title).toBe("Dezhurnaja apteka");
    expect(r.seasonNumber).toBe(5);
    expect(r.episodeNumber).toBe(13);
  });

  it("skips 'Film o filme' making-of featurettes inside season packs", () => {
    const r = parseMediaPath(
      "/media/Series/Epidemia/Epidemiya.S02.2022.WEBRip.1080p/Epidemiya.S02.Film.o.filme.2022.WEBRip.1080p.mkv",
    );
    expect(r.skip).toBe(true);
    const r2 = parseMediaPath(
      "/media/Series/Sestry/Sestry.2021.WEB-DL.1080p/Sestry.S01.Film.o.filme.2021.WEB-DL.1080p.mkv",
    );
    expect(r2.skip).toBe(true);
  });

  it("normalizes dotted show-folder titles while preserving initialisms", () => {
    const r = parseMediaPath("/media/Series/Rick.And.Morty.1080/Rick.and.Morty.S01E01.Pilot.1080p.mkv");
    expect(r.title).toBe("Rick And Morty");
    const swat = parseMediaPath("/media/Series/S.W.A.T/S.W.A.T.S01E01.1080p.mkv");
    expect(swat.title).toBe("S.W.A.T");
  });
});

describe("review findings — parser hardening", () => {
  it("does not skip a show that lives under an extras-named bucket or IS named Extras", () => {
    // grandparent-level extras checks are gone: only the immediate folder counts.
    const r = parseMediaPath("/media/Series/Extras/Season 1/Extras.S01E01.mkv");
    expect(r.skip).toBeUndefined();
    expect(r.title).toBe("Extras");
    expect(r.seasonNumber).toBe(1);
    const bucket = parseMediaPath("/media/Other/Breaking Bad/Breaking.Bad.S01E01.mkv");
    expect(bucket.skip).toBeUndefined();
    expect(bucket.title).toBe("Breaking Bad");
  });

  it("treats a per-episode folder as a pack level, not the show (no year leak)", () => {
    const r = parseMediaPath(
      "/media/Series/Doctor Who/Doctor.Who.2005.S09E13.1080p.BluRay.x264-REMPOWN/doctor.who.2005.s09e13.1080p.bluray.x264-rempown.mkv",
    );
    expect(r.title).toBe("Doctor Who");
    expect(r.seasonNumber).toBe(9);
    expect(r.episodeNumber).toBe(13);
    // The episode-folder's embedded year is episode-adjacent, not premiere-grade.
    expect(r.year).toBeUndefined();
  });

  it("still skips files directly inside extras folders", () => {
    expect(parseMediaPath("/media/Series/Family Guy/1 Season (SerGoLeOne)/FOX.com Promos/Don't Vote.mkv").skip).toBe(true);
  });

  it("never turns a browser-duplicate '(1)' copy into an episode", () => {
    const r = parseMediaPath("/media/Films/Iron Man 2/Iron Man 2 (1).mkv");
    expect(r.seasonNumber).toBeUndefined();
    const r2 = parseMediaPath("/media/Films/Iron Man 2/Iron Man 2 (2).mkv");
    expect(r2.seasonNumber).toBeUndefined();
  });

  it("only trusts a season-pack year as the series year for season 1", () => {
    // A late season's pack year is the AIR year, not the premiere year — it
    // must not feed exact-year gates ("Сезон 5 2002-2003" for a 1998 show).
    const s5 = parseMediaPath("/media/Series/Все женщины ведьмы/Сезон 5 2002-2003/Charmed.5x01.mkv");
    expect(s5.title).toBe("Все женщины ведьмы");
    expect(s5.seasonNumber).toBe(5);
    expect(s5.year).toBeUndefined();
    // …while a season-1 pack's year is premiere-grade and kept.
    const s1 = parseMediaPath("/media/Series/Doctor Who/Doctor.Who.2005.S01.1080p.BluRay.x264-SHORTBREHD/Doctor.Who.2005.S01E01.1080p.mkv");
    expect(s1.year).toBe(2005);
    // …and a SHOW-folder year applies regardless of season.
    const show = parseMediaPath("/media/Series/Метод (2015)/Season 2/Метод.2x01.mkv");
    expect(show.year).toBe(2015);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cartoon/Documentary library audit — sibling-aware scanning (ScanContext).
// Every path below is verbatim from the NAS library dump.
// ─────────────────────────────────────────────────────────────────────────────

import { buildScanContext } from "./scan-context";

const CART = "/media/Cartoons Series";
const DOC = "/media/Documentary Series";

function ctxOf(root: string, paths: string[]) {
  return buildScanContext(root, paths);
}

describe("ordinal-run episode detection (sibling context)", () => {
  it("zero-padded 'NNN - Title' run in a show folder → absolute episodes", () => {
    const paths = [
      `${CART}/Утиные истории (DVD AI Upscale)/001 - Не сдавать корабль!.mkv`,
      `${CART}/Утиные истории (DVD AI Upscale)/002 - Нет дороги трудней, чем дорога в Ронгуэй.mkv`,
      `${CART}/Утиные истории (DVD AI Upscale)/003 - Трое и кондор.mkv`,
    ];
    const ctx = ctxOf(CART, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.title).toBe("Утиные истории");
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(parseMediaPath(paths[2]!, ctx).episodeNumber).toBe(3);
  });

  it("year folders inside an all-seasons pack become year-numbered seasons", () => {
    const paths = [
      `${DOC}/Разрушители легенд (Все сезоны)/2003/001. Взрывающийся унитаз.avi`,
      `${DOC}/Разрушители легенд (Все сезоны)/2003/002. Уничтожение сотового телефона.avi`,
      `${DOC}/Разрушители легенд (Все сезоны)/2003/003. Бочка с кирпичами.avi`,
      `${DOC}/Разрушители легенд (Все сезоны)/2004/009. Взрывная декомпрессия.avi`,
      `${DOC}/Разрушители легенд (Все сезоны)/2004/010. Куриная пушка.avi`,
    ];
    const ctx = ctxOf(DOC, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.title).toBe("Разрушители легенд");
    expect(r.seasonNumber).toBe(2003);
    expect(r.episodeNumber).toBe(1);
    const r2 = parseMediaPath(paths[3]!, ctx);
    expect(r2.seasonNumber).toBe(2004);
    expect(r2.episodeNumber).toBe(9);
  });

  it("flat 'NNN - Title' MythBusters pack keeps absolute numbering in season 1", () => {
    const paths = [
      `${DOC}/Mythbusters HDTV/070 - Hindenburg Mystery.mkv`,
      `${DOC}/Mythbusters HDTV/071 - Pirate Special.mkv`,
      `${DOC}/Mythbusters HDTV/072 - Underwater Car.mkv`,
    ];
    const ctx = ctxOf(DOC, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.title).toBe("Mythbusters");
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(70);
  });

  it("MakeMKV disc rips (A1_tNN) in numbered disc folders → disc-numbered seasons", () => {
    // A disc-numbered season needs ≥3 same-stem sibling disc folders (a real
    // disc series) — a two-folder sequel set must not qualify.
    const disc = (n: number) => [0, 1, 2].map((e) => `${CART}/Ох уж эти детки/RUGRATS_${n}/A1_t0${e}.mkv`);
    const paths = [...disc(1), ...disc(2), ...disc(10)];
    const ctx = ctxOf(CART, paths);
    const r = parseMediaPath(`${CART}/Ох уж эти детки/RUGRATS_10/A1_t00.mkv`, ctx);
    expect(r.title).toBe("Ох уж эти детки");
    expect(r.seasonNumber).toBe(10);
    expect(r.episodeNumber).toBe(1); // zero-based t00 shifts to 1-based
    expect(parseMediaPath(`${CART}/Ох уж эти детки/RUGRATS_10/A1_t02.mkv`, ctx).episodeNumber).toBe(3);
    expect(parseMediaPath(`${CART}/Ох уж эти детки/RUGRATS_1/A1_t00.mkv`, ctx).seasonNumber).toBe(1);
  });

  it("prefix_NN_suffix runs (In_space_01_rus) → episodes with the folder as title", () => {
    const paths = [
      "/media/Documentary/Space/In_space/In_space_01_rus.avi",
      "/media/Documentary/Space/In_space/In_space_02_rus.avi",
      "/media/Documentary/Space/In_space/In_space_03_rus.avi",
      "/media/Documentary/Space/In_space/In_space_04_rus.avi",
      "/media/Documentary/Space/In_space/In_space_05_rus.avi",
    ];
    const ctx = ctxOf("/media/Documentary", paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.title).toBe("In space");
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
  });

  it("unpadded 'N. Title' run of 5+ files → episodes (How the Universe Works)", () => {
    const base = `${DOC}/How.The.Universe.Works.2010.HDTVRip(720p)`;
    const names = ["1. Big Bang", "2. Black Holes", "3. Galaxies", "4. Stars", "5. Supernovas", "6. Planets", "7. Solar Systems", "8. Moons"];
    const paths = names.map((n) => `${base}/${n}.mkv`);
    const ctx = ctxOf(DOC, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.title).toBe("How The Universe Works");
    expect(r.year).toBe(2010);
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
  });

  it("'NN Title' (no dot) padded run → episodes; noise folder tail cleaned", () => {
    const base = `${DOC}/Тайная жизнь птиц 720p -ukraine-`;
    const paths = [
      `${base}/01 Хор на рассвете.mkv`,
      `${base}/02 Создание гнезда.mkv`,
      `${base}/03 Жизнь на краю.mkv`,
    ];
    const ctx = ctxOf(DOC, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("Тайная жизнь птиц");
  });

  it("'Фильм N. Title' run in a yeared pack → episodes with the pack year", () => {
    const base = "/media/Documentary/Space/Год на орбите (2015)";
    const paths = [
      `${base}/Фильм 1. Поехали.avi`,
      `${base}/Фильм 2. Один в поле.avi`,
      `${base}/Фильм 3. Дом.avi`,
      `${base}/Фильм 4. Еда.avi`,
      `${base}/Фильм 5. Вода.avi`,
    ];
    const ctx = ctxOf("/media/Documentary", paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.title).toBe("Год на орбите");
    expect(r.year).toBe(2015);
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
  });

  it("two same-year padded siblings with a common stem → episodes (Тайны пирамид)", () => {
    const paths = [
      `${DOC}/Тайны египетских пирамид/Тайны Египетских пирамид 01.HDTVRip.2017.[Aids].avi`,
      `${DOC}/Тайны египетских пирамид/Тайны Египетских пирамид 02.HDTVRip.2017.[Aids].avi`,
    ];
    const ctx = ctxOf(DOC, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("Тайны египетских пирамид"); // the folder's own casing
  });

  it("collection guard: distinct per-file years keep an ordinal run as movies", () => {
    const base = `${CART}/Vinni-Pukh`;
    const paths = [
      `${base}/1.Vinni-Pukh.1969.BDRip.720p.Rus.mkv`,
      `${base}/2.Vinni-Pukh.idyot.v.gosti.1971.BDRip.720p.Rus.mkv`,
      `${base}/3.Vinni-Pukh.i.den.zabot.1972.BDRip.720p.Rus.mkv`,
    ];
    const ctx = ctxOf(CART, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.seasonNumber).toBeUndefined();
    expect(r.year).toBe(1969);
    expect(r.title).toBe("Vinni-Pukh"); // list index stripped
    const r2 = parseMediaPath(paths[1]!, ctx);
    expect(r2.year).toBe(1971);
    expect(r2.title).toBe("Vinni-Pukh idyot v gosti");
  });

  it("collection guard: unpadded trilogy without years stays movies (LOTR discs)", () => {
    const base = "/media/Films/Властелин колец (2001)";
    const paths = [
      `${base}/1 Братство кольца.mkv`,
      `${base}/2 Две крепости.mkv`,
      `${base}/3 Возвращение короля.mkv`,
    ];
    const ctx = ctxOf("/media/Films", paths);
    for (const p of paths) {
      expect(parseMediaPath(p, ctx).seasonNumber).toBeUndefined();
    }
  });

  it("collection guard: files directly in the source root never form a run", () => {
    const paths = [
      "/media/Cartoons/01. Shrek.mkv",
      "/media/Cartoons/02. Shrek 2.mkv",
      "/media/Cartoons/03. Shrek the Third.mkv",
    ];
    const ctx = ctxOf("/media/Cartoons", paths);
    expect(parseMediaPath(paths[0]!, ctx).seasonNumber).toBeUndefined();
  });

  it("collection guard: CD/part splits never become episodes", () => {
    const paths = [
      "/media/Films/Avatar/Avatar.CD01.mkv",
      "/media/Films/Avatar/Avatar.CD02.mkv",
      "/media/Films/Avatar/Avatar.CD03.mkv",
      "/media/Films/Avatar/Avatar.CD04.mkv",
      "/media/Films/Avatar/Avatar.CD05.mkv",
    ];
    const ctx = ctxOf("/media/Films", paths);
    expect(parseMediaPath(paths[0]!, ctx).seasonNumber).toBeUndefined();
  });

  it("bare numeric season folders (Три Кота 01/02/03) → seasons", () => {
    const base = `${CART}/Три Кота/Три кота.2015.WEBRip 1080p`;
    const paths = [
      `${base}/01/01. Музыкальная открытка.mkv`,
      `${base}/01/02. Пряничный домик.mkv`,
      `${base}/01/03. День варенья.mkv`,
      `${base}/02/01. Хорошие манеры.mp4`,
      `${base}/02/02. Пикник.mp4`,
      `${base}/02/03. Игра.mp4`,
    ];
    const ctx = ctxOf(CART, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.title).toBe("Три кота");
    expect(r.year).toBe(2015);
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(parseMediaPath(paths[3]!, ctx).seasonNumber).toBe(2);
  });

  it("Спецвыпуск folder inside a pack → season-0 provisional with a title hint", () => {
    const base = `${CART}/Три Кота/Три кота.2015.WEBRip 1080p`;
    const paths = [
      `${base}/Спецвыпуск/01. Вперед в прошлое.mkv`,
      `${base}/Спецвыпуск/02. Желтая подводная лодка.mkv`,
      `${base}/01/01. Музыкальная открытка.mkv`,
      `${base}/01/02. Пряничный домик.mkv`,
      `${base}/01/03. Часики.mkv`,
    ];
    const ctx = ctxOf(CART, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.title).toBe("Три кота");
    expect(r.seasonNumber).toBe(0);
    expect(r.episodeNumber).toBe(1);
  });
});

describe("library-root boundary (flat packs directly under the source root)", () => {
  it("never adopts the root folder as the series title (with context)", () => {
    const paths = [
      `${DOC}/Our.Oceans.S01.1080p.NF.WEB-DL.DDP5.1.H.264-RGzsRutracker/Our.Oceans.S01E01.1080p.NF.WEB-DL.mkv`,
      `${DOC}/Prehistoric.Planet.S01.1080p.ATVP.WEB-DL.DDP5.1.H.264-EniaHD/Prehistoric.Planet.S01E01.mkv`,
    ];
    const ctx = ctxOf(DOC, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.title).toBe("Our Oceans");
    expect(r.seasonNumber).toBe(1);
    const r2 = parseMediaPath(paths[1]!, ctx);
    expect(r2.title).toBe("Prehistoric Planet");
  });

  it("…and a '(Season N)' flat pack keeps its own name (Cars on the Road)", () => {
    const p = `${CART}/Cars on the Road (Season 1) HDR WEB-DL 2160p/Cars.on.the.Road.S01E01.HDR.2160p.mkv`;
    const ctx = ctxOf(CART, [p]);
    const r = parseMediaPath(p, ctx);
    expect(r.title).toBe("Cars on the Road");
  });

  it("without context, extended generic-root names are still never show titles", () => {
    const r = parseMediaPath(
      `${DOC}/Our.Oceans.S01.1080p.NF.WEB-DL.DDP5.1.H.264-RGzsRutracker/Our.Oceans.S01E01.1080p.NF.WEB-DL.mkv`,
    );
    expect(r.title).toBe("Our Oceans");
    const r2 = parseMediaPath(
      `${CART}/I Am Groot (Season 1) WEB-DL 2160p/I.Am.Groot.S01E01.2160p.mkv`,
    );
    expect(r2.title).toBe("I Am Groot");
  });
});

describe("episode word-markers without sibling context", () => {
  it("'Episode.N' keyword in a year-less file → episode (Planet Earth II)", () => {
    const r = parseMediaPath(
      `${DOC}/Planet.Earth.II.1080p.BDRip/Planet.Earth.II.Episode.1.1080p.BDRip.mkv`,
    );
    expect(r.title).toBe("Planet Earth II");
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
  });

  it("'Episode N' with a release year stays a movie (Star Wars rips)", () => {
    const r = parseMediaPath(
      "/media/Films/Star.Wars.Episode.3.Revenge.of.the.Sith.2005.BDRip.mkv",
    );
    expect(r.seasonNumber).toBeUndefined();
  });

  it("E-tag glued to a title-terminal '!' is detected via sibling context (Nu_Pogody!E01)", () => {
    // "Nu_Pogody!E01" — no separator before E — is NOT matched by BARE_E_RE
    // (deliberately conservative, so a movie "Title!E5 2020" can't misfire);
    // the ordinal run "Nu_Pogody!E01/E02/E03…" is recognized by scan context.
    const base = `${CART}/Nu_Pogody!.BDRip.1080p.2xRus`;
    const paths = [1, 2, 3].map((e) => `${base}/Nu_Pogody!E0${e}.BDRip.1080p.by_genkasper.mkv`);
    const ctx = ctxOf(CART, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("Nu Pogody!");
  });

  it("underscore separators normalize in series titles (Masha_i_Medved.E01)", () => {
    const r = parseMediaPath(
      `${CART}/Masha i Medved/Masha_i_Medved.1080p.BluRay.Rus.HDCLUB/Masha_i_Medved.E01.1080p.BluRay.Rus.HDCLUB.mkv`,
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("Masha i Medved");
  });

  it("'(N из M)' counters → episode number (BBC Космос)", () => {
    const r = parseMediaPath(
      "/media/Documentary/Space/Космос. Руководство для начинающих/BBC.Космос. Руководство для начинающих.(1 из 6).Жизнь в космосе.avi",
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
    expect(r.title).toBe("Космос. Руководство для начинающих");
  });

  it("'(seria.N.iz.M)' transliterated counters → episode number", () => {
    const r = parseMediaPath(
      "/media/Documentary/Space/Обратный отсчет/Obratnii.otshet.(seria.2.iz.4).SATRip.avi",
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(2);
    expect(r.title).toBe("Обратный отсчет");
  });

  it("'(N-M serii iz K)' ranges attach to the first episode", () => {
    const r = parseMediaPath(
      "/media/Documentary/Space/Открытый космос/Otkrytyj.kosmos.(1-2.serii.iz.4).2011.DivX.SATRip.KimVlad.avi",
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
  });

  it("'(N серия из M)' Cyrillic counters → episode number", () => {
    const r = parseMediaPath(
      "/media/Documentary/Space/Solar.System.2010.HDRip.IRONCLUB/Chudesa.Solnechnoj.Sistemy.(2.serija.iz.5).Porjadok.iz.haosa.2010.XviD.HDRip.IRONCLUB.avi",
    );
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(2);
  });

  it("CD/disc 'N of M' splits never become episodes", () => {
    const r = parseMediaPath("/media/Films/Heat (1995)/Heat.CD1.of.2.avi");
    expect(r.seasonNumber).toBeUndefined();
  });
});

describe("cartoon/docu title & folder hygiene", () => {
  it("skips BDMV disc structures entirely", () => {
    const r = parseMediaPath(
      `${CART}/Masha i Medved/MASHINY_SKAZKI/MS_E01_VOLK_I_SEMERO_KOZLJAT/BDMV/STREAM/00000.m2ts`,
    );
    expect(r.skip).toBe(true);
  });

  it("skips Бонус folders inside an item folder", () => {
    const r = parseMediaPath(
      `${CART}/Fiksiki/Фиксики.2010-2019.WEBRip 720p/Бонус/Фиксики. Бонусная серия.mp4`,
    );
    expect(r.skip).toBe(true);
  });

  it("strips a leading [Group] tag from series folder titles ([DS27]Zootopia+)", () => {
    const p = `${CART}/[DS27]Zootopia+.2160p/[DS27]Zootopia+.S01E01.2160p.mkv`;
    const r = parseMediaPath(p, ctxOf(CART, [p]));
    expect(r.title).toBe("Zootopia+");
  });

  it("strips tracker-domain brackets from series titles (Exo-Squad)", () => {
    const p = `${CART}/Exo-Squad_[cartoons.flybb.ru]/Season 1/Exo-Squad.S01E01.avi`;
    const r = parseMediaPath(p, ctxOf(CART, [p]));
    expect(r.title).toBe("Exo-Squad");
  });

  it("normalizes dots around single-letter tokens (Malysh.i.Karlson)", () => {
    const paths = [
      `${CART}/Malysh.i.Karlson.Sbornik.multfilmov.1957-1970.x264.BDRip(1080p)/1.Malysh.i.Karlson.1968.x264.BDRip(1080p)-KinozalHD.mkv`,
      `${CART}/Malysh.i.Karlson.Sbornik.multfilmov.1957-1970.x264.BDRip(1080p)/2.Karlson.vernulsja.1970.x264.BDRip(1080p)-KinozalHD.mkv`,
      `${CART}/Malysh.i.Karlson.Sbornik.multfilmov.1957-1970.x264.BDRip(1080p)/3.Petja.i.Krasnaja.Shapochka.1958.x264.BDRip(1080p)-KinozalHD.mkv`,
    ];
    const ctx = ctxOf(CART, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.seasonNumber).toBeUndefined(); // distinct years → collection of shorts
    expect(r.title).toBe("Malysh i Karlson");
    expect(r.year).toBe(1968);
  });

  it("keeps acronym dots intact (S.W.A.T.)", () => {
    const p = "/media/Series/S.W.A.T/Season 1/S.W.A.T.S01E01.mkv";
    expect(parseMediaPath(p).title).toBe("S.W.A.T");
  });

  it("drops a duplicated in-title year echo (Лука.2021.2021)", () => {
    const r = parseMediaPath("/media/Cartoons/Лука.2021.2021.Hybrid.UHD.Blu-Ray.Remux.2160p.mkv");
    expect(r.title).toBe("Лука");
    expect(r.year).toBe(2021);
  });

  it("keeps a bare-year movie title that IS the year (2012)", () => {
    const r = parseMediaPath("/media/Films/2012 (2009)/2012.2009.mkv");
    expect(r.title).toBe("2012");
    expect(r.year).toBe(2009);
  });

  it("underscore movie titles normalize (The_Elegant_Universe_2)", () => {
    const r = parseMediaPath("/media/Documentary/Space/The_Elegant_Universe_2.avi");
    expect(r.title).toBe("The Elegant Universe 2");
  });
});

describe("run-detection refinements", () => {
  it("tolerates a small minority of non-conforming siblings (MythBusters SP files)", () => {
    const base = `${DOC}/Mythbusters HDTV`;
    const paths = [
      `${base}/070 - Hindenburg Mystery.mkv`,
      `${base}/071 - Pirate Special.mkv`,
      `${base}/072 - Underwater Car.mkv`,
      `${base}/073 - Speed Cameras.mkv`,
      `${base}/074 - Dog Myths.mkv`,
      `${base}/075 - More Myths Revisited.mkv`,
      `${base}/076 - Voice Flame Extinguisher.mkv`,
      `${base}/084 - Viewers' Special.mkv`,
      `${base}/SP10 - Holiday Special.mkv`,
    ];
    const ctx = ctxOf(DOC, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(70);
    // The non-conforming file itself falls back to the normal (movie) parse.
    expect(parseMediaPath(paths[8]!, ctx).seasonNumber).toBeUndefined();
  });

  it("still refuses runs when too many siblings do not conform", () => {
    const base = "/media/Films/Mixed Bag";
    const paths = [
      `${base}/01 One.mkv`,
      `${base}/02 Two.mkv`,
      `${base}/Making Of.mkv`,
      `${base}/Interview.mkv`,
    ];
    const ctx = ctxOf("/media/Films", paths);
    expect(parseMediaPath(paths[0]!, ctx).seasonNumber).toBeUndefined();
  });

  it("keeps the NAMED pack level as the variant source (Le ranch S01-02/S01)", () => {
    const p = `${CART}/Le ranch S01-02/S01/Ранчо.S01E01.mkv`;
    const r = parseMediaPath(p, ctxOf(CART, [p]));
    expect(r.title).toBe("Ранчо");
    expect(r.titleVariants).toContain("Le ranch");
  });

  it("does NOT treat a 'Пилот'/'Pilots' folder as a specials marker (aviation-movie safety)", () => {
    // "Pilots"/"Пилот" is a plausible movie-collection folder ("Aviation/
    // Pilots/Top Gun.mkv"), so it is deliberately NOT a season-0 marker — the
    // few letter-numbered MythBusters pilot files stay unmatched movies rather
    // than risk routing real films into a phantom series.
    const r = parseMediaPath(
      `${DOC}/Разрушители легенд (Все сезоны)/Пилот/A. Реактивное Шевроле.avi`,
    );
    expect(r.seasonNumber).toBeUndefined();
    const mov = parseMediaPath("/media/Films/Aviation/Pilots/Top Gun.mkv");
    expect(mov.seasonNumber).toBeUndefined();
    expect(mov.title).toBe("Top Gun");
  });
});

describe("review hardening — cartoon/docu round 2", () => {
  it("NFC-composes the run/listIndex lookup so decomposed (NFD) runs still match", () => {
    // buildScanContext keys maps by NFC basename; parseMediaPath looks them up
    // by NFC filename. A decomposed on-disk name must still hit.
    const nfd = (s: string) => s.normalize("NFD");
    const dir = `${CART}/${nfd("Смешарики")}`;
    const names = ["01. Крош идёт", "02. Ёжик спит", "03. Нюша поёт", "04. Бараш"];
    const paths = names.map((n) => `${dir}/${nfd(n)}.mkv`);
    const ctx = ctxOf(CART, paths);
    const r = parseMediaPath(paths[0]!, ctx);
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(1);
  });

  it("keeps a numbered documentary run whose titles MENTION years as episodes", () => {
    // Years inside episode titles ("The 1969 Landing") are not release tags,
    // so distinct in-title years must not dissolve the run into a collection.
    const base = `${DOC}/Space Race`;
    const paths = [
      `${base}/01 - The 1957 Sputnik.mkv`,
      `${base}/02 - The 1969 Landing.mkv`,
      `${base}/03 - The 1986 Disaster.mkv`,
      `${base}/04 - The 2011 Finale.mkv`,
    ];
    const ctx = ctxOf(DOC, paths);
    const r = parseMediaPath(paths[1]!, ctx);
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(2);
  });

  it("still treats a run with per-file RELEASE years (year+noise) as a movie collection", () => {
    const base = `${CART}/Winnie shorts`;
    const paths = [
      `${base}/1.Vinni-Pukh.1969.BDRip.720p.mkv`,
      `${base}/2.Vinni-Pukh.idyot.1971.BDRip.720p.mkv`,
      `${base}/3.Vinni-Pukh.den.1972.BDRip.720p.mkv`,
    ];
    const ctx = ctxOf(CART, paths);
    expect(parseMediaPath(paths[0]!, ctx).seasonNumber).toBeUndefined();
  });

  it("tolerates one stray sibling in a 3-file run", () => {
    const base = `${DOC}/Miniseries`;
    const paths = [
      `${base}/01 - Part One.mkv`,
      `${base}/02 - Part Two.mkv`,
      `${base}/03 - Part Three.mkv`,
      `${base}/Behind The Scenes.mkv`,
    ];
    const ctx = ctxOf(DOC, paths);
    expect(parseMediaPath(paths[0]!, ctx).episodeNumber).toBe(1);
    expect(parseMediaPath(paths[2]!, ctx).episodeNumber).toBe(3);
  });

  it("does not +1-shift a titled run that starts at 00 (00 stays a prologue)", () => {
    const base = `${DOC}/Series With Prologue`;
    const paths = [
      `${base}/00 - Prologue.mkv`,
      `${base}/01 - Episode One.mkv`,
      `${base}/02 - Episode Two.mkv`,
    ];
    const ctx = ctxOf(DOC, paths);
    expect(parseMediaPath(paths[0]!, ctx).episodeNumber).toBe(0);
    expect(parseMediaPath(paths[1]!, ctx).episodeNumber).toBe(1);
  });

  it("does not turn a two-film sequel folder into a disc-numbered season", () => {
    // 'Rambo 2'/'Rambo 3' are 2 same-stem siblings (< 3) → no disc seasonHint,
    // so two padded parts inside stay movies.
    const paths = [
      "/media/Films/Rambo 2/01.mkv",
      "/media/Films/Rambo 2/02.mkv",
      "/media/Films/Rambo 3/01.mkv",
      "/media/Films/Rambo 3/02.mkv",
    ];
    const ctx = ctxOf("/media/Films", paths);
    expect(parseMediaPath(paths[0]!, ctx).seasonNumber).toBeUndefined();
  });

  it("does not read a generic new-gTLD in a fansub tag as a tracker domain", () => {
    const p = "/media/Anime/Show/[Judas.fun] Show - 12.mkv";
    const r = parseMediaPath(p, ctxOf("/media/Anime", [p]));
    expect(r.seasonNumber).toBe(1);
    expect(r.episodeNumber).toBe(12);
  });

  it("does not turn a movie with a '!EN' fragment into an episode", () => {
    const r = parseMediaPath("/media/Films/Surprise!E5 2020.mkv");
    expect(r.seasonNumber).toBeUndefined();
  });

  it("keeps a real show folder literally named 'Collection' (not blanked as generic)", () => {
    const p = "/media/Series/Collection/Season 01/Collection.S01E01.mkv";
    const r = parseMediaPath(p, ctxOf("/media/Series", [p]));
    expect(r.title).toBe("Collection");
  });
});
