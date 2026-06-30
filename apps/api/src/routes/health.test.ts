import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

describe("GET /health", () => {
  it("returns 200 db:true when the DB probe succeeds", async () => {
    const app = await buildApp(env);
    (app as any).prisma.$queryRaw = async () => [{ "?column?": 1 }];
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ db: true });
    await app.close();
  });

  it("returns 503 db:false when the DB probe throws", async () => {
    const app = await buildApp(env);
    (app as any).prisma.$queryRaw = async () => {
      throw new Error("connection refused");
    };
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ db: false });
    await app.close();
  });
});
