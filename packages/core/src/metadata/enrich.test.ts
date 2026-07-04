import { describe, it, expect, vi } from "vitest";
import { enrichItem } from "./enrich";
import type { TmdbLike, SaveMetadataInput } from "./enrich";
import type { TmdbMovie, TmdbCredits, TmdbKeyword, TmdbSearchResult, TmdbSearchCandidate } from "./tmdb";
import type { ImageKind } from "./images";

// ---------------------------------------------------------------------------
// Fakes — NO real network, NO real disk, NO real DB.
// ---------------------------------------------------------------------------

const MATRIX_ID = 603;

const fakeMovie: TmdbMovie = {
  tmdbId: MATRIX_ID,
  title: "The Matrix",
  year: 1999,
  overview: "A computer hacker learns from mysterious rebels about the true nature of his reality.",
  tagline: "Welcome to the Real World.",
  runtimeSec: 8160,
  posterPath: "/p.jpg",
  backdropPath: "/b.jpg",
  imdbId: "tt0133093",
  tmdbScore: 8.7,
  genres: [{ tmdbId: 28, name: "Action" }],
};

const fakeCredits: TmdbCredits = {
  cast: Array.from({ length: 20 }, (_, i) => ({
    tmdbId: 100 + i,
    name: `Actor ${i}`,
    character: `Char ${i}`,
    order: i,
  })),
  crew: [
    { tmdbId: 7, name: "L. W.", job: "Director", department: "Directing" },
    { tmdbId: 8, name: "A. Smith", job: "Producer", department: "Production" },
  ],
};

const fakeKeywords: TmdbKeyword[] = [{ tmdbId: 9, name: "dystopia" }];

function makeFakeClient(
  searchResult: TmdbSearchResult | null = { tmdbId: MATRIX_ID, title: "The Matrix", year: 1999 },
  options: {
    certification?: string | null;
    certThrows?: boolean;
    /** Per-query candidate override for the query-ladder resolver. */
    searchMovies?: (query: string, year?: number, language?: string) => TmdbSearchCandidate[];
    /** Per-id title list for the deep-check phase (default: none known). */
    allTitles?: (id: number) => string[];
  } = {},
): TmdbLike & { searchMoviesCalls: number; allTitlesCalls: number } {
  let searchMoviesCalls = 0;
  let allTitlesCalls = 0;
  // Default: one candidate mirroring searchResult (a strong string match for the
  // existing "The Matrix" tests), or none when searchResult is null.
  const defaultCandidates: TmdbSearchCandidate[] = searchResult
    ? [{ tmdbId: searchResult.tmdbId, title: searchResult.title, year: searchResult.year, voteCount: 20000 }]
    : [];
  return {
    get searchMoviesCalls() {
      return searchMoviesCalls;
    },
    get allTitlesCalls() {
      return allTitlesCalls;
    },
    async searchMovies(query: string, year?: number, language?: string): Promise<TmdbSearchCandidate[]> {
      searchMoviesCalls++;
      return options.searchMovies ? options.searchMovies(query, year, language) : defaultCandidates;
    },
    async allTitles(id: number): Promise<string[]> {
      allTitlesCalls++;
      return options.allTitles ? options.allTitles(id) : [];
    },
    async movie(_id: number): Promise<TmdbMovie> {
      return fakeMovie;
    },
    async credits(_id: number): Promise<TmdbCredits> {
      return fakeCredits;
    },
    async keywords(_id: number): Promise<TmdbKeyword[]> {
      return fakeKeywords;
    },
    async releaseCertification(_id: number): Promise<string | undefined> {
      if (options.certThrows) throw new Error("cert fetch failed");
      if (options.certification == null) return undefined;
      return options.certification;
    },
  };
}

function makeCacheImageSpy() {
  const calls: { tmdbPath: string; kind: string }[] = [];
  const cacheImage = vi.fn(async (tmdbPath: string, kind: ImageKind): Promise<string> => {
    calls.push({ tmdbPath, kind });
    return `${kind}/${tmdbPath.replace(/^\//, "")}`;
  });
  return { cacheImage, calls };
}

