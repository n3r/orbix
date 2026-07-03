import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

function authed(app: any, profile: Record<string, unknown> = {}) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.profile = {
    findUnique: async () => ({
      id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null, language: "en", ...profile,
    }),
  };
}
const cookies = { orbix_session: "s1", orbix_profile: "p1" };

// Shape Prisma would return for the list route's select — no rating field
// (the kids filter lives in the WHERE clause, not the projection).
const card = (id: string, title: string) => ({
  id, title, year: 2020, posterPath: `poster/${id}.jpg`, matchState: "matched", translations: [],
});

describe("GET /wishlist", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/api/wishlist" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a session without a profile cookie with 400", async () => {
    const app = await buildApp(env);
    authed(app as any);
    const res = await app.inject({ method: "GET", url: "/api/wishlist", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no_profile" });
    await app.close();
  });

  it("returns saved cards newest-first, dropping ids missing from the catalog", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.wishlistEntry = {
      findMany: async () => [{ mediaItemId: "m2" }, { mediaItemId: "m1" }, { mediaItemId: "gone" }],
    };
    (app as any).prisma.mediaItem = {
      findMany: async () => [card("m1", "Alpha"), card("m2", "Beta")],
    };
    const res = await app.inject({ method: "GET", url: "/api/wishlist", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((i: any) => i.id)).toEqual(["m2", "m1"]);
    expect(res.json()[0]).toEqual({ id: "m2", title: "Beta", year: 2020, posterPath: "poster/m2.jpg", matchState: "matched" });
    await app.close();
  });

  it("applies the kids rating filter to the catalog join", async () => {
    const app = await buildApp(env);
    authed(app as any, { kind: "kids", maturityCap: 0 });
    let capturedWhere: any;
    (app as any).prisma.wishlistEntry = {
      findMany: async () => [{ mediaItemId: "m1" }, { mediaItemId: "m2" }],
    };
    (app as any).prisma.mediaItem = {
      findMany: async ({ where }: any) => { capturedWhere = where; return [card("m1", "Kids OK")]; },
    };
    const res = await app.inject({ method: "GET", url: "/api/wishlist", cookies });
    expect(capturedWhere.rating).toBeTruthy(); // kidsRatingWhere applied server-side
    expect(res.json().map((i: any) => i.id)).toEqual(["m1"]);
    await app.close();
  });
});

describe("GET /wishlist/ids", () => {
  it("returns only ids visible to the profile, newest-first", async () => {
    const app = await buildApp(env);
    authed(app as any, { kind: "kids", maturityCap: 0 });
    (app as any).prisma.wishlistEntry = {
      findMany: async () => [{ mediaItemId: "m2" }, { mediaItemId: "m1" }],
    };
    (app as any).prisma.mediaItem = { findMany: async () => [{ id: "m2" }] };
    const res = await app.inject({ method: "GET", url: "/api/wishlist/ids", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ids: ["m2"] });
    await app.close();
  });
});

describe("POST /wishlist/:itemId", () => {
  it("upserts on the compound unique and reports ok", async () => {
    const app = await buildApp(env);
    authed(app as any);
    let upsertArgs: any;
    (app as any).prisma.mediaItem = { findUnique: async () => ({ rating: "PG-13" }) };
    (app as any).prisma.wishlistEntry = { upsert: async (args: any) => { upsertArgs = args; return {}; } };
    const res = await app.inject({ method: "POST", url: "/api/wishlist/m1", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(upsertArgs.where).toEqual({ profileId_mediaItemId: { profileId: "p1", mediaItemId: "m1" } });
    expect(upsertArgs.create).toEqual({ profileId: "p1", mediaItemId: "m1" });
    await app.close();
  });

  it("404s (and does not upsert) when a kids profile adds a blocked title", async () => {
    const app = await buildApp(env);
    authed(app as any, { kind: "kids", maturityCap: 0 });
    let upserted = false;
    (app as any).prisma.mediaItem = { findUnique: async () => ({ rating: "R" }) };
    (app as any).prisma.wishlistEntry = { upsert: async () => { upserted = true; return {}; } };
    const res = await app.inject({ method: "POST", url: "/api/wishlist/m1", cookies });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    expect(upserted).toBe(false);
    await app.close();
  });

  it("404s for an unknown item", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.mediaItem = { findUnique: async () => null };
    const res = await app.inject({ method: "POST", url: "/api/wishlist/nope", cookies });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("DELETE /wishlist/:itemId", () => {
  it("removes idempotently scoped to the profile", async () => {
    const app = await buildApp(env);
    authed(app as any);
    let deleteWhere: any;
    (app as any).prisma.wishlistEntry = {
      deleteMany: async ({ where }: any) => { deleteWhere = where; return { count: 0 }; },
    };
    const res = await app.inject({ method: "DELETE", url: "/api/wishlist/m1", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(deleteWhere).toEqual({ profileId: "p1", mediaItemId: "m1" });
    await app.close();
  });
});
