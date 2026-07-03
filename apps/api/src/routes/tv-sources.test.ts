import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../app";
import { tvDoneCache } from "../plugins/tv-queue";
import { Prisma } from "@orbix/db";
import type { Env } from "@orbix/config";

const metadataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbix-tv-sources-"));

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: metadataDir, TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const COOKIES = { orbix_session: "s1", orbix_profile: "p1" };

function patchAuth(app: any, { admin = true, kids = false } = {}) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.account = { findUnique: async () => ({ isAdmin: admin }) };
  app.prisma.profile = {
    findUnique: async () => ({
      id: "p1", name: "P", avatar: null,
      kind: kids ? "kids" : "standard", maturityCap: kids ? 0 : null, language: "en",
    }),
  };
}

afterEach(() => {
  tvDoneCache.clear();
});

describe("admin gates on /tv/sources", () => {
  it("401 without a session", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = { findUnique: async () => null };
    const res = await app.inject({ method: "GET", url: "/api/tv/sources" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403 for a non-admin account", async () => {
    const app = await buildApp(env);
    patchAuth(app, { admin: false });
    const res = await app.inject({ method: "GET", url: "/api/tv/sources", cookies: COOKIES });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("403 for a kids profile even on an admin account", async () => {
    const app = await buildApp(env);
    patchAuth(app, { kids: true });
    (app as any).prisma.tvSource = { findMany: async () => [] };
    const res = await app.inject({ method: "GET", url: "/api/tv/sources", cookies: COOKIES });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not_allowed_for_kids" });
    await app.close();
  });
});

describe("POST /tv/sources", () => {
  it("stores an uploaded m3u under METADATA_DIR/tv/playlists/<sourceId>.m3u", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    let updated: any = null;
    (app as any).prisma.tvSource = {
      create: async (args: any) => ({ id: "src1", ...args.data, filePath: null }),
      update: async (args: any) => {
        updated = args;
        return { id: "src1", kind: "m3u", ...args.data };
      },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/tv/sources",
      cookies: COOKIES,
      payload: {
        kind: "m3u",
        name: "My playlist",
        fileContent: "#EXTM3U\r\n#EXTINF:-1,One\r\nhttps://x/1.m3u8\r\n",
      },
    });
    expect(res.statusCode).toBe(200);
    const expected = path.join(metadataDir, "tv", "playlists", "src1.m3u");
    expect(updated.data.filePath).toBe(expected);
    expect(fs.readFileSync(expected, "utf8")).toContain("#EXTINF:-1,One");
    await app.close();
  });

  it("rejects an m3u source with neither url nor fileContent", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    const res = await app.inject({
      method: "POST", url: "/api/tv/sources", cookies: COOKIES,
      payload: { kind: "m3u", name: "Empty" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("409s a second iptv-org source and 400s one without countries", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    (app as any).prisma.tvSource = { findFirst: async () => ({ id: "existing" }), create: async () => ({}) };
    const dup = await app.inject({
      method: "POST", url: "/api/tv/sources", cookies: COOKIES,
      payload: { kind: "iptv-org", name: "Catalog", countries: ["RU"] },
    });
    expect(dup.statusCode).toBe(409);

    (app as any).prisma.tvSource = { findFirst: async () => null, create: async () => ({}) };
    const bad = await app.inject({
      method: "POST", url: "/api/tv/sources", cookies: COOKIES,
      payload: { kind: "iptv-org", name: "Catalog", countries: [] },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("uppercases country codes on create (iptv-org codes are authoritative)", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    let created: any = null;
    (app as any).prisma.tvSource = {
      findFirst: async () => null,
      create: async (args: any) => {
        created = args;
        return { id: "s", ...args.data };
      },
    };
    const res = await app.inject({
      method: "POST", url: "/api/tv/sources", cookies: COOKIES,
      payload: { kind: "iptv-org", name: "Catalog", countries: ["ru", "uk "] },
    });
    expect(res.statusCode).toBe(200);
    expect(created.data.countries).toEqual(["RU", "UK"]);
    await app.close();
  });

  it("409s when the DB singleton index rejects a concurrent iptv-org create (P2002)", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    (app as any).prisma.tvSource = {
      findFirst: async () => null, // pre-check raced and lost — another request created one first
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError("unique violation", {
          code: "P2002",
          clientVersion: "x",
        });
      },
    };
    const res = await app.inject({
      method: "POST", url: "/api/tv/sources", cookies: COOKIES,
      payload: { kind: "iptv-org", name: "Catalog", countries: ["RU"] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "iptv_org_exists" });
    await app.close();
  });
});

describe("PATCH /tv/sources/:id", () => {
  it("400s on {countries: []} the same way POST does", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    const res = await app.inject({
      method: "PATCH", url: "/api/tv/sources/src1", cookies: COOKIES,
      payload: { countries: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "countries_required" });
    await app.close();
  });
});

describe("POST /tv/sources/:id/sync", () => {
  it("enqueues a tv-sync job for the source", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    (app as any).prisma.tvSource = { findUnique: async () => ({ id: "src1" }) };
    let job: any = null;
    (app as any).tvQueue.add = async (name: string, data: unknown) => {
      job = { name, data };
    };
    const res = await app.inject({ method: "POST", url: "/api/tv/sources/src1/sync", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    const { jobId } = res.json();
    expect(typeof jobId).toBe("string");
    expect(job).toEqual({ name: "tv-sync", data: { jobId, sourceId: "src1" } });
    await app.close();
  });

  it("404s an unknown source", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    (app as any).prisma.tvSource = { findUnique: async () => null };
    const res = await app.inject({ method: "POST", url: "/api/tv/sources/nope/sync", cookies: COOKIES });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /tv/sync/events (SSE)", () => {
  it("replays the done-cache entry and closes", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    tvDoneCache.set("job-1", { phase: "done", channels: 612, streams: 745, logosCached: 530 });
    const res = await app.inject({
      method: "GET", url: "/api/tv/sync/events?jobId=job-1", cookies: COOKIES,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.payload).toBe(
      `data: ${JSON.stringify({ phase: "done", channels: 612, streams: 745, logosCached: 530 })}\n\n`,
    );
    await app.close();
  });

  it("400s without a jobId", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    const res = await app.inject({ method: "GET", url: "/api/tv/sync/events", cookies: COOKIES });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("DELETE /tv/sources/:id", () => {
  it("removes the uploaded playlist file best-effort", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    const filePath = path.join(metadataDir, "tv", "playlists", "gone.m3u");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "#EXTM3U\n");
    (app as any).prisma.tvSource = { delete: async () => ({ id: "gone", filePath }) };
    const res = await app.inject({ method: "DELETE", url: "/api/tv/sources/gone", cookies: COOKIES });
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(filePath)).toBe(false);
    await app.close();
  });
});
