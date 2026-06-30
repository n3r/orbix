import { describe, it, expect, vi } from "vitest";
import { enrichSeries } from "./enrich-series";
import type { TmdbTvLike, SaveSeriesInput } from "./enrich-series";
import type { TmdbTv, TmdbEpisode, TmdbSearchResult } from "./tmdb";
import type { ImageKind } from "./images";

const ARCANE = 94605;

const fakeTv: TmdbTv = {
  tmdbId: ARCANE,
  title: "Arcane",
  year: 2021,
  overview: "Two sisters on opposite sides of a brewing war.",
  tagline: "Welcome to the playground.",
  posterPath: "/p.jpg",
  backdropPath: "/b.jpg",
  imdbId: "tt11126994",
  tmdbScore: 8.7,
  status: "Returning Series",
  genres: [{ tmdbId: 16, name: "Animation" }],
  seasons: [
    { seasonNumber: 0, episodeCount: 3, name: "Specials" },
    { seasonNumber: 1, episodeCount: 9, name: "Season 1", posterPath: "/s1.jpg", airYear: 2021 },
    { seasonNumber: 2, episodeCount: 9, name: "Season 2", airYear: 2024 },
  ],
};

const s1Episodes: TmdbEpisode[] = [
  { episodeNumber: 1, title: "Welcome", overview: "o1", stillPath: "/e1.jpg", runtimeSec: 2520, airDate: "2021-11-06", tmdbEpisodeId: 1 },
  { episodeNumber: 2, title: "Some Mysteries", overview: "o2", runtimeSec: 2520, tmdbEpisodeId: 2 },
];

function makeClient(searchResult: TmdbSearchResult | null = { tmdbId: ARCANE, title: "Arcane", year: 2021 }) {
  const seasonCalls: number[] = [];
  const client: TmdbTvLike & { seasonCalls: number[] } = {
    seasonCalls,
    async searchTv() {
      return searchResult;
    },
    async tv() {
      return fakeTv;
    },
    async tvSeason(_id, n) {
      seasonCalls.push(n);
      return n === 1 ? s1Episodes : [];
    },
    async tvContentRating() {
      return "TV-14";
    },
  };
  return client;
}

function makeImageSpy() {
  const cacheImage = vi.fn(async (p: string, kind: ImageKind) => `${kind}/${p.replace(/^\//, "")}`);
  return cacheImage;
}

function makeSaveSpy() {
  const calls: SaveSeriesInput[] = [];
  const saveSeries = vi.fn(async (input: SaveSeriesInput) => {
    calls.push(input);
  });
  return { saveSeries, calls };
}

describe("enrichSeries", () => {
  it("only fetches local seasons and assembles series + episodes", async () => {
    const client = makeClient();
    const cacheImage = makeImageSpy();
    const { saveSeries, calls } = makeSaveSpy();

    const result = await enrichSeries(
      { id: "series-1", title: "Arcane", year: 2021 },
      { client, cacheImage, saveSeries, localSeasonNumbers: [1] },
    );

    expect(result.matched).toBe(true);
    expect(result.tmdbId).toBe(ARCANE);
    // Only season 1 was fetched (not 0 or 2).
    expect(client.seasonCalls).toEqual([1]);

    const saved = calls[0];
    expect(saved.title).toBe("Arcane");
    expect(saved.status).toBe("Returning Series");
    expect(saved.tmdbScore).toBe(8.7);
    expect(saved.rating).toBe("TV-14");
    expect(saved.seasons).toHaveLength(1);
    expect(saved.seasons[0].seasonNumber).toBe(1);
    expect(saved.seasons[0].episodes).toHaveLength(2);
    expect(saved.seasons[0].episodes[0].title).toBe("Welcome");
    expect(saved.seasons[0].episodes[0].stillPath).toBe("still/e1.jpg");
  });

  it("forwards resolved logo + OMDb ratings", async () => {
    const client = makeClient();
    const cacheImage = makeImageSpy();
    const { saveSeries, calls } = makeSaveSpy();

    await enrichSeries(
      { id: "series-2", title: "Arcane" },
      {
        client,
        cacheImage,
        saveSeries,
        localSeasonNumbers: [1],
        resolveLogo: async () => "logo/arcane.png",
        fetchRatings: async () => ({ imdbRating: 9, rtRating: 100 }),
      },
    );

    const saved = calls[0];
    expect(saved.logoPath).toBe("logo/arcane.png");
    expect(saved.imdbRating).toBe(9);
    expect(saved.rtRating).toBe(100);
  });

  it("returns matched=false when there is no TMDB match", async () => {
    const client = makeClient(null);
    const cacheImage = makeImageSpy();
    const { saveSeries, calls } = makeSaveSpy();

    const result = await enrichSeries(
      { id: "series-3", title: "Unknown Show" },
      { client, cacheImage, saveSeries },
    );

    expect(result.matched).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("emits series/season/episode translations from translateClients", async () => {
    const client = makeClient();
    const cacheImage = makeImageSpy();
    const { saveSeries, calls } = makeSaveSpy();

    const esClient = {
      async tv(): Promise<TmdbTv> {
        return {
          ...fakeTv,
          title: "Arcane (ES)",
          overview: "Dos hermanas en bandos opuestos.",
          seasons: [
            { seasonNumber: 0, episodeCount: 3, name: "Especiales" },
            { seasonNumber: 1, episodeCount: 9, name: "Temporada 1" },
            { seasonNumber: 2, episodeCount: 9, name: "Temporada 2" },
          ],
        };
      },
      async tvSeason(_id: number, n: number): Promise<TmdbEpisode[]> {
        return n === 1
          ? [
              { episodeNumber: 1, title: "Bienvenidos", overview: "oe1" },
              { episodeNumber: 2, title: "Algunos misterios", overview: "oe2" },
            ]
          : [];
      },
    };

    await enrichSeries(
      { id: "series-es", title: "Arcane", year: 2021 },
      { client, cacheImage, saveSeries, localSeasonNumbers: [1], translateClients: new Map([["es", esClient]]) },
    );

    const saved = calls[0];
    expect(saved.translations).toEqual([
      { language: "es", title: "Arcane (ES)", overview: "Dos hermanas en bandos opuestos." },
    ]);
    const s1 = saved.seasons.find((s) => s.seasonNumber === 1)!;
    expect(s1.translations).toEqual([{ language: "es", name: "Temporada 1" }]);
    expect(s1.episodes[0].translations).toEqual([
      { language: "es", title: "Bienvenidos", overview: "oe1" },
    ]);
  });

  it("skips a failing translate client and still succeeds", async () => {
    const client = makeClient();
    const cacheImage = makeImageSpy();
    const { saveSeries, calls } = makeSaveSpy();

    const badClient = {
      async tv(): Promise<TmdbTv> {
        throw new Error("tmdb down");
      },
      async tvSeason(): Promise<TmdbEpisode[]> {
        return [];
      },
    };

    const result = await enrichSeries(
      { id: "series-bad", title: "Arcane" },
      { client, cacheImage, saveSeries, localSeasonNumbers: [1], translateClients: new Map([["de", badClient]]) },
    );

    expect(result.matched).toBe(true);
    expect(calls[0].translations).toEqual([]);
    expect(calls[0].seasons[0].translations).toBeUndefined();
  });
});
