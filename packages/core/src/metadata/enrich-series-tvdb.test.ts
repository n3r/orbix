import { describe, it, expect, vi } from "vitest";
import { enrichSeriesTvdb } from "./enrich-series-tvdb";
import type { TvdbSeries, TvdbEpisode, TvdbSearchResult, TvdbTranslation } from "./tvdb";
import type { SaveSeriesInput } from "./enrich-series";

const series: TvdbSeries = {
  tvdbId: 9,
  title: "Game of Thrones",
  year: 2011,
  overview: "Nine…",
  status: "Ended",
  posterUrl: "https://a/p.jpg",
  backdropUrl: "https://a/b.jpg",
  logoUrl: "https://a/l.png",
  imdbId: "tt0944947",
  tmdbId: 1399,
  contentRating: "TV-MA",
  genres: [{ name: "Drama" }],
  seasons: [{ seasonNumber: 1, posterUrl: "https://a/s1.jpg", tvdbSeasonId: 501 }],
};
const episodes: TvdbEpisode[] = [
  { seasonNumber: 1, episodeNumber: 1, title: "Winter Is Coming", overview: "o1", stillUrl: "https://a/e1.jpg", runtimeSec: 3720, airDate: "2011-04-17", tvdbEpisodeId: 101 },
];

function makeDeps(overrides: Partial<Parameters<typeof enrichSeriesTvdb>[1]> = {}) {
  const saved: SaveSeriesInput[] = [];
  const client = {
    searchSeries: vi.fn(async (): Promise<TvdbSearchResult | null> => ({ tvdbId: 9, title: "Game of Thrones", year: 2011 })),
    series: vi.fn(async () => series),
    seasonEpisodes: vi.fn(async () => episodes),
  };
  const deps = {
    client,
    cacheImageUrl: vi.fn(async (url: string) => `cached/${url.split("/").pop()}`),
    saveSeries: vi.fn(async (i: SaveSeriesInput) => { saved.push(i); }),
    fetchRatings: vi.fn(async () => ({ imdbRating: 9.2, imdbVotes: 100, rtRating: 90, metacritic: 80 })),
    ...overrides,
  };
  return { deps, saved, client };
}

describe("enrichSeriesTvdb", () => {
  it("returns matched:false when TVDB has no match (fallback signal)", async () => {
    const { deps, client } = makeDeps();
    client.searchSeries.mockResolvedValueOnce(null);
    const res = await enrichSeriesTvdb({ id: "it1", title: "Nope" }, deps);
    expect(res).toEqual({ matched: false });
    expect(deps.saveSeries).not.toHaveBeenCalled();
  });

  it("enriches a matched series with tvdb source, ids, images and ratings", async () => {
    const { deps, saved } = makeDeps();
    const res = await enrichSeriesTvdb({ id: "it1", title: "Game of Thrones", year: 2011 }, deps);
    expect(res).toEqual({ matched: true, tvdbId: 9 });
    const s = saved[0]!;
    expect(s).toMatchObject({
      itemId: "it1",
      metadataSource: "tvdb",
      tvdbId: 9,
      tmdbId: 1399,
      imdbId: "tt0944947",
      title: "Game of Thrones",
      rating: "TV-MA",
      imdbRating: 9.2,
    });
    expect(s.tmdbId).toBe(1399);
    expect(s.posterPath).toBe("cached/p.jpg");
    expect(s.backdropPath).toBe("cached/b.jpg");
    expect(s.logoPath).toBe("cached/l.png");
    expect(s.seasons[0]).toMatchObject({ seasonNumber: 1, posterPath: "cached/s1.jpg", tvdbSeasonId: 501 });
    expect(s.seasons[0]!.episodes[0]).toMatchObject({
      episodeNumber: 1,
      title: "Winter Is Coming",
      stillPath: "cached/e1.jpg",
      runtimeSec: 3720,
      airDate: "2011-04-17",
      tvdbEpisodeId: 101,
    });
  });

  it("restricts to localSeasonNumbers when provided", async () => {
    const { deps, saved } = makeDeps();
    deps.client.seasonEpisodes = vi.fn(async () => [
      ...episodes,
      { seasonNumber: 2, episodeNumber: 1, title: "S2E1", tvdbEpisodeId: 201 },
    ]);
    await enrichSeriesTvdb({ id: "it1", title: "GoT", year: 2011 }, { ...deps, localSeasonNumbers: [1] });
    const s = saved[0]!;
    expect(s.seasons.map((x) => x.seasonNumber)).toEqual([1]);
  });

  it("attaches per-language translations and survives a failing translate client", async () => {
    const { deps, saved } = makeDeps();
    const goodTr: TvdbTranslation = {
      title: "Juego de Tronos",
      overview: "Nueve…",
      episodes: new Map([["1:1", { title: "Se acerca el invierno", overview: "o-es" }]]),
    };
    const translateClients = new Map([
      ["es", { seriesTranslated: vi.fn(async () => goodTr) }],
      ["de", { seriesTranslated: vi.fn(async () => { throw new Error("boom"); }) }],
    ]);
    await enrichSeriesTvdb({ id: "it1", title: "GoT", year: 2011 }, { ...deps, translateClients });
    const s = saved[0]!;
    expect(s.translations).toEqual([{ language: "es", title: "Juego de Tronos", overview: "Nueve…" }]);
    expect(s.seasons[0]!.episodes[0]!.translations).toEqual([
      { language: "es", title: "Se acerca el invierno", overview: "o-es" },
    ]);
  });
});
