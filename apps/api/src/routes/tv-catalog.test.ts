import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const COOKIES = { orbix_session: "s1", orbix_profile: "p1" };

function patchAuth(app: any, { kids = false, profile = true } = {}) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.account = { findUnique: async () => ({ isAdmin: true }) };
  app.prisma.profile = {
    findUnique: async () =>
      profile
        ? {
            id: "p1", name: kids ? "Kid" : "Me", avatar: null,
            kind: kids ? "kids" : "standard", maturityCap: kids ? 0 : null, language: "en",
          }
        : null,
  };
}

function emptyTvModels(app: any) {
  app.prisma.tvChannel = { findMany: async () => [], findUnique: async () => null, count: async () => 0 };
  app.prisma.tvFavorite = {
    findMany: async () => [],
    findUnique: async () => null,
    aggregate: async () => ({ _max: { position: null } }),
    upsert: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
  };
  app.prisma.tvPlayEvent = { findMany: async () => [], create: async () => ({}) };
}

function channelRow(over: Record<string, unknown> = {}) {
  return {
    id: "c1", number: 1, name: "Channel One", country: "RU",
    categories: ["general"], quality: "1080p", logoPath: "channel/1tv.png", hidden: false,
    streams: [{ protocol: "hls", status: "unknown" }],
    ...over,
  };
}

const KIDS_BLOCKED_ROUTES: { method: "GET" | "PUT" | "DELETE" | "POST"; url: string }[] = [
  { method: "GET", url: "/api/tv/home" },
  { method: "GET", url: "/api/tv/guide" },
  { method: "GET", url: "/api/tv/channels/c1" },
  { method: "GET", url: "/api/tv/channels/c1/programmes" },
  { method: "GET", url: "/api/tv/favorites" },
  { method: "PUT", url: "/api/tv/favorites/c1" },
  { method: "DELETE", url: "/api/tv/favorites/c1" },
  { method: "POST", url: "/api/tv/events/c1" },
];

describe("kids enforcement", () => {
  it("403s every /tv route for a kids profile", async () => {
    const app = await buildApp(env);
    patchAuth(app, { kids: true });
    emptyTvModels(app);
    for (const { method, url } of KIDS_BLOCKED_ROUTES) {
      const res = await app.inject({ method, url, cookies: COOKIES });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json(), `${method} ${url}`).toEqual({ error: "not_allowed_for_kids" });
    }
    await app.close();
  });

  it("401s without a session", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = { findUnique: async () => null };
    const res = await app.inject({ method: "GET", url: "/api/tv/home" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /tv/home", () => {
  it("builds recents/favorites/countries/categories rails from visible channels", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    const c1 = channelRow();
    const c2 = channelRow({
      id: "c2", number: 2, name: "2x2", categories: ["comedy"], logoPath: null,
      streams: [{ protocol: "hls", status: "dead" }, { protocol: "other", status: "ok" }],
    });
    const c3 = channelRow({ id: "c3", number: 3, name: "BBC One", country: "UK" });
    let channelWhere: any = null;
    (app as any).prisma.tvChannel = {
      findMany: async (args: any) => {
        channelWhere = args.where;
        return [c1, c2, c3];
      },
    };
    (app as any).prisma.tvFavorite = { findMany: async () => [{ channelId: "c3" }] };
    (app as any).prisma.tvPlayEvent = {
      // newest first; c2 appears twice → deduped
      findMany: async () => [{ channelId: "c2" }, { channelId: "c1" }, { channelId: "c2" }],
    };

    const res = await app.inject({ method: "GET", url: "/api/tv/home", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(channelWhere).toEqual({ hidden: false }); // hidden excluded at the query

    const body = res.json();
    expect(body.recents.map((c: any) => c.id)).toEqual(["c2", "c1"]);
    expect(body.favorites.map((c: any) => c.id)).toEqual(["c3"]);
    expect(body.favorites[0].favorite).toBe(true);
    expect(body.countries.map((r: any) => r.code)).toEqual(["RU", "UK"]); // RU: 2 channels, UK: 1
    expect(body.countries[0].channels.map((c: any) => c.id)).toEqual(["c1", "c2"]);
    expect(body.categories.map((r: any) => r.id)).toEqual(["general", "comedy"]);

    // Card mapping: no live HLS stream → unhealthy; no logoPath → null (monogram).
    const c2card = body.recents[0];
    expect(c2card).toEqual({
      id: "c2", number: 2, name: "2x2", country: "RU", categories: ["comedy"],
      quality: "1080p", logo: null, healthy: false, favorite: false,
    });
    const c1card = body.recents[1];
    expect(c1card.logo).toBe("/api/images/channel/1tv.png");
    expect(c1card.healthy).toBe(true);
    await app.close();
  });
});

describe("GET /tv/guide", () => {
  it("caps limit at 200, applies offset and country/category/q filters", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    let captured: any = null;
    (app as any).prisma.tvChannel = {
      count: async () => 450,
      findMany: async (args: any) => {
        captured = args;
        return [channelRow()];
      },
    };
    const res = await app.inject({
      method: "GET",
      url: "/api/tv/guide?limit=999&offset=40&country=ru&category=News&q=first",
      cookies: COOKIES,
    });
    expect(res.statusCode).toBe(200);
    expect(captured.take).toBe(200); // hard cap
    expect(captured.skip).toBe(40);
    expect(captured.orderBy).toEqual({ number: "asc" }); // numeric sort, never string
    expect(captured.where.hidden).toBe(false);
    expect(captured.where.country).toBe("RU");
    expect(captured.where.categories).toEqual({ has: "news" });
    expect(captured.where.name).toEqual({ contains: "first", mode: "insensitive" });
    expect(res.json()).toMatchObject({ total: 450, offset: 40, limit: 200 });
    await app.close();
  });

  it("filters to the profile's favorites when favorites=true", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    let captured: any = null;
    (app as any).prisma.tvChannel = {
      count: async () => 1,
      findMany: async (args: any) => {
        captured = args;
        return [channelRow({ id: "c9", number: 9 })];
      },
    };
    (app as any).prisma.tvFavorite = { findMany: async () => [{ channelId: "c9" }] };
    const res = await app.inject({ method: "GET", url: "/api/tv/guide?favorites=true", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(captured.where.id).toEqual({ in: ["c9"] });
    expect(res.json().channels[0].favorite).toBe(true);
    await app.close();
  });

  it("uses defaults offset=0 limit=100", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    let captured: any = null;
    (app as any).prisma.tvChannel = {
      count: async () => 0,
      findMany: async (args: any) => {
        captured = args;
        return [];
      },
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/guide", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(captured.skip).toBe(0);
    expect(captured.take).toBe(100);
    await app.close();
  });
});

describe("GET /tv/channels/:id", () => {
  it("returns detail with summarised streams (no URLs) and 404s hidden channels", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    (app as any).prisma.tvChannel = {
      findUnique: async () => ({
        id: "c1", number: 1, name: "Channel One", rawName: "RU| ПЕРВЫЙ HD",
        country: "RU", languages: ["rus"], categories: ["general"],
        website: "https://1tv.ru", epgId: "ChannelOne.ru@SD", quality: "1080p",
        logoPath: "channel/1tv.png", hidden: false,
        streams: [
          { id: "s1", quality: "1080p", label: null, protocol: "hls", status: "ok", priority: 0, url: "https://leak.example/x.m3u8" },
        ],
      }),
    };
    (app as any).prisma.tvFavorite = { findUnique: async () => ({ id: "f1" }) };
    const res = await app.inject({ method: "GET", url: "/api/tv/channels/c1", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: "c1", number: 1, name: "Channel One", epgId: "ChannelOne.ru@SD",
      logo: "/api/images/channel/1tv.png", healthy: true, favorite: true,
    });
    expect(body.streams).toEqual([
      { id: "s1", quality: "1080p", label: null, protocol: "hls", status: "ok", priority: 0 },
    ]); // url never leaks

    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "cH", hidden: true, streams: [] }) };
    const hidden = await app.inject({ method: "GET", url: "/api/tv/channels/cH", cookies: COOKIES });
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /tv/channels/:id/programmes", () => {
  it("returns the locked empty shape until the EPG phase", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "c1", hidden: false }) };
    const res = await app.inject({ method: "GET", url: "/api/tv/channels/c1/programmes", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ programmes: [] });
    await app.close();
  });
});

