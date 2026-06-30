import { describe, it, expect, vi } from "vitest";
import { enrichItem } from "./enrich";
import type { TmdbLike, SaveMetadataInput } from "./enrich";
import type { TmdbMovie, TmdbCredits, TmdbKeyword, TmdbSearchResult } from "./tmdb";

// ---------------------------------------------------------------------------
// Fakes — NO real network, NO real disk, NO real DB.
// ---------------------------------------------------------------------------

const MATRIX_ID = 603;

const fakeMovie: TmdbMovie = {
  tmdbId: MATRIX_ID,
  title: "The Matrix",
  year: 1999,
  overview: "A computer hacker learns from mysterious rebels about the true nature of his reality.",
  runtimeSec: 8160,
  posterPath: "/p.jpg",
  backdropPath: "/b.jpg",
  imdbId: "tt0133093",
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
  options: { certification?: string | null; certThrows?: boolean } = {},
): TmdbLike & { searchCalls: number } {
  let searchCalls = 0;
  return {
    get searchCalls() {
      return searchCalls;
    },
    async searchMovie(_title: string, _year?: number): Promise<TmdbSearchResult | null> {
      searchCalls++;
      return searchResult;
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
  const cacheImage = vi.fn(async (tmdbPath: string, kind: "poster" | "backdrop"): Promise<string> => {
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
    // searchMovie should NOT have been called since tmdbId was embedded
    expect(client.searchCalls).toBe(0);
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
});
