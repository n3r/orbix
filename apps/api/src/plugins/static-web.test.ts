import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { staticWebPlugin } from "./static-web";

let dist: string;
beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "orbix-dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Orbix SPA</title>");
  writeFileSync(join(dist, "asset.js"), "console.log(1)");
});
afterAll(() => rmSync(dist, { recursive: true, force: true }));

describe("staticWebPlugin", () => {
  it("serves index.html for an unknown client route", async () => {
    const app = Fastify();
    app.get("/api/ping", async () => ({ ok: true })); // stand-in for API routes
    await app.register(staticWebPlugin, { distDir: dist });
    const res = await app.inject({ method: "GET", url: "/library/abc" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Orbix SPA");
    await app.close();
  });

  it("serves a real static asset", async () => {
    const app = Fastify();
    await app.register(staticWebPlugin, { distDir: dist });
    const res = await app.inject({ method: "GET", url: "/asset.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log(1)");
    await app.close();
  });

  it("returns JSON 404 for unknown /api routes (no SPA fallback)", async () => {
    const app = Fastify();
    await app.register(staticWebPlugin, { distDir: dist });
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    await app.close();
  });
});
