# Floating Top-Nav Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Orbix's left B2B-style sidebar with a floating Netflix-style top navigation, with profile-scoped catalog categories, a full-page search, and a tabbed Account hub that absorbs the admin Manage/Settings pages.

**Architecture:** Bottom-up. A new `ProfileMenuEntry` join table stores each profile's chosen/ordered catalog sections; a pure `resolveProfileMenu` resolver (in `packages/core`) turns sections + entries into an ordered menu (no entries ⇒ all sections). New `/api/me/menu*` routes wire DB → resolver; `/api/auth/me` gains `isAdmin`; admin routes gain a `requireAdmin` guard. The web SPA replaces `Sidebar`/`AppShell` with `TopNav` + `BottomNav`, adds an `/account` nested-route hub (Overview / My Menu / Library / Settings), and reworks `SearchPage`.

**Tech Stack:** pnpm 10.22.0 + Turborepo, Node 22, TypeScript. API: Fastify + Prisma (Postgres + pgvector). Web: Vite + React + React Router v8 + TanStack Query + Tailwind. Tests: Vitest (+ @testing-library/react), Playwright e2e.

## Global Constraints

- Use the repo-local pnpm (`pnpm <cmd>`); never a global pnpm/npm.
- The browser only ever calls relative `/api/...` via `apiFetch`/`apiJson` (`apps/web/src/lib/api.ts`). Never hardcode an API origin.
- `packages/core` stays pure: no DB / network / fs / ffmpeg imports. Adapters are injected; tests use fakes.
- Kids filtering is server-enforced per-item by rating; this feature does **not** add section-level kids filtering (all profile kinds see all sections in the menu, matching today's behavior).
- Run `pnpm lint` (or `pnpm --filter <pkg> lint`) per change, not just typecheck+test — Turbo caches can hide lint-only errors.
- Admin access rule after this change: authenticated **and** `account.isAdmin` **and** active profile not kids.
- Commit after each task. Branch: `menu-update` (already checked out).
- Do not run the e2e suite against the dev DB — its global-setup wipes accounts/profiles. Use a throwaway DB.

---

## File Structure

**Create:**
- `packages/core/src/menu/resolve.ts` — pure `resolveProfileMenu` + types.
- `packages/core/src/menu/resolve.test.ts` — resolver unit tests.
- `apps/api/src/routes/menu.ts` — `GET /me/menu`, `GET /me/menu/config`, `PUT /me/menu`.
- `apps/api/src/routes/menu.test.ts` — menu route tests.
- `apps/web/src/components/shell/TopNav.tsx` — floating top bar (container).
- `apps/web/src/components/shell/NavCategories.tsx` — pure category-links renderer (+ overflow).
- `apps/web/src/components/shell/NavCategories.test.tsx`
- `apps/web/src/components/shell/BottomNav.tsx` — mobile bottom tab bar + Catalog sheet.
- `apps/web/src/components/shell/icons.tsx` — shared inline SVG icons.
- `apps/web/src/components/account/ProfileMenuEditor.tsx` — per-profile menu editor.
- `apps/web/src/components/account/menu-order.ts` — pure `moveItem` reorder helper.
- `apps/web/src/components/account/menu-order.test.ts`
- `apps/web/src/components/account/ProfileMenuEditor.test.tsx`
- `apps/web/src/pages/account/AccountLayout.tsx` — `/account` chrome (tab nav + `<Outlet/>` + admin guard).
- `apps/web/src/pages/account/AccountOverview.tsx` — profile header + Switch Profile + Logout.
- `apps/web/src/pages/account/AccountMenuPage.tsx` — wraps `ProfileMenuEditor`.
- `apps/web/src/test/renderWithProviders.tsx` — test helper (MemoryRouter + QueryClientProvider).

**Modify:**
- `packages/db/prisma/schema.prisma` — add `ProfileMenuEntry`, Section back-relation.
- `packages/core/src/index.ts` — export menu resolver.
- `apps/api/src/routes/auth.ts` — `/auth/me` returns `isAdmin`.
- `apps/api/src/lib/auth.ts` — add `requireAdmin`.
- `apps/api/src/routes/auth.test.ts` — assert `isAdmin`.
- `apps/api/src/routes/{libraries,settings,scan,fix,refresh}.ts` — add `requireAdmin` to admin preHandlers.
- `apps/api/src/app.ts` — register `menuRoute`.
- `apps/web/src/lib/types.ts` — `MenuItem`, `MenuConfig`, `AuthMe` types.
- `apps/web/src/lib/queries.ts` — `useMenu`, `useMenuConfig`, `useAuthMe`.
- `apps/web/src/components/shell/AppShell.tsx` — TopNav + BottomNav layout.
- `apps/web/src/routes/RequireProfile.tsx` — simplified props to AppShell.
- `apps/web/src/router.tsx` — `/account*` nested routes + `/admin/*` redirects.
- `apps/web/src/pages/SearchPage.tsx` — full-page search, autofocus.

**Delete:**
- `apps/web/src/components/shell/Sidebar.tsx`
- `apps/web/src/components/shell/TopBar.tsx`

---

## Task 1: `ProfileMenuEntry` schema + migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma model `ProfileMenuEntry { id, profileId, sectionId, position }`, `prisma.profileMenuEntry` client delegate, `Section.menuEntries` back-relation.

- [ ] **Step 1: Add the model + back-relation**

In `packages/db/prisma/schema.prisma`, add the back-relation field to `Section` (inside the existing `model Section { ... }`, after the `items MediaItem[]` line):

```prisma
  menuEntries ProfileMenuEntry[]
```

Then add the new model after the `model Source { ... }` block:

```prisma
model ProfileMenuEntry {
  id        String  @id @default(cuid())
  profileId String
  sectionId String
  position  Int
  section   Section @relation(fields: [sectionId], references: [id], onDelete: Cascade)

  @@unique([profileId, sectionId])
  @@index([profileId])
}
```

- [ ] **Step 2: Ensure Postgres is up, then create the migration**

Run:
```bash
docker compose up -d postgres
pnpm db:migrate --name add_profile_menu_entry
```
Expected: a new folder under `packages/db/prisma/migrations/<timestamp>_add_profile_menu_entry/` with `migration.sql` creating `ProfileMenuEntry`, and `prisma generate` runs so the client now exposes `prisma.profileMenuEntry`.

> If Postgres isn't reachable, start it first (`docker compose up -d postgres`, port 1062). The api container applies migrations in prod via `prisma migrate deploy`.

- [ ] **Step 3: Verify the client typechecks**

Run:
```bash
pnpm --filter @orbix/db build
```
Expected: PASS (prisma generate succeeds; `ProfileMenuEntry` types generated).

- [ ] **Step 4: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat(db): add ProfileMenuEntry for per-profile catalog menus"
```

---

## Task 2: Pure menu resolver in core

**Files:**
- Create: `packages/core/src/menu/resolve.ts`
- Create: `packages/core/src/menu/resolve.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `interface MenuSection { sectionId: string; name: string; libraryName: string; order: number }`
  - `interface MenuEntry { sectionId: string; position: number }`
  - `interface ResolvedMenuItem { sectionId: string; name: string; libraryName: string }`
  - `resolveProfileMenu(sections: MenuSection[], entries: MenuEntry[]): ResolvedMenuItem[]`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/menu/resolve.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveProfileMenu, type MenuSection } from "./resolve";

const sections: MenuSection[] = [
  { sectionId: "s2", name: "Shows", libraryName: "TV", order: 1 },
  { sectionId: "s1", name: "Movies", libraryName: "Films", order: 0 },
  { sectionId: "s3", name: "Docs", libraryName: "Films", order: 2 },
];

