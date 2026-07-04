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

const RAW = "orb_device-token";
const HASH = hashDeviceToken(RAW);
const bearer = { authorization: `Bearer ${RAW}` };

const PROFILES: Record<string, unknown> = {
  p_kid: { id: "p_kid", name: "Kid", avatar: null, kind: "kids", maturityCap: 1, language: "en", pinHash: null },
  p_std: { id: "p_std", name: "Adult", avatar: null, kind: "standard", maturityCap: null, language: "en", pinHash: null },
};

function stubs(app: unknown, device: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = [];
  (app as any).prisma.deviceToken = {
    findUnique: async ({ where }: any) =>
      where.tokenHash === HASH || where.id === device.id ? device : null,
    update: async ({ data }: any) => { updates.push(data); Object.assign(device, data); return device; },
  };
  (app as any).prisma.account = { findFirst: async () => ({ id: "a1" }), findUnique: async () => ({ isAdmin: true }) };
  (app as any).prisma.profile = {
    findUnique: async ({ where }: any) => PROFILES[where.id] ?? null,
  };
  return updates;
}

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: "dev1", tokenHash: HASH, name: "TV", platform: "tvos", activeProfileId: null,
    lastSeenAt: new Date(), createdAt: new Date(), revokedAt: null, ...overrides,
  };
}

describe("device-scoped profile selection", () => {
  it("select via bearer persists activeProfileId on the device (no cookie)", async () => {
    const app = await buildApp(env);
    const updates = stubs(app, makeDevice());
    const res = await app.inject({
      method: "POST", url: "/api/profiles/p_std/select", headers: bearer, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profileId: "p_std" });
    expect(updates.some((u) => u.activeProfileId === "p_std")).toBe(true);
    expect(res.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("GET /api/me/profile resolves the device's active profile", async () => {
    const app = await buildApp(env);
    stubs(app, makeDevice({ activeProfileId: "p_std" }));
    const res = await app.inject({ method: "GET", url: "/api/me/profile", headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("p_std");
    await app.close();
  });

  it("a kids device profile is blocked from management routes by requireNonKids", async () => {
    const app = await buildApp(env);
    stubs(app, makeDevice({ activeProfileId: "p_kid" }));
    const res = await app.inject({ method: "GET", url: "/api/devices", headers: bearer });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not_allowed_for_kids" });
    await app.close();
  });

  it("cookie-based selection still sets the cookie for browser sessions", async () => {
    const app = await buildApp(env);
    stubs(app, makeDevice());
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    const res = await app.inject({
      method: "POST", url: "/api/profiles/p_std/select", cookies: { orbix_session: "s1" }, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain("orbix_profile=p_std");
    await app.close();
  });

  it("progress PUT/GET works via bearer using the device's active profile", async () => {
    const app = await buildApp(env);
    stubs(app, makeDevice({ activeProfileId: "p_std" }));
    (app as any).prisma.mediaItem = {
      findUnique: async () => ({ rating: "PG-13" }),
    };
    const upserts: Record<string, unknown>[] = [];
    (app as any).prisma.playbackState = {
      upsert: async ({ where, create }: any) => { upserts.push({ where, create }); return create; },
      findUnique: async () => ({ positionSec: 42, durationSec: 100, finished: false }),
    };
    (app as any).prisma.playEvent = {
      findFirst: async () => ({ id: "recent" }), // suppress event append
      create: async () => ({}),
    };

    const put = await app.inject({
      method: "PUT", url: "/api/items/m1/progress", headers: bearer,
      payload: { positionSec: 42, durationSec: 100 },
    });
    expect(put.statusCode).toBe(200);
    expect((upserts[0].where as any).profileId_mediaItemId_episodeId.profileId).toBe("p_std");

    const get = await app.inject({ method: "GET", url: "/api/items/m1/progress", headers: bearer });
    expect(get.statusCode).toBe(200);
    expect(get.json().positionSec).toBe(42);
    await app.close();
  });

  it("progress PUT still 400s when a device has no active profile", async () => {
    const app = await buildApp(env);
    stubs(app, makeDevice({ activeProfileId: null }));
    const res = await app.inject({
      method: "PUT", url: "/api/items/m1/progress", headers: bearer,
      payload: { positionSec: 1, durationSec: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no_profile" });
    await app.close();
  });
});
