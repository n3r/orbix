import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

// Minimal authenticated + profile-selected session wired onto the mocked prisma.
function authed(app: unknown, profile: Record<string, unknown>) {
  const a = app as { prisma: Record<string, unknown> };
  a.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  a.prisma.profile = { findUnique: async () => profile };
}

const baseItem = {
  id: "m1",
  title: "The Matrix",
  year: 1999,
  overview: "A hacker discovers reality is a simulation.",
  runtimeSec: 8160,
  rating: "R",
  posterPath: "/p.jpg",
  backdropPath: "/b.jpg",
  matchState: "matched",
  credits: [],
  files: [],
};

describe("GET /items/:id localization", () => {
  it("returns the requested-language title/overview/genre when a translation exists", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", name: "Alex", avatar: null, kind: "standard", maturityCap: null, language: "es" });
    (app as unknown as { prisma: { mediaItem: unknown } }).prisma.mediaItem = {
      findUnique: async () => ({
        ...baseItem,
        translations: [{ title: "Matrix", overview: "Un hacker descubre que la realidad es una simulación." }],
        genres: [{ genre: { tmdbId: 28, name: "Action", translations: [{ name: "Acción" }] } }],
      }),
    };

    const res = await app.inject({
      method: "GET", url: "/api/items/m1",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe("Matrix");
    expect(body.overview).toBe("Un hacker descubre que la realidad es una simulación.");
    expect(body.genres).toEqual(["Acción"]);
    await app.close();
  });

  it("falls back to the base (en) values when no translation row exists", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", name: "Alex", avatar: null, kind: "standard", maturityCap: null, language: "es" });
    (app as unknown as { prisma: { mediaItem: unknown } }).prisma.mediaItem = {
      findUnique: async () => ({
        ...baseItem,
        translations: [],
        genres: [{ genre: { tmdbId: 28, name: "Action", translations: [] } }],
      }),
    };

    const res = await app.inject({
      method: "GET", url: "/api/items/m1",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe("The Matrix");
    expect(body.overview).toBe("A hacker discovers reality is a simulation.");
    expect(body.genres).toEqual(["Action"]);
    await app.close();
  });
});

describe("GET /sections/:id/items localization", () => {
  it("coalesces the list title to the requested language", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", name: "Alex", avatar: null, kind: "standard", maturityCap: null, language: "es" });
    (app as unknown as { prisma: { mediaItem: unknown } }).prisma.mediaItem = {
      findMany: async () => [
        { id: "m1", title: "The Matrix", year: 1999, posterPath: "/p.jpg", matchState: "matched", translations: [{ title: "Matrix" }] },
        { id: "m2", title: "Heat", year: 1995, posterPath: "/h.jpg", matchState: "matched", translations: [] },
      ],
    };

    const res = await app.inject({
      method: "GET", url: "/api/sections/s1/items",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body[0].title).toBe("Matrix"); // translated
    expect(body[1].title).toBe("Heat"); // fell back to base
    expect(body[0]).not.toHaveProperty("translations"); // stripped from response
    await app.close();
  });
});
