import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true,
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
  overview: "x", genres: [{ genre: { name: "Action" } }], keywords: [], credits: [],
};
const other = {
  id: "b", title: "Other", year: 2021, rating: "PG-13", posterPath: "poster/b.jpg", matchState: "matched",
  overview: "y", genres: [{ genre: { name: "Action" } }], keywords: [], credits: [],
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

  it("excludes the anchor and ranks the rest (Jaccard fallback path)", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", kind: "standard", maturityCap: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).prisma.mediaItem = {
      findUnique: async () => anchor,
      findMany: async () => [other],
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
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["b"]);
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
