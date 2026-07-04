import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import { Prisma } from "@orbix/db";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

async function adminApp() {
  const app = await buildApp(env);
  (app as any).prisma.session = { findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }) };
  (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }) };
  (app as any).prisma.profile = { findUnique: async () => null };
  return app;
}

describe("EPG sources CRUD", () => {
  it("lists, creates (validating url), patches and deletes", async () => {
    const app = await adminApp();
    const rows: any[] = [{ id: "e1", name: "iptvx.one (RU/CIS)", url: "https://epg.iptvx.one/EPG_LITE.xml.gz", enabled: true, offsetMin: 0, status: "ok", statusMessage: null, lastSyncAt: null, createdAt: new Date() }];
    (app as any).prisma.tvEpgSource = {
      findMany: async () => rows,
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
      create: async ({ data }: any) => ({ id: "e2", enabled: true, offsetMin: 0, status: "ok", statusMessage: null, lastSyncAt: null, createdAt: new Date(), ...data }),
      update: async ({ where, data }: any) => ({ ...rows[0], id: where.id, ...data }),
      delete: async () => rows[0],
    };
    expect((await app.inject({ method: "GET", url: "/api/tv/epg-sources", cookies: { orbix_session: "s1" } })).statusCode).toBe(200);
    const created = await app.inject({ method: "POST", url: "/api/tv/epg-sources", cookies: { orbix_session: "s1" }, payload: { name: "epg.pw RU", url: "https://epg.pw/xmltv/epg_RU.xml.gz" } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/tv/epg-sources", cookies: { orbix_session: "s1" }, payload: { name: "bad", url: "ftp://nope" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/tv/epg-sources/e1", cookies: { orbix_session: "s1" }, payload: { enabled: false, offsetMin: 60 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/tv/epg-sources/e1", cookies: { orbix_session: "s1" } })).statusCode).toBe(204);
    await app.close();
  });

  it("409s when the DB unique index rejects a duplicate url (P2002)", async () => {
    const app = await adminApp();
    (app as any).prisma.tvEpgSource = {
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError("unique violation", {
          code: "P2002",
          clientVersion: "x",
        });
      },
    };
    const res = await app.inject({
      method: "POST", url: "/api/tv/epg-sources", cookies: { orbix_session: "s1" },
      payload: { name: "dup", url: "https://epg.iptvx.one/EPG_LITE.xml.gz" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "epg_source_exists" });
    await app.close();
  });

  it("PATCH /tv/epg-sources/:id 409s when updating url to a duplicate", async () => {
    const app = await adminApp();
    (app as any).prisma.tvEpgSource = {
      findUnique: async () => ({ id: "e1", name: "existing", url: "https://epg.old.xml", enabled: true, offsetMin: 0, status: "ok", statusMessage: null, lastSyncAt: null, createdAt: new Date() }),
      update: async () => {
        throw new Prisma.PrismaClientKnownRequestError("unique violation", {
          code: "P2002",
          clientVersion: "x",
        });
      },
    };
    const res = await app.inject({
      method: "PATCH", url: "/api/tv/epg-sources/e1", cookies: { orbix_session: "s1" },
      payload: { url: "https://epg.iptvx.one/EPG_LITE.xml.gz" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "epg_source_exists" });
    await app.close();
  });

  it("POST /api/tv/epg/refresh returns a jobId", async () => {
    const app = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/tv/epg/refresh", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(202);
    expect(typeof res.json().jobId).toBe("string");
    await app.close();
  });
});

describe("admin channel manager", () => {
  it("GET lists channels INCLUDING hidden, with q/country/paging mapped to the query", async () => {
    const app = await adminApp();
    let captured: any = null;
    (app as any).prisma.tvChannel = {
      count: async () => 1,
      findMany: async (args: any) => {
        captured = args;
        return [{ id: "c1", number: 5, name: "Первый канал", country: "RU", logoPath: null, hidden: true, kidsAllowed: false, epgId: "ChannelOne.ru", quality: "1080p" }];
      },
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/admin/channels?q=перв&country=RU&offset=10&limit=25", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(captured.where.hidden).toBeUndefined(); // includes hidden
    expect(captured.where.country).toBe("RU");
    expect(JSON.stringify(captured.where.OR)).toContain("insensitive");
    expect(captured.skip).toBe(10);
    expect(captured.take).toBe(25);
    expect(captured.orderBy).toEqual({ number: "asc" });
    expect(res.json()).toMatchObject({ total: 1 });
    await app.close();
  });

  it("PATCH validates and normalizes; 404 on unknown id", async () => {
    const app = await adminApp();
    let updated: any = null;
    (app as any).prisma.tvChannel = {
      findUnique: async ({ where }: any) => (where.id === "c1" ? { id: "c1" } : null),
      update: async ({ data }: any) => { updated = data; return { id: "c1", number: 7, name: "x", country: null, logoPath: null, hidden: false, kidsAllowed: true, epgId: null, quality: null, ...data }; },
    };
    expect((await app.inject({ method: "PATCH", url: "/api/tv/admin/channels/nope", cookies: { orbix_session: "s1" }, payload: { hidden: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/tv/admin/channels/c1", cookies: { orbix_session: "s1" }, payload: { number: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/tv/admin/channels/c1", cookies: { orbix_session: "s1" }, payload: { hidden: "yes" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "PATCH", url: "/api/tv/admin/channels/c1", cookies: { orbix_session: "s1" }, payload: { kidsAllowed: true, epgId: "  ", number: 7 } });
    expect(ok.statusCode).toBe(200);
    expect(updated).toEqual({ kidsAllowed: true, epgId: null, number: 7 }); // "" → null
    await app.close();
  });

  it("401s without a session", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = { findUnique: async () => null };
    const res = await app.inject({ method: "GET", url: "/api/tv/epg-sources" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects non-admin accounts and kids profiles", async () => {
    const app = await adminApp();
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: false }) };
    expect((await app.inject({ method: "GET", url: "/api/tv/epg-sources", cookies: { orbix_session: "s1" } })).statusCode).toBe(403);
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }) };
    (app as any).prisma.profile = { findUnique: async () => ({ id: "p1", kind: "kids", maturityCap: 1 }) };
    const res = await app.inject({ method: "GET", url: "/api/tv/admin/channels", cookies: { orbix_session: "s1", orbix_profile: "p1" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