describe("resolveProfileMenu", () => {
  it("returns all sections in default order (order, then library, then name) when no entries", () => {
    const out = resolveProfileMenu(sections, []);
    expect(out.map((s) => s.sectionId)).toEqual(["s1", "s2", "s3"]);
    expect(out[0]).toEqual({ sectionId: "s1", name: "Movies", libraryName: "Films" });
  });

  it("returns entries' sections in position order", () => {
    const out = resolveProfileMenu(sections, [
      { sectionId: "s3", position: 0 },
      { sectionId: "s1", position: 1 },
    ]);
    expect(out.map((s) => s.sectionId)).toEqual(["s3", "s1"]);
  });

  it("drops entries whose section no longer exists", () => {
    const out = resolveProfileMenu(sections, [
      { sectionId: "gone", position: 0 },
      { sectionId: "s2", position: 1 },
    ]);
    expect(out.map((s) => s.sectionId)).toEqual(["s2"]);
  });

  it("breaks order ties by library name then section name", () => {
    const tied: MenuSection[] = [
      { sectionId: "b", name: "B", libraryName: "Zeta", order: 0 },
      { sectionId: "a", name: "A", libraryName: "Alpha", order: 0 },
    ];
    expect(resolveProfileMenu(tied, []).map((s) => s.sectionId)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
pnpm --filter @orbix/core exec vitest run src/menu/resolve.test.ts
```
Expected: FAIL (`Cannot find module './resolve'`).

- [ ] **Step 3: Implement the resolver**

Create `packages/core/src/menu/resolve.ts`:

```ts
export interface MenuSection {
  sectionId: string;
  name: string;
  libraryName: string;
  order: number;
}

export interface MenuEntry {
  sectionId: string;
  position: number;
}

export interface ResolvedMenuItem {
  sectionId: string;
  name: string;
  libraryName: string;
}

const view = (s: MenuSection): ResolvedMenuItem => ({
  sectionId: s.sectionId,
  name: s.name,
  libraryName: s.libraryName,
});

/**
 * Resolve the ordered catalog menu for a profile.
 *   - no entries  → every section in default order (order, then library name, then section name)
 *   - has entries → the entries' sections in `position` order, dropping any whose
 *                   section no longer exists.
 */
export function resolveProfileMenu(
  sections: MenuSection[],
  entries: MenuEntry[],
): ResolvedMenuItem[] {
  if (entries.length === 0) {
    return [...sections]
      .sort(
        (a, b) =>
          a.order - b.order ||
          a.libraryName.localeCompare(b.libraryName) ||
          a.name.localeCompare(b.name),
      )
      .map(view);
  }
  const byId = new Map(sections.map((s) => [s.sectionId, s]));
  return [...entries]
    .sort((a, b) => a.position - b.position)
    .map((e) => byId.get(e.sectionId))
    .filter((s): s is MenuSection => Boolean(s))
    .map(view);
}
```

- [ ] **Step 4: Export from the core barrel**

In `packages/core/src/index.ts`, add at the end:

```ts
export * from "./menu/resolve";
```

- [ ] **Step 5: Run the test to confirm it passes**

Run:
```bash
pnpm --filter @orbix/core exec vitest run src/menu/resolve.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/menu packages/core/src/index.ts
git commit -m "feat(core): resolveProfileMenu pure resolver"
```

---

## Task 3: `/auth/me` returns `isAdmin`

**Files:**
- Modify: `apps/api/src/routes/auth.ts:25-28`
- Modify: `apps/api/src/routes/auth.test.ts`

**Interfaces:**
- Produces: `GET /api/auth/me` → `{ accountId: string, isAdmin: boolean }` (401 when unauthenticated).

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/auth.test.ts` (inside the file's top-level `describe`, or add a new `describe`). Use the existing `env` + `buildApp` pattern from this file:

```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
// (reuse the `env` already defined in this test file)

describe("GET /auth/me", () => {
  it("returns accountId and isAdmin for an authenticated admin", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    (app as any).prisma.account = {
      findUnique: async () => ({ isAdmin: true }),
    };
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accountId: "a1", isAdmin: true });
    await app.close();
  });

  it("401s when unauthenticated", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = { findUnique: async () => null };
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

> If `apps/api/src/routes/auth.test.ts` already defines `env`/imports `buildApp`, don't redeclare them — just add the new `describe` block.

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
pnpm --filter @orbix/api exec vitest run src/routes/auth.test.ts -t "isAdmin"
```
Expected: FAIL (response lacks `isAdmin`).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/auth.ts`, replace the `/auth/me` handler (lines 25-28):

```ts
  app.get("/auth/me", async (req, reply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
    const acct = await app.prisma.account.findUnique({
      where: { id: req.accountId },
      select: { isAdmin: true },
    });
    return { accountId: req.accountId, isAdmin: acct?.isAdmin ?? false };
  });
```

- [ ] **Step 4: Run the test to confirm it passes**

Run:
```bash
pnpm --filter @orbix/api exec vitest run src/routes/auth.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(api): /auth/me returns account isAdmin"
```

---

## Task 4: `requireAdmin` guard on admin routes

**Files:**
- Modify: `apps/api/src/lib/auth.ts`
- Modify: `apps/api/src/routes/libraries.ts`, `settings.ts`, `scan.ts`, `fix.ts`, `refresh.ts`
- Create test additions in: `apps/api/src/routes/libraries.test.ts` (create if absent)

**Interfaces:**
- Consumes: `req.accountId` (session plugin), `app.prisma.account`.
- Produces: `requireAdmin(app)` preHandler — 401 if unauthenticated, 403 `{error:"forbidden"}` if `account.isAdmin` is false.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/libraries.test.ts` (mirror the inject pattern; copy the `env` literal from `apps/api/src/routes/profiles.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

describe("admin gating (requireAdmin)", () => {
  it("403s POST /libraries for a non-admin account", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: false }) };
    (app as any).prisma.profile = { findUnique: async () => ({ id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null }) };
    const res = await app.inject({
      method: "POST", url: "/api/libraries",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
      payload: { name: "New Lib" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
pnpm --filter @orbix/api exec vitest run src/routes/libraries.test.ts
```
Expected: FAIL (currently returns 200/400, not 403).

- [ ] **Step 3: Add `requireAdmin` to `apps/api/src/lib/auth.ts`**

Replace the file contents with:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function requireAuth(_app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
  };
}

export function requireAdmin(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
    const acct = await app.prisma.account.findUnique({
      where: { id: req.accountId },
      select: { isAdmin: true },
    });
    if (!acct?.isAdmin) return reply.code(403).send({ error: "forbidden" });
  };
}
```

- [ ] **Step 4: Add `requireAdmin` into each admin preHandler array**

In each of these files, import `requireAdmin` and insert `requireAdmin(app)` into every preHandler array that currently contains `requireNonKids(app)`, so `[requireAuth(app), requireNonKids(app)]` becomes `[requireAuth(app), requireAdmin(app), requireNonKids(app)]`.

- `apps/api/src/routes/libraries.ts` — add `import { requireAuth, requireAdmin } from "../lib/auth";` (replace the existing `requireAuth` import); update the 7 mutation handlers (POST/DELETE `/libraries`, POST/PATCH/DELETE `/sections`, POST/DELETE `/sources`). Leave `GET /libraries` as `requireAuth(app)` only (every profile reads it).
- `apps/api/src/routes/settings.ts` — add `requireAdmin` import; update `GET /settings` and `PUT /settings`.
- `apps/api/src/routes/scan.ts` — add `requireAdmin` import; update the scan route.
- `apps/api/src/routes/fix.ts` — add `requireAdmin` import; update all 3 handlers.
- `apps/api/src/routes/refresh.ts` — add `requireAdmin` import; update all 3 handlers.

Example (libraries.ts POST `/libraries`):

```ts
import { requireAuth, requireAdmin } from "../lib/auth";
// ...
  app.post<{ Body: unknown }>("/libraries", { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] }, async (req, reply) => {
```

> In `fix.ts`/`refresh.ts` the routes are inside factory functions `fixRoute(env)`/`refreshRoute(env)` — `app` is the inner param; `requireAdmin(app)` uses that same `app`.

- [ ] **Step 5: Run the test to confirm it passes**

Run:
```bash
pnpm --filter @orbix/api exec vitest run src/routes/libraries.test.ts
```
Expected: PASS.

- [ ] **Step 6: Verify nothing else broke**

Run:
```bash
pnpm --filter @orbix/api test
pnpm --filter @orbix/api typecheck
```
Expected: PASS. (Existing admin-route tests that authenticate may now need an `account.findUnique → { isAdmin: true }` stub; add it where a previously-passing admin test starts 403ing.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/auth.ts apps/api/src/routes/libraries.ts apps/api/src/routes/settings.ts apps/api/src/routes/scan.ts apps/api/src/routes/fix.ts apps/api/src/routes/refresh.ts apps/api/src/routes/libraries.test.ts
git commit -m "feat(api): require account.isAdmin on admin routes"
```

---

## Task 5: `/me/menu` routes

**Files:**
- Create: `apps/api/src/routes/menu.ts`
- Create: `apps/api/src/routes/menu.test.ts`
- Modify: `apps/api/src/app.ts` (register `menuRoute`)

**Interfaces:**
- Consumes: `resolveProfileMenu` (Task 2), `activeProfile` (`apps/api/src/lib/catalog-filter.ts`), `requireAuth` (`apps/api/src/lib/auth.ts`).
- Produces:
  - `GET /api/me/menu` → `{ items: { sectionId, name, libraryName }[] }`
  - `GET /api/me/menu/config` → `{ sections: { sectionId, name, libraryName }[]; enabled: string[] }`
  - `PUT /api/me/menu` body `{ sectionIds: string[] }` → `{ items: { sectionId, name, libraryName }[] }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/menu.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

function authed(app: any) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.profile = {
    findUnique: async () => ({ id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null }),
  };
}
const libsWithSections = [
  { name: "Films", sections: [
    { id: "s1", name: "Movies", order: 0 },
    { id: "s2", name: "Docs", order: 1 },
  ] },
];
const cookies = { orbix_session: "s1", orbix_profile: "p1" };

describe("GET /me/menu", () => {
  it("returns all sections in default order when the profile has no entries", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.library = { findMany: async () => libsWithSections };
    (app as any).prisma.profileMenuEntry = { findMany: async () => [] };
    const res = await app.inject({ method: "GET", url: "/api/me/menu", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [
      { sectionId: "s1", name: "Movies", libraryName: "Films" },
      { sectionId: "s2", name: "Docs", libraryName: "Films" },
    ] });
    await app.close();
  });

  it("honors the profile's entry order", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.library = { findMany: async () => libsWithSections };
    (app as any).prisma.profileMenuEntry = { findMany: async () => [
      { sectionId: "s2", position: 0 }, { sectionId: "s1", position: 1 },
    ] };
    const res = await app.inject({ method: "GET", url: "/api/me/menu", cookies });
    expect(res.json().items.map((i: any) => i.sectionId)).toEqual(["s2", "s1"]);
    await app.close();
  });
});

describe("PUT /me/menu", () => {
  it("rejects an unknown sectionId with 400", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.section = { findMany: async () => [{ id: "s1" }, { id: "s2" }] };
    const res = await app.inject({ method: "PUT", url: "/api/me/menu", cookies, payload: { sectionIds: ["s1", "nope"] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("replaces entries and returns the resolved menu", async () => {
    const app = await buildApp(env);
    authed(app as any);
    const calls: string[] = [];
    (app as any).prisma.section = { findMany: async () => [{ id: "s1" }, { id: "s2" }] };
    (app as any).prisma.library = { findMany: async () => libsWithSections };
    (app as any).prisma.profileMenuEntry = {
      deleteMany: async () => { calls.push("delete"); return { count: 0 }; },
      createMany: async ({ data }: any) => { calls.push("create:" + data.map((d: any) => d.sectionId).join(",")); return { count: data.length }; },
      findMany: async () => [{ sectionId: "s2", position: 0 }, { sectionId: "s1", position: 1 }],
    };
    (app as any).prisma.$transaction = async (ops: any[]) => Promise.all(ops);
    const res = await app.inject({ method: "PUT", url: "/api/me/menu", cookies, payload: { sectionIds: ["s2", "s1"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: any) => i.sectionId)).toEqual(["s2", "s1"]);
    await app.close();
  });
});
```

> Note: with `$transaction` stubbed to `Promise.all(ops)`, `deleteMany`/`createMany` must return promises (they do above). The route passes the *promise results* of those delegate calls into `$transaction`, matching Prisma's array form.

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
pnpm --filter @orbix/api exec vitest run src/routes/menu.test.ts
```
Expected: FAIL (route file doesn't exist → 404s).

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/routes/menu.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { resolveProfileMenu, type MenuSection, type MenuEntry } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { activeProfile } from "../lib/catalog-filter";

async function loadSections(app: FastifyInstance): Promise<MenuSection[]> {
  const libraries = await app.prisma.library.findMany({
    select: { name: true, sections: { select: { id: true, name: true, order: true } } },
  });
  return libraries.flatMap((lib) =>
    lib.sections.map((s) => ({ sectionId: s.id, name: s.name, libraryName: lib.name, order: s.order })),
  );
}

async function loadEntries(app: FastifyInstance, profileId: string): Promise<MenuEntry[]> {
  return app.prisma.profileMenuEntry.findMany({
    where: { profileId },
    select: { sectionId: true, position: true },
  });
}

export default async function menu(app: FastifyInstance) {
  // GET /me/menu — resolved categories for the active profile's nav.
  app.get("/me/menu", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.send({ items: [] });
    const [sections, entries] = await Promise.all([loadSections(app), loadEntries(app, profile.id)]);
    return reply.send({ items: resolveProfileMenu(sections, entries) });
  });

  // GET /me/menu/config — every section + the currently-enabled ordered ids, for the editor.
  app.get("/me/menu/config", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    const sections = await loadSections(app);
    const entries = profile ? await loadEntries(app, profile.id) : [];
    const all = resolveProfileMenu(sections, []);
    const enabled = resolveProfileMenu(sections, entries).map((s) => s.sectionId);
    return reply.send({ sections: all, enabled });
  });

  // PUT /me/menu — replace the active profile's ordered enabled sections.
  app.put<{ Body: { sectionIds?: unknown } }>("/me/menu", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.code(400).send({ error: "no_active_profile" });

    const ids = req.body?.sectionIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      return reply.code(400).send({ error: "invalid" });
    }
    const sectionIds = ids as string[];
    const existing = await app.prisma.section.findMany({ select: { id: true } });
    const valid = new Set(existing.map((s) => s.id));
    if (!sectionIds.every((id) => valid.has(id))) {
      return reply.code(400).send({ error: "unknown_section" });
    }

    await app.prisma.$transaction([
      app.prisma.profileMenuEntry.deleteMany({ where: { profileId: profile.id } }),
      app.prisma.profileMenuEntry.createMany({
        data: sectionIds.map((sectionId, position) => ({ profileId: profile.id, sectionId, position })),
      }),
    ]);

    const [sections, entries] = await Promise.all([loadSections(app), loadEntries(app, profile.id)]);
    return reply.send({ items: resolveProfileMenu(sections, entries) });
  });
}
```

- [ ] **Step 4: Register the route in `apps/api/src/app.ts`**

Add the import near the other route imports (after line 11):

```ts
import menuRoute from "./routes/menu";
```

Register it under `/api` (after the `profilesRoute` registration, line 42):

```ts
  await app.register(menuRoute, { prefix: "/api" });
```

- [ ] **Step 5: Run the test to confirm it passes**

Run:
```bash
pnpm --filter @orbix/api exec vitest run src/routes/menu.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/menu.ts apps/api/src/routes/menu.test.ts apps/api/src/app.ts
git commit -m "feat(api): /me/menu read/config/update routes"
```

---

## Task 6: Web data layer — types & query hooks

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/queries.ts`

**Interfaces:**
- Produces:
  - `interface MenuItem { sectionId: string; name: string; libraryName: string }`
  - `interface MenuConfig { sections: MenuItem[]; enabled: string[] }`
  - `interface AuthMe { accountId: string; isAdmin: boolean }`
  - `useMenu()` → `UseQueryResult<{ items: MenuItem[] }>` (queryKey `["menu"]`)
  - `useMenuConfig()` → `UseQueryResult<MenuConfig>` (queryKey `["menu-config"]`)
  - `useAuthMe()` → `UseQueryResult<AuthMe>` (queryKey `["auth-me"]`)
  - `saveMenu(sectionIds: string[]): Promise<{ items: MenuItem[] }>`

- [ ] **Step 1: Add types**

Append to `apps/web/src/lib/types.ts`:

```ts
/** One catalog category in the profile's nav (resolved from sections). */
export interface MenuItem {
  sectionId: string;
  name: string;
  libraryName: string;
}

/** Editor payload: all sections + the profile's currently-enabled ordered ids. */
export interface MenuConfig {
  sections: MenuItem[];
  enabled: string[];
}

/** Account-level identity for admin gating. */
export interface AuthMe {
  accountId: string;
  isAdmin: boolean;
}
```

- [ ] **Step 2: Add hooks + mutation helper**

In `apps/web/src/lib/queries.ts`, update the type import and add hooks. Change the import on line 3 to include the new types:

```ts
import type { AuthMe, HomeRow, Library, MediaCard, MenuConfig, MenuItem, Profile } from "./types";
```

Add `apiFetch` to the api import on line 2:

```ts
import { apiJson, apiFetch } from "./api";
```

Append at the end of the file:

```ts
export function useMenu() {
  return useQuery({ queryKey: ["menu"], queryFn: () => apiJson<{ items: MenuItem[] }>("/me/menu") });
}
export function useMenuConfig() {
  return useQuery({ queryKey: ["menu-config"], queryFn: () => apiJson<MenuConfig>("/me/menu/config") });
}
export function useAuthMe() {
  return useQuery({ queryKey: ["auth-me"], queryFn: () => apiJson<AuthMe>("/auth/me") });
}

/** Replace the active profile's menu; returns the resolved menu. */
export async function saveMenu(sectionIds: string[]): Promise<{ items: MenuItem[] }> {
  const res = await apiFetch("/me/menu", { method: "PUT", body: JSON.stringify({ sectionIds }) });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as { items: MenuItem[] };
}
```

Add `ApiError` to the existing api import (so the helper can throw it). Line 2 becomes:

```ts
import { apiJson, apiFetch, ApiError } from "./api";
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @orbix/web typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/queries.ts
git commit -m "feat(web): menu + auth-me query hooks and saveMenu"
```

---

## Task 7: Shared icons + pure NavCategories renderer

**Files:**
- Create: `apps/web/src/components/shell/icons.tsx`
- Create: `apps/web/src/components/shell/NavCategories.tsx`
- Create: `apps/web/src/components/shell/NavCategories.test.tsx`
- Create: `apps/web/src/test/renderWithProviders.tsx`

**Interfaces:**
- Produces:
  - `icons.tsx`: `HomeIcon`, `TvIcon`, `HeartIcon`, `SearchIcon`, `UserIcon`, `ChevronDownIcon` (each `(props?: { className?: string }) => JSX.Element`).
  - `NavCategories({ items, pathname, maxVisible, onNavigate }: { items: MenuItem[]; pathname: string; maxVisible?: number; onNavigate?: () => void })` — renders category `<Link>`s to `/library/:sectionId`, collapsing the overflow beyond `maxVisible` (default 6) into a "More ▾" `<details>` menu.
  - `renderWithProviders(ui, { route?, client? })` test helper.

- [ ] **Step 1: Create the test-providers helper**

Create `apps/web/src/test/renderWithProviders.tsx`:

```tsx
import { type ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

export function renderWithProviders(
  ui: ReactElement,
  opts: { route?: string; client?: QueryClient } = {},
) {
  const client = opts.client ?? makeClient();
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[opts.route ?? "/"]}>{ui}</MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
```

- [ ] **Step 2: Write the failing test for NavCategories**

Create `apps/web/src/components/shell/NavCategories.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders";
import NavCategories from "./NavCategories";
import type { MenuItem } from "@/lib/types";

const items: MenuItem[] = [
  { sectionId: "s1", name: "Movies", libraryName: "Films" },
  { sectionId: "s2", name: "Shows", libraryName: "TV" },
];

describe("NavCategories", () => {
  it("renders a link per category targeting /library/:id", () => {
    renderWithProviders(<NavCategories items={items} pathname="/" />);
    const movies = screen.getByRole("link", { name: "Movies" });
    expect(movies.getAttribute("href")).toBe("/library/s1");
  });

  it("marks the active category via aria-current", () => {
    renderWithProviders(<NavCategories items={items} pathname="/library/s2" />);
    expect(screen.getByRole("link", { name: "Shows" }).getAttribute("aria-current")).toBe("page");
  });

  it("collapses overflow beyond maxVisible into a More menu", () => {
    const many: MenuItem[] = Array.from({ length: 5 }, (_, i) => ({
      sectionId: `x${i}`, name: `Cat${i}`, libraryName: "L",
    }));
    renderWithProviders(<NavCategories items={many} pathname="/" maxVisible={3} />);
    expect(screen.getByText("More")).toBeTruthy();
    // The 5th item lives inside the More menu, not the top row.
    expect(screen.getByRole("link", { name: "Cat4" })).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run:
```bash
pnpm --filter @orbix/web exec vitest run src/components/shell/NavCategories.test.tsx
```
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement icons**

Create `apps/web/src/components/shell/icons.tsx`:

```tsx
type IconProps = { className?: string };
const base = "h-5 w-5 shrink-0";
const svg = (className: string | undefined, children: React.ReactNode) => (
  <svg className={className ?? base} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const HomeIcon = ({ className }: IconProps) => svg(className, <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>);
export const TvIcon = ({ className }: IconProps) => svg(className, <><rect x="2" y="7" width="20" height="13" rx="2" /><path d="m7 7 5-4 5 4" /></>);
export const HeartIcon = ({ className }: IconProps) => svg(className, <path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1Z" />);
export const SearchIcon = ({ className }: IconProps) => svg(className, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></>);
export const UserIcon = ({ className }: IconProps) => svg(className, <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const ChevronDownIcon = ({ className }: IconProps) => svg(className ?? "h-4 w-4 shrink-0", <path d="m6 9 6 6 6-6" />);
```

- [ ] **Step 5: Implement NavCategories**

Create `apps/web/src/components/shell/NavCategories.tsx`:

```tsx
import { Link } from "react-router";
import { cn } from "@orbix/ui";
import type { MenuItem } from "@/lib/types";
import { ChevronDownIcon } from "./icons";

function CategoryLink({ item, active, onNavigate }: { item: MenuItem; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      to={`/library/${item.sectionId}`}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "whitespace-nowrap text-sm transition-colors",
        active ? "text-[var(--text)] font-medium" : "text-[var(--text-dim)] hover:text-[var(--text)]",
      )}
    >
      {item.name}
    </Link>
  );
}

export default function NavCategories({
  items,
  pathname,
  maxVisible = 6,
  onNavigate,
}: {
  items: MenuItem[];
  pathname: string;
  maxVisible?: number;
  onNavigate?: () => void;
}) {
  const isActive = (id: string) => pathname === `/library/${id}`;
  const visible = items.slice(0, maxVisible);
  const overflow = items.slice(maxVisible);

  return (
    <div className="flex items-center gap-4">
      {visible.map((item) => (
        <CategoryLink key={item.sectionId} item={item} active={isActive(item.sectionId)} onNavigate={onNavigate} />
      ))}
      {overflow.length > 0 && (
        <details className="relative">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-sm text-[var(--text-dim)] hover:text-[var(--text)]">
            More <ChevronDownIcon />
          </summary>
          <div className="absolute right-0 z-50 mt-2 flex min-w-40 flex-col gap-1 rounded-[var(--radius)] border border-[var(--surface-2)] bg-[var(--surface)] p-2 shadow-lg">
            {overflow.map((item) => (
              <CategoryLink key={item.sectionId} item={item} active={isActive(item.sectionId)} onNavigate={onNavigate} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the test to confirm it passes**

Run:
```bash
pnpm --filter @orbix/web exec vitest run src/components/shell/NavCategories.test.tsx
```
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/shell/icons.tsx apps/web/src/components/shell/NavCategories.tsx apps/web/src/components/shell/NavCategories.test.tsx apps/web/src/test/renderWithProviders.tsx
git commit -m "feat(web): shared nav icons + NavCategories renderer + test helper"
```

---

## Task 8: TopNav container

**Files:**
- Create: `apps/web/src/components/shell/TopNav.tsx`

**Interfaces:**
- Consumes: `useMenu`, `useAuthMe` (Task 6), `NavCategories`, icons (Task 7), `Avatar`/`cn` from `@orbix/ui`.
- Produces: `TopNav({ profile }: { profile: Profile | null })` — fixed floating bar; transparent at top, solid+blurred when scrolled.

- [ ] **Step 1: Implement TopNav**

Create `apps/web/src/components/shell/TopNav.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Avatar, cn } from "@orbix/ui";
import { useMenu } from "@/lib/queries";
import type { Profile } from "@/lib/types";
import NavCategories from "./NavCategories";
import { HomeIcon, TvIcon, HeartIcon, SearchIcon } from "./icons";

function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        setScrolled(window.scrollY > threshold);
        raf = 0;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [threshold]);
  return scrolled;
}

/** A visible-but-inert placeholder nav item (TV, Heart) for not-yet-built features. */
function Placeholder({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span
      aria-disabled
      title="Coming soon"
      className="flex cursor-default items-center gap-1.5 text-sm text-[var(--text-dim)]/60"
    >
      {children}
      <span className="sr-only">{label} (coming soon)</span>
    </span>
  );
}

export default function TopNav({ profile }: { profile: Profile | null }) {
  const { pathname } = useLocation();
  const scrolled = useScrolled();
  const menu = useMenu();
  const items = menu.data?.items ?? [];

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-40 transition-colors duration-300",
        scrolled
          ? "bg-[var(--surface)]/85 backdrop-blur border-b border-[var(--surface-2)]"
          : "bg-gradient-to-b from-black/60 to-transparent",
      )}
    >
      <nav className="mx-auto flex h-14 items-center gap-6 px-4 md:px-8">
        {/* Left: logo */}
        <Link to="/" className="text-xl font-bold tracking-tight text-[var(--text)]">
          Orbix
        </Link>

        {/* Center: Home · TV · categories (desktop only — mobile uses BottomNav) */}
        <div className="hidden md:flex items-center gap-4">
          <Link
            to="/"
            aria-current={pathname === "/" ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 text-sm transition-colors",
              pathname === "/" ? "text-[var(--text)] font-medium" : "text-[var(--text-dim)] hover:text-[var(--text)]",
            )}
          >
            <HomeIcon className="h-4 w-4" /> Home
          </Link>
          <Placeholder label="TV"><TvIcon className="h-4 w-4" /> TV</Placeholder>
          <NavCategories items={items} pathname={pathname} />
        </div>

        {/* Right: heart · search · avatar */}
        <div className="ml-auto flex items-center gap-4">
          <Placeholder label="My list"><HeartIcon /></Placeholder>
          <Link to="/search" aria-label="Search" className="text-[var(--text-dim)] hover:text-[var(--text)] transition-colors">
            <SearchIcon />
          </Link>
          <Link to="/account" aria-label="Account" className="rounded-full focus:outline-none focus:ring-2 focus:ring-[var(--accent)]">
            <Avatar name={profile?.name ?? "?"} src={profile?.avatar ?? undefined} size={32} />
          </Link>
        </div>
      </nav>
    </header>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm --filter @orbix/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/shell/TopNav.tsx
git commit -m "feat(web): floating TopNav (transparent→solid on scroll)"
```

---

## Task 9: BottomNav (mobile) + Catalog sheet

**Files:**
- Create: `apps/web/src/components/shell/BottomNav.tsx`

**Interfaces:**
- Consumes: `useMenu`, icons, `cn`.
- Produces: `BottomNav()` — fixed `md:hidden` bottom tab bar (Home, TV, Catalog, Search, Account). The Catalog tab toggles a sheet listing the profile's categories.

- [ ] **Step 1: Implement BottomNav**

Create `apps/web/src/components/shell/BottomNav.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { cn } from "@orbix/ui";
import { useMenu } from "@/lib/queries";
import { HomeIcon, TvIcon, SearchIcon, UserIcon } from "./icons";

function Tab({ to, label, active, onClick, children }: {
  to?: string; label: string; active?: boolean; onClick?: () => void; children: React.ReactNode;
}) {
  const cls = cn(
    "flex flex-1 flex-col items-center gap-1 py-2 text-[10px]",
    active ? "text-[var(--text)]" : "text-[var(--text-dim)]",
  );
  if (to) return <Link to={to} className={cls} aria-current={active ? "page" : undefined}>{children}<span>{label}</span></Link>;
  return <button type="button" onClick={onClick} className={cls} aria-label={label}>{children}<span>{label}</span></button>;
}

export default function BottomNav() {
  const { pathname } = useLocation();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const menu = useMenu();
  const items = menu.data?.items ?? [];

  // Close the sheet whenever the route changes.
  useEffect(() => { setCatalogOpen(false); }, [pathname]);

  return (
    <>
      {catalogOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-label="Catalog">
          <div className="absolute inset-0 bg-black/60" onClick={() => setCatalogOpen(false)} aria-hidden />
          <div className="absolute inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-[var(--surface-2)] bg-[var(--surface)] p-4 pb-24">
            <p className="px-2 pb-2 text-xs uppercase tracking-wide text-[var(--text-dim)]">Catalog</p>
            {items.length === 0 && <p className="px-2 py-3 text-sm text-[var(--text-dim)]">No categories yet.</p>}
            <div className="flex flex-col">
              {items.map((item) => (
                <Link
                  key={item.sectionId}
                  to={`/library/${item.sectionId}`}
                  className="rounded-[var(--radius-sm)] px-2 py-3 text-[var(--text)] hover:bg-[var(--surface-2)]"
                >
                  {item.name}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--surface-2)] bg-[var(--surface)]/95 backdrop-blur md:hidden">
        <Tab to="/" label="Home" active={pathname === "/"}><HomeIcon className="h-5 w-5" /></Tab>
        <Tab label="TV"><TvIcon className="h-5 w-5 opacity-60" /></Tab>
        <Tab label="Catalog" active={catalogOpen} onClick={() => setCatalogOpen((v) => !v)}>
          {/* simple grid glyph */}
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        </Tab>
        <Tab to="/search" label="Search" active={pathname === "/search"}><SearchIcon className="h-5 w-5" /></Tab>
        <Tab to="/account" label="Account" active={pathname.startsWith("/account")}><UserIcon className="h-5 w-5" /></Tab>
      </nav>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm --filter @orbix/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/shell/BottomNav.tsx
git commit -m "feat(web): mobile BottomNav + Catalog sheet"
```

---

## Task 10: Rewire AppShell; delete Sidebar/TopBar

**Files:**
- Modify: `apps/web/src/components/shell/AppShell.tsx`
- Modify: `apps/web/src/routes/RequireProfile.tsx`
- Delete: `apps/web/src/components/shell/Sidebar.tsx`, `apps/web/src/components/shell/TopBar.tsx`

**Interfaces:**
- Consumes: `TopNav` (Task 8), `BottomNav` (Task 9).
- Produces: `AppShell({ profile, children }: { profile: Profile | null; children: React.ReactNode })`.

- [ ] **Step 1: Rewrite AppShell**

Replace `apps/web/src/components/shell/AppShell.tsx` with:

```tsx
import TopNav from "./TopNav";
import BottomNav from "./BottomNav";
import type { Profile } from "@/lib/types";

export default function AppShell({
  profile,
  children,
}: {
  profile: Profile | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <TopNav profile={profile} />
      {/* Content flows under the fixed top bar; pt clears it on non-hero pages.
          pb-24 on mobile clears the fixed BottomNav. */}
      <div className="pt-14 pb-24 md:pb-0">{children}</div>
      <BottomNav />
      <footer className="px-6 py-4 pb-28 md:pb-4 md:px-8 text-center text-xs text-[var(--text-dim)]">
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </footer>
    </div>
  );
}
```

> Hero pages (TitlePage) intentionally render under the transparent bar. The `pt-14` keeps plain pages (search, library grid, account) from being clipped. If a hero page wants to bleed under the bar, it can use a negative margin — out of scope here.

- [ ] **Step 2: Simplify RequireProfile's AppShell usage**

In `apps/web/src/routes/RequireProfile.tsx`, the `useLibraries()` call and the `libraries`/`isKids` props are no longer needed by AppShell. Update:

- Remove `useLibraries` from the import on line 3: `import { useSetupStatus, useMyProfile } from "@/lib/queries";`
- Remove the `const libs = useLibraries();` line.
- Change the render to:

```tsx
  return (
    <AppShell profile={profile}>
      <Outlet />
    </AppShell>
  );
```

(Keep the rest — `decideRedirect`, the `profile` object — unchanged.)

- [ ] **Step 3: Delete the old shell components**

Run:
```bash
git rm apps/web/src/components/shell/Sidebar.tsx apps/web/src/components/shell/TopBar.tsx
```

- [ ] **Step 4: Typecheck + lint**

Run:
```bash
pnpm --filter @orbix/web typecheck
pnpm --filter @orbix/web lint
```
Expected: PASS. (If anything still imports `Sidebar`/`TopBar`, fix those references — grep `rg "Sidebar|TopBar" apps/web/src`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/shell/AppShell.tsx apps/web/src/routes/RequireProfile.tsx
git commit -m "feat(web): AppShell uses TopNav+BottomNav; remove Sidebar/TopBar"
```

---

## Task 11: Pure menu-reorder helper

**Files:**
- Create: `apps/web/src/components/account/menu-order.ts`
- Create: `apps/web/src/components/account/menu-order.test.ts`

**Interfaces:**
- Produces: `moveItem<T>(list: T[], index: number, dir: -1 | 1): T[]` — returns a new array with the item at `index` swapped toward `dir`; no-op at the ends.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/account/menu-order.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { moveItem } from "./menu-order";

describe("moveItem", () => {
  it("moves an item up", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
  });
  it("moves an item down", () => {
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });
  it("is a no-op past the top", () => {
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
  it("is a no-op past the bottom", () => {
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
  it("does not mutate the input", () => {
    const input = ["a", "b"];
    moveItem(input, 0, 1);
    expect(input).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
pnpm --filter @orbix/web exec vitest run src/components/account/menu-order.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/web/src/components/account/menu-order.ts`:

```ts
/** Swap the item at `index` one slot toward `dir` (-1 up, 1 down). No-op at the ends. */
export function moveItem<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (target < 0 || target >= list.length) return list.slice();
  const next = list.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run:
```bash
pnpm --filter @orbix/web exec vitest run src/components/account/menu-order.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/account/menu-order.ts apps/web/src/components/account/menu-order.test.ts
git commit -m "feat(web): pure moveItem reorder helper"
```

---

## Task 12: ProfileMenuEditor

**Files:**
- Create: `apps/web/src/components/account/ProfileMenuEditor.tsx`
- Create: `apps/web/src/components/account/ProfileMenuEditor.test.tsx`

**Interfaces:**
- Consumes: `useMenuConfig`, `saveMenu` (Task 6), `moveItem` (Task 11), `Button` from `@orbix/ui`, `useQueryClient`.
- Produces: `ProfileMenuEditor()` — checkbox enable/disable + up/down reorder of the enabled list; Save persists via `saveMenu` and invalidates `["menu"]`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/account/ProfileMenuEditor.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import ProfileMenuEditor from "./ProfileMenuEditor";
import type { MenuConfig } from "@/lib/types";

const saveMock = vi.fn();
vi.mock("@/lib/queries", async (orig) => {
  const actual = await orig<typeof import("@/lib/queries")>();
  return { ...actual, saveMenu: (...args: unknown[]) => saveMock(...args) };
});

const config: MenuConfig = {
  sections: [
    { sectionId: "s1", name: "Movies", libraryName: "Films" },
    { sectionId: "s2", name: "Shows", libraryName: "TV" },
    { sectionId: "s3", name: "Docs", libraryName: "Films" },
  ],
  enabled: ["s1", "s2", "s3"],
};

beforeEach(() => { saveMock.mockReset(); saveMock.mockResolvedValue({ items: [] }); });

describe("ProfileMenuEditor", () => {
  function setup() {
    const client = makeClient();
    client.setQueryData(["menu-config"], config);
    return renderWithProviders(<ProfileMenuEditor />, { client, route: "/account/menu" });
  }

  it("lists every section as a checkbox", () => {
    setup();
    expect(screen.getByLabelText("Movies")).toBeTruthy();
    expect(screen.getByLabelText("Shows")).toBeTruthy();
    expect(screen.getByLabelText("Docs")).toBeTruthy();
  });

  it("saves only the enabled section ids in order", async () => {
    setup();
    fireEvent.click(screen.getByLabelText("Shows")); // disable s2
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith(["s1", "s3"]));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
pnpm --filter @orbix/web exec vitest run src/components/account/ProfileMenuEditor.test.tsx
```
Expected: FAIL (component not found).

- [ ] **Step 3: Implement ProfileMenuEditor**

Create `apps/web/src/components/account/ProfileMenuEditor.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@orbix/ui";
import { useMenuConfig, saveMenu } from "@/lib/queries";
import type { MenuItem } from "@/lib/types";
import { moveItem } from "./menu-order";

export default function ProfileMenuEditor() {
  const { data, isLoading } = useMenuConfig();
  const qc = useQueryClient();
  const [order, setOrder] = useState<string[] | null>(null);
  const [enabled, setEnabled] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed local state from the loaded config once.
  const byId = useMemo(() => new Map((data?.sections ?? []).map((s) => [s.sectionId, s])), [data]);
  if (data && order === null) {
    // All section ids, enabled-first in saved order, then the rest in default order.
    const rest = data.sections.map((s) => s.sectionId).filter((id) => !data.enabled.includes(id));
    setOrder([...data.enabled, ...rest]);
    setEnabled(new Set(data.enabled));
  }

  if (isLoading || !data || order === null || enabled === null) {
    return <p className="text-[var(--text-dim)]">Loading…</p>;
  }

  const toggle = (id: string) => {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id); else next.add(id);
    setEnabled(next);
    setSaved(false);
  };
  const move = (index: number, dir: -1 | 1) => { setOrder(moveItem(order, index, dir)); setSaved(false); };

  async function onSave() {
    setSaving(true);
    setSaved(false);
    try {
      const sectionIds = order!.filter((id) => enabled!.has(id));
      await saveMenu(sectionIds);
      await qc.invalidateQueries({ queryKey: ["menu"] });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <p className="text-sm text-[var(--text-dim)]">
        Choose which categories show in your menu and drag them into order.
      </p>
      <ul className="flex flex-col gap-1">
        {order.map((id, index) => {
          const section = byId.get(id) as MenuItem | undefined;
          if (!section) return null;
          return (
            <li key={id} className="flex items-center gap-3 rounded-[var(--radius-sm)] bg-[var(--surface)] px-3 py-2">
              <input
                id={`sec-${id}`}
                type="checkbox"
                checked={enabled.has(id)}
                onChange={() => toggle(id)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <label htmlFor={`sec-${id}`} className="flex-1 text-sm text-[var(--text)]">
                {section.name}
                <span className="ml-2 text-xs text-[var(--text-dim)]">{section.libraryName}</span>
              </label>
              <div className="flex gap-1">
                <button type="button" aria-label={`Move ${section.name} up`} disabled={index === 0}
                  onClick={() => move(index, -1)} className="px-2 text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-30">↑</button>
                <button type="button" aria-label={`Move ${section.name} down`} disabled={index === order.length - 1}
                  onClick={() => move(index, 1)} className="px-2 text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-30">↓</button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save menu"}</Button>
        {saved && <span className="text-sm text-[var(--text-dim)]">Saved.</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run:
```bash
pnpm --filter @orbix/web exec vitest run src/components/account/ProfileMenuEditor.test.tsx
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/account/ProfileMenuEditor.tsx apps/web/src/components/account/ProfileMenuEditor.test.tsx
git commit -m "feat(web): ProfileMenuEditor (toggle + reorder + save)"
```

---

## Task 13: Account hub pages (Layout, Overview, Menu)

**Files:**
- Create: `apps/web/src/pages/account/AccountLayout.tsx`
- Create: `apps/web/src/pages/account/AccountOverview.tsx`
- Create: `apps/web/src/pages/account/AccountMenuPage.tsx`

**Interfaces:**
- Consumes: `useAuthMe`, `useMyProfile`, `ProfileMenuEditor`, `apiFetch`, `Avatar`/`Button`/`cn`, React Router `NavLink`/`Outlet`/`Navigate`/`useLocation`.
- Produces: routed components for `/account` (layout), `/account` index (overview), `/account/menu`.

- [ ] **Step 1: Implement AccountLayout (tab chrome + admin guard)**

Create `apps/web/src/pages/account/AccountLayout.tsx`:

```tsx
import { NavLink, Outlet, Navigate, useLocation } from "react-router";
import { cn } from "@orbix/ui";
import { useAuthMe, useMyProfile } from "@/lib/queries";

const tab = ({ isActive }: { isActive: boolean }) =>
  cn(
    "border-b-2 px-1 pb-2 text-sm transition-colors",
    isActive
      ? "border-[var(--accent)] text-[var(--text)]"
      : "border-transparent text-[var(--text-dim)] hover:text-[var(--text)]",
  );

export default function AccountLayout() {
  const me = useAuthMe();
  const profile = useMyProfile();
  const { pathname } = useLocation();

  const isKids = profile.data?.kind === "kids";
  const isAdmin = (me.data?.isAdmin ?? false) && !isKids;

  // Guard the admin tabs: a non-admin who deep-links to /account/library|settings
  // is bounced to the overview. Wait for the query to settle first.
  const onAdminTab = pathname.startsWith("/account/library") || pathname.startsWith("/account/settings");
  if (onAdminTab && !me.isLoading && !profile.isLoading && !isAdmin) {
    return <Navigate to="/account" replace />;
  }

  return (
    <main className="mx-auto max-w-5xl px-4 md:px-8 py-8">
      <h1 className="text-2xl font-semibold text-[var(--text)]">Account</h1>
      <nav className="mt-4 flex gap-6 border-b border-[var(--surface-2)]">
        <NavLink to="/account" end className={tab}>Overview</NavLink>
        <NavLink to="/account/menu" className={tab}>My Menu</NavLink>
        {isAdmin && <NavLink to="/account/library" className={tab}>Library</NavLink>}
        {isAdmin && <NavLink to="/account/settings" className={tab}>Settings</NavLink>}
      </nav>
      <div className="pt-6">
        <Outlet />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Implement AccountOverview (profile header + switch + logout)**

Create `apps/web/src/pages/account/AccountOverview.tsx`:

```tsx
import { Link } from "react-router";
import { Avatar, Button } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { useMyProfile } from "@/lib/queries";

async function handleLogout() {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // Navigate regardless so the user isn't stuck.
  }
  window.location.href = "/login";
}

export default function AccountOverview() {
  const { data } = useMyProfile();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-4">
        <Avatar name={data?.name ?? "?"} src={data?.avatar ?? undefined} size={64} />
        <div>
          <p className="text-lg font-medium text-[var(--text)]">{data?.name ?? ""}</p>
          <p className="text-sm text-[var(--text-dim)]">{data?.kind === "kids" ? "Kids profile" : "Standard profile"}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link to="/profiles">
          <Button variant="ghost">Switch profile</Button>
        </Link>
        <Button variant="ghost" onClick={handleLogout}>Log out</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Implement AccountMenuPage**

Create `apps/web/src/pages/account/AccountMenuPage.tsx`:

```tsx
import ProfileMenuEditor from "@/components/account/ProfileMenuEditor";

export default function AccountMenuPage() {
  return (
    <section>
      <h2 className="mb-4 text-lg font-medium text-[var(--text)]">My Menu</h2>
      <ProfileMenuEditor />
    </section>
  );
}
```

- [ ] **Step 4: Typecheck**

Run:
```bash
pnpm --filter @orbix/web typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/account
git commit -m "feat(web): account hub — layout, overview, menu tab"
```

---

## Task 14: Router — account routes + admin redirects

**Files:**
- Modify: `apps/web/src/router.tsx`

**Interfaces:**
- Consumes: `AccountLayout`, `AccountOverview`, `AccountMenuPage`, existing `AdminLibrariesPage`/`AdminSettingsPage`, `Navigate`.
- Produces: routes `/account` (index → Overview, `menu`, `library`, `settings`); `/admin/libraries`→`/account/library`, `/admin/settings`→`/account/settings`.

- [ ] **Step 1: Update the router**

Replace `apps/web/src/router.tsx` with:

```tsx
import { createBrowserRouter, Navigate } from "react-router";
import RequireProfile from "./routes/RequireProfile";
import LoginPage from "./pages/LoginPage";
import SetupPage from "./pages/SetupPage";
import ProfilesPage from "./pages/ProfilesPage";
import HomePage from "./pages/HomePage";
import LibraryPage from "./pages/LibraryPage";
import SearchPage from "./pages/SearchPage";
import TitlePage from "./pages/TitlePage";
import FixMatchPage from "./pages/FixMatchPage";
import AdminLibrariesPage from "./pages/AdminLibrariesPage";
import AdminSettingsPage from "./pages/AdminSettingsPage";
import AccountLayout from "./pages/account/AccountLayout";
import AccountOverview from "./pages/account/AccountOverview";
import AccountMenuPage from "./pages/account/AccountMenuPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/setup", element: <SetupPage /> },
  { path: "/profiles", element: <ProfilesPage /> },
  {
    element: <RequireProfile />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/library/:sectionId", element: <LibraryPage /> },
      { path: "/search", element: <SearchPage /> },
      { path: "/title/:id", element: <TitlePage /> },
      { path: "/title/:id/fix", element: <FixMatchPage /> },
      {
        path: "/account",
        element: <AccountLayout />,
        children: [
          { index: true, element: <AccountOverview /> },
          { path: "menu", element: <AccountMenuPage /> },
          { path: "library", element: <AdminLibrariesPage /> },
          { path: "settings", element: <AdminSettingsPage /> },
        ],
      },
      { path: "/admin/libraries", element: <Navigate to="/account/library" replace /> },
      { path: "/admin/settings", element: <Navigate to="/account/settings" replace /> },
    ],
  },
]);
```

- [ ] **Step 2: Confirm the admin pages don't double-render a `<main>` problem**

`AdminLibrariesPage`/`AdminSettingsPage` render their own `<main>`/content; they now sit inside `AccountLayout`'s `<main>`. To avoid nested `<main>`, AccountLayout uses `<main>` and these pages render inside its `<Outlet/>`. If lint/HTML-validation complains about nested `<main>`, change `AccountLayout`'s wrapper from `<main>` to `<div>`. (Functionally both work; pick `<div>` if a nested-landmark warning appears.)

- [ ] **Step 3: Typecheck + lint**

Run:
```bash
pnpm --filter @orbix/web typecheck
pnpm --filter @orbix/web lint
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/router.tsx
git commit -m "feat(web): /account hub routes + /admin redirects"
```

---

## Task 15: Full-page search rework

**Files:**
- Modify: `apps/web/src/pages/SearchPage.tsx`

**Interfaces:**
- Consumes: `useSearch` (existing). No API change.
- Produces: search page with a prominent top search bar, autofocused on mount.

- [ ] **Step 1: Rework SearchPage**

Replace `apps/web/src/pages/SearchPage.tsx` with:

```tsx
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { useSearch } from "@/lib/queries";
import PosterCard from "@/components/PosterCard";
import { SearchIcon } from "@/components/shell/icons";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { data, isFetching, error } = useSearch(submitted);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSubmitted(query.trim());
  }

  const errorMsg = error
    ? error instanceof ApiError && error.status === 401
      ? "Please sign in to search."
      : "Search failed. Please try again."
    : null;
  const results = data?.items ?? null;
  const usedEmbeddings = data?.usedEmbeddings ?? false;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 md:px-8 py-6">
      <form onSubmit={handleSubmit} className="sticky top-14 z-10 -mx-4 bg-[var(--bg,transparent)] px-4 py-2">
        <div className="flex items-center gap-3 rounded-full border border-[var(--surface-2)] bg-[var(--surface)] px-4 py-3 focus-within:ring-2 focus-within:ring-[var(--accent)]">
          <SearchIcon className="h-5 w-5 text-[var(--text-dim)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search — e.g. comedy under 2 hours, something funny and lighthearted"
            className="flex-1 bg-transparent text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none"
            aria-label="Search query"
          />
          {isFetching && <span className="text-xs text-[var(--text-dim)]">Searching…</span>}
        </div>
      </form>

      {errorMsg && <p className="text-sm text-red-400">{errorMsg}</p>}

      {results !== null && (
        <>
          <div className="flex items-center gap-3">
            <p className="text-sm text-[var(--text-dim)]">
              {results.length} result{results.length !== 1 ? "s" : ""}
            </p>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                usedEmbeddings ? "bg-purple-900/50 text-purple-300" : "bg-[var(--surface)] text-[var(--text-dim)]"
              }`}
            >
              {usedEmbeddings ? "semantic" : "keyword"}
            </span>
          </div>

          {results.length === 0 ? (
            <p className="text-[var(--text-dim)]">No results found.</p>
          ) : (
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 md:gap-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
              {results.map((item) => (
                <PosterCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run:
```bash
pnpm --filter @orbix/web typecheck
pnpm --filter @orbix/web lint
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/SearchPage.tsx
git commit -m "feat(web): full-page search with autofocused top bar"
```

---

## Task 16: Full gates + e2e fixes + manual smoke

**Files:**
- Modify (as needed): Playwright e2e specs under `apps/web` (and any test that navigated via the old sidebar/logout).

- [ ] **Step 1: Run the full gate suite**

Run:
```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
Expected: PASS. Fix any failures before continuing. Likely touch-ups:
- Web unit tests or snapshots referencing the removed `Sidebar`/`TopBar`.
- Any api admin-route test that authenticates but lacks an `account.findUnique → { isAdmin: true }` stub (now 403s) — add the stub.

- [ ] **Step 2: Find and update e2e specs that used the old nav**

Run:
```bash
rg -l "Switch profile|Log out|/admin/|getByRole\\('link'.*Search|sidebar|Manage" apps/web --glob '*.spec.ts' --glob '*.e2e.ts' -i
```
For each hit, update selectors/flows:
- **Logout** now lives on `/account` (Overview). Navigate to the account avatar (`getByRole('link', { name: 'Account' })`) → click "Log out".
- **Switch profile** now lives on `/account` Overview ("Switch profile").
- **Manage/Settings** links → navigate to `/account/library` / `/account/settings` (or via the Account tabs).
- **Search** is the top-bar search icon (`getByRole('link', { name: 'Search' })`) → `/search`.

- [ ] **Step 3: Run e2e against a throwaway DB**

Ensure postgres + redis are up and point e2e at a disposable DB (its global-setup wipes accounts/profiles — never the dev DB). Run:
```bash
pnpm --filter @orbix/web test:e2e
```
Expected: PASS. Fix selectors until green.

- [ ] **Step 4: Manual smoke (host dev), then reap servers**

Bring up the app and verify by hand:
- Top bar is transparent over the home hero, turns solid on scroll.
- Center shows Home · TV (inert, "Coming soon") · category links; overflow collapses into "More".
- Right shows Heart (inert) · Search (→ full-page search, input autofocused) · Avatar (→ `/account`).
- `/account`: Overview (Switch profile, Log out), My Menu (toggle/reorder → Save → nav updates), and — for an admin, non-kids profile — Library + Settings tabs; old `/admin/libraries` redirects to `/account/library`.
- A kids profile sees no Library/Settings tabs and gets bounced from `/account/library`.
- Mobile width: top bar shows Logo + Search + Avatar; bottom tab bar with Home/TV/Catalog/Search/Account; Catalog opens the categories sheet.

Then reap host dev servers to avoid EMFILE / stale-server reuse:
```bash
pkill -f "tsx.*watch src/server.ts"; pkill -f vite
```

- [ ] **Step 5: Final commit (any e2e/test fixes)**

```bash
git add -A
git commit -m "test: update e2e + unit specs for top-nav redesign"
```

---

## Self-Review

**Spec coverage:**
- Floating top bar transparent→solid (spec §1,§4,§7) → Task 8 (`useScrolled`).
- Inline category links + overflow (spec §2.3,§6) → Tasks 7–8 (`NavCategories`).
- Per-profile menu data model + default-all (spec §3) → Task 1 + Task 2 resolver.
- `/me/menu*` API (spec §5) → Task 5.
- `/auth/me` isAdmin + admin gating (spec §2.6,§5) → Tasks 3–4.
- Account hub tabs + redirects (spec §2,§6 Account) → Tasks 13–14.
- Menu editor on account page (spec §6) → Tasks 11–13.
- Mobile bottom tab bar + Catalog sheet (spec §5 mobile) → Task 9.
- Full-page search autofocus (spec §6 Search) → Task 15.
- Placeholders TV/Heart (spec §2.7,§7) → Task 8 (`Placeholder`).
- Remove Sidebar/TopBar (spec §6) → Task 10.
- Tests core/api/web/e2e (spec §8) → Tasks 2,3,4,5,7,11,12 + 16.

**Placeholder scan:** No "TBD/TODO/handle edge cases" — each code step carries full code. The two judgment calls (nested-`<main>` → switch to `<div>`; `maxVisible` overflow threshold) are explicit with the exact change to make.

**Type consistency:** `MenuItem {sectionId,name,libraryName}` is identical across types.ts, API responses, `resolveProfileMenu`'s `ResolvedMenuItem`, NavCategories, BottomNav, ProfileMenuEditor. `AuthMe {accountId,isAdmin}` matches `/auth/me` and `useAuthMe`. `saveMenu(string[])` matches the editor's call and the `PUT /me/menu` body `{sectionIds}`. `moveItem(list,index,dir)` matches its test and editor usage. Hook query keys (`["menu"]`, `["menu-config"]`, `["auth-me"]`) are consistent between definition, invalidation, and test seeding.

---

## Execution Handoff

Plan saved. Two execution options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