describe("favorites", () => {
  it("PUT upserts with an appended position", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "c1", hidden: false }) };
    let upserted: any = null;
    (app as any).prisma.tvFavorite = {
      aggregate: async () => ({ _max: { position: 2 } }),
      upsert: async (args: any) => {
        upserted = args;
        return {};
      },
    };
    const res = await app.inject({ method: "PUT", url: "/api/tv/favorites/c1", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(upserted.create).toEqual({ profileId: "p1", channelId: "c1", position: 3 });
    expect(upserted.update).toEqual({}); // re-favoriting keeps the position
    await app.close();
  });

  it("DELETE removes and returns 204; GET lists ordered cards and drops hidden", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    let deleted: any = null;
    (app as any).prisma.tvFavorite = {
      deleteMany: async (args: any) => {
        deleted = args;
        return { count: 1 };
      },
      findMany: async () => [
        { channelId: "c1", channel: channelRow() },
        { channelId: "cH", channel: channelRow({ id: "cH", hidden: true }) },
      ],
    };
    const del = await app.inject({ method: "DELETE", url: "/api/tv/favorites/c1", cookies: COOKIES });
    expect(del.statusCode).toBe(204);
    expect(deleted.where).toEqual({ profileId: "p1", channelId: "c1" });

    const list = await app.inject({ method: "GET", url: "/api/tv/favorites", cookies: COOKIES });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.favorites.map((c: any) => c.id)).toEqual(["c1"]); // hidden favorite dropped
    expect(body.favorites[0].favorite).toBe(true);
    await app.close();
  });

  it("400s favorites without an active profile", async () => {
    const app = await buildApp(env);
    patchAuth(app, { profile: false });
    emptyTvModels(app);
    const res = await app.inject({
      method: "PUT", url: "/api/tv/favorites/c1", cookies: { orbix_session: "s1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no_profile" });
    await app.close();
  });
});

describe("POST /tv/events/:channelId", () => {
  it("records a tune event for the active profile", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "c1", hidden: false }) };
    let created: any = null;
    (app as any).prisma.tvPlayEvent = {
      create: async (args: any) => {
        created = args;
        return {};
      },
    };
    const res = await app.inject({ method: "POST", url: "/api/tv/events/c1", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(created.data).toEqual({ profileId: "p1", channelId: "c1" });
    await app.close();
  });

  it("404s a hidden or unknown channel", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "cH", hidden: true }) };
    const res = await app.inject({ method: "POST", url: "/api/tv/events/cH", cookies: COOKIES });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
