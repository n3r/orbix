import { describe, it, expect, vi } from "vitest";
import { TvdbClient, TvdbError } from "./tvdb";

/** Build a fake fetch that returns queued JSON responses by URL substring. */
function fakeFetch(routes: { match: string; status?: number; body: unknown }[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no fake route for ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("TvdbClient auth + searchSeries", () => {
  it("logs in lazily and searches series", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "jwt-1" } } },
      {
        match: "/search",
        body: {
          status: "success",
          data: [{ tvdb_id: "121361", name: "Game of Thrones", year: "2011", image_url: "https://x/p.jpg" }],
        },
      },
    ]);
    const client = new TvdbClient("api-key", fetchImpl, "pin-1");
    const res = await client.searchSeries("Game of Thrones", 2011);
    expect(res).toEqual({ tvdbId: 121361, title: "Game of Thrones", year: 2011 });

    // login called once with apikey + pin; search carried the Bearer token
    const loginCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("/login"),
    );
    expect(JSON.parse((loginCall![1] as RequestInit).body as string)).toEqual({ apikey: "api-key", pin: "pin-1" });
    const searchCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("/search"),
    );
    expect((searchCall![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-1" });
  });

  it("returns null when there are no results", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "jwt-1" } } },
      { match: "/search", body: { status: "success", data: [] } },
    ]);
    const client = new TvdbClient("k", fetchImpl);
    expect(await client.searchSeries("Nope")).toBeNull();
  });

  it("re-logs in once on a 401 and retries", async () => {
    let searchHits = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login")) {
        return new Response(JSON.stringify({ status: "success", data: { token: "jwt-fresh" } }), { status: 200 });
      }
      searchHits++;
      if (searchHits === 1) return new Response("unauthorized", { status: 401 });
      return new Response(
        JSON.stringify({ status: "success", data: [{ tvdb_id: "9", name: "X", year: "2000" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new TvdbClient("k", fetchImpl);
    const res = await client.searchSeries("X");
    expect(res?.tvdbId).toBe(9);
    expect(searchHits).toBe(2); // retried once
  });

  it("throws TvdbError on a non-401 error", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "t" } } },
      { match: "/search", status: 500, body: {} },
    ]);
    const client = new TvdbClient("k", fetchImpl);
    await expect(client.searchSeries("X")).rejects.toBeInstanceOf(TvdbError);
  });
});

import { pickArtwork } from "./tvdb";

describe("pickArtwork", () => {
  const art = [
    { image: "https://a/logo-eng.png", type: 23, language: "eng", score: 10 },
    { image: "https://a/logo-neutral.png", type: 23, language: null, score: 99 },
    { image: "https://a/bg.jpg", type: 3, language: null, score: 5 },
  ];
  it("prefers the requested language, then highest score", () => {
    expect(pickArtwork(art, 23, "eng")).toBe("https://a/logo-eng.png");
  });
  it("falls back to any of the type by score when language missing", () => {
    expect(pickArtwork(art, 23, "spa")).toBe("https://a/logo-neutral.png");
  });
  it("returns undefined when the type is absent", () => {
    expect(pickArtwork(art, 2, "eng")).toBeUndefined();
  });
});

describe("TvdbClient.series", () => {
  it("normalises the extended record", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "t" } } },
      {
        match: "/series/121361/extended",
        body: {
          status: "success",
          data: {
            id: 121361,
            name: "Game of Thrones",
            image: "https://a/poster.jpg",
            overview: "Nine noble families…",
            year: "2011",
            status: { name: "Ended" },
            genres: [{ id: 1, name: "Drama" }, { id: 2, name: "Fantasy" }],
            remoteIds: [
              { id: "tt0944947", type: 2, sourceName: "IMDB" },
              { id: "1399", type: 12, sourceName: "TheMovieDB.com" },
            ],
            seasons: [
              { id: 500, number: 0, image: "https://a/s0.jpg", type: { type: "official" } },
              { id: 501, number: 1, image: "https://a/s1.jpg", type: { type: "official" } },
              { id: 599, number: 1, image: "https://a/s1-dvd.jpg", type: { type: "dvd" } },
            ],
            artworks: [
              { image: "https://a/bg.jpg", type: 3, language: null, score: 8 },
              { image: "https://a/logo.png", type: 23, language: "eng", score: 8 },
            ],
            contentRatings: [
              { name: "TV-MA", country: "usa" },
              { name: "18", country: "gbr" },
            ],
          },
        },
      },
    ]);
    const client = new TvdbClient("k", fetchImpl);
    const s = await client.series(121361);
    expect(s).toMatchObject({
      tvdbId: 121361,
      title: "Game of Thrones",
      year: 2011,
      status: "Ended",
      posterUrl: "https://a/poster.jpg",
      backdropUrl: "https://a/bg.jpg",
      logoUrl: "https://a/logo.png",
      imdbId: "tt0944947",
      tmdbId: 1399,
      contentRating: "TV-MA",
      genres: [{ name: "Drama" }, { name: "Fantasy" }],
    });
    // official seasons only, de-duped by number
    expect(s.seasons).toEqual([
      { seasonNumber: 0, posterUrl: "https://a/s0.jpg", tvdbSeasonId: 500 },
      { seasonNumber: 1, posterUrl: "https://a/s1.jpg", tvdbSeasonId: 501 },
    ]);
  });
});

describe("TvdbClient.seasonEpisodes", () => {
  it("follows pagination and normalises episodes", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login")) {
        return new Response(JSON.stringify({ status: "success", data: { token: "t" } }), { status: 200 });
      }
      if (url.includes("/episodes/default")) {
        const page = new URL(url).searchParams.get("page") ?? "0";
        if (page === "0") {
          return new Response(
            JSON.stringify({
              data: {
                episodes: [
                  { id: 1, seasonNumber: 1, number: 1, name: "Winter Is Coming", overview: "o1", image: "https://a/e1.jpg", runtime: 62, aired: "2011-04-17" },
                ],
              },
              links: { next: `${"https://api4.thetvdb.com/v4"}/series/9/episodes/default?page=1` },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            data: { episodes: [{ id: 2, seasonNumber: 1, number: 2, name: "The Kingsroad", aired: "2011-04-24" }] },
            links: { next: null },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const client = new TvdbClient("k", fetchImpl);
    const eps = await client.seasonEpisodes(9);
    expect(eps).toEqual([
      { seasonNumber: 1, episodeNumber: 1, title: "Winter Is Coming", overview: "o1", stillUrl: "https://a/e1.jpg", runtimeSec: 3720, airDate: "2011-04-17", tvdbEpisodeId: 1 },
      { seasonNumber: 1, episodeNumber: 2, title: "The Kingsroad", airDate: "2011-04-24", tvdbEpisodeId: 2 },
    ]);
  });
});
