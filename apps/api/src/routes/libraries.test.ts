import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

describe("admin gating (requireAdmin)", () => {
  it("403s POST /libraries for a non-admin account", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: false }) };
    (app as any).prisma.profile = { findUnique: async () => ({ id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null }) };
    const res = await app.inject({
      method: "POST", url: "/api/libraries",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
      payload: { name: "New Lib" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("allows POST /libraries for an admin account", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }) };
    (app as any).prisma.profile = { findUnique: async () => ({ id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null }) };
    (app as any).prisma.library = { create: async () => ({ id: "lib1", name: "New Lib" }) };
    const res = await app.inject({
      method: "POST", url: "/api/libraries",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
      payload: { name: "New Lib" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
