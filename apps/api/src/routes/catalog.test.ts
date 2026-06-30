import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

describe("GET /libraries/:id/items", () => {
  it("returns items filtered by libraryId", async () => {
    const app = await buildApp(env);
    let captured: { libraryId?: string } = {};
    (app as any).prisma.session = { findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }) };
    (app as any).prisma.profile = { findUnique: async () => null };
    (app as any).prisma.mediaItem = {
      findMany: async (args: { where: { libraryId: string } }) => {
        captured = args.where;
        return [{ id: "m1", title: "Heat", year: 1995, posterPath: null, matchState: "matched", translations: [] }];
      },
    };
    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/items", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(captured.libraryId).toBe("lib1");
    expect(res.json()).toHaveLength(1);
    await app.close();
  });

  it("rejects an invalid sort", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = { findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }) };
    (app as any).prisma.profile = { findUnique: async () => null };
    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/items?sort=bogus", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
