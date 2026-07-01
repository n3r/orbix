import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

/** Build an authenticated app and capture the WHERE clause /search sends to findMany. */
async function appCapturingSearchWhere(profile: unknown) {
  const app = await buildApp(env);
  (app as any).prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  (app as any).prisma.profile = { findUnique: async () => profile };
  const captured: { where?: any } = {};
  (app as any).prisma.mediaItem = {
    findMany: async (args: any) => {
      captured.where = args.where;
      return [];
    },
  };
  return { app, captured };
}

describe("GET /search — ratingMax constraint", () => {
  it("applies a ratingMax constraint as a rating filter for a standard profile", async () => {
    const { app, captured } = await appCapturingSearchWhere(null);
    const res = await app.inject({
      method: "GET", url: "/api/search?q=" + encodeURIComponent("for kids"),
      cookies: { orbix_session: "s1" },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.where.rating).toEqual({ in: ["G", "PG"] });
    await app.close();
  });

  it("intersects ratingMax with a kids profile's maturity cap (stricter wins)", async () => {
    // kids cap = PG-13 (2) → {G,PG,PG-13}; query ratingMax PG → {G,PG}; intersection {G,PG}
    const { app, captured } = await appCapturingSearchWhere({
      id: "p1", name: "K", avatar: null, kind: "kids", maturityCap: 2,
    });
    const res = await app.inject({
      method: "GET", url: "/api/search?q=PG",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.where.rating).toEqual({ in: ["G", "PG"] });
    await app.close();
  });
});

describe("GET /home/rows — continue-watching enrichment", () => {
  function authed(app: any, profile: unknown = { id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null }) {
    app.prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    app.prisma.profile = { findUnique: async () => profile };
  }

  const cookies = { orbix_session: "s1", orbix_profile: "p1" };

  const seriesItem = {
    id: "series-1", title: "The Series", year: 2011, posterPath: "poster/s.jpg",
    addedAt: new Date("2026-06-30T00:00:00Z"),
    translations: [], genres: [], keywords: [], credits: [],
  };
  const movieItem = {
    id: "movie-1", title: "The Movie", year: 2020, posterPath: "poster/m.jpg",
    addedAt: new Date("2020-01-01T00:00:00Z"),
    translations: [], genres: [], keywords: [], credits: [],
  };

  it("adds progress + resume (S/E/title) to a series continue item and addedAt to all items", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.mediaItem = { findMany: async () => [seriesItem] };
    (app as any).prisma.playbackState = {
      findMany: async () => [
        { mediaItemId: "series-1", episodeId: "ep-1", positionSec: 600, durationSec: 1200, finished: false, updatedAt: new Date() },
      ],
    };
    (app as any).prisma.playEvent = { findMany: async () => [] };
    (app as any).prisma.episode = {
      findMany: async () => [{ id: "ep-1", episodeNumber: 4, title: "Old Friends", season: { seasonNumber: 3 } }],
    };

    const res = await app.inject({ method: "GET", url: "/api/home/rows", cookies });
    expect(res.statusCode).toBe(200);
    const cont = res.json().rows.find((r: any) => r.key === "continue");
    expect(cont.items[0]).toMatchObject({
      id: "series-1",
      addedAt: "2026-06-30T00:00:00.000Z",
      progress: { positionSec: 600, durationSec: 1200 },
      resume: { seasonNumber: 3, episodeNumber: 4, episodeTitle: "Old Friends" },
    });
    await app.close();
  });

  it("gives a movie continue item progress but resume=null (empty episodeId)", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.mediaItem = { findMany: async () => [movieItem] };
    (app as any).prisma.playbackState = {
      findMany: async () => [
        { mediaItemId: "movie-1", episodeId: "", positionSec: 300, durationSec: 6000, finished: false, updatedAt: new Date() },
      ],
    };
    (app as any).prisma.playEvent = { findMany: async () => [] };
    (app as any).prisma.episode = { findMany: async () => [] };

    const res = await app.inject({ method: "GET", url: "/api/home/rows", cookies });
    expect(res.statusCode).toBe(200);
    const cont = res.json().rows.find((r: any) => r.key === "continue");
    expect(cont.items[0]).toMatchObject({
      id: "movie-1",
      progress: { positionSec: 300, durationSec: 6000 },
      resume: null,
    });
    await app.close();
  });
});
