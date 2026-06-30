import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import { Prisma } from "@orbix/db";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

describe("POST /setup", () => {
  it("creates the admin and returns 200 when no account exists", async () => {
    const app = await buildApp(env);
    (app as any).prisma.account = {
      count: async () => 0,
      create: async () => ({ id: "a1" }),
    };
    (app as any).prisma.session = {
      create: async () => ({ id: "s1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    const res = await app.inject({
      method: "POST", url: "/api/setup",
      payload: { email: "admin@example.com", password: "longenough" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accountId: "a1" });
    await app.close();
  });

  it("returns 409 when the DB single-admin guard rejects a concurrent second admin (P2002)", async () => {
    const app = await buildApp(env);
    (app as any).prisma.account = {
      count: async () => 0, // racing request also saw an empty table
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError("unique violation", {
          code: "P2002",
          clientVersion: "x",
        });
      },
    };
    const res = await app.inject({
      method: "POST", url: "/api/setup",
      payload: { email: "admin@example.com", password: "longenough" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "setup_complete" });
    await app.close();
  });
});
