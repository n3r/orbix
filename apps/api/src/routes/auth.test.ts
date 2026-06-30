import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

describe("auth routes", () => {
  it("rejects login with bad credentials", async () => {
    const app = await buildApp(env);
    // override prisma with an in-memory stub via app.prisma (decorated)
    (app as any).prisma.account = { findUnique: async () => null };
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@b.c", password: "longenough" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /auth/me", () => {
  it("returns accountId and isAdmin for an authenticated admin", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }) };
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accountId: "a1", isAdmin: true });
    await app.close();
  });

  it("401s when unauthenticated", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = { findUnique: async () => null };
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
