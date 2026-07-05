import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const cookies = { orbix_session: "s1" };

/** Stub the admin-auth chain (session → admin account → non-kids profile). */
function stubAdminAuth(app: unknown): void {
  (app as any).prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }), findFirst: async () => ({ id: "a1" }) };
  (app as any).prisma.profile = { findUnique: async () => null };
}

describe("POST /maintenance/extract-subtitles (backfill)", () => {
  it("enqueues one job per file that has a text subtitle track, skipping image-only / subtitle-less files", async () => {
    const app = await buildApp(env);
    stubAdminAuth(app);
    (app as any).prisma.mediaFile = {
      findMany: async () => [
        { id: "f1", subtitleTracks: [{ index: 2, codec: "subrip", language: "en" }] },
        { id: "f2", subtitleTracks: [{ index: 3, codec: "hdmv_pgs_subtitle", language: "ru" }] }, // image only
        { id: "f3", subtitleTracks: [] }, // none
        { id: "f4", subtitleTracks: [{ index: 2, codec: "ass" }, { index: 3, codec: "dvd_subtitle" }] },
      ],
    };
    const enqueued: string[] = [];
    (app as any).subtitlesQueue = {
      add: async (_name: string, data: { fileId: string }, opts: { jobId: string }) => {
        enqueued.push(`${data.fileId}:${opts.jobId}`);
        return undefined;
      },
    };

    const res = await app.inject({ method: "POST", url: "/api/maintenance/extract-subtitles", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enqueued: 2 });
    // Only f1 and f4 have text tracks; each dedups on jobId=fileId.
    expect(enqueued).toEqual(["f1:f1", "f4:f4"]);
    await app.close();
  });

  it("rejects a non-admin caller", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: false }), findFirst: async () => ({ id: "a1" }) };
    const res = await app.inject({ method: "POST", url: "/api/maintenance/extract-subtitles", cookies });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
