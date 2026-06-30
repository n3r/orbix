import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

describe("auth routes", () => {
  it("rejects login with bad credentials", async () => {
    const app = await buildApp(env);
    // override prisma with an in-memory stub via app.prisma (decorated)
    (app as any).prisma.account = { findUnique: async () => null };
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@b.c", password: "longenough" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
