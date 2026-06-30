import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true,
};

describe("GET /me/profile", () => {
  it("returns the full active profile when a valid profile cookie is set", async () => {
    const app = await buildApp(env);
    // Authenticated session + a selected profile.
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    (app as any).prisma.profile = {
      findUnique: async () => ({ id: "p1", name: "Alex", avatar: null, kind: "kids", maturityCap: 1 }),
    };
    const res = await app.inject({
      method: "GET", url: "/me/profile",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "p1", name: "Alex", avatar: null, kind: "kids", maturityCap: 1 });
    await app.close();
  });

  it("returns all-null when no profile cookie is set", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    const res = await app.inject({ method: "GET", url: "/me/profile", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: null, name: null, avatar: null, kind: null, maturityCap: null });
    await app.close();
  });
});
