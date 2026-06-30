import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

function authed(app: unknown, profile: Record<string, unknown>) {
  const a = app as { prisma: Record<string, unknown> };
  a.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  a.prisma.profile = { findUnique: async () => profile };
}

const esProfile = { id: "p1", name: "Sofía", avatar: null, kind: "standard", maturityCap: null, language: "es" };

describe("GET /items/:id/seasons/:n/episodes localization", () => {
  it("returns localized episode title/overview for the active language", async () => {
    const app = await buildApp(env);
    authed(app, esProfile);
    const p = (app as unknown as { prisma: Record<string, unknown> }).prisma;
    p.mediaItem = { findUnique: async () => ({ id: "sr1", kind: "series", rating: "TV-14" }) };
    p.season = { findUnique: async () => ({ id: "se1" }) };
    p.episode = {
      findMany: async () => [
        {
          id: "e1", episodeNumber: 1, title: "Welcome", overview: "An intro.",
          stillPath: null, runtimeSec: 2520, airDate: null, files: [{ id: "f1" }],
          translations: [{ title: "Bienvenidos", overview: "Una introducción." }],
        },
        {
          id: "e2", episodeNumber: 2, title: "Some Mysteries", overview: "More.",
          stillPath: null, runtimeSec: 2520, airDate: null, files: [],
          translations: [],
        },
      ],
    };
    p.playbackState = { findMany: async () => [] };

    const res = await app.inject({
      method: "GET", url: "/api/items/sr1/seasons/1/episodes",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    const eps = res.json().episodes;
    expect(eps[0].title).toBe("Bienvenidos");
    expect(eps[0].overview).toBe("Una introducción.");
    // No translation row → falls back to base.
    expect(eps[1].title).toBe("Some Mysteries");
    expect(eps[1].overview).toBe("More.");
    await app.close();
  });

  it("blocks a kids profile above the cap (gate intact under localization)", async () => {
    const app = await buildApp(env);
    authed(app, { ...esProfile, kind: "kids", maturityCap: 0 });
    const p = (app as unknown as { prisma: Record<string, unknown> }).prisma;
    p.mediaItem = { findUnique: async () => ({ id: "sr1", kind: "series", rating: "TV-MA" }) };

    const res = await app.inject({
      method: "GET", url: "/api/items/sr1/seasons/1/episodes",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /items/:id season-name localization", () => {
  it("localizes season names for a series", async () => {
    const app = await buildApp(env);
    authed(app, esProfile);
    const p = (app as unknown as { prisma: Record<string, unknown> }).prisma;
    p.mediaItem = {
      findUnique: async () => ({
        id: "sr1", kind: "series", title: "Arcane", year: 2021, overview: "o",
        tagline: null, status: "Ended", runtimeSec: null, rating: "TV-14",
        posterPath: null, backdropPath: null, logoPath: null, tmdbScore: null,
        imdbRating: null, imdbVotes: null, rtRating: null, metacritic: null, matchState: "matched",
        translations: [{ title: "Arcane", overview: "o" }],
        genres: [],
        seasons: [
          { seasonNumber: 1, name: "Season 1", posterPath: null, _count: { episodes: 9 }, translations: [{ name: "Temporada 1" }] },
          { seasonNumber: 2, name: "Season 2", posterPath: null, _count: { episodes: 9 }, translations: [] },
        ],
        credits: [],
        files: [],
      }),
    };

    const res = await app.inject({
      method: "GET", url: "/api/items/sr1",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seasons[0].name).toBe("Temporada 1"); // localized
    expect(body.seasons[1].name).toBe("Season 2"); // fallback
    await app.close();
  });
});