function makeSaveMetadataSpy() {
  const calls: SaveMetadataInput[] = [];
  const saveMetadata = vi.fn(async (input: SaveMetadataInput): Promise<void> => {
    calls.push(input);
  });
  return { saveMetadata, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enrichItem", () => {
  it("Test 1: matches via searchMovie, fetches details, caches images, calls saveMetadata", async () => {
    const client = makeFakeClient();
    const { cacheImage, calls: imageCalls } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-1", title: "The Matrix", year: 1999 },
      { client, cacheImage, saveMetadata },
    );

    // matched
    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(MATRIX_ID);

    // saveMetadata called exactly once
    expect(saveCalls).toHaveLength(1);
    const saved = saveCalls[0];

    // required fields
    expect(saved.itemId).toBe("item-1");
    expect(saved.tmdbId).toBe(MATRIX_ID);
    expect(saved.overview).toBe(fakeMovie.overview);
    expect(saved.runtimeSec).toBe(8160);
    expect(saved.posterPath).toBe("poster/p.jpg");

    // genres mapped
    expect(saved.genres).toEqual([{ tmdbId: 28, name: "Action" }]);

    // director
    expect(saved.director).toBeDefined();
    expect(saved.director!.name).toBe("L. W.");
    expect(saved.director!.tmdbId).toBe(7);

    // cast capped at 15
    expect(saved.cast.length).toBeLessThanOrEqual(15);
    expect(saved.cast.length).toBeGreaterThan(0);

    // keywords
    expect(saved.keywords).toEqual([{ tmdbId: 9, name: "dystopia" }]);

    // cacheImage called for poster and backdrop
    expect(imageCalls.length).toBe(2);
    const posterCall = imageCalls.find((c) => c.kind === "poster");
    const backdropCall = imageCalls.find((c) => c.kind === "backdrop");
    expect(posterCall).toBeDefined();
    expect(backdropCall).toBeDefined();
  });

  it("Test 1b: forwards tmdbScore/tagline, resolved logo, and OMDb ratings", async () => {
    const client = makeFakeClient();
    const { cacheImage, calls: imageCalls } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-1b", title: "The Matrix", year: 1999 },
      {
        client,
        cacheImage,
        saveMetadata,
        resolveLogo: async ({ tmdbId, imdbId }) => {
          expect(tmdbId).toBe(MATRIX_ID);
          expect(imdbId).toBe("tt0133093");
          return "logo/matrix.png";
        },
        fetchRatings: async (imdbId) => {
          expect(imdbId).toBe("tt0133093");
          return { imdbRating: 8.7, imdbVotes: 2000000, rtRating: 88, metacritic: 73 };
        },
      },
    );

    expect(result.matched).toBe(true);
    const saved = saveCalls[0];
    expect(saved.tmdbScore).toBe(8.7);
    expect(saved.tagline).toBe("Welcome to the Real World.");
    expect(saved.logoPath).toBe("logo/matrix.png");
    expect(saved.imdbRating).toBe(8.7);
    expect(saved.rtRating).toBe(88);
    expect(saved.metacritic).toBe(73);
    // logo is resolved via the injected dep, not cacheImage
    expect(imageCalls.find((c) => c.kind === "logo")).toBeUndefined();
  });

  it("Test 2: no match → matched=false, saveMetadata NOT called", async () => {
    const client = makeFakeClient(null);
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-2", title: "Unknown Film" },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(false);
    expect(result.tmdbId).toBeUndefined();
    expect(saveCalls).toHaveLength(0);
  });

  it("Test 3: item already has tmdbId → searchMovie is NOT called", async () => {
    const client = makeFakeClient();
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-3", title: "The Matrix", year: 1999, tmdbId: MATRIX_ID },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(MATRIX_ID);
    // No TMDB search of any kind since tmdbId was embedded
    expect(client.searchMoviesCalls).toBe(0);
  });

  it("Test 4: releaseCertification returns a value → saveMetadata receives rating", async () => {
    const client = makeFakeClient(undefined, { certification: "R" });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-4", title: "The Matrix", year: 1999 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].rating).toBe("R");
  });

  it("Test 5: releaseCertification throws → enrichItem still succeeds, rating absent/undefined", async () => {
    const client = makeFakeClient(undefined, { certThrows: true });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-5", title: "The Matrix", year: 1999 },
      { client, cacheImage, saveMetadata },
    );

    // Enrich still completes successfully
    expect(result.matched).toBe(true);
    expect(saveCalls).toHaveLength(1);
    // rating should be undefined (not throw)
    expect(saveCalls[0].rating).toBeUndefined();
  });

  it("Test 6: releaseCertification returns undefined → saveMetadata receives no rating", async () => {
    const client = makeFakeClient(undefined, { certification: null });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    await enrichItem(
      { id: "item-6", title: "The Matrix", year: 1999 },
      { client, cacheImage, saveMetadata },
    );

    expect(saveCalls[0].rating).toBeUndefined();
  });

  it("Test 7: translateClients → saveMetadata receives per-language translations", async () => {
    const client = makeFakeClient();
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const esClient = {
      async movie(_id: number): Promise<TmdbMovie> {
        return { ...fakeMovie, title: "Matrix", overview: "Un hacker..." };
      },
    };

    await enrichItem(
      { id: "item-7", title: "The Matrix", year: 1999 },
      { client, cacheImage, saveMetadata, translateClients: new Map([["es", esClient]]) },
    );

    expect(saveCalls[0].translations).toEqual([
      { language: "es", title: "Matrix", overview: "Un hacker..." },
    ]);
  });

  it("Test 8: a failing translate client is skipped, enrichment still succeeds", async () => {
    const client = makeFakeClient();
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const badClient = {
      async movie(_id: number): Promise<TmdbMovie> {
        throw new Error("tmdb down");
      },
    };

    const result = await enrichItem(
      { id: "item-8", title: "The Matrix", year: 1999 },
      { client, cacheImage, saveMetadata, translateClients: new Map([["de", badClient]]) },
    );

    expect(result.matched).toBe(true);
    expect(saveCalls[0].translations).toEqual([]);
  });

  it("Test 9: ladder rescue — cleans release noise so a noisy title matches", async () => {
    // Old behavior: searchMovie("Body of Lies Remux") → null → unmatched.
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "Body of Lies"
          ? [{ tmdbId: 8064, title: "Body of Lies", year: 2008, voteCount: 800 }]
          : [],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-9", title: "Body of Lies Remux" },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(8064);
    expect(saveCalls).toHaveLength(1);
  });

  it("Test 10: Cyrillic — matches the film via its originalTitle after cleaning", async () => {
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "Горько! 2"
          ? [{ tmdbId: 253235, title: "Gorko 2", originalTitle: "Горько! 2", year: 2014, voteCount: 300 }]
          : [],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-10", title: "Горько! 2 Blu-Ray (" },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(253235);
  });

  it("Test 11: a low-similarity candidate is NOT matched on an exact year alone", async () => {
    // Regression for the false-positive class (a mangled Cyrillic title matched
    // to a random same-year film): exact year + votes must NOT be enough.
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "Zheleznyj chelovek 2"
          ? [{ tmdbId: 10138, title: "Iron Man 2", originalTitle: "Iron Man 2", year: 2010, voteCount: 15000 }]
          : [],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-11", title: "Zheleznyj chelovek 2", year: 2010 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(false);
    expect(saveCalls).toHaveLength(0);
  });

  it("Test 12: a clean common title resolves in a single search call", async () => {
    const client = makeFakeClient();
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-12", title: "The Matrix", year: 1999 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(client.searchMoviesCalls).toBe(1);
  });

  it("Test 13: low-similarity candidate is NOT accepted without a year (false-positive guard)", async () => {
    const client = makeFakeClient(null, {
      searchMovies: () => [
        { tmdbId: 10138, title: "Iron Man 2", year: 2010, voteCount: 15000 },
      ],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-13", title: "Zheleznyj chelovek 2" }, // no year, low similarity → no match
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(false);
    expect(saveCalls).toHaveLength(0);
  });

  it("Test 14: matches via a parenthetical original-title variant", async () => {
    // "Экзистенция (eXistenZ) (BDRemux)" — only the (eXistenZ) parenthetical is
    // searchable; the ladder tries it as its own query.
    const EXISTENZ_ID = 1876;
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "eXistenZ"
          ? [{ tmdbId: EXISTENZ_ID, title: "eXistenZ", originalTitle: "eXistenZ", year: 1999, voteCount: 900 }]
          : [],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-14", title: "Экзистенция (eXistenZ) (BDRemux)" },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(EXISTENZ_ID);
  });

  it("Test 15: matches a long official title via the prefix rescue", async () => {
    const FD_ID = 542178;
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "The French Dispatch"
          ? [{ tmdbId: FD_ID, title: "The French Dispatch of the Liberty, Kansas Evening Sun", voteCount: 2000 }]
          : [],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-15", title: "The French Dispatch BDRemux" },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(FD_ID);
  });

  it("Test 16: matches via an in-title year used as a last-resort filter", async () => {
    const TAXI_ID = 2377;
    const client = makeFakeClient(null, {
      searchMovies: (query, year) =>
        query === "Taxi" && year === 1998
          ? [{ tmdbId: TAXI_ID, title: "Taxi", year: 1998, voteCount: 500 }]
          : [],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-16", title: "Taxi 1998" },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(TAXI_ID);
  });

  it("Test 17: deep check — Cyrillic query verified against the candidate's alternative titles", async () => {
    // TMDB's search index finds Shawshank for "Побег из Шоушенка" but returns the
    // ENGLISH display title, so the cheap gate can't verify it. The deep check
    // fetches every known title and finds the exact RU alternative title.
    const SHAWSHANK = 278;
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "Побег из Шоушенка"
          ? [
              {
                tmdbId: SHAWSHANK,
                title: "The Shawshank Redemption",
                originalTitle: "The Shawshank Redemption",
                year: 1994,
                voteCount: 28000,
              },
            ]
          : [],
      allTitles: (id) =>
        id === SHAWSHANK
          ? ["The Shawshank Redemption", "Побег из Шоушенка", "Um Sonho de Liberdade"]
          : [],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-17", title: "Побег из Шоушенка", year: 1994 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(SHAWSHANK);
    expect(client.allTitlesCalls).toBe(1);
  });

  it("Test 18: deep check rejects a candidate whose known titles do not match", async () => {
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "Побег из Шоушенка"
          ? [{ tmdbId: 999, title: "Some Random Film", year: 1994, voteCount: 5000 }]
          : [],
      allTitles: () => ["Some Random Film", "Ein Zufälliger Film"],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-18", title: "Побег из Шоушенка", year: 1994 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(false);
    expect(saveCalls).toHaveLength(0);
  });

  it("Test 19: deep check matches an abbreviated subtitle via the acronym rule", async () => {
    const HAT_ID = 493529;
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "Dungeons and Dragons"
          ? [
              {
                tmdbId: HAT_ID,
                title: "Dungeons & Dragons: Honor Among Thieves",
                year: 2023,
                voteCount: 5000,
              },
            ]
          : [],
      allTitles: (id) => (id === HAT_ID ? ["Dungeons & Dragons: Honor Among Thieves"] : []),
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-19", title: "Dungeons and Dragons H.A.T.", year: 2023 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(HAT_ID);
  });

  it("Test 19b: deep check never verifies a TRUNCATED query — decoy with the truncation as an alt title loses to the acronym match", async () => {
    // Regression: the 2000 "Dungeons & Dragons" film carries the alt title
    // "Dungeons and Dragons", which exactly equals the first-3-tokens query of
    // "Dungeons and Dragons H.A.T.". A truncated query match proves nothing —
    // only faithful queries may verify a candidate in the deep check.
    const OLD_ID = 11849;
    const HAT_ID = 493529;
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "Dungeons and Dragons"
          ? [
              { tmdbId: OLD_ID, title: "Dungeons & Dragons", year: 2000, voteCount: 900 },
              { tmdbId: HAT_ID, title: "Dungeons & Dragons: Honor Among Thieves", year: 2023, voteCount: 5000 },
            ]
          : [],
      allTitles: (id) =>
        id === OLD_ID
          ? ["Dungeons & Dragons", "Dungeons and Dragons"] // decoy alt title
          : ["Dungeons & Dragons: Honor Among Thieves"],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-19b", title: "Dungeons and Dragons H.A.T.", year: 2023 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(HAT_ID); // not the 2000 decoy
  });

  it("Test 19c: a derived attempt can only SURFACE candidates, never accept one", async () => {
    // "1 Братство кольца" (disc 1, no year): the derived token "Братство"
    // returns the 2001 horror "Братство" at sim 1.0 — against the DERIVED
    // query. That must not be a match; the full query verifies nothing here.
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "Братство"
          ? [{ tmdbId: 28933, title: "Братство", year: 2001, voteCount: 300 }]
          : [],
      allTitles: () => ["Братство", "The Brotherhood"],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata, calls: saveCalls } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-19c", title: "1 Братство кольца" },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(false);
    expect(saveCalls).toHaveLength(0);
  });

  it("Test 19d: deep check verifies exact-year candidates before higher-ranked off-year ones", async () => {
    // Franchise pollution: the popular 2006 sequel carries the 2003 opener's
    // title among its alternative titles. The 2003 candidate must be verified
    // first because the item's year says 2003.
    const SEQUEL = 58; // 2006, more popular
    const OPENER = 22; // 2003, exact year
    const client = makeFakeClient(null, {
      searchMovies: (query) =>
        query === "Проклятие Черной жемчужины"
          ? [
              { tmdbId: SEQUEL, title: "Сундук мертвеца", year: 2006, voteCount: 20000 },
              { tmdbId: OPENER, title: "Пираты: Проклятие", year: 2003, voteCount: 15000 },
            ]
          : [],
      allTitles: (id) =>
        id === SEQUEL
          ? ["Сундук мертвеца", "Проклятие Чёрной жемчужины"] // polluted alt data
          : ["Проклятие Чёрной жемчужины"],
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-19d", title: "Проклятие Черной жемчужины", year: 2003 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(OPENER);
  });

  it("Test 19e: an exact-year acceptance beats a later strong-sim wrong-year one", async () => {
    // "Хроники Нарнии" (2005): the year-filtered attempt accepts the 2005 film
    // via the prefix rescue; the unfiltered attempt then returns an unreleased
    // reboot whose display title is literally the query (sim 1.0, wrong year).
    // Year agreement must win.
    const FILM_2005 = 411;
    const REBOOT_2027 = 1147572;
    const client = makeFakeClient(null, {
      searchMovies: (query, yr) => {
        if (query !== "Хроники Нарнии") return [];
        return yr === 2005
          ? [
              {
                tmdbId: FILM_2005,
                title: "Хроники Нарнии: Лев, колдунья и волшебный шкаф",
                year: 2005,
                voteCount: 11000,
              },
            ]
          : [{ tmdbId: REBOOT_2027, title: "Хроники Нарнии", year: 2027, voteCount: 250 }];
      },
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-19e", title: "Хроники Нарнии", year: 2005 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(FILM_2005);
  });

  it("Test 21: a weak exact-year candidate cannot displace a STRONG off-year match", async () => {
    // The item's parsed year is off by one vs TMDB's canonical year (common:
    // festival vs wide release). The sim-1.0 film must win over a junk film
    // that merely shares the parsed year at rule-B similarity.
    const RIGHT = 1001; // sim 1.0, year 1969
    const JUNK = 2002; // sim ~0.75 (WEAK tier), year 1968 (matches parsed year)
    const client = makeFakeClient(null, {
      searchMovies: (query) => {
        if (query !== "Once Upon a Time") return [];
        return [
          { tmdbId: RIGHT, title: "Once Upon a Time", year: 1969, voteCount: 9000 },
          { tmdbId: JUNK, title: "Once Upon a Winter", year: 1968, voteCount: 800 },
        ];
      },
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-21", title: "Once Upon a Time", year: 1968 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(RIGHT);
  });

  it("Test 22: deep-check WEAK-tier acceptance requires a real vote count", async () => {
    // A near-zero-vote film sharing the parsed year with a 0.6-sim translated
    // title must NOT be matched; the same film with real votes may be.
    const makeClientWithVotes = (votes: number) =>
      makeFakeClient(null, {
        searchMovies: (query) =>
          query === "Хитровка Знак четырёх"
            ? [{ tmdbId: 777, title: "Some Display Title", year: 2023, voteCount: votes }]
            : [],
        allTitles: () => ["Хитровка Знак"], // partial overlap ≈ WEAK tier
      });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const low = await enrichItem(
      { id: "item-22a", title: "Хитровка Знак четырёх", year: 2023 },
      { client: makeClientWithVotes(3), cacheImage, saveMetadata },
    );
    expect(low.matched).toBe(false);

    const ok = await enrichItem(
      { id: "item-22b", title: "Хитровка Знак четырёх", year: 2023 },
      { client: makeClientWithVotes(500), cacheImage, saveMetadata },
    );
    expect(ok.matched).toBe(true);
    expect(ok.tmdbId).toBe(777);
  });

  it("Test 23: a failing search attempt does not abort the ladder", async () => {
    let calls = 0;
    const client = makeFakeClient(null, {
      searchMovies: (query, yr) => {
        calls++;
        if (calls === 1) throw new Error("429 rate limited");
        return query === "The Matrix" && yr == null
          ? [{ tmdbId: MATRIX_ID, title: "The Matrix", year: 1999, voteCount: 20000 }]
          : [];
      },
    });
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-23", title: "The Matrix", year: 1999 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(MATRIX_ID);
  });

  it("Test 20: deep check is skipped entirely when the cheap gate already matched", async () => {
    const client = makeFakeClient(); // default: exact "The Matrix" candidate
    const { cacheImage } = makeCacheImageSpy();
    const { saveMetadata } = makeSaveMetadataSpy();

    const result = await enrichItem(
      { id: "item-20", title: "The Matrix", year: 1999 },
      { client, cacheImage, saveMetadata },
    );

    expect(result.matched).toBe(true);
    expect(client.allTitlesCalls).toBe(0);
  });
});
