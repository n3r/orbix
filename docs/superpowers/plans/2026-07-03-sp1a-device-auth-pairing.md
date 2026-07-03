# SP1a: Device Auth & Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native clients (tvOS first) can pair with the server via an on-screen code approved from the web UI, then authenticate every API call with a long-lived per-device bearer token — including AVPlayer's cookieless segment fetches via a `?token=` query parameter on `/api/play/*`.

**Architecture:** A new `DeviceToken` Prisma model holds sha256-hashed bearer tokens with per-device metadata and a device-scoped `activeProfileId` (the device equivalent of the `orbix_profile` cookie). The global session plugin gains a Bearer-header path beside the cookie path; stream/subtitle routes additionally accept the token as a query param. Pairing is an in-memory, TTL'd code exchange (`initiate` → web `approve` → `poll` redeems the token once). A Devices tab in the web Account hub lists/renames/revokes devices and approves pairing codes.

**Tech Stack:** Fastify 5 + Prisma (Postgres), zod-free hand validation (matches existing routes), vitest (`buildApp` + prisma stubs + `app.inject`), React 19 + TanStack Query + react-i18next for the web tab.

**Spec:** `docs/superpowers/specs/2026-07-03-tv-app-and-client-server-contract-design.md` §4.1

## Global Constraints

- Always use the repo-local pnpm (`pnpm@10.22.0` via `packageManager`); run commands from the repo root.
- `packages/core` must stay free of DB/network/ffmpeg/fs imports — `node:crypto` is allowed (existing `password.ts`/`session.ts` use it).
- Run `pnpm --filter <pkg> lint` per task, not just typecheck+test — lint-only errors hide behind Turbo's cache.
- Kids filtering is server-enforced on every route; new device-auth paths must preserve that (device's active profile flows through `activeProfile()`).
- Never return secrets from the API: raw device tokens appear exactly once (in the poll redemption response); only sha256 hashes are stored.
- All new API routes live under the `/api` prefix via registration in `apps/api/src/app.ts`.
- Offline guarantee: no new runtime network dependencies.
- Commit after every task with a conventional-commit message.

---

### Task 1: `DeviceToken` Prisma model + migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (append after the `Session` model, line 40)
- Create: `packages/db/prisma/migrations/<timestamp>_add_device_tokens/migration.sql` (generated)

**Interfaces:**
- Produces: Prisma model `DeviceToken` with fields `id, tokenHash (unique), name, platform, activeProfileId, lastSeenAt, createdAt, revokedAt` — later tasks call `prisma.deviceToken.findUnique({ where: { tokenHash } })`, `.update`, `.findMany`, `.create`.

- [ ] **Step 1: Add the model to the schema**

Append to `packages/db/prisma/schema.prisma` directly after the `Session` model block:

```prisma
// Per-device bearer tokens for native clients (tvOS, future mobile).
// The raw token is returned exactly once at pairing redemption; only its
// sha256 hex digest is stored. activeProfileId is the device-scoped
// equivalent of the orbix_profile cookie.
model DeviceToken {
  id              String    @id @default(cuid())
  tokenHash       String    @unique
  name            String
  platform        String // "tvos" | future: "ios" | "android" | ...
  activeProfileId String?
  lastSeenAt      DateTime  @default(now())
  createdAt       DateTime  @default(now())
  revokedAt       DateTime?
}
```

Note: no relation to `Profile` — profiles are deletable independently; `activeProfileId` is resolved defensively at read time (same pattern as the `orbix_profile` cookie, which also stores a bare id).

- [ ] **Step 2: Generate the migration and client**

Run (requires the dev postgres from `docker compose up -d` on port 1062):

```bash
pnpm db:migrate -- --name add_device_tokens
pnpm db:generate
```

Expected: a new folder `packages/db/prisma/migrations/*_add_device_tokens/` containing `CREATE TABLE "DeviceToken" (...)` with a unique index on `tokenHash`, and `prisma generate` completing.

If `pnpm db:migrate` doesn't forward the flag, run the underlying command: `pnpm --filter @orbix/db exec prisma migrate dev --name add_device_tokens`.

- [ ] **Step 3: Verify typecheck sees the new model**

```bash
pnpm --filter @orbix/db build && pnpm --filter @orbix/api typecheck
```

Expected: both pass (`DeviceToken` available on the Prisma client type).

- [ ] **Step 4: Commit**

```bash
git add packages/db/prisma
git commit -m "feat(db): DeviceToken model for per-device bearer tokens"
```

---

### Task 2: Core pairing/token helpers

**Files:**
- Create: `packages/core/src/auth/device-token.ts`
- Create: `packages/core/src/auth/device-token.test.ts`
- Modify: `packages/core/src/index.ts` (add export line next to the existing `./auth/session` export)

**Interfaces:**
- Produces (all exported from `@orbix/core`):
  - `DEVICE_TOKEN_PREFIX = "orb_"`
  - `generateDeviceToken(): { token: string; tokenHash: string }` — token is `orb_` + 43-char base64url; hash is sha256 hex of the full token string.
  - `hashDeviceToken(token: string): string` — sha256 hex.
  - `generatePairingCode(): string` — 6 chars from `PAIRING_CODE_ALPHABET` (no `0/O/1/I`), crypto-random.
  - `PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"`
  - `PAIRING_TTL_MS = 10 * 60 * 1000`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/auth/device-token.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  generateDeviceToken,
  hashDeviceToken,
  generatePairingCode,
  DEVICE_TOKEN_PREFIX,
  PAIRING_CODE_ALPHABET,
  PAIRING_TTL_MS,
} from "./device-token";

describe("generateDeviceToken", () => {
  it("produces an orb_-prefixed token whose stored hash matches hashDeviceToken", () => {
    const { token, tokenHash } = generateDeviceToken();
    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(DEVICE_TOKEN_PREFIX.length + 43);
    expect(tokenHash).toBe(hashDeviceToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces unique tokens", () => {
    const a = generateDeviceToken();
    const b = generateDeviceToken();
    expect(a.token).not.toBe(b.token);
  });
});

describe("hashDeviceToken", () => {
  it("is deterministic", () => {
    expect(hashDeviceToken("orb_x")).toBe(hashDeviceToken("orb_x"));
  });
});

describe("generatePairingCode", () => {
  it("emits 6 chars from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(6);
      for (const ch of code) expect(PAIRING_CODE_ALPHABET).toContain(ch);
    }
  });
});

