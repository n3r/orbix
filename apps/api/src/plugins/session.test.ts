import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import { hashDeviceToken } from "@orbix/core";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const RAW = "orb_test-token";
const HASH = hashDeviceToken(RAW);

function stubDevice(app: unknown, overrides: Record<string, unknown> = {}) {
  const device = {
    id: "dev1", tokenHash: HASH, name: "Living Room", platform: "tvos",
    activeProfileId: null, lastSeenAt: new Date(), createdAt: new Date(), revokedAt: null,
    ...overrides,
  };
  (app as any).prisma.deviceToken = {
    findUnique: async ({ where }: any) => (where.tokenHash === HASH ? device : null),
    update: async () => device,
  };
  (app as any).prisma.account = {
    findFirst: async () => ({ id: "acct1" }),
    findUnique: async () => ({ isAdmin: true }),
  };
}

describe("session plugin bearer path", () => {
  it("authenticates a valid bearer token (GET /api/auth/me)", async () => {
    const app = await buildApp(env);
    stubDevice(app);
    const res = await app.inject({
      method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${RAW}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accountId).toBe("acct1");
    await app.close();
  });

  it("rejects a revoked token", async () => {
    const app = await buildApp(env);
    stubDevice(app, { revokedAt: new Date() });
    const res = await app.inject({
      method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${RAW}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an unknown token", async () => {
    const app = await buildApp(env);
    stubDevice(app);
    const res = await app.inject({
      method: "GET", url: "/api/auth/me", headers: { authorization: "Bearer orb_wrong" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("cookie sessions still work unchanged", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }) };
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().accountId).toBe("a1");
    await app.close();
  });
});
