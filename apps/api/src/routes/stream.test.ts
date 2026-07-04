import { describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

// The legacy GET /play/:fileId/decision endpoint (and its quality-ladder master
// with parallel /hls/:quality/:audio/* routes) was replaced by the session
// model: the client negotiates via POST /playback/info — which now carries the
// quality + audio-mode ladders — and each choice mints a fresh play session
// whose single-variant master reflects the chosen quality. These tests cover
// that reconciled contract.

const env: Env = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://x",
  REDIS_URL: "redis://x",
  API_PORT: 1061,
  WEB_PORT: 1060,
  SESSION_SECRET: "x".repeat(32),
  WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata",
  TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models",
  MOUNTS_DIR: "./data/mounts",
  EMBEDDINGS_ENABLED: true,
  MAX_TRANSCODE_SESSIONS: 4,
};

const WEB_CAPS = {
  containers: ["mp4"],
  videoCodecs: ["h264"],
  audioCodecs: ["aac"],
  maxAudioChannels: 2,
  hlsMultichannelAacBroken: true,
};

const cookies = { orbix_session: "s1", orbix_profile: "p1" };
const profile = {
  id: "p1",
  name: "Watcher",
  avatar: null,
  kind: "standard",
  maturityCap: null,
  language: "en",
};

// A 1080p, direct-playable mp4/h264/aac file: source is direct, and the ladder
// offers 720p/480p downscales (which force transcode).
function fileRow() {
  return {
    id: "f1",
    path: "/media/movie.mp4",
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    videoCodec: "h264",
    audioCodecs: ["aac"],
    audioTracks: [{ index: 1, codec: "aac", channels: 2, language: "en" }],
    subtitleTracks: [],
    // A keyframe index is present so a remux plan (e.g. audio-leveling on a
    // direct file) stays remux instead of downgrading to transcode.
    keyframes: [0, 6.006, 12.012],
    width: 1920,
    height: 1080,
    durationSec: 7200,
    bitrate: 8_000_000,
    videoProfile: null,
    videoLevel: null,
    colorTransfer: null,
    frameRate: 24,
    mediaItem: { rating: "PG-13" },
  };
}

async function buildStreamApp() {
  const app = await buildApp(env);
  const prisma = (app as unknown as { prisma: Record<string, unknown> }).prisma;

  prisma.session = {
    findUnique: async () => ({
      id: "s1",
      accountId: "a1",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
  };
  prisma.account = { findUnique: async () => ({ isAdmin: true }), findFirst: async () => ({ id: "a1" }) };
  prisma.profile = { findUnique: async () => profile };
  prisma.setting = { findUnique: async () => null };
  prisma.mediaFile = {
    findUnique: async ({ where }: { where: { id: string } }) => (where.id === "f1" ? fileRow() : null),
  };
  return app;
}

async function negotiate(
  app: Awaited<ReturnType<typeof buildStreamApp>>,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/api/playback/info",
    cookies,
    payload: { fileId: "f1", capabilities: WEB_CAPS, ...body },
  });
}

describe("VOD stream routes (session model)", () => {
  it("playback/info exposes the quality ladder and audio modes", async () => {
    const app = await buildStreamApp();

    const res = await negotiate(app, {});
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.mode).toBe("direct");
    expect(body.streamUrl).toBe("/api/play/f1/direct");
    expect(body.quality).toBe("source");
    expect(body.audioMode).toBe("standard");
    expect(body.qualities.map((q: { id: string }) => q.id)).toEqual(["source", "720p", "480p"]);
    expect(body.audioModes).toEqual([
      { id: "standard", label: "Standard" },
      { id: "leveled", label: "Leveling" },
    ]);

    await app.close();
  });

  it("choosing a downscale quality mints a transcode session whose master reflects it", async () => {
    const app = await buildStreamApp();

    const info = (await negotiate(app, { quality: "720p" })).json();
    expect(info.mode).toBe("transcode");
    expect(info.quality).toBe("720p");
    expect(info.streamUrl).toBe(`/api/play/f1/master.m3u8?playSessionId=${info.playSessionId}`);

    const master = await app.inject({
      method: "GET",
      url: `/api/play/f1/master.m3u8?playSessionId=${info.playSessionId}`,
      cookies,
    });
    expect(master.statusCode).toBe(200);
    expect(master.headers["content-type"]).toContain("mpegurl");
    // Single variant reflecting the 720p downscale target.
    expect(master.body).toContain("RESOLUTION=1280x720");
    expect(master.body).toContain(`index.m3u8?playSessionId=${info.playSessionId}`);

    await app.close();
  });

  it("audio leveling on a direct file upgrades to a (remux) session", async () => {
    const app = await buildStreamApp();

    const info = (await negotiate(app, { audioMode: "leveled" })).json();
    // Direct play can't re-encode audio, so leveling forces at least a remux.
    expect(info.mode).toBe("remux");
    expect(info.audioMode).toBe("leveled");
    expect(info.streamUrl).toBe(`/api/play/f1/master.m3u8?playSessionId=${info.playSessionId}`);

    await app.close();
  });
});
