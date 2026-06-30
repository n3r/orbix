import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function authed(app: any, profile: unknown) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.profile = { findUnique: async () => profile };
}

describe("GET /items/:id/seasons/:n/episodes", () => {
  it("returns episodes with fileId + progress for the season", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", kind: "standard", maturityCap: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).prisma.mediaItem = {
      findUnique: async () => ({ id: "series-1", kind: "series", rating: "TV-14" }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).prisma.season = { findUnique: async () => ({ id: "season-1" }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).prisma.episode = {
      findMany: async () => [
        { id: "e1", episodeNumber: 1, title: "Pilot", overview: "o", stillPath: "still/e1.jpg", runtimeSec: 1500, airDate: new Date("2021-11-06T00:00:00.000Z"), files: [{ id: "f1" }] },
        { id: "e2", episodeNumber: 2, title: "Next", overview: null, stillPath: null, runtimeSec: null, airDate: null, files: [] },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).prisma.playbackState = {
      findMany: async () => [{ episodeId: "e1", positionSec: 300, durationSec: 1500, finished: false }],
    };

    const res = await app.inject({
      method: "GET", url: "/api/items/series-1/seasons/1/episodes",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.episodes).toHaveLength(2);
    expect(body.episodes[0]).toMatchObject({ id: "e1", episodeNumber: 1, fileId: "f1" });
    expect(body.episodes[0].progress).toEqual({ positionSec: 300, durationSec: 1500, finished: false });
    expect(body.episodes[0].airDate).toBe("2021-11-06T00:00:00.000Z");
    expect(body.episodes[1]).toMatchObject({ id: "e2", fileId: null, progress: null });
    await app.close();
  });

  it("404s for a kids profile when the series exceeds the cap", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", kind: "kids", maturityCap: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).prisma.mediaItem = {
      findUnique: async () => ({ id: "series-1", kind: "series", rating: "TV-MA" }),
    };
    const res = await app.inject({
      method: "GET", url: "/api/items/series-1/seasons/1/episodes",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
