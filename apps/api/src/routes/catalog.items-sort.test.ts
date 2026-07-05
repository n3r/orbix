import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const cookies = { orbix_session: "s1", orbix_profile: "p1" };

function authed(app: any, profile: unknown = null) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.profile = { findUnique: async () => profile };
}

const dbItem = (
  id: string, title: string,
  extra: Partial<{ imdbRating: number; tmdbScore: number; translations: { title: string }[] }> = {},
) => ({
  id, title, sortTitle: title.toLowerCase(), year: 2020, posterPath: null, matchState: "matched",
  imdbRating: extra.imdbRating ?? null, tmdbScore: extra.tmdbScore ?? null,
  translations: extra.translations ?? [],
});

describe("GET /libraries/:id/items — new sorts and genre filter", () => {
  it("sort=alpha orders by displayed title: Latin, Cyrillic, digits last", async () => {
    const app = await buildApp(env);
    // ru profile: localized titles drive the order
    authed(app as any, { id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null, language: "ru" });
    (app as any).prisma.mediaItem = {
      findMany: async () => [
        dbItem("m1", "1917"),
        dbItem("m2", "Brother", { translations: [{ title: "Брат" }] }),
        dbItem("m3", "Alien"),
      ],
    };
    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/items?sort=alpha", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((i: any) => i.title)).toEqual(["Alien", "Брат", "1917"]);
    await app.close();
  });

  it("sort=rating orders imdb??tmdb desc with unrated last", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.mediaItem = {
      findMany: async () => [
        dbItem("m1", "Unrated"),
        dbItem("m2", "Good", { tmdbScore: 7.5 }),
        dbItem("m3", "Great", { imdbRating: 9 }),
      ],
    };
    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/items?sort=rating", cookies });
    expect(res.json().map((i: any) => i.id)).toEqual(["m3", "m2", "m1"]);
    await app.close();
  });

  it("genre=<id> filters via the genre join; response shape keeps MediaCard fields only", async () => {
    const app = await buildApp(env);
    authed(app as any);
    let captured: any = {};
    (app as any).prisma.mediaItem = {
      findMany: async (args: any) => { captured = args; return [dbItem("m1", "Heat", { imdbRating: 8 })]; },
    };
    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/items?sort=rating&genre=35", cookies });
    expect(res.statusCode).toBe(200);
    expect(captured.where.genres).toEqual({ some: { genreId: 35 } });
    expect(captured.take).toBe(2000);
    expect(res.json()[0]).toEqual({ id: "m1", title: "Heat", year: 2020, posterPath: null, matchState: "matched" });
    await app.close();
  });

  it.each(["abc", "", "1e2", "0x23", " ", "1.5", "-1"])(
    "rejects a non-integer genre (genre=%j)",
    async (genre) => {
      const app = await buildApp(env);
      authed(app as any);
      const res = await app.inject({
        method: "GET",
        url: `/api/libraries/lib1/items?genre=${encodeURIComponent(genre)}`,
        cookies,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_genre" });
      await app.close();
    },
  );
});
