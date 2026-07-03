import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../app";
import { hashDeviceToken } from "@orbix/core";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const RAW = "orb_stream-token";
const HASH = hashDeviceToken(RAW);

function stubAuth(app: unknown, opts: { kids?: boolean } = {}) {
  const device = {
    id: "dev1", tokenHash: HASH, name: "TV", platform: "tvos",
    activeProfileId: opts.kids ? "p_kid" : null,
    lastSeenAt: new Date(), createdAt: new Date(), revokedAt: null,
  };
  (app as any).prisma.deviceToken = {
    findUnique: async ({ where }: any) =>
      where.tokenHash === HASH || where.id === "dev1" ? device : null,
    update: async () => device,
  };
  (app as any).prisma.account = { findFirst: async () => ({ id: "a1" }), findUnique: async () => ({ isAdmin: true }) };
  (app as any).prisma.profile = {
    findUnique: async ({ where }: any) =>
      where.id === "p_kid"
        ? { id: "p_kid", name: "Kid", avatar: null, kind: "kids", maturityCap: 0, language: "en" }
        : null,
  };
}

async function withTempFile(fn: (p: string) => Promise<void>) {
  const p = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), "orbix-")), "movie.mp4");
  await fs.promises.writeFile(p, Buffer.alloc(1024, 7));
  try { await fn(p); } finally { await fs.promises.rm(path.dirname(p), { recursive: true, force: true }); }
}

describe("query-token auth on /play/*", () => {
  it("serves a direct stream with ?token= and no cookies", async () => {
    await withTempFile(async (filePath) => {
      const app = await buildApp(env);
      stubAuth(app);
      (app as any).prisma.mediaFile = {
        findUnique: async () => ({
          id: "f1", path: filePath, container: "mp4",
          mediaItem: { rating: "PG-13" },
        }),
      };
      const res = await app.inject({ method: "GET", url: `/api/play/f1/direct?token=${RAW}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["accept-ranges"]).toBe("bytes");
      await app.close();
    });
  });

  it("serves a 206 partial range with ?token=", async () => {
    await withTempFile(async (filePath) => {
      const app = await buildApp(env);
      stubAuth(app);
      (app as any).prisma.mediaFile = {
        findUnique: async () => ({
          id: "f1", path: filePath, container: "mp4",
          mediaItem: { rating: "PG-13" },
        }),
      };
      const res = await app.inject({
        method: "GET",
        url: `/api/play/f1/direct?token=${RAW}`,
        headers: { range: "bytes=0-99" },
      });
      expect(res.statusCode).toBe(206);
      expect(res.headers["content-range"]).toMatch(/^bytes 0-99\//);
      expect(res.headers["accept-ranges"]).toBe("bytes");
      await app.close();
    });
  });

  it("401s without any credentials", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    const res = await app.inject({ method: "GET", url: "/api/play/f1/direct" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("401s with an unknown token", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    const res = await app.inject({ method: "GET", url: "/api/play/f1/direct?token=orb_wrong" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("enforces the kids gate through the device's active profile", async () => {
    await withTempFile(async (filePath) => {
      const app = await buildApp(env);
      stubAuth(app, { kids: true });
      (app as any).prisma.mediaFile = {
        findUnique: async () => ({
          id: "f1", path: filePath, container: "mp4",
          mediaItem: { rating: "R" },
        }),
      };
      const res = await app.inject({ method: "GET", url: `/api/play/f1/direct?token=${RAW}` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "blocked_by_rating" });
      await app.close();
    });
  });

  it("an invalid bearer header never falls back to a valid cookie (device semantics)", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    const res = await app.inject({
      method: "GET", url: "/api/auth/me",
      headers: { authorization: "Bearer orb_wrong" },
      cookies: { orbix_session: "s1" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("subtitle listing accepts ?token= too", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    (app as any).prisma.mediaFile = {
      findUnique: async () => ({
        id: "f1", path: "/nope.mkv", subtitleTracks: [],
        mediaItem: { rating: "PG-13" },
      }),
    };
    const res = await app.inject({ method: "GET", url: `/api/play/f1/subs?token=${RAW}` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
