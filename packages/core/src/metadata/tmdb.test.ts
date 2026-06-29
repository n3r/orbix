import { describe, it, expect } from "vitest";
import { TmdbClient, TmdbError, type TmdbSearchCandidate } from "./tmdb";

// ---------------------------------------------------------------------------
// Fake fetch helpers — NO real network. All tests use canned payloads.
// ---------------------------------------------------------------------------

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function makeFetch(payload: unknown, status = 200): {
  fake: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: url.toString(), init });
    const resp: FakeResponse = {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
    return resp as unknown as Response;
  };
  return { fake: fake as unknown as typeof fetch, calls };
}

// ---------------------------------------------------------------------------
// searchMovies (plural — returns top 8 candidates with posterPath)
// ---------------------------------------------------------------------------

describe("TmdbClient.searchMovies", () => {
  it("returns top 8 results mapped to TmdbSearchCandidate with posterPath", async () => {
    const { fake, calls } = makeFetch({
      results: [
        { id: 603, title: "The Matrix", release_date: "1999-03-31", poster_path: "/p.jpg" },
        { id: 604, title: "The Matrix Reloaded", release_date: "2003-05-15", poster_path: "/p2.jpg" },
        { id: 605, title: "The Matrix Revolutions", release_date: "2003-11-05", poster_path: null },
      ],
    });

    const client = new TmdbClient("tok", fake);
    const results: TmdbSearchCandidate[] = await client.searchMovies("The Matrix");

    // URL assertions
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/search/movie");
    expect(calls[0].url).toContain("query=The%20Matrix");
    expect(calls[0].url).not.toContain("year=");

    // All three results returned
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ tmdbId: 603, title: "The Matrix", year: 1999, posterPath: "/p.jpg" });
    expect(results[1]).toEqual({ tmdbId: 604, title: "The Matrix Reloaded", year: 2003, posterPath: "/p2.jpg" });
    // null poster_path → posterPath omitted
    expect(results[2]).toEqual({ tmdbId: 605, title: "The Matrix Revolutions", year: 2003 });
    expect(results[2]!.posterPath).toBeUndefined();
  });

  it("appends year param when provided", async () => {
    const { fake, calls } = makeFetch({ results: [] });
    const client = new TmdbClient("tok", fake);
    await client.searchMovies("The Matrix", 1999);
    expect(calls[0]!.url).toContain("year=1999");
  });

  it("limits results to 8 even when API returns more", async () => {
    const manyResults = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      title: `Movie ${i + 1}`,
      release_date: "2020-01-01",
      poster_path: null,
    }));
    const { fake } = makeFetch({ results: manyResults });
    const client = new TmdbClient("tok", fake);
    const candidates = await client.searchMovies("Movie");
    expect(candidates).toHaveLength(8);
  });

  it("returns empty array when results is empty", async () => {
    const { fake } = makeFetch({ results: [] });
    const client = new TmdbClient("tok", fake);
    const candidates = await client.searchMovies("Nothing");
    expect(candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchMovie
// ---------------------------------------------------------------------------

describe("TmdbClient.searchMovie", () => {
  it("returns first result mapped to TmdbSearchResult", async () => {
    const { fake, calls } = makeFetch({
      results: [{ id: 603, title: "The Matrix", release_date: "1999-03-31" }],
    });

    const client = new TmdbClient("tok", fake);
    const result = await client.searchMovie("The Matrix", 1999);

    // URL assertions
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/search/movie");
    expect(calls[0].url).toContain("query=The%20Matrix");
    expect(calls[0].url).toContain("year=1999");

    // Auth header assertion
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");

    // Normalized result
    expect(result).toEqual({ tmdbId: 603, title: "The Matrix", year: 1999 });
  });

  it("returns null when results array is empty", async () => {
    const { fake } = makeFetch({ results: [] });
    const client = new TmdbClient("tok", fake);
    const result = await client.searchMovie("Unknown Film");
    expect(result).toBeNull();
  });

  it("omits year when release_date is absent", async () => {
    const { fake } = makeFetch({
      results: [{ id: 999, title: "No Date Film" }],
    });
    const client = new TmdbClient("tok", fake);
    const result = await client.searchMovie("No Date Film");
    expect(result).toEqual({ tmdbId: 999, title: "No Date Film" });
    expect(result?.year).toBeUndefined();
  });

  it("does not append year param when year is not provided", async () => {
    const { fake, calls } = makeFetch({ results: [] });
    const client = new TmdbClient("tok", fake);
    await client.searchMovie("Something");
    expect(calls[0].url).not.toContain("year=");
  });
});

// ---------------------------------------------------------------------------
// movie
// ---------------------------------------------------------------------------

describe("TmdbClient.movie", () => {
  const canned = {
    id: 603,
    title: "The Matrix",
    release_date: "1999-03-31",
    overview: "Neo...",
    runtime: 136,
    poster_path: "/p.jpg",
    backdrop_path: "/b.jpg",
    imdb_id: "tt0133093",
    genres: [{ id: 28, name: "Action" }],
  };

  it("maps all fields to TmdbMovie", async () => {
    const { fake, calls } = makeFetch(canned);
    const client = new TmdbClient("tok", fake);
    const movie = await client.movie(603);

    expect(calls[0].url).toContain("/movie/603");
    expect(movie.tmdbId).toBe(603);
    expect(movie.title).toBe("The Matrix");
    expect(movie.year).toBe(1999);
    expect(movie.overview).toBe("Neo...");
    expect(movie.runtimeSec).toBe(136 * 60); // 8160
    expect(movie.posterPath).toBe("/p.jpg");
    expect(movie.backdropPath).toBe("/b.jpg");
    expect(movie.imdbId).toBe("tt0133093");
    expect(movie.genres).toEqual([{ tmdbId: 28, name: "Action" }]);
  });

  it("handles missing optional fields gracefully", async () => {
    const { fake } = makeFetch({ id: 1, title: "Minimal", genres: [] });
    const client = new TmdbClient("tok", fake);
    const movie = await client.movie(1);
    expect(movie.year).toBeUndefined();
    expect(movie.overview).toBeUndefined();
    expect(movie.runtimeSec).toBeUndefined();
    expect(movie.posterPath).toBeUndefined();
    expect(movie.backdropPath).toBeUndefined();
    expect(movie.imdbId).toBeUndefined();
    expect(movie.genres).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// credits
// ---------------------------------------------------------------------------

describe("TmdbClient.credits", () => {
  it("maps cast and crew", async () => {
    const { fake } = makeFetch({
      cast: [{ id: 6384, name: "Keanu Reeves", character: "Neo", order: 0 }],
      crew: [{ id: 9339, name: "Lilly Wachowski", job: "Director", department: "Directing" }],
    });

    const client = new TmdbClient("tok", fake);
    const credits = await client.credits(603);

    expect(credits.cast).toEqual([
      { tmdbId: 6384, name: "Keanu Reeves", character: "Neo", order: 0 },
    ]);
    expect(credits.crew).toEqual([
      { tmdbId: 9339, name: "Lilly Wachowski", job: "Director", department: "Directing" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// keywords
// ---------------------------------------------------------------------------

describe("TmdbClient.keywords", () => {
  it("maps keywords array", async () => {
    const { fake } = makeFetch({
      keywords: [
        { id: 703, name: "martial arts" },
        { id: 311, name: "dystopia" },
      ],
    });

    const client = new TmdbClient("tok", fake);
    const kws = await client.keywords(603);

    expect(kws).toEqual([
      { tmdbId: 703, name: "martial arts" },
      { tmdbId: 311, name: "dystopia" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// releaseCertification
// ---------------------------------------------------------------------------

describe("TmdbClient.releaseCertification", () => {
  it("returns the US certification from the release_dates payload", async () => {
    const payload = {
      results: [
        { iso_3166_1: "US", release_dates: [{ certification: "PG-13" }] },
        { iso_3166_1: "GB", release_dates: [{ certification: "12A" }] },
      ],
    };
    const { fake, calls } = makeFetch(payload);
    const client = new TmdbClient("tok", fake);

    const cert = await client.releaseCertification(603);

    // Correct certification (US, not GB)
    expect(cert).toBe("PG-13");

    // URL contains the correct path
    expect(calls[0].url).toContain("/movie/603/release_dates");

    // Bearer auth header is present
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
  });

  it("returns undefined when there is no US entry", async () => {
    const payload = {
      results: [{ iso_3166_1: "GB", release_dates: [{ certification: "12A" }] }],
    };
    const { fake } = makeFetch(payload);
    const client = new TmdbClient("tok", fake);
    const cert = await client.releaseCertification(603);
    expect(cert).toBeUndefined();
  });

  it("returns undefined when the US entry has only empty certifications", async () => {
    const payload = {
      results: [
        { iso_3166_1: "US", release_dates: [{ certification: "" }, { certification: "" }] },
      ],
    };
    const { fake } = makeFetch(payload);
    const client = new TmdbClient("tok", fake);
    const cert = await client.releaseCertification(603);
    expect(cert).toBeUndefined();
  });

  it("returns undefined when results array is empty", async () => {
    const { fake } = makeFetch({ results: [] });
    const client = new TmdbClient("tok", fake);
    const cert = await client.releaseCertification(603);
    expect(cert).toBeUndefined();
  });

  it("picks the first non-empty certification from multiple US release_dates entries", async () => {
    const payload = {
      results: [
        {
          iso_3166_1: "US",
          release_dates: [{ certification: "" }, { certification: "R" }],
        },
      ],
    };
    const { fake } = makeFetch(payload);
    const client = new TmdbClient("tok", fake);
    const cert = await client.releaseCertification(603);
    expect(cert).toBe("R");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("TmdbClient error handling", () => {
  it("throws TmdbError on non-2xx response", async () => {
    const { fake } = makeFetch({ status_message: "Unauthorized" }, 401);
    const client = new TmdbClient("tok", fake);
    await expect(client.movie(1)).rejects.toBeInstanceOf(TmdbError);
  });

  it("TmdbError includes the HTTP status code", async () => {
    const { fake } = makeFetch({}, 404);
    const client = new TmdbClient("tok", fake);
    await expect(client.movie(1)).rejects.toThrow("404");
  });
});
