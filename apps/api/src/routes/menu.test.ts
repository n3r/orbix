import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

function authed(app: any) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.profile = {
    findUnique: async () => ({ id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null }),
  };
}
const libsWithSections = [
  { name: "Films", sections: [
    { id: "s1", name: "Movies", order: 0 },
    { id: "s2", name: "Docs", order: 1 },
  ] },
];
const cookies = { orbix_session: "s1", orbix_profile: "p1" };

describe("GET /me/menu", () => {
  it("returns all sections in default order when the profile has no entries", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.library = { findMany: async () => libsWithSections };
    (app as any).prisma.profileMenuEntry = { findMany: async () => [] };
    const res = await app.inject({ method: "GET", url: "/api/me/menu", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [
      { sectionId: "s1", name: "Movies", libraryName: "Films" },
      { sectionId: "s2", name: "Docs", libraryName: "Films" },
    ] });
    await app.close();
  });

  it("honors the profile's entry order", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.library = { findMany: async () => libsWithSections };
    (app as any).prisma.profileMenuEntry = { findMany: async () => [
      { sectionId: "s2", position: 0 }, { sectionId: "s1", position: 1 },
    ] };
    const res = await app.inject({ method: "GET", url: "/api/me/menu", cookies });
    expect(res.json().items.map((i: any) => i.sectionId)).toEqual(["s2", "s1"]);
    await app.close();
  });
});

describe("PUT /me/menu", () => {
  it("rejects an unknown sectionId with 400", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.section = { findMany: async () => [{ id: "s1" }, { id: "s2" }] };
    const res = await app.inject({ method: "PUT", url: "/api/me/menu", cookies, payload: { sectionIds: ["s1", "nope"] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an empty sectionIds array with 400 (would silently re-enable all)", async () => {
    const app = await buildApp(env);
    authed(app as any);
    const res = await app.inject({ method: "PUT", url: "/api/me/menu", cookies, payload: { sectionIds: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "empty" });
    await app.close();
  });

  it("rejects duplicate sectionIds with 400", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.section = { findMany: async () => [{ id: "s1" }] };
    const res = await app.inject({ method: "PUT", url: "/api/me/menu", cookies, payload: { sectionIds: ["s1", "s1"] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "duplicate" });
    await app.close();
  });

  it("replaces entries and returns the resolved menu", async () => {
    const app = await buildApp(env);
    authed(app as any);
    const calls: string[] = [];
    (app as any).prisma.section = { findMany: async () => [{ id: "s1" }, { id: "s2" }] };
    (app as any).prisma.library = { findMany: async () => libsWithSections };
    (app as any).prisma.profileMenuEntry = {
      deleteMany: async () => { calls.push("delete"); return { count: 0 }; },
      createMany: async ({ data }: any) => { calls.push("create:" + data.map((d: any) => d.sectionId).join(",")); return { count: data.length }; },
      findMany: async () => [{ sectionId: "s2", position: 0 }, { sectionId: "s1", position: 1 }],
    };
    (app as any).prisma.$transaction = async (ops: any[]) => Promise.all(ops);
    const res = await app.inject({ method: "PUT", url: "/api/me/menu", cookies, payload: { sectionIds: ["s2", "s1"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: any) => i.sectionId)).toEqual(["s2", "s1"]);
    await app.close();
  });
});
