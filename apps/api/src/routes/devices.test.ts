import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

/** Authenticated-session stubs shared by the approval/admin tests. */
function stubSession(app: unknown) {
  (app as any).prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }), findFirst: async () => ({ id: "a1" }) };
  (app as any).prisma.profile = { findUnique: async () => null }; // no active profile → not kids
}

describe("pairing flow", () => {
  it("initiate → approve → poll redeems a device token exactly once", async () => {
    const app = await buildApp(env);
    stubSession(app);
    const created: Record<string, unknown>[] = [];
    (app as any).prisma.deviceToken = {
      create: async ({ data }: any) => { created.push(data); return { id: "dev1", ...data }; },
    };

    const init = await app.inject({
      method: "POST", url: "/api/pair/initiate",
      payload: { name: "Living Room", platform: "tvos" },
    });
    expect(init.statusCode).toBe(200);
    const { code, pollToken } = init.json();
    expect(code).toHaveLength(6);

    // still pending before approval
    const pending = await app.inject({ method: "GET", url: `/api/pair/poll?token=${pollToken}` });
    expect(pending.json()).toEqual({ status: "pending" });

    // the approval UI can inspect the pending request
    const info = await app.inject({
      method: "GET", url: `/api/pair/pending/${code}`, cookies: { orbix_session: "s1" },
    });
    expect(info.json()).toEqual({ name: "Living Room", platform: "tvos" });

    const approve = await app.inject({
      method: "POST", url: "/api/pair/approve",
      cookies: { orbix_session: "s1" }, payload: { code },
    });
    expect(approve.statusCode).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe("Living Room");

    const redeemed = await app.inject({ method: "GET", url: `/api/pair/poll?token=${pollToken}` });
    expect(redeemed.json().status).toBe("approved");
    expect(redeemed.json().deviceToken).toMatch(/^orb_/);
    expect(redeemed.json().deviceId).toBe("dev1");

    // single-use redemption
    const again = await app.inject({ method: "GET", url: `/api/pair/poll?token=${pollToken}` });
    expect(again.statusCode).toBe(404);
    await app.close();
  });

  it("rejects invalid initiate bodies and unauthenticated approval", async () => {
    const app = await buildApp(env);
    stubSession(app);
    const bad = await app.inject({ method: "POST", url: "/api/pair/initiate", payload: { name: "", platform: "tvos" } });
    expect(bad.statusCode).toBe(400);
    const noAuth = await app.inject({ method: "POST", url: "/api/pair/approve", payload: { code: "ABCDEF" } });
    expect(noAuth.statusCode).toBe(401);
    const unknown = await app.inject({
      method: "POST", url: "/api/pair/approve", cookies: { orbix_session: "s1" }, payload: { code: "ABCDEF" },
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });
});

describe("devices admin", () => {
  it("lists, renames, and revokes devices (admin only)", async () => {
    const app = await buildApp(env);
    stubSession(app);
    const dev = {
      id: "dev1", name: "Living Room", platform: "tvos", activeProfileId: null,
      lastSeenAt: new Date(), createdAt: new Date(), revokedAt: null,
    };
    const updates: Record<string, unknown>[] = [];
    (app as any).prisma.deviceToken = {
      findMany: async () => [dev],
      update: async ({ where, data }: any) => {
        if (where.id !== "dev1") { const e: any = new Error("nf"); e.code = "P2025"; throw e; }
        updates.push(data); return { ...dev, ...data };
      },
    };

    const list = await app.inject({ method: "GET", url: "/api/devices", cookies: { orbix_session: "s1" } });
    expect(list.statusCode).toBe(200);
    expect(list.json().devices).toHaveLength(1);
    expect(list.json().devices[0]).not.toHaveProperty("tokenHash");

    const rename = await app.inject({
      method: "PATCH", url: "/api/devices/dev1", cookies: { orbix_session: "s1" }, payload: { name: "Bedroom" },
    });
    expect(rename.statusCode).toBe(200);
    expect(updates[0]).toEqual({ name: "Bedroom" });

    const revoke = await app.inject({
      method: "POST", url: "/api/devices/dev1/revoke", cookies: { orbix_session: "s1" },
    });
    expect(revoke.statusCode).toBe(200);
    expect(updates[1]).toHaveProperty("revokedAt");

    const missing = await app.inject({
      method: "PATCH", url: "/api/devices/nope", cookies: { orbix_session: "s1" }, payload: { name: "x" },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("401s unauthenticated device listing", async () => {
    const app = await buildApp(env);
    stubSession(app);
    const res = await app.inject({ method: "GET", url: "/api/devices" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
