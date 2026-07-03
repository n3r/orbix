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
    searchMovies?: (query: string, year?: number) => TmdbSearchCandidate[];
  } = {},
): TmdbLike & { searchCalls: number; searchMoviesCalls: number } {
  let searchCalls = 0;
  let searchMoviesCalls = 0;
  // Default: one candidate mirroring searchResult (a strong string match for the
  // existing "The Matrix" tests), or none when searchResult is null.
  const defaultCandidates: TmdbSearchCandidate[] = searchResult
    ? [{ tmdbId: searchResult.tmdbId, title: searchResult.title, year: searchResult.year, voteCount: 20000 }]
    : [];
  return {
    get searchCalls() {
      return searchCalls;
    },
    get searchMoviesCalls() {
      return searchMoviesCalls;
    },
    async searchMovie(_title: string, _year?: number): Promise<TmdbSearchResult | null> {
      searchCalls++;
      return searchResult;
    },
    async searchMovies(query: string, year?: number): Promise<TmdbSearchCandidate[]> {
      searchMoviesCalls++;
      return options.searchMovies ? options.searchMovies(query, year) : defaultCandidates;
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
    expect(client.searchCalls).toBe(0);
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
});
