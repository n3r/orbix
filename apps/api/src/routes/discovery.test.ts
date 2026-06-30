import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true,
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
