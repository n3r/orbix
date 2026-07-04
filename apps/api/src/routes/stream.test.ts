import { describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

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

const cookies = { orbix_session: "s1", orbix_profile: "p1" };
const profile = {
  id: "p1",
  name: "Watcher",
  avatar: null,
  kind: "standard",
  maturityCap: null,
  language: "en",
};

function fileRow() {
  return {
    id: "f1",
    path: "/media/movie.mp4",
    container: "mp4",
    videoCodec: "h264",
    audioCodecs: ["aac"],
    width: 1920,
    height: 1080,
    durationSec: 7200,
    bitrate: 8_000_000,
    mediaItem: { rating: "PG-13" },
  };
}

async function buildStreamApp() {
  const app = await buildApp(env);
  const prisma = (app as unknown as {
    prisma: {
      session: unknown;
      profile: unknown;
      setting: unknown;
      mediaFile: unknown;
    };
  }).prisma;

  prisma.session = {
    findUnique: async () => ({
      id: "s1",
      accountId: "a1",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
  };
  prisma.profile = { findUnique: async () => profile };
  prisma.setting = { findUnique: async () => null };
  prisma.mediaFile = {
    findUnique: async ({ where }: { where: { id: string } }) => (
      where.id === "f1" ? fileRow() : null
    ),
  };
  return app;
}

describe("VOD stream routes", () => {
  it("decision includes selectable qualities and audio modes", async () => {
    const app = await buildStreamApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/play/f1/decision",
      cookies,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      mode: "direct",
      url: "/api/play/f1/direct",
    });
    expect(body.qualities.map((q: { id: string }) => q.id)).toEqual([
      "auto",
      "source",
      "720p",
      "480p",
    ]);
    expect(body.qualities[1]).toMatchObject({
      id: "source",
      type: "direct",
      url: "/api/play/f1/direct",
      hlsUrl: "/api/play/f1/hls/source/standard/index.m3u8",
    });
    expect(body.qualities[2]).toMatchObject({
      id: "720p",
      type: "hls",
      url: "/api/play/f1/hls/720p/standard/index.m3u8",
    });
    expect(body.audioModes).toEqual([
      { id: "standard", label: "Standard" },
      { id: "leveled", label: "Leveling" },
    ]);

    await app.close();
  });

  it("master playlist advertises HLS renditions for the selected audio mode", async () => {
    const app = await buildStreamApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/play/f1/master.m3u8?audio=leveled",
      cookies,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("mpegurl");
    expect(res.body).toContain("#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080");
    expect(res.body).toContain("hls/source/leveled/index.m3u8");
    expect(res.body).toContain("hls/720p/leveled/index.m3u8");
    expect(res.body).toContain("hls/480p/leveled/index.m3u8");

    await app.close();
  });
});