describe("PAIRING_TTL_MS", () => {
  it("is 10 minutes", () => {
    expect(PAIRING_TTL_MS).toBe(600_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @orbix/core exec vitest run src/auth/device-token.test.ts
```

Expected: FAIL — cannot resolve `./device-token`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/auth/device-token.ts`:

```ts
import { createHash, randomBytes, randomInt } from "node:crypto";

/** Raw-token prefix — makes leaked tokens grep-able and self-identifying. */
export const DEVICE_TOKEN_PREFIX = "orb_";

/** Unambiguous pairing-code alphabet: no 0/O or 1/I look-alikes. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Pairing codes and poll tokens expire after 10 minutes. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** sha256 hex digest of a raw device token (the only form ever persisted). */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Generates a long-lived device bearer token. The raw token is shown to the
 * client exactly once (pairing redemption); the caller persists only tokenHash.
 */
export function generateDeviceToken(): { token: string; tokenHash: string } {
  const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, tokenHash: hashDeviceToken(token) };
}

/** 6-char human-typeable pairing code (crypto-random, unambiguous alphabet). */
export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}
```

Add to `packages/core/src/index.ts`, next to the existing `export * from "./auth/session";` line:

```ts
export * from "./auth/device-token";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @orbix/core exec vitest run src/auth/device-token.test.ts
```

Expected: PASS (all 5 tests).

- [ ] **Step 5: Lint + typecheck the package, then commit**

```bash
pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck
git add packages/core/src/auth/device-token.ts packages/core/src/auth/device-token.test.ts packages/core/src/index.ts
git commit -m "feat(core): device-token + pairing-code helpers"
```

---

### Task 3: In-memory pairing store

**Files:**
- Create: `apps/api/src/lib/pairing.ts`
- Create: `apps/api/src/lib/pairing.test.ts`

**Interfaces:**
- Consumes: `generatePairingCode`, `generateDeviceToken` (not here — token creation happens in the route; the store is DB-free), `PAIRING_TTL_MS` from `@orbix/core`.
- Produces: `class PairingStore` (constructor `new PairingStore(opts?: { now?: () => number })`):
  - `initiate(input: { name: string; platform: string; ip: string }): { code: string; pollToken: string; expiresInSec: number } | "rate_limited"`
  - `lookup(code: string): { name: string; platform: string } | null` — pending, unexpired entries only.
  - `markApproved(code: string, payload: { deviceToken: string; deviceId: string }): boolean`
  - `redeem(pollToken: string): { status: "pending" } | { status: "approved"; deviceToken: string; deviceId: string } | null` — `null` = unknown/expired; approved redemption is single-use (entry deleted).
  - `allowPoll(ip: string): boolean` — poll rate limit (60/min/IP).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/pairing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PairingStore } from "./pairing";

function makeStore(startMs = 1_000_000) {
  let nowMs = startMs;
  const store = new PairingStore({ now: () => nowMs });
  return { store, advance: (ms: number) => { nowMs += ms; } };
}

const input = { name: "Living Room", platform: "tvos", ip: "192.168.1.50" };

describe("PairingStore", () => {
  it("initiate returns a 6-char code and a poll token; redeem is pending until approved", () => {
    const { store } = makeStore();
    const res = store.initiate(input);
    expect(res).not.toBe("rate_limited");
    if (res === "rate_limited") throw new Error("unreachable");
    expect(res.code).toHaveLength(6);
    expect(res.pollToken.length).toBeGreaterThan(20);
    expect(res.expiresInSec).toBe(600);
    expect(store.redeem(res.pollToken)).toEqual({ status: "pending" });
  });

  it("lookup finds pending entries by code; markApproved + redeem hands out the token once", () => {
    const { store } = makeStore();
    const res = store.initiate(input);
    if (res === "rate_limited") throw new Error("unreachable");
    expect(store.lookup(res.code)).toEqual({ name: "Living Room", platform: "tvos" });
    expect(store.markApproved(res.code, { deviceToken: "orb_x", deviceId: "d1" })).toBe(true);
    // approved entries are no longer approvable/visible via lookup
    expect(store.lookup(res.code)).toBeNull();
    expect(store.redeem(res.pollToken)).toEqual({ status: "approved", deviceToken: "orb_x", deviceId: "d1" });
    // single-use: second redeem finds nothing
    expect(store.redeem(res.pollToken)).toBeNull();
  });

  it("expires entries after the TTL", () => {
    const { store, advance } = makeStore();
    const res = store.initiate(input);
    if (res === "rate_limited") throw new Error("unreachable");
    advance(10 * 60 * 1000 + 1);
    expect(store.lookup(res.code)).toBeNull();
    expect(store.redeem(res.pollToken)).toBeNull();
    expect(store.markApproved(res.code, { deviceToken: "t", deviceId: "d" })).toBe(false);
  });

  it("rate-limits initiate to 5 per minute per IP and recovers after the window", () => {
    const { store, advance } = makeStore();
    for (let i = 0; i < 5; i++) expect(store.initiate(input)).not.toBe("rate_limited");
    expect(store.initiate(input)).toBe("rate_limited");
    expect(store.initiate({ ...input, ip: "192.168.1.51" })).not.toBe("rate_limited");
    advance(60_001);
    expect(store.initiate(input)).not.toBe("rate_limited");
  });

  it("rate-limits polling to 60 per minute per IP", () => {
    const { store, advance } = makeStore();
    for (let i = 0; i < 60; i++) expect(store.allowPoll("ip1")).toBe(true);
    expect(store.allowPoll("ip1")).toBe(false);
    expect(store.allowPoll("ip2")).toBe(true);
    advance(60_001);
    expect(store.allowPoll("ip1")).toBe(true);
  });

  it("markApproved on an unknown code returns false", () => {
    const { store } = makeStore();
    expect(store.markApproved("XXXXXX", { deviceToken: "t", deviceId: "d" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @orbix/api exec vitest run src/lib/pairing.test.ts
```

Expected: FAIL — cannot resolve `./pairing`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/lib/pairing.ts`:

```ts
import { randomBytes } from "node:crypto";
import { generatePairingCode, PAIRING_TTL_MS } from "@orbix/core";

interface PendingEntry {
  code: string;
  pollToken: string;
  name: string;
  platform: string;
  createdAtMs: number;
  approved: { deviceToken: string; deviceId: string } | null;
}

const INITIATE_LIMIT_PER_MIN = 5;
const POLL_LIMIT_PER_MIN = 60;
const WINDOW_MS = 60_000;
const MAX_PENDING = 50;

/**
 * In-memory pairing exchange: a TV calls initiate() and displays the code, a
 * signed-in web user approves it, the TV's poll redeems the device token once.
 * Single-node by design (pairing is ephemeral); entries expire after
 * PAIRING_TTL_MS. Includes small per-IP rate limits since initiate/poll are
 * the only unauthenticated brute-forceable endpoints.
 */
export class PairingStore {
  private entries = new Map<string, PendingEntry>(); // keyed by code
  private byPollToken = new Map<string, string>(); // pollToken -> code
  private hits = new Map<string, { windowStartMs: number; count: number }>();
  private now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  private allow(bucket: string, limit: number): boolean {
    const nowMs = this.now();
    const hit = this.hits.get(bucket);
    if (!hit || nowMs - hit.windowStartMs > WINDOW_MS) {
      this.hits.set(bucket, { windowStartMs: nowMs, count: 1 });
      return true;
    }
    hit.count += 1;
    return hit.count <= limit;
  }

  private sweep(): void {
    const nowMs = this.now();
    for (const [code, e] of this.entries) {
      if (nowMs - e.createdAtMs > PAIRING_TTL_MS) {
        this.byPollToken.delete(e.pollToken);
        this.entries.delete(code);
      }
    }
  }

  initiate(input: { name: string; platform: string; ip: string }):
    | { code: string; pollToken: string; expiresInSec: number }
    | "rate_limited" {
    if (!this.allow(`i:${input.ip}`, INITIATE_LIMIT_PER_MIN)) return "rate_limited";
    this.sweep();
    if (this.entries.size >= MAX_PENDING) return "rate_limited";

    // Regenerate on the (astronomically unlikely) code collision.
    let code = generatePairingCode();
    while (this.entries.has(code)) code = generatePairingCode();

    const pollToken = randomBytes(32).toString("base64url");
    this.entries.set(code, {
      code,
      pollToken,
      name: input.name,
      platform: input.platform,
      createdAtMs: this.now(),
      approved: null,
    });
    this.byPollToken.set(pollToken, code);
    return { code, pollToken, expiresInSec: PAIRING_TTL_MS / 1000 };
  }

  /** Pending (unapproved, unexpired) entry metadata for the approval UI. */
  lookup(code: string): { name: string; platform: string } | null {
    this.sweep();
    const e = this.entries.get(code);
    if (!e || e.approved) return null;
    return { name: e.name, platform: e.platform };
  }

  markApproved(code: string, payload: { deviceToken: string; deviceId: string }): boolean {
    this.sweep();
    const e = this.entries.get(code);
    if (!e || e.approved) return false;
    e.approved = payload;
    return true;
  }

  /** null = unknown/expired; approved redemption deletes the entry (single-use). */
  redeem(pollToken: string):
    | { status: "pending" }
    | { status: "approved"; deviceToken: string; deviceId: string }
    | null {
    this.sweep();
    const code = this.byPollToken.get(pollToken);
    if (!code) return null;
    const e = this.entries.get(code);
    if (!e) return null;
    if (!e.approved) return { status: "pending" };
    this.entries.delete(code);
    this.byPollToken.delete(pollToken);
    return { status: "approved", ...e.approved };
  }

  allowPoll(ip: string): boolean {
    return this.allow(`p:${ip}`, POLL_LIMIT_PER_MIN);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @orbix/api exec vitest run src/lib/pairing.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck
git add apps/api/src/lib/pairing.ts apps/api/src/lib/pairing.test.ts
git commit -m "feat(api): in-memory pairing store with TTL and per-IP rate limits"
```

---

### Task 4: Bearer-token path in the session plugin

**Files:**
- Create: `apps/api/src/lib/device-auth.ts`
- Modify: `apps/api/src/plugins/session.ts`
- Create: `apps/api/src/plugins/session.test.ts`

**Interfaces:**
- Consumes: `hashDeviceToken` from `@orbix/core`; `prisma.deviceToken` (Task 1); `prisma.account`.
- Produces:
  - `req.deviceId: string | null` (new request decoration, default `null`).
  - `resolveDeviceToken(app, rawToken): Promise<{ deviceId: string; accountId: string } | null>` in `lib/device-auth.ts` — shared by this plugin and Task 7's query-param path. Rejects revoked tokens; resolves `accountId` to the single admin account; touches `lastSeenAt` (fire-and-forget, throttled to ≥60s).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/plugins/session.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import { hashDeviceToken } from "@orbix/core";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const RAW = "orb_test-token";
const HASH = hashDeviceToken(RAW);

function stubDevice(app: unknown, overrides: Record<string, unknown> = {}) {
  const device = {
    id: "dev1", tokenHash: HASH, name: "Living Room", platform: "tvos",
    activeProfileId: null, lastSeenAt: new Date(), createdAt: new Date(), revokedAt: null,
    ...overrides,
  };
  (app as any).prisma.deviceToken = {
    findUnique: async ({ where }: any) => (where.tokenHash === HASH ? device : null),
    update: async () => device,
  };
  (app as any).prisma.account = {
    findFirst: async () => ({ id: "acct1" }),
    findUnique: async () => ({ isAdmin: true }),
  };
}

describe("session plugin bearer path", () => {
  it("authenticates a valid bearer token (GET /api/auth/me)", async () => {
    const app = await buildApp(env);
    stubDevice(app);
    const res = await app.inject({
      method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${RAW}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accountId).toBe("acct1");
    await app.close();
  });

  it("rejects a revoked token", async () => {
    const app = await buildApp(env);
    stubDevice(app, { revokedAt: new Date() });
    const res = await app.inject({
      method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${RAW}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an unknown token", async () => {
    const app = await buildApp(env);
    stubDevice(app);
    const res = await app.inject({
      method: "GET", url: "/api/auth/me", headers: { authorization: "Bearer orb_wrong" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("cookie sessions still work unchanged", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }) };
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().accountId).toBe("a1");
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @orbix/api exec vitest run src/plugins/session.test.ts
```

Expected: the two bearer-accept tests FAIL with 401 (no bearer path yet); revoked/unknown/cookie tests may already pass.

- [ ] **Step 3: Implement `resolveDeviceToken` and wire the plugin**

Create `apps/api/src/lib/device-auth.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { hashDeviceToken } from "@orbix/core";

const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * Resolves a raw device bearer token to its device + the (single) admin
 * account. Returns null for unknown or revoked tokens. Touches lastSeenAt at
 * most once per minute, fire-and-forget — liveness metadata must never fail
 * or slow a request.
 */
export async function resolveDeviceToken(
  app: FastifyInstance,
  rawToken: string,
): Promise<{ deviceId: string; accountId: string } | null> {
  const device = await app.prisma.deviceToken.findUnique({
    where: { tokenHash: hashDeviceToken(rawToken) },
    select: { id: true, revokedAt: true, lastSeenAt: true },
  });
  if (!device || device.revokedAt) return null;

  // Single-household: every device belongs to the sole (admin) account.
  const account = await app.prisma.account.findFirst({ select: { id: true } });
  if (!account) return null;

  if (Date.now() - device.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    void app.prisma.deviceToken
      .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
      .catch(() => {});
  }

  return { deviceId: device.id, accountId: account.id };
}
```

Replace `apps/api/src/plugins/session.ts` with:

```ts
import fp from "fastify-plugin";
import { isSessionValid } from "@orbix/core";
import { resolveDeviceToken } from "../lib/device-auth";

export default fp(async (app) => {
  // Resolves the current account from either a device bearer token
  // (Authorization: Bearer orb_...) or the "orbix_session" cookie.
  app.decorateRequest("accountId", null);
  app.decorateRequest("deviceId", null);
  app.addHook("preHandler", async (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      try {
        const resolved = await resolveDeviceToken(app, auth.slice("Bearer ".length));
        if (resolved) {
          req.accountId = resolved.accountId;
          req.deviceId = resolved.deviceId;
        }
      } catch (err) {
        req.log.error({ err }, "device token lookup failed");
      }
      return; // bearer present = device semantics; never fall back to cookies
    }

    const sid = req.cookies["orbix_session"];
    if (!sid) return;
    try {
      const session = await app.prisma.session.findUnique({ where: { id: sid } });
      if (session && isSessionValid(session)) {
        req.accountId = session.accountId;
      }
    } catch (err) {
      req.log.error({ err }, "session lookup failed");
    }
  });
});

declare module "fastify" {
  interface FastifyRequest { accountId: string | null; deviceId: string | null; }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @orbix/api exec vitest run src/plugins/session.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Run the whole api suite (guard against regressions), lint, commit**

```bash
pnpm --filter @orbix/api test && pnpm --filter @orbix/api lint
git add apps/api/src/lib/device-auth.ts apps/api/src/plugins/session.ts apps/api/src/plugins/session.test.ts
git commit -m "feat(api): bearer device-token auth path in session plugin"
```

---

### Task 5: Pairing + devices routes

**Files:**
- Create: `apps/api/src/routes/devices.ts`
- Create: `apps/api/src/routes/devices.test.ts`
- Modify: `apps/api/src/app.ts` (import + register after `profilesRoute`)

**Interfaces:**
- Consumes: `PairingStore` (Task 3), `generateDeviceToken` (Task 2), `requireAuth`/`requireAdmin` (`lib/auth.ts`), `requireNonKids` (`lib/catalog-filter.ts`), `prisma.deviceToken`.
- Produces endpoints (all under `/api`):
  - `POST /api/pair/initiate` (public) body `{name, platform}` → `{code, pollToken, expiresInSec}` | 429 `{error:"rate_limited"}` | 400 `{error:"invalid"}`
  - `GET /api/pair/poll?token=` (public) → `{status:"pending"}` | `{status:"approved", deviceToken, deviceId}` | 404 `{error:"unknown_or_expired"}` | 429
  - `POST /api/pair/approve` (session + non-kids) body `{code}` → `{ok:true, name, platform}` | 404 `{error:"unknown_or_expired"}`
  - `GET /api/pair/pending/:code` (session + non-kids) → `{name, platform}` | 404 — lets the web UI confirm what it's approving.
  - `GET /api/devices` (admin) → `{devices:[{id,name,platform,lastSeenAt,createdAt,revokedAt,activeProfileId}]}`
  - `PATCH /api/devices/:id` (admin) body `{name}` → `{ok:true}` | 404
  - `POST /api/devices/:id/revoke` (admin) → `{ok:true}` | 404

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/devices.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

/** Authenticated-session stubs shared by the approval/admin tests. */
function stubSession(app: unknown) {
  (app as any).prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }), findFirst: async () => ({ id: "a1" }) };
  (app as any).prisma.profile = { findUnique: async () => null }; // no active profile → not kids
}

describe("pairing flow", () => {
  it("initiate → approve → poll redeems a device token exactly once", async () => {
    const app = await buildApp(env);
    stubSession(app);
    const created: Record<string, unknown>[] = [];
    (app as any).prisma.deviceToken = {
      create: async ({ data }: any) => { created.push(data); return { id: "dev1", ...data }; },
    };

    const init = await app.inject({
      method: "POST", url: "/api/pair/initiate",
      payload: { name: "Living Room", platform: "tvos" },
    });
    expect(init.statusCode).toBe(200);
    const { code, pollToken } = init.json();
    expect(code).toHaveLength(6);

    // still pending before approval
    const pending = await app.inject({ method: "GET", url: `/api/pair/poll?token=${pollToken}` });
    expect(pending.json()).toEqual({ status: "pending" });

    // the approval UI can inspect the pending request
    const info = await app.inject({
      method: "GET", url: `/api/pair/pending/${code}`, cookies: { orbix_session: "s1" },
    });
    expect(info.json()).toEqual({ name: "Living Room", platform: "tvos" });

    const approve = await app.inject({
      method: "POST", url: "/api/pair/approve",
      cookies: { orbix_session: "s1" }, payload: { code },
    });
    expect(approve.statusCode).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe("Living Room");

    const redeemed = await app.inject({ method: "GET", url: `/api/pair/poll?token=${pollToken}` });
    expect(redeemed.json().status).toBe("approved");
    expect(redeemed.json().deviceToken).toMatch(/^orb_/);
    expect(redeemed.json().deviceId).toBe("dev1");

    // single-use redemption
    const again = await app.inject({ method: "GET", url: `/api/pair/poll?token=${pollToken}` });
    expect(again.statusCode).toBe(404);
    await app.close();
  });

  it("rejects invalid initiate bodies and unauthenticated approval", async () => {
    const app = await buildApp(env);
    stubSession(app);
    const bad = await app.inject({ method: "POST", url: "/api/pair/initiate", payload: { name: "", platform: "tvos" } });
    expect(bad.statusCode).toBe(400);
    const noAuth = await app.inject({ method: "POST", url: "/api/pair/approve", payload: { code: "ABCDEF" } });
    expect(noAuth.statusCode).toBe(401);
    const unknown = await app.inject({
      method: "POST", url: "/api/pair/approve", cookies: { orbix_session: "s1" }, payload: { code: "ABCDEF" },
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });
});

describe("devices admin", () => {
  it("lists, renames, and revokes devices (admin only)", async () => {
    const app = await buildApp(env);
    stubSession(app);
    const dev = {
      id: "dev1", name: "Living Room", platform: "tvos", activeProfileId: null,
      lastSeenAt: new Date(), createdAt: new Date(), revokedAt: null,
    };
    const updates: Record<string, unknown>[] = [];
    (app as any).prisma.deviceToken = {
      findMany: async () => [dev],
      update: async ({ where, data }: any) => {
        if (where.id !== "dev1") { const e: any = new Error("nf"); e.code = "P2025"; throw e; }
        updates.push(data); return { ...dev, ...data };
      },
    };

    const list = await app.inject({ method: "GET", url: "/api/devices", cookies: { orbix_session: "s1" } });
    expect(list.statusCode).toBe(200);
    expect(list.json().devices).toHaveLength(1);
    expect(list.json().devices[0]).not.toHaveProperty("tokenHash");

    const rename = await app.inject({
      method: "PATCH", url: "/api/devices/dev1", cookies: { orbix_session: "s1" }, payload: { name: "Bedroom" },
    });
    expect(rename.statusCode).toBe(200);
    expect(updates[0]).toEqual({ name: "Bedroom" });

    const revoke = await app.inject({
      method: "POST", url: "/api/devices/dev1/revoke", cookies: { orbix_session: "s1" },
    });
    expect(revoke.statusCode).toBe(200);
    expect(updates[1]).toHaveProperty("revokedAt");

    const missing = await app.inject({
      method: "PATCH", url: "/api/devices/nope", cookies: { orbix_session: "s1" }, payload: { name: "x" },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("401s unauthenticated device listing", async () => {
    const app = await buildApp(env);
    stubSession(app);
    const res = await app.inject({ method: "GET", url: "/api/devices" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/devices.test.ts
```

Expected: FAIL — 404s on every route (not registered).

- [ ] **Step 3: Implement the routes and register them**

Create `apps/api/src/routes/devices.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { generateDeviceToken, hashDeviceToken } from "@orbix/core";
import { Prisma } from "@orbix/db";
import { requireAuth, requireAdmin } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import { PairingStore } from "../lib/pairing";

const PLATFORMS = new Set(["tvos", "ios", "android", "web", "other"]);

function validName(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 64;
}

export default async function devicesRoute(app: FastifyInstance) {
  const store = new PairingStore();

  // ── Pairing (the TV side is unauthenticated by nature) ──────────────────

  app.post<{ Body: { name?: unknown; platform?: unknown } }>("/pair/initiate", async (req, reply) => {
    const name = req.body?.name;
    const platform = req.body?.platform;
    if (!validName(name) || typeof platform !== "string" || !PLATFORMS.has(platform)) {
      return reply.code(400).send({ error: "invalid" });
    }
    const res = store.initiate({ name: name.trim(), platform, ip: req.ip });
    if (res === "rate_limited") return reply.code(429).send({ error: "rate_limited" });
    return res;
  });

  app.get<{ Querystring: { token?: string } }>("/pair/poll", async (req, reply) => {
    if (!store.allowPoll(req.ip)) return reply.code(429).send({ error: "rate_limited" });
    const token = req.query.token;
    if (!token) return reply.code(400).send({ error: "invalid" });
    const res = store.redeem(token);
    if (!res) return reply.code(404).send({ error: "unknown_or_expired" });
    return res;
  });

  // ── Approval + registry (web side, signed-in) ────────────────────────────

  app.get<{ Params: { code: string } }>(
    "/pair/pending/:code",
    { preHandler: [requireAuth(app), requireNonKids(app)] },
    async (req, reply) => {
      const info = store.lookup(req.params.code.toUpperCase());
      if (!info) return reply.code(404).send({ error: "unknown_or_expired" });
      return info;
    },
  );

  app.post<{ Body: { code?: unknown } }>(
    "/pair/approve",
    { preHandler: [requireAuth(app), requireNonKids(app)] },
    async (req, reply) => {
      const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
      const info = store.lookup(code);
      if (!info) return reply.code(404).send({ error: "unknown_or_expired" });

      const { token, tokenHash } = generateDeviceToken();
      const device = await app.prisma.deviceToken.create({
        data: { tokenHash, name: info.name, platform: info.platform },
      });
      // markApproved only fails if the entry expired between lookup and now —
      // in that case the device row is orphaned but revocable from the registry.
      store.markApproved(code, { deviceToken: token, deviceId: device.id });
      return { ok: true, name: info.name, platform: info.platform };
    },
  );

  app.get(
    "/devices",
    { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] },
    async () => {
      const devices = await app.prisma.deviceToken.findMany({
        select: {
          id: true, name: true, platform: true, activeProfileId: true,
          lastSeenAt: true, createdAt: true, revokedAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
      return { devices };
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    "/devices/:id",
    { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] },
    async (req, reply) => {
      if (!validName(req.body?.name)) return reply.code(400).send({ error: "invalid" });
      try {
        await app.prisma.deviceToken.update({
          where: { id: req.params.id },
          data: { name: (req.body.name as string).trim() },
        });
        return { ok: true };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
          return reply.code(404).send({ error: "not_found" });
        }
        if ((e as { code?: string }).code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/devices/:id/revoke",
    { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] },
    async (req, reply) => {
      try {
        await app.prisma.deviceToken.update({
          where: { id: req.params.id },
          data: { revokedAt: new Date() },
        });
        return { ok: true };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
          return reply.code(404).send({ error: "not_found" });
        }
        if ((e as { code?: string }).code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    },
  );
}
```

Note the double P2025 check: route tests stub prisma with plain objects whose thrown errors are not `Prisma.PrismaClientKnownRequestError` instances — the duck-typed `code` check keeps both real and stubbed errors mapped to 404 (matches how stubs behave elsewhere; if the existing `profiles.test.ts` pattern disagrees, prefer the repo's established idiom).

In `apps/api/src/app.ts`, add the import next to the other route imports:

```ts
import devicesRoute from "./routes/devices";
```

and register it directly after `profilesRoute`:

```ts
  await app.register(devicesRoute, { prefix: "/api" });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/devices.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Full api suite, lint, commit**

```bash
pnpm --filter @orbix/api test && pnpm --filter @orbix/api lint
git add apps/api/src/routes/devices.ts apps/api/src/routes/devices.test.ts apps/api/src/app.ts
git commit -m "feat(api): pairing endpoints + devices registry"
```

---

### Task 6: Device-scoped active profile

**Files:**
- Modify: `apps/api/src/lib/catalog-filter.ts` (function `activeProfile`, lines 33-43; add `activeProfileId`)
- Modify: `apps/api/src/routes/profiles.ts` (select route, lines 78-88)
- Modify: `apps/api/src/routes/playstate.ts` (direct cookie reads at lines 12, 80, 114)
- Modify: `apps/api/src/routes/discovery.ts` (direct cookie read at line 74)
- Modify: `apps/api/src/routes/series.ts` (direct cookie read at line 23)
- Create: `apps/api/src/routes/profiles.device.test.ts`

**Interfaces:**
- Consumes: `req.deviceId` (Task 4), `prisma.deviceToken`.
- Produces:
  - `activeProfile(app, req)` resolves, in order: device's `activeProfileId` when `req.deviceId` is set; else the `orbix_profile` cookie.
  - NEW export `activeProfileId(app, req): Promise<string | null>` in `catalog-filter.ts` — same resolution order, id only (no profile row fetch). The five direct `req.cookies["orbix_profile"]` reads in playstate/discovery/series are replaced with this helper so progress reporting, continue-watching, home rows, and episode-progress hydration all work for bearer devices.
  - `POST /api/profiles/:id/select` with bearer auth persists `deviceToken.activeProfileId` instead of setting a cookie.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/profiles.device.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import { hashDeviceToken } from "@orbix/core";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const RAW = "orb_device-token";
const HASH = hashDeviceToken(RAW);
const bearer = { authorization: `Bearer ${RAW}` };

const PROFILES: Record<string, unknown> = {
  p_kid: { id: "p_kid", name: "Kid", avatar: null, kind: "kids", maturityCap: 1, language: "en", pinHash: null },
  p_std: { id: "p_std", name: "Adult", avatar: null, kind: "standard", maturityCap: null, language: "en", pinHash: null },
};

function stubs(app: unknown, device: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = [];
  (app as any).prisma.deviceToken = {
    findUnique: async ({ where }: any) =>
      where.tokenHash === HASH || where.id === device.id ? device : null,
    update: async ({ data }: any) => { updates.push(data); Object.assign(device, data); return device; },
  };
  (app as any).prisma.account = { findFirst: async () => ({ id: "a1" }), findUnique: async () => ({ isAdmin: true }) };
  (app as any).prisma.profile = {
    findUnique: async ({ where }: any) => PROFILES[where.id] ?? null,
  };
  return updates;
}

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: "dev1", tokenHash: HASH, name: "TV", platform: "tvos", activeProfileId: null,
    lastSeenAt: new Date(), createdAt: new Date(), revokedAt: null, ...overrides,
  };
}

describe("device-scoped profile selection", () => {
  it("select via bearer persists activeProfileId on the device (no cookie)", async () => {
    const app = await buildApp(env);
    const updates = stubs(app, makeDevice());
    const res = await app.inject({
      method: "POST", url: "/api/profiles/p_std/select", headers: bearer, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profileId: "p_std" });
    expect(updates.some((u) => u.activeProfileId === "p_std")).toBe(true);
    expect(res.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("GET /api/me/profile resolves the device's active profile", async () => {
    const app = await buildApp(env);
    stubs(app, makeDevice({ activeProfileId: "p_std" }));
    const res = await app.inject({ method: "GET", url: "/api/me/profile", headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("p_std");
    await app.close();
  });

  it("a kids device profile is blocked from management routes by requireNonKids", async () => {
    const app = await buildApp(env);
    stubs(app, makeDevice({ activeProfileId: "p_kid" }));
    const res = await app.inject({ method: "GET", url: "/api/devices", headers: bearer });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not_allowed_for_kids" });
    await app.close();
  });

  it("cookie-based selection still sets the cookie for browser sessions", async () => {
    const app = await buildApp(env);
    stubs(app, makeDevice());
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    const res = await app.inject({
      method: "POST", url: "/api/profiles/p_std/select", cookies: { orbix_session: "s1" }, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain("orbix_profile=p_std");
    await app.close();
  });

  it("progress PUT/GET works via bearer using the device's active profile", async () => {
    const app = await buildApp(env);
    stubs(app, makeDevice({ activeProfileId: "p_std" }));
    (app as any).prisma.mediaItem = {
      findUnique: async () => ({ rating: "PG-13" }),
    };
    const upserts: Record<string, unknown>[] = [];
    (app as any).prisma.playbackState = {
      upsert: async ({ where, create }: any) => { upserts.push({ where, create }); return create; },
      findUnique: async () => ({ positionSec: 42, durationSec: 100, finished: false }),
    };
    (app as any).prisma.playEvent = {
      findFirst: async () => ({ id: "recent" }), // suppress event append
      create: async () => ({}),
    };

    const put = await app.inject({
      method: "PUT", url: "/api/items/m1/progress", headers: bearer,
      payload: { positionSec: 42, durationSec: 100 },
    });
    expect(put.statusCode).toBe(200);
    expect((upserts[0].where as any).profileId_mediaItemId_episodeId.profileId).toBe("p_std");

    const get = await app.inject({ method: "GET", url: "/api/items/m1/progress", headers: bearer });
    expect(get.statusCode).toBe(200);
    expect(get.json().positionSec).toBe(42);
    await app.close();
  });

  it("progress PUT still 400s when a device has no active profile", async () => {
    const app = await buildApp(env);
    stubs(app, makeDevice({ activeProfileId: null }));
    const res = await app.inject({
      method: "PUT", url: "/api/items/m1/progress", headers: bearer,
      payload: { positionSec: 1, durationSec: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no_profile" });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/profiles.device.test.ts
```

Expected: first three tests FAIL (select sets a cookie and doesn't touch the device; `/me/profile` returns null profile; `/devices` responds 200 because the kids profile isn't seen).

- [ ] **Step 3: Implement the device paths**

In `apps/api/src/lib/catalog-filter.ts`, replace the `activeProfile` function (keep its doc comment style):

```ts
/**
 * Loads the active profile for this request. Device (bearer) requests resolve
 * the profile stored on the DeviceToken row; browser requests resolve the
 * orbix_profile cookie. Returns null when nothing is selected or the profile
 * no longer exists.
 */
export async function activeProfile(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ id: string; name: string; avatar: string | null; kind: string; maturityCap: number | null; language: string } | null> {
  let profileId: string | null | undefined;
  if (req.deviceId) {
    const device = await app.prisma.deviceToken.findUnique({
      where: { id: req.deviceId },
      select: { activeProfileId: true },
    });
    profileId = device?.activeProfileId;
  } else {
    profileId = req.cookies["orbix_profile"];
  }
  if (!profileId) return null;
  return app.prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true, name: true, avatar: true, kind: true, maturityCap: true, language: true },
  });
}
```

Also add to `apps/api/src/lib/catalog-filter.ts` (below `activeProfile`):

```ts
/**
 * Resolves just the active profile id (device row for bearer requests, cookie
 * for browser requests) without fetching the profile. Routes that key rows by
 * profile id (playback state, play events, home rows) use this instead of
 * reading the cookie directly, so device clients work identically.
 */
export async function activeProfileId(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<string | null> {
  if (req.deviceId) {
    const device = await app.prisma.deviceToken.findUnique({
      where: { id: req.deviceId },
      select: { activeProfileId: true },
    });
    return device?.activeProfileId ?? null;
  }
  return req.cookies["orbix_profile"] ?? null;
}
```

And refactor `activeProfile` to reuse it:

```ts
export async function activeProfile(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ id: string; name: string; avatar: string | null; kind: string; maturityCap: number | null; language: string } | null> {
  const profileId = await activeProfileId(app, req);
  if (!profileId) return null;
  return app.prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true, name: true, avatar: true, kind: true, maturityCap: true, language: true },
  });
}
```

Then replace every direct cookie read with the helper (add `activeProfileId` to each file's existing `../lib/catalog-filter` import):
- `apps/api/src/routes/playstate.ts` lines 12, 80, 114: `const profileId = req.cookies["orbix_profile"];` → `const profileId = await activeProfileId(app, req);`
- `apps/api/src/routes/discovery.ts` line 74: same replacement.
- `apps/api/src/routes/series.ts` line 23: same replacement.

(The surrounding `if (!profileId) …` guards stay exactly as they are.)

In `apps/api/src/routes/profiles.ts`, replace the select handler body (lines 78-88) with:

```ts
  app.post<{ Params: { id: string }; Body: { pin?: string } }>("/profiles/:id/select", { preHandler: requireAuth(app) }, async (req, reply) => {
    const p = await app.prisma.profile.findUnique({ where: { id: req.params.id } });
    if (!p) return reply.code(404).send({ error: "not_found" });
    if (p.pinHash) {
      if (!req.body?.pin || !(await verifyPin(p.pinHash, req.body.pin))) {
        return reply.code(403).send({ error: "pin_required" });
      }
    }
    if (req.deviceId) {
      // Device clients have no cookie jar: the active profile lives on the row.
      await app.prisma.deviceToken.update({
        where: { id: req.deviceId },
        data: { activeProfileId: p.id },
      });
      return { profileId: p.id };
    }
    reply.setCookie("orbix_profile", p.id, { httpOnly: true, sameSite: "lax", path: "/" });
    return { profileId: p.id };
  });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/profiles.device.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Full api suite (catalog-filter is widely consumed — watch for regressions), lint, commit**

```bash
pnpm --filter @orbix/api test && pnpm --filter @orbix/api lint
git add apps/api/src/lib/catalog-filter.ts apps/api/src/routes/profiles.ts apps/api/src/routes/profiles.device.test.ts
git commit -m "feat(api): device-scoped active profile (bearer clients)"
```

---

### Task 7: `?token=` query auth on stream + subtitle routes

**Files:**
- Modify: `apps/api/src/lib/device-auth.ts` (add `queryTokenAuth`)
- Modify: `apps/api/src/routes/stream.ts` (all six routes' preHandlers)
- Modify: `apps/api/src/routes/subtitles.ts` (both routes' preHandlers)
- Create: `apps/api/src/routes/stream.token.test.ts`

**Interfaces:**
- Consumes: `resolveDeviceToken` (Task 4).
- Produces: `queryTokenAuth(app)` — a preHandler that, when `req.accountId` is still null and `?token=` is present, resolves it as a device token and fills `req.accountId`/`req.deviceId`. Placed BEFORE `requireAuth(app)` in each route's preHandler array: `{ preHandler: [queryTokenAuth(app), requireAuth(app)] }`. AVPlayer's playlist/segment/subtitle fetches (which carry no cookies and no headers) authenticate this way; SP1c's playlist generator will embed the same `?token=` in URI lines.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/stream.token.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/stream.token.test.ts
```

Expected: the `?token=` tests FAIL with 401 (query token not honored); the no-credential 401 test passes.

- [ ] **Step 3: Implement `queryTokenAuth` and wire it in**

Append to `apps/api/src/lib/device-auth.ts`:

```ts
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * preHandler for streaming/subtitle routes: AVPlayer fetches playlists,
 * segments, and subtitle renditions with no cookies and no headers, so these
 * routes also accept the device token as a ?token= query param (embedded in
 * generated playlist URIs). Runs before requireAuth in the preHandler array;
 * does nothing when the request is already authenticated.
 */
export function queryTokenAuth(app: FastifyInstance) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (req.accountId) return;
    const token = (req.query as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token.length === 0) return;
    try {
      const resolved = await resolveDeviceToken(app, token);
      if (resolved) {
        req.accountId = resolved.accountId;
        req.deviceId = resolved.deviceId;
      }
    } catch (err) {
      req.log.error({ err }, "query token lookup failed");
    }
  };
}
```

(Merge the `FastifyReply`/`FastifyRequest` imports with the existing `FastifyInstance` type import at the top of the file: `import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";`.)

In `apps/api/src/routes/stream.ts`:
- Add to imports: `import { queryTokenAuth } from "../lib/device-auth";`
- Change every one of the six routes' options from `{ preHandler: requireAuth(app) }` to `{ preHandler: [queryTokenAuth(app), requireAuth(app)] }` (routes: `/play/:fileId/decision`, `/direct`, `/master.m3u8`, `/index.m3u8`, `/init.mp4`, `/:seg`).

In `apps/api/src/routes/subtitles.ts`: same import; change both routes (`/play/:fileId/subs`, `/play/:fileId/subs/:index`) to `{ preHandler: [queryTokenAuth(app), requireAuth(app)] }`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/stream.token.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Full api suite, lint, commit**

```bash
pnpm --filter @orbix/api test && pnpm --filter @orbix/api lint
git add apps/api/src/lib/device-auth.ts apps/api/src/routes/stream.ts apps/api/src/routes/subtitles.ts apps/api/src/routes/stream.token.test.ts
git commit -m "feat(api): query-param device-token auth on stream/subtitle routes"
```

---

### Task 8: Web Devices tab (registry + pairing approval)

**Files:**
- Create: `apps/web/src/pages/account/AccountDevicesPage.tsx`
- Modify: `apps/web/src/pages/account/AccountLayout.tsx` (add the tab, admin-gated)
- Modify: `apps/web/src/router.tsx` (add the child route under `/account`)
- Modify: `apps/web/src/locales/en/account.json` (+ mirror keys in `de`, `es`, `fr`, `pt`, `ru` account.json files)

**Interfaces:**
- Consumes: `GET /api/devices`, `PATCH /api/devices/:id`, `POST /api/devices/:id/revoke`, `GET /api/pair/pending/:code`, `POST /api/pair/approve` (Task 5) via `apiJson` from `@/lib/api`; TanStack Query (`useQuery`/`useMutation`/`useQueryClient` from `@tanstack/react-query`) and `useTranslation` — the same stack every existing page uses.
- Produces: `/account/devices` page. No other task depends on it.

- [ ] **Step 1: Add locale keys**

In `apps/web/src/locales/en/account.json`, add inside the existing `tabs` object and at the top level:

```jsonc
// inside "tabs": { ... }
    "devices": "Devices"
// top-level additions
  ,"devices": {
    "title": "Paired devices",
    "empty": "No devices paired yet. Start pairing from the TV app.",
    "pairTitle": "Pair a new device",
    "pairHint": "Enter the 6-character code shown on your TV.",
    "pairButton": "Approve",
    "pairApproved": "Device approved — the TV will connect in a moment.",
    "pairUnknown": "Code not found or expired.",
    "lastSeen": "Last seen",
    "revoked": "Revoked",
    "revoke": "Revoke",
    "rename": "Rename",
    "save": "Save"
  }
```

Mirror the same keys into `apps/web/src/locales/{de,es,fr,pt,ru}/account.json` with translated values:
- **ru**: Devices→"Устройства", title→"Сопряжённые устройства", empty→"Пока нет сопряжённых устройств. Начните сопряжение в приложении на ТВ.", pairTitle→"Подключить новое устройство", pairHint→"Введите 6-значный код с экрана телевизора.", pairButton→"Подтвердить", pairApproved→"Устройство подтверждено — ТВ подключится через мгновение.", pairUnknown→"Код не найден или истёк.", lastSeen→"Был в сети", revoked→"Отозвано", revoke→"Отозвать", rename→"Переименовать", save→"Сохранить"
- **de**: "Geräte", "Gekoppelte Geräte", "Noch keine Geräte gekoppelt. Starte die Kopplung in der TV-App.", "Neues Gerät koppeln", "Gib den 6-stelligen Code vom Fernseher ein.", "Bestätigen", "Gerät bestätigt — der Fernseher verbindet sich gleich.", "Code nicht gefunden oder abgelaufen.", "Zuletzt gesehen", "Widerrufen", "Widerrufen", "Umbenennen", "Speichern"
- **es**: "Dispositivos", "Dispositivos emparejados", "Aún no hay dispositivos emparejados. Inicia el emparejamiento desde la app del TV.", "Emparejar un dispositivo nuevo", "Introduce el código de 6 caracteres que aparece en tu TV.", "Aprobar", "Dispositivo aprobado — el TV se conectará en un momento.", "Código no encontrado o caducado.", "Última conexión", "Revocado", "Revocar", "Renombrar", "Guardar"
- **fr**: "Appareils", "Appareils associés", "Aucun appareil associé pour l'instant. Lancez l'association depuis l'app TV.", "Associer un nouvel appareil", "Saisissez le code à 6 caractères affiché sur votre TV.", "Approuver", "Appareil approuvé — la TV va se connecter dans un instant.", "Code introuvable ou expiré.", "Vu pour la dernière fois", "Révoqué", "Révoquer", "Renommer", "Enregistrer"
- **pt**: "Dispositivos", "Dispositivos emparelhados", "Ainda não há dispositivos emparelhados. Inicie o emparelhamento no app da TV.", "Emparelhar um novo dispositivo", "Digite o código de 6 caracteres exibido na sua TV.", "Aprovar", "Dispositivo aprovado — a TV vai conectar em instantes.", "Código não encontrado ou expirado.", "Visto por último", "Revogado", "Revogar", "Renomear", "Salvar"

- [ ] **Step 2: Create the page component**

Create `apps/web/src/pages/account/AccountDevicesPage.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiJson, ApiError } from "@/lib/api";

interface Device {
  id: string;
  name: string;
  platform: string;
  activeProfileId: string | null;
  lastSeenAt: string;
  createdAt: string;
  revokedAt: string | null;
}

export default function AccountDevicesPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => apiJson<{ devices: Device[] }>("/devices"),
  });

  const [code, setCode] = useState("");
  const [pairMsg, setPairMsg] = useState<"approved" | "unknown" | null>(null);

  const approve = useMutation({
    mutationFn: (c: string) =>
      apiJson<{ ok: true }>("/pair/approve", { method: "POST", body: JSON.stringify({ code: c }) }),
    onSuccess: () => {
      setPairMsg("approved");
      setCode("");
      void qc.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (e) => {
      setPairMsg(e instanceof ApiError && e.status === 404 ? "unknown" : null);
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => apiJson<{ ok: true }>(`/devices/${id}/revoke`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["devices"] }),
  });

  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      apiJson<{ ok: true }>(`/devices/${v.id}`, { method: "PATCH", body: JSON.stringify({ name: v.name }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["devices"] }),
  });

  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-medium text-[var(--text)]">{t("account:devices.pairTitle")}</h2>
        <p className="mt-1 text-sm text-[var(--text-dim)]">{t("account:devices.pairHint")}</p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim().length === 6) approve.mutate(code.trim().toUpperCase());
          }}
        >
          <input
            value={code}
            onChange={(e) => { setCode(e.target.value.toUpperCase()); setPairMsg(null); }}
            maxLength={6}
            placeholder="ABC123"
            className="w-32 rounded bg-[var(--surface-2)] px-3 py-2 font-mono text-lg tracking-widest text-[var(--text)] outline-none"
            aria-label={t("account:devices.pairHint")}
          />
          <button
            type="submit"
            disabled={code.trim().length !== 6 || approve.isPending}
            className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {t("account:devices.pairButton")}
          </button>
        </form>
        {pairMsg === "approved" && <p className="mt-2 text-sm text-green-500">{t("account:devices.pairApproved")}</p>}
        {pairMsg === "unknown" && <p className="mt-2 text-sm text-red-400">{t("account:devices.pairUnknown")}</p>}
      </section>

      <section>
        <h2 className="text-lg font-medium text-[var(--text)]">{t("account:devices.title")}</h2>
        {devices.data && devices.data.devices.length === 0 && (
          <p className="mt-2 text-sm text-[var(--text-dim)]">{t("account:devices.empty")}</p>
        )}
        <ul className="mt-3 divide-y divide-[var(--surface-2)]">
          {devices.data?.devices.map((d) => (
            <li key={d.id} className="flex items-center gap-4 py-3">
              <div className="min-w-0 flex-1">
                {editing?.id === d.id ? (
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      rename.mutate(editing);
                      setEditing(null);
                    }}
                  >
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                      className="rounded bg-[var(--surface-2)] px-2 py-1 text-sm text-[var(--text)] outline-none"
                    />
                    <button type="submit" className="text-sm text-[var(--accent)]">{t("account:devices.save")}</button>
                  </form>
                ) : (
                  <p className="truncate text-sm text-[var(--text)]">
                    {d.name} <span className="text-[var(--text-dim)]">· {d.platform}</span>
                    {d.revokedAt && (
                      <span className="ml-2 rounded bg-red-950 px-2 py-0.5 text-xs text-red-400">
                        {t("account:devices.revoked")}
                      </span>
                    )}
                  </p>
                )}
                <p className="text-xs text-[var(--text-dim)]">
                  {t("account:devices.lastSeen")}: {fmt.format(new Date(d.lastSeenAt))}
                </p>
              </div>
              {!d.revokedAt && (
                <>
                  <button
                    onClick={() => setEditing({ id: d.id, name: d.name })}
                    className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]"
                  >
                    {t("account:devices.rename")}
                  </button>
                  <button
                    onClick={() => revoke.mutate(d.id)}
                    className="text-sm text-red-400 hover:text-red-300"
                  >
                    {t("account:devices.revoke")}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Wire the tab and route**

In `apps/web/src/pages/account/AccountLayout.tsx`, add after the settings NavLink (line 37), inside the same `isAdmin` gating:

```tsx
        {isAdmin && <NavLink to="/account/devices" className={tab}>{t("account:tabs.devices")}</NavLink>}
```

Also extend the admin-tab deep-link guard (line 25) to cover the new path:

```tsx
  const onAdminTab = pathname.startsWith("/account/library") || pathname.startsWith("/account/settings") || pathname.startsWith("/account/devices");
```

In `apps/web/src/router.tsx`: import the page next to the other account imports (`import AccountDevicesPage from "./pages/account/AccountDevicesPage";`) and add a child route beside the existing `/account` children (mirror how `AccountMenuPage` is declared):

```tsx
          { path: "devices", element: <AccountDevicesPage /> },
```

(If the existing children use absolute paths like `/account/menu`, match that style: `{ path: "/account/devices", element: <AccountDevicesPage /> }`.)

- [ ] **Step 4: Verify typecheck, lint, tests**

```bash
pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test
```

Expected: all pass (no new unit test — this page is exercised by the manual smoke below; the web suite guards against regressions in shared modules).

- [ ] **Step 5: Manual smoke (dev stack), then commit**

With `docker compose up -d` running: open http://localhost:1060 → Account → Devices. In a terminal:

```bash
curl -s -X POST http://localhost:1061/api/pair/initiate -H 'content-type: application/json' -d '{"name":"Test TV","platform":"tvos"}'
```

Enter the returned code in the Devices tab → expect the approved message; then:

```bash
curl -s "http://localhost:1061/api/pair/poll?token=<pollToken>"
```

Expect `{"status":"approved","deviceToken":"orb_...","deviceId":"..."}`, and the device listed in the tab. Verify rename + revoke work, and that a revoked token 401s:

```bash
curl -s -o /dev/null -w '%{http_code}' http://localhost:1061/api/auth/me -H "Authorization: Bearer <deviceToken>"
```

Expected `200` before revoke, `401` after. **Reap any host dev servers you started afterwards** (`pkill -f vite; pkill -f "tsx.*watch src/server.ts"`) per repo rules if you ran outside docker.

```bash
git add apps/web/src/pages/account/AccountDevicesPage.tsx apps/web/src/pages/account/AccountLayout.tsx apps/web/src/router.tsx apps/web/src/locales
git commit -m "feat(web): Devices tab — pairing approval + device registry"
```

---

### Task 9: Full gates + docs

**Files:**
- Modify: `CLAUDE.md` (auth bullet in Architecture section)

- [ ] **Step 1: Run every gate from the repo root**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all four green. Fix anything that fails before proceeding (Turbo cache may hide stale lint results — if in doubt, `pnpm --filter <pkg> lint` the packages you touched).

- [ ] **Step 2: Update CLAUDE.md**

In the Architecture section's auth bullet (currently: "Auth: password account (single-household, single admin) → session cookie; then a profile-selection cookie (`orbix_profile`). Routes guard via the shared helper in `apps/api/src/lib/auth.ts`."), replace with:

```markdown
- Auth: password account (single-household, single admin) → session cookie; then a profile-selection cookie (`orbix_profile`). Native clients instead pair via `/api/pair/*` (code shown on device, approved in web Settings → Devices) and authenticate with per-device bearer tokens (`DeviceToken` model, sha256-hashed at rest; `Authorization: Bearer orb_…`, or `?token=` on `/api/play/*` only, since AVPlayer segment fetches carry no headers). A device's active profile lives on its `DeviceToken.activeProfileId` row, not a cookie. Routes guard via the shared helpers in `apps/api/src/lib/auth.ts` + `apps/api/src/lib/device-auth.ts`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: device bearer-token auth in CLAUDE.md"
```

---

## Self-review notes

- **Spec coverage (§4.1):** model ✓ (Task 1), pairing flow ✓ (Tasks 3+5), rate limiting ✓ (Task 3), bearer in session plugin ✓ (Task 4), query token on `/play/*` only ✓ (Task 7 — subtitles are under `/play/:fileId/subs`, so included by the spec's own path rule), device-scoped profile selection ✓ (Task 6), devices registry + web Settings ✓ (Tasks 5+8). Playlist-URI token embedding is deliberately deferred to SP1c (playlist generation is rewritten there).
- **Known simplification:** `resolveDeviceToken` resolves the single admin account via `findFirst` — correct for the enforced single-account install (DB-level unique index).
- **Type consistency:** `req.deviceId` declared once (Task 4) and consumed in Tasks 6-7; `PairingStore` method names match between Tasks 3 and 5; locale key `account:tabs.devices` matches Layout usage.
