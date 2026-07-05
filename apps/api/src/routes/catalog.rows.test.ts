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

function authed(app: any, profile: unknown = { id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null }) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.profile = { findUnique: async () => profile };
  app.prisma.genreTranslation = { findMany: async () => [] };
}

const COMEDY = { id: 35, name: "Comedy" };
const DRAMA = { id: 18, name: "Drama" };

/** Library item as the route's findMany select shapes it. */
const dbItem = (
  id: string,
  genres: { id: number; name: string }[],
  extra: Partial<{ imdbRating: number; tmdbScore: number; translations: { title: string }[] }> = {},
) => ({
  id, title: `Title ${id}`, sortTitle: `title ${id}`, year: 2020,
  posterPath: `poster/${id}.jpg`, backdropPath: `backdrop/${id}.jpg`, matchState: "matched",
  addedAt: new Date("2026-01-01T00:00:00Z"),
  imdbRating: extra.imdbRating ?? null, tmdbScore: extra.tmdbScore ?? null,
  translations: extra.translations ?? [],
  genres: genres.map((genre) => ({ genre })),
});

describe("GET /libraries/:id/rows", () => {
  it("groups a library into count-ordered genre rows with hydrated cards", async () => {
    const app = await buildApp(env);
    authed(app as any);
    let captured: any = {};
    (app as any).prisma.mediaItem = {
      findMany: async (args: any) => {
        captured = args;
        return [
          dbItem("a", [COMEDY, DRAMA], { imdbRating: 6 }),
          dbItem("b", [COMEDY], { imdbRating: 9 }),
          dbItem("c", []),
        ];
      },
    };

    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/rows", cookies });
    expect(res.statusCode).toBe(200);
    expect(captured.where.libraryId).toBe("lib1");
    const { rows } = res.json();
    expect(rows.map((r: any) => [r.key, r.title, r.total])).toEqual([
      ["genre:35", "Comedy", 2],
      ["genre:18", "Drama", 1],
    ]);
    // Top-rated first inside the rail; cards carry box-art fields.
    expect(rows[0].items.map((i: any) => i.id)).toEqual(["b", "a"]);
    expect(rows[0].items[0]).toMatchObject({
      title: "Title b", posterPath: "poster/b.jpg", backdropPath: "backdrop/b.jpg",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    await app.close();
  });

  it("localizes item titles and genre headings for a non-en profile", async () => {
    const app = await buildApp(env);
    authed(app as any, { id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null, language: "ru" });
    (app as any).prisma.mediaItem = {
      findMany: async () => [dbItem("a", [COMEDY], { translations: [{ title: "Тайтл А" }] })],
    };
    (app as any).prisma.genreTranslation = {
      findMany: async () => [{ genreId: 35, name: "Комедии" }],
    };

    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/rows", cookies });
    const { rows } = res.json();
    expect(rows[0].title).toBe("Комедии");
    expect(rows[0].items[0].title).toBe("Тайтл А");
    await app.close();
  });

  it("applies the kids maturity filter to the item query", async () => {
    const app = await buildApp(env);
    authed(app as any, { id: "p1", name: "K", avatar: null, kind: "kids", maturityCap: 2 });
    let captured: any = {};
    (app as any).prisma.mediaItem = {
      findMany: async (args: any) => { captured = args; return []; },
    };

    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/rows", cookies });
    expect(res.statusCode).toBe(200);
    expect(captured.where.rating).toEqual({ in: ["G", "PG", "PG-13"] });
    expect(res.json()).toEqual({ rows: [] });
    await app.close();
  });
});
