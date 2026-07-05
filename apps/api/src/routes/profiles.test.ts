import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";
import { hashPin } from "@orbix/core";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

function prismaStub(app: unknown): Record<string, unknown> {
  return (app as { prisma: Record<string, unknown> }).prisma;
}

describe("GET /me/profile", () => {
  it("returns the full active profile when a valid profile cookie is set", async () => {
    const app = await buildApp(env);
    // Authenticated session + a selected profile.
    prismaStub(app).session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    prismaStub(app).profile = {
      findUnique: async () => ({
        id: "p1",
        name: "Alex",
        avatar: null,
        kind: "kids",
        maturityCap: 1,
        language: "en",
        isGroup: false,
        pinHash: null,
        groupMembers: [],
      }),
    };
    const res = await app.inject({
      method: "GET", url: "/api/me/profile",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: "p1",
      name: "Alex",
      avatar: null,
      kind: "kids",
      maturityCap: 1,
      language: "en",
      isGroup: false,
      hasPin: false,
      members: [],
    });
    await app.close();
  });

  it("returns all-null when no profile cookie is set", async () => {
    const app = await buildApp(env);
    prismaStub(app).session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    const res = await app.inject({ method: "GET", url: "/api/me/profile", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: null,
      name: null,
      avatar: null,
      kind: null,
      maturityCap: null,
      language: null,
      isGroup: false,
      hasPin: false,
      members: [],
    });
    await app.close();
  });
});

describe("profile PINs", () => {
  it("does not expose pinHash and reports hasPin on the list route", async () => {
    const app = await buildApp(env);
    prismaStub(app).session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    prismaStub(app).profile = {
      findMany: async () => [{
        id: "g1",
        name: "Movie Night",
        avatar: null,
        kind: "standard",
        maturityCap: null,
        language: "en",
        isGroup: true,
        pinHash: "secret-hash",
        groupMembers: [{
          member: { id: "p1", name: "Alex", avatar: null, kind: "standard", maturityCap: null, isGroup: false },
        }],
      }],
    };

    const res = await app.inject({
      method: "GET", url: "/api/profiles", cookies: { orbix_session: "s1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{
      id: "g1",
      name: "Movie Night",
      avatar: null,
      kind: "standard",
      maturityCap: null,
      language: "en",
      isGroup: true,
      hasPin: true,
      members: [{ id: "p1", name: "Alex", avatar: null, kind: "standard", maturityCap: null, isGroup: false }],
    }]);
    expect(JSON.stringify(res.json())).not.toContain("secret-hash");
    await app.close();
  });

  it("requires and verifies a 4-6 digit profile PIN when selecting", async () => {
    const app = await buildApp(env);
    const pinHash = await hashPin("123456");
    prismaStub(app).session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    prismaStub(app).profile = {
      findUnique: async () => ({
        id: "p1",
        name: "Admin",
        avatar: null,
        kind: "standard",
        maturityCap: null,
        language: "en",
        isGroup: false,
        pinHash,
      }),
    };

    const denied = await app.inject({
      method: "POST", url: "/api/profiles/p1/select", cookies: { orbix_session: "s1" }, payload: { pin: "0000" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "pin_required" });

    const allowed = await app.inject({
      method: "POST", url: "/api/profiles/p1/select", cookies: { orbix_session: "s1" }, payload: { pin: "123456" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ profileId: "p1" });
    expect(String(allowed.headers["set-cookie"])).toContain("orbix_profile=p1");
    await app.close();
  });
});

describe("group profiles", () => {
  it("blocks profile mutations from an active kids profile", async () => {
    const app = await buildApp(env);
    prismaStub(app).session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    prismaStub(app).profile = {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "kid"
          ? {
              id: "kid",
              name: "Kid",
              avatar: null,
              kind: "kids",
              maturityCap: 1,
              language: "en",
              isGroup: false,
              pinHash: null,
              groupMembers: [],
            }
          : null,
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/profiles",
      cookies: { orbix_session: "s1", orbix_profile: "kid" },
      payload: { name: "Bypass", kind: "standard", language: "en" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not_allowed_for_kids" });
    await app.close();
  });

  it("creates a group profile with member rows and clamps to kids-safe settings when a kid is included", async () => {
    const app = await buildApp(env);
    prismaStub(app).session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    type CreatedData = {
      name: string;
      kind: string;
      maturityCap: number | null;
      language: string;
      isGroup: boolean;
      pinHash: string | null;
    };
    type MemberRow = { groupProfileId: string; memberProfileId: string; position: number };
    let createdData: CreatedData | null = null;
    let memberRows: MemberRow[] = [];
    const members = [
      { id: "adult", kind: "standard", maturityCap: null, isGroup: false },
      { id: "kid", kind: "kids", maturityCap: 1, isGroup: false },
    ];
    const tx = {
      profile: {
        create: async ({ data }: { data: CreatedData }) => {
          createdData = data;
          return { id: "group" };
        },
        findUnique: async () => ({
          id: "group",
          name: createdData!.name,
          avatar: null,
          kind: createdData!.kind,
          maturityCap: createdData!.maturityCap,
          language: createdData!.language,
          isGroup: createdData!.isGroup,
          pinHash: createdData!.pinHash,
          groupMembers: memberRows.map((row) => ({
            member: {
              id: row.memberProfileId,
              name: row.memberProfileId === "adult" ? "Adult" : "Kid",
              avatar: null,
              kind: row.memberProfileId === "adult" ? "standard" : "kids",
              maturityCap: row.memberProfileId === "adult" ? null : 1,
              isGroup: false,
            },
          })),
        }),
      },
      profileGroupMember: {
        createMany: async ({ data }: { data: MemberRow[] }) => {
          memberRows = data;
          return { count: data.length };
        },
      },
    };
    prismaStub(app).$transaction = async (fn: (txArg: typeof tx) => Promise<unknown>) => fn(tx);
    prismaStub(app).profile = {
      findMany: async () => members,
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/profiles",
      cookies: { orbix_session: "s1" },
      payload: {
        name: "Family Night",
        kind: "standard",
        language: "en",
        isGroup: true,
        memberProfileIds: ["adult", "kid"],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(createdData).toMatchObject({ kind: "kids", maturityCap: 1, isGroup: true });
    expect(memberRows.map((row) => row.memberProfileId)).toEqual(["adult", "kid"]);
    expect(res.json()).toMatchObject({
      id: "group",
      name: "Family Night",
      kind: "kids",
      maturityCap: 1,
      isGroup: true,
      hasPin: false,
      members: [
        { id: "adult", name: "Adult", kind: "standard", isGroup: false },
        { id: "kid", name: "Kid", kind: "kids", maturityCap: 1, isGroup: false },
      ],
    });
    await app.close();
  });
});
