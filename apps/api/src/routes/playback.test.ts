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

function stubAuth(app: unknown, profile: Record<string, unknown> | null = null) {
  (app as any).prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }), findFirst: async () => ({ id: "a1" }) };
  (app as any).prisma.profile = { findUnique: async () => profile };
}

function stubFile(app: unknown, overrides: Record<string, unknown> = {}) {
  (app as any).prisma.mediaFile = {
    findUnique: async () => ({
      id: "f1", path: "/media/movie.mkv", container: "matroska,webm", videoCodec: "h264",
      audioCodecs: ["ac3"], durationSec: 120,
      audioTracks: [{ index: 1, codec: "ac3", channels: 6, language: "ru" }],
      subtitleTracks: [
        { index: 2, codec: "subrip", language: "en" },
        { index: 3, codec: "hdmv_pgs_subtitle", language: "ru" },
      ],
      mediaItem: { rating: "PG-13" },
      ...overrides,
    }),
  };
}

const cookies = { orbix_session: "s1" };

describe("POST /api/playback/info", () => {
  it("returns a session, decision, and track lists", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app);
    const res = await app.inject({
      method: "POST", url: "/api/playback/info", cookies,
      payload: { fileId: "f1", capabilities: WEB_CAPS },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("remux");
    expect(body.playSessionId).toMatch(/[0-9a-f-]{36}/);
    expect(body.streamUrl).toBe(`/api/play/f1/master.m3u8?playSessionId=${body.playSessionId}`);
    expect(body.audioTracks).toEqual([
      { index: 0, codec: "ac3", channels: 6, language: "ru", selected: true },
    ]);
    expect(body.subtitleTracks).toEqual([
      { index: 2, codec: "subrip", language: "en", available: true },
      { index: 3, codec: "hdmv_pgs_subtitle", language: "ru", available: false, reason: "image_based" },
    ]);
    await app.close();
  });

  it("direct mode returns the direct URL", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app, {
      container: "mov,mp4,m4a,3gp,3g2,mj2", videoCodec: "h264",
      audioTracks: [{ index: 1, codec: "aac", channels: 2 }],
    });
    const res = await app.inject({
      method: "POST", url: "/api/playback/info", cookies,
      payload: { fileId: "f1", capabilities: WEB_CAPS },
    });
    expect(res.json().mode).toBe("direct");
    expect(res.json().streamUrl).toBe("/api/play/f1/direct");
    await app.close();
  });

  it("404s kids-blocked titles without leaking existence", async () => {
    const app = await buildApp(env);
    stubAuth(app, { id: "p_kid", name: "Kid", avatar: null, kind: "kids", maturityCap: 0, language: "en" });
    stubFile(app, { mediaItem: { rating: "R" } });
    const res = await app.inject({
      method: "POST", url: "/api/playback/info",
      cookies: { ...cookies, orbix_profile: "p_kid" },
      payload: { fileId: "f1", capabilities: WEB_CAPS },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    await app.close();
  });

  it("409s unprobed files for non-direct modes", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app, { durationSec: null });
    const res = await app.inject({
      method: "POST", url: "/api/playback/info", cookies,
      payload: { fileId: "f1", capabilities: WEB_CAPS },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("400s invalid bodies", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app);
    for (const payload of [
      {},
      { fileId: "f1" },
      { fileId: "f1", capabilities: { containers: "mp4" } },
      { fileId: "f1", capabilities: WEB_CAPS, audioTrackIndex: -1 },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/playback/info", cookies, payload });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("401s without credentials", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app);
    const res = await app.inject({
      method: "POST", url: "/api/playback/info",
      payload: { fileId: "f1", capabilities: WEB_CAPS },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
