import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const WEB_CAPS = {
  containers: ["mp4"], videoCodecs: ["h264"], audioCodecs: ["aac"],
  maxAudioChannels: 2, hlsMultichannelAacBroken: true,
};
const cookies = { orbix_session: "s1" };

function stubAll(app: unknown) {
  (app as any).prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }), findFirst: async () => ({ id: "a1" }) };
  (app as any).prisma.profile = { findUnique: async () => null };
  (app as any).prisma.mediaFile = {
    findUnique: async () => ({
      id: "f1", path: "/media/movie.mkv", container: "matroska,webm", videoCodec: "h264",
      audioCodecs: ["aac"], durationSec: 30,
      audioTracks: [{ index: 1, codec: "aac", channels: 2 }],
      subtitleTracks: [],
      mediaItem: { rating: "PG-13" },
    }),
  };
}

/** A direct-play-eligible file (mp4/h264/aac) — negotiation yields plan.mode==="direct". */
function stubDirectFile(app: unknown) {
  (app as any).prisma.mediaFile = {
    findUnique: async () => ({
      id: "f1", path: "/media/movie.mp4", container: "mov,mp4,m4a,3gp,3g2,mj2", videoCodec: "h264",
      audioCodecs: ["aac"], durationSec: null,
      audioTracks: [{ index: 1, codec: "aac", channels: 2 }],
      subtitleTracks: [],
      mediaItem: { rating: "PG-13" },
    }),
  };
}

/** Same as stubAll's file (remux-eligible mkv/h264/aac) but rated R, for the kids-gate re-check test. */
function stubRRatedFile(app: unknown) {
  (app as any).prisma.mediaFile = {
    findUnique: async () => ({
      id: "f1", path: "/media/movie.mkv", container: "matroska,webm", videoCodec: "h264",
      audioCodecs: ["aac"], durationSec: 30,
      audioTracks: [{ index: 1, codec: "aac", channels: 2 }],
      subtitleTracks: [],
      mediaItem: { rating: "R" },
    }),
  };
}

async function negotiate(app: any): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/playback/info", cookies,
    payload: { fileId: "f1", capabilities: WEB_CAPS },
  });
  return res.json().playSessionId as string;
}

describe("session-aware HLS routes", () => {
  it("master echoes the playSessionId into index.m3u8", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const sid = await negotiate(app);
    const res = await app.inject({ method: "GET", url: `/api/play/f1/master.m3u8?playSessionId=${sid}`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`index.m3u8?playSessionId=${sid}`);
    await app.close();
  });

  it("index playlist URIs carry the playSessionId query", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const sid = await negotiate(app);
    const res = await app.inject({ method: "GET", url: `/api/play/f1/index.m3u8?playSessionId=${sid}`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`init.mp4?playSessionId=${sid}`);
    expect(res.body).toContain(`seg0.m4s?playSessionId=${sid}`);
    await app.close();
  });

  it("unknown playSessionId → 404 session_expired", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const res = await app.inject({
      method: "GET", url: "/api/play/f1/master.m3u8?playSessionId=00000000-0000-0000-0000-000000000000", cookies,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "session_expired" });
    await app.close();
  });

  it("master without playSessionId → 400 missing_session", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const res = await app.inject({ method: "GET", url: "/api/play/f1/master.m3u8", cookies });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "missing_session" });
    await app.close();
  });

  it("index/init/seg without playSessionId → 400 missing_session", async () => {
    const app = await buildApp(env);
    stubAll(app);
    for (const url of [
      "/api/play/f1/index.m3u8",
      "/api/play/f1/init.mp4",
      "/api/play/f1/seg0.m4s",
    ]) {
      const res = await app.inject({ method: "GET", url, cookies });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "missing_session" });
    }
    await app.close();
  });

  it("stop is idempotent and tears the session down", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const sid = await negotiate(app);
    const stop1 = await app.inject({ method: "POST", url: `/api/playback/${sid}/stop`, cookies });
    expect(stop1.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/play/f1/master.m3u8?playSessionId=${sid}`, cookies });
    expect(after.statusCode).toBe(404);
    const stop2 = await app.inject({ method: "POST", url: `/api/playback/${sid}/stop`, cookies });
    expect(stop2.statusCode).toBe(200);
    await app.close();
  });

  it("progress PUT with playSessionId succeeds and ignores unknown ids", async () => {
    const app = await buildApp(env);
    stubAll(app);
    (app as any).prisma.mediaItem = { findUnique: async () => ({ rating: "PG-13" }) };
    (app as any).prisma.playbackState = { upsert: async ({ create }: any) => create };
    (app as any).prisma.playEvent = { findFirst: async () => ({ id: "r" }), create: async () => ({}) };
    const sid = await negotiate(app);
    for (const playSessionId of [sid, "unknown-id"]) {
      const res = await app.inject({
        method: "PUT", url: "/api/items/m1/progress",
        cookies: { ...cookies, orbix_profile: "p1" },
        payload: { positionSec: 5, durationSec: 30, playSessionId },
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it("a direct-mode session (unprobed direct-play) 404s on the HLS master route", async () => {
    const app = await buildApp(env);
    stubAll(app);
    stubDirectFile(app);
    const sid = await negotiate(app);
    const res = await app.inject({ method: "GET", url: `/api/play/f1/master.m3u8?playSessionId=${sid}`, cookies });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "session_expired" });
    await app.close();
  });

  it("kids gate is re-checked per-request on the session-aware index route", async () => {
    const app = await buildApp(env);
    stubAll(app);
    stubRRatedFile(app);
    // Negotiate with a standard/no profile (allowed — R is fine for an unrestricted viewer).
    const sid = await negotiate(app);

    // Flip the active profile to a kids profile capped below R (mid-session profile switch).
    (app as any).prisma.profile = {
      findUnique: async () => ({ id: "p_kid", name: "Kid", avatar: null, kind: "kids", maturityCap: 0, language: "en" }),
    };
    const res = await app.inject({
      method: "GET",
      url: `/api/play/f1/index.m3u8?playSessionId=${sid}`,
      cookies: { ...cookies, orbix_profile: "p_kid" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "blocked_by_rating" });
    await app.close();
  });
});
