import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function authed(app: any, profile: unknown) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.profile = { findUnique: async () => profile };
}

const anchor = {
  id: "a", title: "Anchor", year: 2020, rating: "PG-13", posterPath: null, matchState: "matched",
  runtimeSec: 120 * 60, tmdbScore: 7.4, imdbRating: 7.6, rtRating: null, metacritic: null,
  overview: "x",
  genres: [{ genre: { name: "Action" } }, { genre: { name: "Crime" } }],
  keywords: [{ keyword: { name: "heist" } }, { keyword: { name: "undercover" } }],
  credits: [
    { role: "Lead", department: "cast", order: 0, person: { name: "Actor A" } },
    { role: "Director", department: "crew", order: 0, person: { name: "Director A" } },
  ],
};
const specific = {
  id: "specific", title: "Specific", year: 2021, rating: "PG-13", posterPath: "poster/s.jpg", matchState: "matched",
  runtimeSec: 118 * 60, tmdbScore: 7.1, imdbRating: 7.0, rtRating: null, metacritic: null,
  overview: "y",
  genres: [{ genre: { name: "Crime" } }],
  keywords: [{ keyword: { name: "heist" } }, { keyword: { name: "undercover" } }],
  credits: [
    { role: "Supporting", department: "cast", order: 0, person: { name: "Actor B" } },
    { role: "Director", department: "crew", order: 0, person: { name: "Director A" } },
  ],
};
const broad = {
  id: "broad", title: "Broad", year: 2022, rating: "PG-13", posterPath: "poster/b.jpg", matchState: "matched",
  runtimeSec: 121 * 60, tmdbScore: 8.4, imdbRating: 8.2, rtRating: null, metacritic: null,
  overview: "z",
  genres: [{ genre: { name: "Action" } }],
  keywords: [],
  credits: [],
};
const unrelated = {
  id: "unrelated", title: "Unrelated", year: 2023, rating: "PG-13", posterPath: "poster/u.jpg", matchState: "matched",
  runtimeSec: 90 * 60, tmdbScore: 9.7, imdbRating: 9.7, rtRating: 100, metacritic: 100,
  overview: "w",
  genres: [{ genre: { name: "Romance" } }],
  keywords: [{ keyword: { name: "wedding" } }],
  credits: [],
};

describe("GET /items/:id/similar", () => {
  it("returns 404 when the anchor item does not exist", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", kind: "standard", maturityCap: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).prisma.mediaItem = { findUnique: async () => null };
    const res = await app.inject({
      method: "GET", url: "/api/items/missing/similar",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("ranks specific related candidates above broad same-genre matches and drops unrelated fallback filler", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", kind: "standard", maturityCap: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).prisma.mediaItem = {
      findUnique: async () => anchor,
      findMany: async () => [unrelated, broad, specific],
    };
    // Force the embeddings path to degrade: $queryRaw throws.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).prisma.$queryRaw = async () => { throw new Error("no embeddings"); };
    const res = await app.inject({
      method: "GET", url: "/api/items/a/similar",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["specific", "broad"]);
    await app.close();
  });

  it("returns 404 for a kids profile when the anchor exceeds the cap", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", kind: "kids", maturityCap: 1 }); // cap below PG-13
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).prisma.mediaItem = { findUnique: async () => anchor };
    const res = await app.inject({
      method: "GET", url: "/api/items/a/similar",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
