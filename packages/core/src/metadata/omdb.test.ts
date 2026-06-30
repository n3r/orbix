import { describe, it, expect } from "vitest";
import { parseOmdbRatings, fetchOmdbRatings } from "./omdb";

describe("parseOmdbRatings", () => {
  it("extracts imdb, votes, metacritic and rotten tomatoes", () => {
    expect(
      parseOmdbRatings({
        Response: "True",
        imdbRating: "9.0",
        imdbVotes: "1,234,567",
        Metascore: "85",
        Ratings: [
          { Source: "Internet Movie Database", Value: "9.0/10" },
          { Source: "Rotten Tomatoes", Value: "96%" },
          { Source: "Metacritic", Value: "85/100" },
        ],
      }),
    ).toEqual({ imdbRating: 9, imdbVotes: 1234567, metacritic: 85, rtRating: 96 });
  });

  it("ignores N/A and missing fields", () => {
    expect(parseOmdbRatings({ Response: "True", imdbRating: "N/A", Ratings: [] })).toEqual({});
  });

  it("returns empty for a not-found response", () => {
    expect(parseOmdbRatings({ Response: "False" })).toEqual({});
  });
});

describe("fetchOmdbRatings", () => {
  it("returns undefined without an api key", async () => {
    const fetchImpl = (() => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    expect(await fetchOmdbRatings("tt1", { fetchImpl, apiKey: "" })).toBeUndefined();
  });

  it("fetches and parses ratings", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ Response: "True", imdbRating: "8.5", Ratings: [{ Source: "Rotten Tomatoes", Value: "90%" }] }),
    })) as unknown as typeof fetch;
    expect(await fetchOmdbRatings("tt1", { fetchImpl, apiKey: "k" })).toEqual({ imdbRating: 8.5, rtRating: 90 });
  });

  it("returns undefined when OMDb reports no data", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ Response: "False", Error: "Movie not found!" }),
    })) as unknown as typeof fetch;
    expect(await fetchOmdbRatings("tt1", { fetchImpl, apiKey: "k" })).toBeUndefined();
  });
});
