import { describe, it, expect } from "vitest";
import os from "node:os";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const fakeRuntime = { resolve: async () => os.tmpdir(), unmount: async () => {} };

// Minimal in-memory prisma fake that honours `select` so projection (password
// exclusion) is exercised, not bypassed.
function project<T extends object>(row: T, select?: Record<string, boolean>): Record<string, unknown> {
  const r = row as Record<string, unknown>;
  if (!select) return { ...r };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
  return out;
}

interface SourceRow {
  id: string; libraryId: string; kind: string; path: string | null;
  smbHost: string | null; smbShare: string | null; smbSubpath: string | null;
  smbUsername: string | null; smbPassword: string | null; smbDomain: string | null;
  enabled: boolean; status: string; statusMessage: string | null; lastScanAt: Date | null;
}
interface LibRow { id: string; name: string; order: number; createdAt: Date }

function fakePrisma() {
  const libs: LibRow[] = [];
  const sources: SourceRow[] = [];
  let n = 0;
  const id = () => `id${++n}`;
  return {
    session: { findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }) },
    profile: { findUnique: async () => null },
    library: {
      findMany: async (args: { orderBy?: { order: "asc" }; include?: { sources?: { select?: Record<string, boolean> } } }) => {
        const rows = [...libs].sort((a, b) => a.order - b.order);
        return rows.map((l) => ({
          ...l,
          sources: args.include?.sources
            ? sources.filter((s) => s.libraryId === l.id).map((s) => project(s, args.include!.sources!.select))
            : undefined,
        }));
      },
      create: async (args: { data: { name: string }; select?: Record<string, boolean> }) => {
        const row: LibRow = { id: id(), name: args.data.name, order: 0, createdAt: new Date() };
        libs.push(row);
        return project(row, args.select);
      },
      update: async (args: { where: { id: string }; data: Partial<LibRow>; select?: Record<string, boolean> }) => {
        const row = libs.find((l) => l.id === args.where.id);
        if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
        Object.assign(row, args.data);
        return project(row, args.select);
      },
      delete: async (args: { where: { id: string } }) => {
        const i = libs.findIndex((l) => l.id === args.where.id);
        if (i < 0) throw Object.assign(new Error("not found"), { code: "P2025" });
        libs.splice(i, 1);
        for (let j = sources.length - 1; j >= 0; j--) if (sources[j]!.libraryId === args.where.id) sources.splice(j, 1);
        return {};
      },
    },
    source: {
      findMany: async (args: { where: { libraryId?: string; kind?: string }; select?: Record<string, boolean> }) =>
        sources
          .filter((s) => (args.where.libraryId ? s.libraryId === args.where.libraryId : true) && (args.where.kind ? s.kind === args.where.kind : true))
          .map((s) => project(s, args.select)),
      findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = sources.find((s) => s.id === args.where.id);
        return row ? project(row, args.select) : null;
      },
      create: async (args: { data: Partial<SourceRow>; select?: Record<string, boolean> }) => {
        const row: SourceRow = {
          id: id(), libraryId: "", kind: "local", path: null,
          smbHost: null, smbShare: null, smbSubpath: null, smbUsername: null, smbPassword: null, smbDomain: null,
          enabled: true, status: "ok", statusMessage: null, lastScanAt: null, ...args.data,
        };
        sources.push(row);
        return project(row, args.select);
      },
      update: async (args: { where: { id: string }; data: Partial<SourceRow>; select?: Record<string, boolean> }) => {
        const row = sources.find((s) => s.id === args.where.id);
        if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
        Object.assign(row, args.data);
        return project(row, args.select);
      },
      delete: async (args: { where: { id: string } }) => {
        const i = sources.findIndex((s) => s.id === args.where.id);
        if (i < 0) throw Object.assign(new Error("not found"), { code: "P2025" });
        sources.splice(i, 1);
        return {};
      },
    },
    _raw: { libs, sources },
  };
}

async function makeApp() {
  const app = await buildApp(env, { mountRuntime: fakeRuntime });
  (app as unknown as { prisma: ReturnType<typeof fakePrisma> }).prisma = fakePrisma();
  return app;
}
const COOKIE = { orbix_session: "s1" };

describe("library + source routes", () => {
  it("creates a library and lists it", async () => {
    const app = await makeApp();
    const created = await app.inject({ method: "POST", url: "/api/libraries", cookies: COOKIE, payload: { name: "Films" } });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/libraries", cookies: COOKIE });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].name).toBe("Films");
    await app.close();
  });

  it("rejects an unreadable local source path", async () => {
    const app = await makeApp();
    const lib = (await app.inject({ method: "POST", url: "/api/libraries", cookies: COOKIE, payload: { name: "L" } })).json();
    const res = await app.inject({ method: "POST", url: `/api/libraries/${lib.id}/sources`, cookies: COOKIE, payload: { kind: "local", path: "/no/such/path/xyz" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("path_unreadable");
    await app.close();
  });

  it("accepts a readable local source path", async () => {
    const app = await makeApp();
    const lib = (await app.inject({ method: "POST", url: "/api/libraries", cookies: COOKIE, payload: { name: "L" } })).json();
    const res = await app.inject({ method: "POST", url: `/api/libraries/${lib.id}/sources`, cookies: COOKIE, payload: { kind: "local", path: os.tmpdir() } });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("local");
    await app.close();
  });

  it("stores an SMB source with an encrypted password and never returns it", async () => {
    const app = await makeApp();
    const prisma = (app as unknown as { prisma: ReturnType<typeof fakePrisma> }).prisma;
    const lib = (await app.inject({ method: "POST", url: "/api/libraries", cookies: COOKIE, payload: { name: "L" } })).json();
    const res = await app.inject({
      method: "POST", url: `/api/libraries/${lib.id}/sources`, cookies: COOKIE,
      payload: { kind: "smb", host: "nas", share: "media", username: "u", password: "hunter2" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("smb");
    expect(res.json().smbPassword).toBeUndefined();
    // stored password is encrypted, not plaintext
    const stored = prisma._raw.sources[0]!;
    expect(stored.smbPassword).not.toBe("hunter2");
    expect(stored.smbPassword).toBeTruthy();
    // GET also never leaks the password
    const list = await app.inject({ method: "GET", url: "/api/libraries", cookies: COOKIE });
    expect(list.json()[0].sources[0].smbPassword).toBeUndefined();
    await app.close();
  });

  it("patches library order and deletes a library", async () => {
    const app = await makeApp();
    const lib = (await app.inject({ method: "POST", url: "/api/libraries", cookies: COOKIE, payload: { name: "L" } })).json();
    const patched = await app.inject({ method: "PATCH", url: `/api/libraries/${lib.id}`, cookies: COOKIE, payload: { order: 5 } });
    expect(patched.json().order).toBe(5);
    const del = await app.inject({ method: "DELETE", url: `/api/libraries/${lib.id}`, cookies: COOKIE });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({ method: "GET", url: "/api/libraries", cookies: COOKIE });
    expect(list.json()).toHaveLength(0);
    await app.close();
  });
});
