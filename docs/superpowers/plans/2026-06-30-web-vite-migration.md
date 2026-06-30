# Web UI Migration (Next.js → Vite React SPA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Next.js Node web server with a static Vite React SPA served same-origin by Fastify, making the UI fast on low-end devices and removing a Node process, with zero loss of existing behavior.

**Architecture:** `apps/web` becomes a Vite SPA (React Router v8 client routing, TanStack Query for data/caching). All existing React components, Tailwind tokens, and the Vidstack/hls.js player are reused. Server-side auth/profile gating moves to a client route guard backed by an extended `GET /me/profile`. Fastify serves the built `dist/` via `@fastify/static` with an SPA fallback; the separate `web` container is retired in production.

**Tech Stack:** Vite 8 · `@vitejs/plugin-react` 6 · React 19.2 · `react-router` 8.1 · `@tanstack/react-query` 5.101 · Tailwind 4.3 (`@tailwindcss/vite`) · Vitest 4.1 · `@fastify/static` · `@vidstack/react` ^1 + `hls.js` 1.6 (unchanged).

## Global Constraints

- **Pin exact versions** for `react-router` (8.1.x) and `vite` (8.1.x); React Router v8 is recently GA — `react-router@7.18.1` is the documented fallback if a blocker appears.
- **Browser code calls only relative `/api/...`** via `apiFetch` (`apps/web/src/lib/api.ts`); never hardcode an absolute API origin (breaks LAN/CORS).
- **Kids/maturity filtering is server-enforced** on every route; this migration must not move any gating to UI-only. The client guard is UX convenience; the API remains authoritative.
- **Offline guarantee:** hls.js stays bundled and wired via the Vidstack provider `library` prop (no CDN). Do not reintroduce a CDN player load.
- **`MediaFile.size` is a Prisma `BigInt`** — already serialized as string in API routes; do not change.
- **Run `pnpm lint` (or `pnpm --filter <pkg> lint`) per change**, not just typecheck+test — Turbo caches hide lint-only errors.
- **Reap host dev servers after smokes:** `pkill -f "tsx.*watch src/server.ts"`, `pkill -f vite`, free ports 1060/1061 (avoids EMFILE + Playwright reusing a stale server).
- Ports unchanged: web dev 1060, api 1061, postgres 1062, redis 1063.
- Commit after every task. Branch is `feat/web-vite-migration` (already created).

---

## Task 1: Extend `GET /me/profile` to return the full active profile

The client guard needs the selected profile's identity (id/name/avatar) — not just `kind` — because the browser cannot read the httpOnly `orbix_profile` cookie. This is the one API change. It is additive: the existing consumer (`apps/web` title page) reads only `kind`, which is preserved.

**Files:**
- Modify: `apps/api/src/lib/catalog-filter.ts:33-43` (widen `activeProfile` select)
- Modify: `apps/api/src/routes/profiles.ts:8-13` (`/me/profile` handler)
- Test: `apps/api/src/routes/profiles.test.ts` (create)

**Interfaces:**
- Produces: `GET /me/profile` → `{ id: string; name: string; avatar: string | null; kind: string; maturityCap: number | null }` when a profile is selected, else `{ id: null; name: null; avatar: null; kind: null; maturityCap: null }`. Requires auth (401 otherwise).
- `activeProfile(app, req)` now returns `{ id; name; avatar; kind; maturityCap } | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/profiles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true,
};

describe("GET /me/profile", () => {
  it("returns the full active profile when a valid profile cookie is set", async () => {
    const app = await buildApp(env);
    // Authenticated session + a selected profile.
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    (app as any).prisma.profile = {
      findUnique: async () => ({ id: "p1", name: "Alex", avatar: null, kind: "kids", maturityCap: 1 }),
    };
    const res = await app.inject({
      method: "GET", url: "/me/profile",
      cookies: { orbix_session: "s1", orbix_profile: "p1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "p1", name: "Alex", avatar: null, kind: "kids", maturityCap: 1 });
    await app.close();
  });

  it("returns all-null when no profile cookie is set", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    const res = await app.inject({ method: "GET", url: "/me/profile", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: null, name: null, avatar: null, kind: null, maturityCap: null });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/profiles.test.ts`
Expected: FAIL — current handler returns `{ kind }` only (first test mismatches the full-object assertion).

- [ ] **Step 3: Widen `activeProfile`**

In `apps/api/src/lib/catalog-filter.ts`, change the `activeProfile` signature and select (lines 33-43):

```ts
export async function activeProfile(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ id: string; name: string; avatar: string | null; kind: string; maturityCap: number | null } | null> {
  const profileId = req.cookies["orbix_profile"];
  if (!profileId) return null;
  return app.prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true, name: true, avatar: true, kind: true, maturityCap: true },
  });
}
```

(Other callers read only `kind`/`maturityCap`/`id`; the added fields are harmless.)

- [ ] **Step 4: Update the `/me/profile` handler**

In `apps/api/src/routes/profiles.ts`, replace the handler body (lines 8-13):

```ts
  // GET /me/profile — returns the active profile (for UI gating + the client route guard)
  app.get("/me/profile", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.send({ id: null, name: null, avatar: null, kind: null, maturityCap: null });
    return reply.send(profile);
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/profiles.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/catalog-filter.ts apps/api/src/routes/profiles.ts apps/api/src/routes/profiles.test.ts
git commit -m "feat(api): /me/profile returns full active profile for the SPA guard"
```

---

## Task 2: Serve the built SPA from Fastify (`@fastify/static` + SPA fallback)

Fastify serves `apps/web/dist` at `/` when that directory exists (production image), with a fallback that returns `index.html` for client routes and JSON 404s for unknown `/api/*`. Inert in dev (no `dist/`).

**Files:**
- Modify: `apps/api/package.json` (add `@fastify/static`)
- Create: `apps/api/src/plugins/static-web.ts`
- Modify: `apps/api/src/app.ts` (register after API routes)
- Test: `apps/api/src/plugins/static-web.test.ts` (create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `staticWebPlugin(opts?: { distDir?: string })` — a Fastify plugin. When `distDir` exists: serves files at `/`, and an unmatched non-`/api` GET returns `index.html`; unmatched `/api/*` returns `{ error: "not_found" }` 404.

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @orbix/api add @fastify/static`

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/plugins/static-web.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/plugins/static-web.test.ts`
Expected: FAIL with "Cannot find module './static-web'".

- [ ] **Step 4: Implement the plugin**

Create `apps/api/src/plugins/static-web.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";

// Serves the built Vite SPA (apps/web/dist) at "/" with an SPA fallback.
// No-op when the dist directory is absent (e.g. local dev where Vite serves the UI).
export const staticWebPlugin = fp(async (app, opts: { distDir?: string }) => {
  const distDir =
    opts.distDir ??
    process.env.WEB_DIST ??
    join(process.cwd(), "apps/web/dist");

  if (!existsSync(join(distDir, "index.html"))) {
    app.log.info({ distDir }, "static-web: no SPA build found; skipping static serving");
    return;
  }

  await app.register(fastifyStatic, { root: distDir, wildcard: false });

  // Unmatched routes: client-route GETs get index.html; anything under /api 404s as JSON.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });
});
```

- [ ] **Step 5: Register it in `app.ts`**

In `apps/api/src/app.ts`, add the import near the other plugin imports:

```ts
import { staticWebPlugin } from "./plugins/static-web";
```

Then register it **after** all `routes/*` registrations and before the `return app;` (so API routes win and the fallback only catches the rest). Insert after line 48 (`await app.register(refreshRoute(env));`):

```ts
  // Serve the built SPA last so its catch-all fallback sits below the API routes.
  await app.register(staticWebPlugin, {});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @orbix/api exec vitest run src/plugins/static-web.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/src/plugins/static-web.ts apps/api/src/app.ts apps/api/src/plugins/static-web.test.ts pnpm-lock.yaml
git commit -m "feat(api): serve the Vite SPA with @fastify/static + SPA fallback"
```

---

## Task 3: Scaffold the Vite app (config, entry, deps) — keep Next files until ported

Stand up Vite alongside the existing Next pages so the app still typechecks while we port. New deps, Vite config, HTML entry, tsconfig, a temporary `main.tsx` rendering a placeholder.

**Files:**
- Modify: `apps/web/package.json` (deps + scripts)
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx` (temporary placeholder; replaced in Task 5)
- Create: `apps/web/src/vite-env.d.ts`
- Create: `apps/web/src/index.css` (moved from `src/app/globals.css`)
- Modify: `apps/web/tsconfig.json`

**Interfaces:**
- Produces: `pnpm --filter @orbix/web dev` runs Vite on :1060 proxying `/api`→:1061; `pnpm --filter @orbix/web build` emits `apps/web/dist`.

- [ ] **Step 1: Update dependencies**

Run:

```bash
pnpm --filter @orbix/web add react-router@8.1 @tanstack/react-query@5.101
pnpm --filter @orbix/web add -D vite@8.1 @vitejs/plugin-react@6 @tailwindcss/vite@4.3 vitest@4.1 jsdom @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 2: Replace scripts in `apps/web/package.json`**

Set the `"scripts"` block to:

```json
  "scripts": {
    "dev": "vite --port 1060",
    "build": "vite build",
    "preview": "vite preview --port 1060",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "lint": "eslint ."
  },
```

(Leave `next`, `@tailwindcss/postcss` in `devDependencies` for now; removed in Task 17.)

- [ ] **Step 3: Create `apps/web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const API = process.env.API_INTERNAL_URL ?? "http://localhost:1061";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@orbix/ui": fileURLToPath(new URL("../../packages/ui/src", import.meta.url)),
    },
  },
  server: {
    port: 1060,
    proxy: {
      // SSE scan stream must stream, not buffer.
      "/api": { target: API, changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
```

- [ ] **Step 4: Create `apps/web/src/test-setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 5: Create `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Orbix</title>
  </head>
  <body class="min-h-screen">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Move global CSS**

Move `apps/web/src/app/globals.css` → `apps/web/src/index.css` and set its contents (fix the `@source` depth — now 3 levels up from `src/`):

```css
@import "tailwindcss";
@source "../../../packages/ui/src";
```

```bash
git mv apps/web/src/app/globals.css apps/web/src/index.css
```

(then edit the `@source` line as above)

- [ ] **Step 7: Create `apps/web/src/vite-env.d.ts`**

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 8: Create the temporary `apps/web/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@orbix/ui/src/tokens.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="p-8 text-[var(--text)]">Orbix SPA scaffold OK</div>
  </StrictMode>,
);
```

- [ ] **Step 9: Update `apps/web/tsconfig.json`**

Replace with:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "types": ["vite/client", "node"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vite.config.ts"],
  "exclude": ["node_modules", "e2e", "dist"]
}
```

- [ ] **Step 10: Verify scaffold builds**

Run: `pnpm --filter @orbix/web build`
Expected: PASS — emits `apps/web/dist/index.html` + assets. (Next's `app/` dir is ignored by Vite.)

- [ ] **Step 11: Commit**

```bash
git add apps/web/package.json apps/web/vite.config.ts apps/web/index.html apps/web/src/main.tsx apps/web/src/vite-env.d.ts apps/web/src/index.css apps/web/src/test-setup.ts apps/web/tsconfig.json pnpm-lock.yaml
git rm apps/web/src/app/globals.css 2>/dev/null || true
git commit -m "chore(web): scaffold Vite + React Router + TanStack Query (parallel to Next)"
```

---

## Task 4: Data layer — `apiJson` helper + `QueryClient` + query hooks

A thin error-typed wrapper over `apiFetch`, a shared `QueryClient`, and the query hooks the pages will consume.

**Files:**
- Modify: `apps/web/src/lib/api.ts` (add `ApiError` + `apiJson`)
- Create: `apps/web/src/lib/queryClient.ts`
- Create: `apps/web/src/lib/queries.ts`
- Test: `apps/web/src/lib/api.test.ts` (create)

**Interfaces:**
- Produces:
  - `class ApiError extends Error { status: number }`
  - `apiJson<T>(path: string, init?: RequestInit): Promise<T>` — throws `ApiError` on non-2xx.
  - `queryClient: QueryClient`
  - Hooks: `useSetupStatus()`, `useMyProfile()`, `useLibraries()`, `useHomeRows()`, `useItem(id)`, `useSectionItems(sectionId, sort, q)`, `useSearch(q)`, `useSettings()`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { apiJson, ApiError } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("apiJson", () => {
  it("returns parsed JSON on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })));
    await expect(apiJson<{ ok: number }>("/x")).resolves.toEqual({ ok: 1 });
  });

  it("throws ApiError with the status on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(apiJson("/x")).rejects.toMatchObject({ status: 401 });
    await expect(apiJson("/x")).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/web exec vitest run src/lib/api.test.ts`
Expected: FAIL — `apiJson`/`ApiError` not exported.

- [ ] **Step 3: Extend `apps/web/src/lib/api.ts`**

Append to the existing file (keep `apiFetch` as-is):

```ts
export class ApiError extends Error {
  constructor(public status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/web exec vitest run src/lib/api.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Create `apps/web/src/lib/queryClient.ts`**

```ts
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // back-nav renders instantly from cache
      retry: (count, err) => !(err instanceof ApiError) && count < 2, // never retry 4xx
      refetchOnWindowFocus: false,
    },
  },
});
```

- [ ] **Step 6: Create `apps/web/src/lib/queries.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { apiJson } from "./api";
import type { Library, MediaCard, Profile } from "./types";

export interface SetupStatus { complete: boolean }
export interface ActiveProfile {
  id: string | null; name: string | null; avatar: string | null;
  kind: string | null; maturityCap: number | null;
}

export function useSetupStatus() {
  return useQuery({ queryKey: ["setup-status"], queryFn: () => apiJson<SetupStatus>("/setup/status") });
}
export function useMyProfile() {
  return useQuery({ queryKey: ["me-profile"], queryFn: () => apiJson<ActiveProfile>("/me/profile") });
}
export function useLibraries() {
  return useQuery({ queryKey: ["libraries"], queryFn: () => apiJson<Library[]>("/libraries") });
}
export function useProfiles() {
  return useQuery({ queryKey: ["profiles"], queryFn: () => apiJson<Profile[]>("/profiles") });
}

export interface HomeRow { key: string; title: string; items: MediaCard[] }
export function useHomeRows() {
  return useQuery({ queryKey: ["home-rows"], queryFn: () => apiJson<{ rows: HomeRow[] }>("/home/rows") });
}

export function useSectionItems(sectionId: string | undefined, sort: string, q: string) {
  return useQuery({
    queryKey: ["section-items", sectionId, sort, q],
    enabled: !!sectionId,
    queryFn: () => {
      const qs = new URLSearchParams({ sort });
      if (q) qs.set("q", q);
      return apiJson<MediaCard[]>(`/sections/${sectionId}/items?${qs}`);
    },
  });
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: ["search", q],
    enabled: q.trim().length > 0,
    queryFn: () => apiJson<MediaCard[]>(`/search?q=${encodeURIComponent(q.trim())}`),
  });
}
```

- [ ] **Step 7: Verify typecheck**

Run: `pnpm --filter @orbix/web typecheck`
Expected: PASS (note: the new modules typecheck; legacy Next pages may still typecheck under the new tsconfig — if a Next-only type error appears here, it will be resolved when that page is ported in a later task; if it blocks, port order can move that page earlier).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/lib/queryClient.ts apps/web/src/lib/queries.ts
git commit -m "feat(web): apiJson error wrapper + QueryClient + query hooks"
```

---

## Task 5: Routing skeleton + auth/profile guard

Build the real router: a pure `decideRedirect` helper (unit-tested), a `RequireProfile` guard component, the protected layout route (renders `AppShell` + `<Outlet/>`), and `main.tsx` wiring `QueryClientProvider` + `RouterProvider`. Pages are stubbed here and filled in Tasks 6-14.

**Files:**
- Create: `apps/web/src/routes/decideRedirect.ts`
- Create: `apps/web/src/routes/RequireProfile.tsx`
- Create: `apps/web/src/router.tsx`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/src/routes/decideRedirect.test.ts` (create)

**Interfaces:**
- Consumes: `useSetupStatus`, `useMyProfile`, `useLibraries` (Task 4); `AppShell` (Task 6).
- Produces:
  - `decideRedirect(s: { setupComplete?: boolean; authError401?: boolean; profileSelected?: boolean }): "/setup" | "/login" | "/profiles" | null`
  - `<RequireProfile>` — renders `AppShell` + `<Outlet/>` once authed with a selected profile; otherwise `<Navigate>`s.
  - `router` (a `createBrowserRouter` instance).

- [ ] **Step 1: Write the failing test for the pure decision fn**

Create `apps/web/src/routes/decideRedirect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decideRedirect } from "./decideRedirect";

describe("decideRedirect", () => {
  it("sends to /setup when setup incomplete", () => {
    expect(decideRedirect({ setupComplete: false })).toBe("/setup");
  });
  it("sends to /login on a 401", () => {
    expect(decideRedirect({ setupComplete: true, authError401: true })).toBe("/login");
  });
  it("sends to /profiles when authed but no profile selected", () => {
    expect(decideRedirect({ setupComplete: true, profileSelected: false })).toBe("/profiles");
  });
  it("returns null when setup complete, authed, and a profile is selected", () => {
    expect(decideRedirect({ setupComplete: true, profileSelected: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/web exec vitest run src/routes/decideRedirect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `decideRedirect`**

Create `apps/web/src/routes/decideRedirect.ts`:

```ts
export function decideRedirect(s: {
  setupComplete?: boolean;
  authError401?: boolean;
  profileSelected?: boolean;
}): "/setup" | "/login" | "/profiles" | null {
  if (s.setupComplete === false) return "/setup";
  if (s.authError401) return "/login";
  if (s.profileSelected === false) return "/profiles";
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/web exec vitest run src/routes/decideRedirect.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Implement `RequireProfile`**

Create `apps/web/src/routes/RequireProfile.tsx`:

```tsx
import { Navigate, Outlet } from "react-router";
import { ApiError } from "@/lib/api";
import { useSetupStatus, useMyProfile, useLibraries } from "@/lib/queries";
import { decideRedirect } from "./decideRedirect";
import AppShell from "@/components/shell/AppShell";

export default function RequireProfile() {
  const setup = useSetupStatus();
  const me = useMyProfile();
  const libs = useLibraries();

  if (setup.isLoading || me.isLoading) {
    return <div className="p-8 text-[var(--text-dim)]">Loading…</div>;
  }

  const authError401 = me.error instanceof ApiError && me.error.status === 401;
  const target = decideRedirect({
    setupComplete: setup.data?.complete,
    authError401,
    profileSelected: !!me.data?.id,
  });
  if (target) return <Navigate to={target} replace />;

  const profile = me.data
    ? { id: me.data.id!, name: me.data.name!, avatar: me.data.avatar, kind: me.data.kind!, maturityCap: me.data.maturityCap }
    : null;

  return (
    <AppShell libraries={libs.data ?? []} profile={profile} isKids={me.data?.kind === "kids"}>
      <Outlet />
    </AppShell>
  );
}
```

- [ ] **Step 6: Create the router with page stubs**

Create `apps/web/src/router.tsx` (page imports point at the files that will be ported in later tasks; the lazy public pages already exist as Next `"use client"` components and will be edited in place):

```tsx
import { createBrowserRouter } from "react-router";
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
      { path: "/admin/libraries", element: <AdminLibrariesPage /> },
      { path: "/admin/settings", element: <AdminSettingsPage /> },
    ],
  },
]);
```

> **Decomposition decision:** pages move from `src/app/**/page.tsx` to flat `src/pages/*.tsx` (one file per route, plain components). Tasks 6-14 create these `src/pages/*` files by relocating + transforming the existing page bodies. This removes the App Router directory convention cleanly.

- [ ] **Step 7: Wire `main.tsx`**

Replace `apps/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { router } from "./router";
import "@orbix/ui/src/tokens.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 8: Run the decision test (router won't build until Tasks 6-14 create the page files)**

Run: `pnpm --filter @orbix/web exec vitest run src/routes/decideRedirect.test.ts`
Expected: PASS. (A full `build` is deferred to Task 14, after all `src/pages/*` exist. This is the one intentional cross-task dependency; do Tasks 6-14 before the next `build`.)

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/routes apps/web/src/router.tsx apps/web/src/main.tsx
git commit -m "feat(web): router + RequireProfile guard + decideRedirect (pages stubbed)"
```

---

## Task 6: Port the shell + link components (AppShell, Sidebar, Hero, PosterCard)

Swap `next/link`→`react-router` `Link` (`href`→`to`) and `usePathname()`→`useLocation().pathname`. Components stay in `src/components/`.

**Files:**
- Modify: `apps/web/src/components/shell/AppShell.tsx`
- Modify: `apps/web/src/components/shell/Sidebar.tsx`
- Modify: `apps/web/src/components/Hero.tsx`
- Modify: `apps/web/src/components/PosterCard.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: shell + cards usable by `RequireProfile` (Task 5) and page components.

- [ ] **Step 1: AppShell — replace `usePathname`**

In `apps/web/src/components/shell/AppShell.tsx`:
- Delete line 1 `"use client";`
- Replace line 4 `import { usePathname } from "next/navigation";` → `import { useLocation } from "react-router";`
- Replace line 21 `const pathname = usePathname();` → `const { pathname } = useLocation();`

- [ ] **Step 2: Sidebar — replace `Link` + `usePathname`**

In `apps/web/src/components/shell/Sidebar.tsx`:
- Delete line 1 `"use client";`
- Replace lines 3-4:
  ```ts
  import { Link, useLocation } from "react-router";
  ```
- Replace line 79 `const pathname = usePathname();` → `const { pathname } = useLocation();`
- In the `NavLink` component (lines 29-39) and every `<Link href=...>` in this file, rename the `href` prop to `to`. Concretely: `NavLink` passes `href` to `<Link>` — change `<Link href={href} ...>` → `<Link to={href} ...>` (keep the `NavLink` prop name `href` for its own signature; only the inner react-router `<Link>` needs `to`). The wordmark, "Switch profile" links: `<Link href="/" ...>`→`<Link to="/" ...>`, `<Link href="/profiles" ...>`→`<Link to="/profiles" ...>`.
- `handleLogout` keeps `window.location.href = "/login"` (intentional full reload to clear cookies and re-run the guard).

- [ ] **Step 3: Hero — replace `Link`**

In `apps/web/src/components/Hero.tsx`:
- Delete line 1 `"use client";`
- Replace line 4 `import Link from "next/link";` → `import { Link } from "react-router";`
- Lines 67 & 70: `<Link href={\`/title/${active.id}\`}>` → `<Link to={\`/title/${active.id}\`}>` (both).

- [ ] **Step 4: PosterCard — replace `Link`**

In `apps/web/src/components/PosterCard.tsx`:
- Replace line 1 `import Link from "next/link";` → `import { Link } from "react-router";`
- Line 25: `<Link href={\`/title/${item.id}\`} ...>` → `<Link to={\`/title/${item.id}\`} ...>`

- [ ] **Step 5: Verify typecheck of components**

Run: `pnpm --filter @orbix/web typecheck`
Expected: these components compile against react-router. (Page files not yet created may error — acceptable until Task 14; if blocking, continue the port tasks.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components
git commit -m "feat(web): port shell + card components to react-router links"
```

---

## Task 7: Port public pages (Login, Setup, Profiles) → `src/pages/`

Relocate the three public pages and swap `useRouter().replace(x)`→`useNavigate()(x, { replace: true })`.

**Files:**
- Create: `apps/web/src/pages/LoginPage.tsx` (from `src/app/login/page.tsx`)
- Create: `apps/web/src/pages/SetupPage.tsx` (from `src/app/setup/page.tsx`)
- Create: `apps/web/src/pages/ProfilesPage.tsx` (from `src/app/profiles/page.tsx`)

**Interfaces:**
- Produces: `LoginPage`, `SetupPage`, `ProfilesPage` default exports for the router.

- [ ] **Step 1: Move the files**

```bash
mkdir -p apps/web/src/pages
git mv apps/web/src/app/login/page.tsx apps/web/src/pages/LoginPage.tsx
git mv apps/web/src/app/setup/page.tsx apps/web/src/pages/SetupPage.tsx
git mv apps/web/src/app/profiles/page.tsx apps/web/src/pages/ProfilesPage.tsx
```

- [ ] **Step 2: LoginPage — swap navigation**

In `apps/web/src/pages/LoginPage.tsx`:
- Delete line 1 `"use client";`
- Replace `import { useRouter } from "next/navigation";` → `import { useNavigate } from "react-router";`
- Replace `const router = useRouter();` → `const navigate = useNavigate();`
- Replace `router.replace("/profiles");` → `navigate("/profiles", { replace: true });`

- [ ] **Step 3: SetupPage — swap navigation**

Same three edits as Step 2 (it also navigates to `/profiles`).

- [ ] **Step 4: ProfilesPage — swap navigation**

In `apps/web/src/pages/ProfilesPage.tsx`:
- Delete line 1 `"use client";`
- Replace `import { useRouter } from "next/navigation";` → `import { useNavigate } from "react-router";`
- Replace `const router = useRouter();` → `const navigate = useNavigate();`
- Replace `router.replace("/login");` → `navigate("/login", { replace: true });`
- Replace `router.replace("/");` → `navigate("/", { replace: true });`

- [ ] **Step 5: Verify typecheck**

Run: `pnpm --filter @orbix/web typecheck`
Expected: the three public pages compile (remaining errors only from not-yet-created `(app)` pages).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages
git commit -m "feat(web): port login/setup/profiles pages to react-router navigation"
```

---

## Task 8: Port the Home page (server component → client query)

Convert the server-rendered home into a client component that uses `useHomeRows()` and derives the hero from item-detail queries.

**Files:**
- Create: `apps/web/src/pages/HomePage.tsx` (from `src/app/(app)/page.tsx`)
- Modify: `apps/web/src/components/HomeRows.tsx` (only if it imports a Next-coupled `HomeRow` type; re-export stays)

**Interfaces:**
- Consumes: `useHomeRows` (Task 4), `HomeRows`, `Hero` components.
- Produces: `HomePage` default export.

- [ ] **Step 1: Create `apps/web/src/pages/HomePage.tsx`**

```tsx
import { useQueries } from "@tanstack/react-query";
import { apiJson } from "@/lib/api";
import { useHomeRows } from "@/lib/queries";
import HomeRows from "@/components/HomeRows";
import Hero, { type HeroItem } from "@/components/Hero";

export default function HomePage() {
  const { data, isLoading } = useHomeRows();
  const rows = data?.rows ?? [];

  // Hero candidates: top of Continue Watching (or first row); fetch detail for backdrop/overview.
  const firstRow = rows.find((r) => r.key === "continue_watching") ?? rows[0];
  const candIds = (firstRow?.items ?? []).slice(0, 6).map((i) => i.id);
  const detailQueries = useQueries({
    queries: candIds.map((id) => ({
      queryKey: ["item", id] as const,
      queryFn: () => apiJson<HeroItem & { backdropPath: string | null }>(`/items/${id}`),
    })),
  });
  const heroItems: HeroItem[] = detailQueries
    .map((q) => q.data)
    .filter((d): d is NonNullable<typeof d> => Boolean(d && d.backdropPath))
    .slice(0, 5)
    .map((d) => ({ id: d.id, title: d.title, year: d.year, overview: d.overview, backdropPath: d.backdropPath, rating: d.rating }));

  if (isLoading) return <div className="p-8 text-[var(--text-dim)]">Loading…</div>;

  return (
    <div className="flex flex-col gap-6 pb-4">
      {heroItems.length > 0 && <Hero items={heroItems} />}
      <HomeRows rows={rows} />
    </div>
  );
}
```

- [ ] **Step 2: Reconcile the `HomeRow` type**

`HomeRows.tsx` currently exports `type HomeRow`. Ensure `useHomeRows()` returns the same shape. If `HomeRows`'s `HomeRow` differs from `queries.ts`'s `HomeRow`, import the component's type into `queries.ts` instead (single source). Concretely, in `apps/web/src/lib/queries.ts` replace the local `HomeRow` interface with:

```ts
import type { HomeRow } from "@/components/HomeRows";
export type { HomeRow };
```

and delete the duplicate interface. (If `HomeRows.tsx` has `"use client";` at line 1, delete it.)

- [ ] **Step 3: Remove the old server page**

```bash
git rm "apps/web/src/app/(app)/page.tsx"
```

- [ ] **Step 4: Verify typecheck of HomePage**

Run: `pnpm --filter @orbix/web typecheck`
Expected: HomePage + HomeRows compile.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/HomePage.tsx apps/web/src/components/HomeRows.tsx apps/web/src/lib/queries.ts
git commit -m "feat(web): port home page to TanStack Query"
```

---

## Task 9: Port the Library page (params + query)

**Files:**
- Create: `apps/web/src/pages/LibraryPage.tsx` (from `src/app/(app)/library/[sectionId]/page.tsx`)

**Interfaces:**
- Consumes: `useSectionItems` (Task 4), `PosterCard`.
- Produces: `LibraryPage` default export.

- [ ] **Step 1: Move the file**

```bash
git mv "apps/web/src/app/(app)/library/[sectionId]/page.tsx" apps/web/src/pages/LibraryPage.tsx
```

- [ ] **Step 2: Rewrite the data/params logic**

In `apps/web/src/pages/LibraryPage.tsx`:
- Delete line 1 `"use client";`
- Replace the imports block (lines 3-7) with:

```tsx
import { useState } from "react";
import { useParams } from "react-router";
import { Input } from "@orbix/ui";
import PosterCard from "@/components/PosterCard";
import { useSectionItems } from "@/lib/queries";
```

- Delete the `Props` interface (lines 9-11) and the `params` parameter.
- Replace the component header + state (lines 13-48) with:

```tsx
export default function LibraryPage() {
  const { sectionId } = useParams();
  const [sort, setSort] = useState("title");
  const [q, setQ] = useState("");
  const { data: items = [], isLoading, error } = useSectionItems(sectionId, sort, q);
```

- In the JSX, replace `{error && ...}` with `{error && <p className="mb-4 text-sm text-red-400">Failed to load items</p>}` and `{loading && ...}` with `{isLoading && <p className="text-[var(--text-dim)]">Loading…</p>}` and `{!loading && items.length === 0 && ...}` with `{!isLoading && items.length === 0 && ...}`. (The poster grid `{items.map(...)}` is unchanged.)

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @orbix/web typecheck`
Expected: LibraryPage compiles.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/LibraryPage.tsx
git commit -m "feat(web): port library page to useParams + TanStack Query"
```

---

## Task 10: Port the Search page (query)

**Files:**
- Create: `apps/web/src/pages/SearchPage.tsx` (from `src/app/(app)/search/page.tsx`)

**Interfaces:**
- Consumes: `useSearch` (Task 4), `PosterCard`.

- [ ] **Step 1: Move the file**

```bash
git mv "apps/web/src/app/(app)/search/page.tsx" apps/web/src/pages/SearchPage.tsx
```

- [ ] **Step 2: Convert fetch→query**

In `apps/web/src/pages/SearchPage.tsx`:
- Delete line 1 `"use client";`.
- Keep the local `query`/input state. Replace the manual `apiFetch("/search?...")` + results `useState`/`useEffect` with the `useSearch(submittedQuery)` hook: keep an input `query` state and a `submitted` state set on submit; call `const { data: results = [], isLoading, error } = useSearch(submitted);`. Render `results` exactly as before; map `isLoading`→the existing "searching" text and `error`→the existing error text. (The endpoint, query-encoding, and `MediaCard`/`PosterCard` rendering are unchanged.)
- Remove the `import { apiFetch } ...` if no longer referenced; add `import { useSearch } from "@/lib/queries";`.

- [ ] **Step 3: Verify typecheck + lint**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint`
Expected: PASS for this file.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/SearchPage.tsx
git commit -m "feat(web): port search page to TanStack Query"
```

---

## Task 11: Port the Title page (params + lazy Player + queries)

**Files:**
- Create: `apps/web/src/pages/TitlePage.tsx` (from `src/app/(app)/title/[id]/page.tsx`)

**Interfaces:**
- Consumes: `apiJson`, react-router `useParams`/`Link`, `Player` (lazy), `Button`.

- [ ] **Step 1: Move the file**

```bash
git mv "apps/web/src/app/(app)/title/[id]/page.tsx" apps/web/src/pages/TitlePage.tsx
```

- [ ] **Step 2: Swap framework APIs**

In `apps/web/src/pages/TitlePage.tsx`:
- Delete line 1 `"use client";`.
- Replace the imports (lines 3-9) with:

```tsx
import { useState, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Button } from "@orbix/ui";
import { apiJson, ApiError } from "@/lib/api";
import type { ActiveProfile } from "@/lib/queries";

const Player = lazy(() => import("@/components/Player"));
```

- Delete the `Props` interface (`params: Promise<{ id: string }>`) and both param-resolving `useEffect`s and the `id`/`item`/`loading`/`error`/`notFound`/`isKidsProfile` state. Replace with:

```tsx
export default function TitlePage() {
  const { id } = useParams();
  const [playing, setPlaying] = useState(false);

  const itemQuery = useQuery({
    queryKey: ["item", id],
    enabled: !!id,
    queryFn: () => apiJson<ItemDetail>(`/items/${id}`),
    retry: false,
  });
  const profileQuery = useQuery({ queryKey: ["me-profile"], queryFn: () => apiJson<ActiveProfile>("/me/profile") });
  const isKidsProfile = profileQuery.data?.kind === "kids";

  const notFound = itemQuery.error instanceof ApiError && itemQuery.error.status === 404;
  if (itemQuery.isLoading) return <main className="p-8"><p className="text-[var(--text-dim)]">Loading…</p></main>;
  if (notFound) return <main className="p-8"><h1 className="text-2xl font-bold text-[var(--text)]">Title not found</h1></main>;
  const item = itemQuery.data;
  if (!item) return <main className="p-8"><p className="text-sm text-red-400">Failed to load title</p></main>;
```

- Keep `ItemDetail`/`CastMember`/`MediaFile` interfaces and `formatRuntime` (they're independent of Next).
- Replace the Fix-match `<Link href={\`/title/${id}/fix\`} ...>` → `<Link to={\`/title/${id}/fix\`} ...>`.
- Wrap the `<Player .../>` usage in `<Suspense fallback={<p className="text-sm text-[var(--text-dim)] py-2">Loading player…</p>}>...</Suspense>` (replaces the `next/dynamic` `{ ssr: false }` behavior).
- The rest of the JSX (backdrop, header, overview, cast) is unchanged.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @orbix/web typecheck`
Expected: TitlePage + Player compile. (Player itself uses only `apiFetch` + Vidstack; no Next APIs — no change needed there, but delete its line 1 `"use client";` for cleanliness.)

- [ ] **Step 4: Drop `"use client"` from Player**

In `apps/web/src/components/Player.tsx`, delete line 1 `"use client";`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/TitlePage.tsx apps/web/src/components/Player.tsx
git commit -m "feat(web): port title page to useParams + lazy Player + queries"
```

---

## Task 12: Port the Fix-match page (params + navigation)

**Files:**
- Create: `apps/web/src/pages/FixMatchPage.tsx` (from `src/app/(app)/title/[id]/fix/page.tsx`)

**Interfaces:**
- Consumes: `apiFetch` (kept for mutations), react-router `useParams`/`useNavigate`.

- [ ] **Step 1: Move the file**

```bash
git mv "apps/web/src/app/(app)/title/[id]/fix/page.tsx" apps/web/src/pages/FixMatchPage.tsx
```

- [ ] **Step 2: Swap framework APIs**

In `apps/web/src/pages/FixMatchPage.tsx`:
- Delete line 1 `"use client";`.
- Replace `import { useRouter } from "next/navigation";` → `import { useParams, useNavigate } from "react-router";`.
- Delete the `Props` interface and `params` param; delete the `id` `useState` and the param-resolving `useEffect` (lines 33-36).
- Replace `const router = useRouter();` + `const [id, setId] = useState<string | null>(null);` with:
  ```tsx
  const { id } = useParams();
  const navigate = useNavigate();
  ```
- Replace `router.push(\`/title/${id}\`)` (two occurrences: in `handleMatch` and the Back button) → `navigate(\`/title/${id}\`)`.
- The `apiFetch` mutation calls and the auto-search `useEffect` on `itemTitle` are unchanged (the `if (!id) return;` guards still hold since `id` from `useParams` is a string).

- [ ] **Step 3: Verify typecheck + lint**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint`
Expected: PASS for this file. (If lint flags the existing `useEffect` exhaustive-deps on `[itemTitle]`, preserve the existing eslint-disable/comment that was already there.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/FixMatchPage.tsx
git commit -m "feat(web): port fix-match page to useParams + useNavigate"
```

---

## Task 13: Port Admin → Libraries page (query + mutations + SSE + internal links)

**Files:**
- Create: `apps/web/src/pages/AdminLibrariesPage.tsx` (from `src/app/(app)/admin/libraries/page.tsx`)

**Interfaces:**
- Consumes: `apiFetch` (mutations), `useLibraries` + `queryClient.invalidateQueries` for the list, react-router `Link`. `EventSource('/api/scan/:jobId/stream')` unchanged.

- [ ] **Step 1: Move the file**

```bash
git mv "apps/web/src/app/(app)/admin/libraries/page.tsx" apps/web/src/pages/AdminLibrariesPage.tsx
```

- [ ] **Step 2: Swap framework APIs + data layer**

In `apps/web/src/pages/AdminLibrariesPage.tsx`:
- Delete line 1 `"use client";`.
- The page currently loads `/libraries` via `apiFetch` into local state. Keep that local state pattern (it manages create/delete/scan flows imperatively), OR replace the initial load with `useLibraries()` and call `queryClient.invalidateQueries({ queryKey: ["libraries"] })` after create/delete/scan. **Minimal change:** keep the existing `apiFetch("/libraries")` + local state load (no behavior change); just ensure the post-mutation reload still calls the same loader function.
- Replace any internal navigation `<a href="/admin/settings">...</a>` (line ~244) with react-router `Link`:
  - Add `import { Link } from "react-router";`
  - `<a href="/admin/settings" ...>` → `<Link to="/admin/settings" ...>` (and matching closing tag).
- `new EventSource(\`/api/scan/${jobId}/stream\`)` stays exactly as-is (same-origin in prod, Vite-proxied in dev).

- [ ] **Step 3: Verify typecheck + lint**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint`
Expected: PASS for this file.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/AdminLibrariesPage.tsx
git commit -m "feat(web): port admin libraries page (SSE preserved) to react-router"
```

---

## Task 14: Port Admin → Settings page + full build

**Files:**
- Create: `apps/web/src/pages/AdminSettingsPage.tsx` (from `src/app/(app)/admin/settings/page.tsx`)

**Interfaces:**
- Consumes: `apiFetch` (settings GET/PUT, maintenance/rebuild), react-router `Link`.

- [ ] **Step 1: Move the file**

```bash
git mv "apps/web/src/app/(app)/admin/settings/page.tsx" apps/web/src/pages/AdminSettingsPage.tsx
```

- [ ] **Step 2: Swap framework APIs**

In `apps/web/src/pages/AdminSettingsPage.tsx`:
- Delete line 1 `"use client";`.
- Replace internal `<a href="/admin/libraries">...</a>` (line ~149) with react-router `Link` (`import { Link } from "react-router";`, `to=` instead of `href=`).
- `apiFetch` calls (`/settings` GET/PUT, `/maintenance/rebuild`) are unchanged.

- [ ] **Step 3: Remove the now-empty Next `app/` tree + root layout**

```bash
git rm "apps/web/src/app/(app)/layout.tsx" "apps/web/src/app/layout.tsx"
# Verify nothing remains under src/app:
find apps/web/src/app -type f
```

Expected: no files remain under `apps/web/src/app` (delete the directory if empty).

- [ ] **Step 4: Full typecheck + build (all pages now exist)**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web build`
Expected: PASS — `apps/web/dist` emitted with the full router. Fix any remaining `next/*` import or type errors surfaced here (grep guard: `grep -rnE "next/|use client" apps/web/src` should return nothing except possibly stray `"use client"` strings, removed in Task 17).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/AdminSettingsPage.tsx
git rm -r --ignore-unmatch "apps/web/src/app"
git commit -m "feat(web): port admin settings page; remove Next app/ tree; full Vite build green"
```

---

## Task 15: Playwright e2e against Vite + manual dev smoke

**Files:**
- Modify: `apps/web/playwright.config.ts` (web command `next dev`→`vite`)

**Interfaces:**
- Consumes: the built/served app.

- [ ] **Step 1: Update the web dev server command**

In `apps/web/playwright.config.ts`, the second `webServer` entry (lines 43-51): the `command: "pnpm --filter @orbix/web dev"` already resolves to `vite` after Task 3 (the `dev` script changed). Update its `env` to drop the obsolete `NEXT_PUBLIC_API_URL` and set the Vite proxy target:

```ts
    {
      command: "pnpm --filter @orbix/web dev",
      url: "http://localhost:1060",
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        API_INTERNAL_URL: "http://localhost:1061",
      },
    },
```

- [ ] **Step 2: Bring up infra + run e2e**

Run:

```bash
docker compose up -d postgres redis
pnpm --filter @orbix/web test:e2e
```

Expected: existing specs (`onboarding`, `library`, `playback`, `discovery`) PASS against the Vite app. Investigate any failure as a real regression (URLs and behaviors are preserved by design).

- [ ] **Step 3: Manual dev smoke (host)**

Run the API and Vite, then click through:

```bash
# terminal A
pnpm --filter @orbix/api dev
# terminal B
pnpm --filter @orbix/web dev
```

Verify: setup→login→profiles→home (hero + rows)→library (sort/filter)→search→title→Play (HLS + direct, subtitles, resume)→admin libraries (start scan, live SSE progress)→admin settings (save). Then reap servers:

```bash
pkill -f "tsx.*watch src/server.ts"; pkill -f vite
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/playwright.config.ts
git commit -m "test(web): point Playwright at the Vite dev server"
```

---

## Task 16: Production serving — Dockerfiles, compose, deploy stack, docs

Collapse to one container in production: the api image builds the SPA and serves it. Keep a Vite-dev `web` service in the local `docker-compose.yml` for HMR.

> **Spec refinement (flag to user):** the spec said remove the `web` service from *both* compose files. During planning we keep a **Vite-dev** `web` service in `docker-compose.yml` (local dev) to preserve hot-reload, and remove `web` only from the **production** `deploy/portainer-stack.yml`. Acceptance ("single container in production") is met.

**Files:**
- Modify: `apps/api/Dockerfile` (build SPA, set `WEB_DIST`)
- Modify: `apps/web/Dockerfile` (becomes a Vite build stage; or delete if folded into api image)
- Modify: `apps/web/Dockerfile.dev` (run `vite` instead of `next dev`)
- Modify: `docker-compose.yml` (web → vite dev; api serves UI in prod only)
- Modify: `deploy/portainer-stack.yml` (remove `web` service; map user port to api)
- Modify: `README.md`, `CLAUDE.md`, `deploy/README.md`

**Interfaces:**
- Produces: a production api image that serves the SPA at `/` and `/api`.

- [ ] **Step 1: Build the SPA inside the api image**

In `apps/api/Dockerfile`, after `RUN pnpm install --frozen-lockfile` and before the model-bake step, add:

```dockerfile
# Build the Vite SPA and let Fastify serve it from /app/apps/web/dist
RUN pnpm --filter @orbix/web build
ENV WEB_DIST=/app/apps/web/dist
```

(The `staticWebPlugin` from Task 2 reads `WEB_DIST`; `existsSync` makes it a no-op when absent.)

- [ ] **Step 2: Point dev Dockerfile + compose at Vite**

In `apps/web/Dockerfile.dev`, change the start command to run Vite (e.g. `CMD ["sh","-c","pnpm --filter @orbix/web dev"]`; `dev` is now `vite --port 1060`). In `docker-compose.yml`, the `web` service: replace `NEXT_PUBLIC_API_URL` env with `API_INTERNAL_URL: http://api:1061` (Vite proxy target) and keep the `1060:1060` port + the `./apps/web/src` + `./packages/ui/src` volume mounts.

- [ ] **Step 3: Remove `web` from the production stack**

In `deploy/portainer-stack.yml`, delete the `web` service block. Ensure the api service publishes the user-facing port (map the previous web port, default 8080, to the api container's `1061`), e.g. `ports: ["${WEB_PORT:-8080}:1061"]`, and that `WEB_DIST` is set (it's baked via the Dockerfile). Remove any `web`→`api` `depends_on` left dangling.

- [ ] **Step 4: Update docs**

- `README.md`: the UI is now served by the api container; one fewer service.
- `CLAUDE.md`: update the Architecture section (`apps/web` = Vite SPA; Fastify serves it in prod), the ports note (web dev 1060 = Vite; prod UI served by api), and remove the Next-specific lines.
- `deploy/README.md`: reflect the single-container topology.

- [ ] **Step 5: Build the production api image to verify SPA bake**

Run: `docker build -f apps/api/Dockerfile -t orbix-api-test .`
Expected: build succeeds, including `pnpm --filter @orbix/web build`. (Optional: `docker run` it against the DB and `curl localhost:1061/` returns the SPA HTML; `curl localhost:1061/api/health`... → use the real health route path.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/Dockerfile apps/web/Dockerfile apps/web/Dockerfile.dev docker-compose.yml deploy/portainer-stack.yml README.md CLAUDE.md deploy/README.md
git commit -m "build: api image serves the SPA; retire web container in production; update docs"
```

---

## Task 17: Cleanup — remove Next, strip leftovers, final gates

**Files:**
- Modify: `apps/web/package.json` (drop `next`, `@tailwindcss/postcss`)
- Delete: `apps/web/next.config.ts`, `apps/web/next-env.d.ts`, `apps/web/postcss.config.mjs`
- Modify: any file still containing a stray `"use client";` first line

**Interfaces:** none.

- [ ] **Step 1: Delete Next config files**

```bash
git rm apps/web/next.config.ts apps/web/next-env.d.ts apps/web/postcss.config.mjs
```

- [ ] **Step 2: Remove Next deps**

Run: `pnpm --filter @orbix/web remove next @tailwindcss/postcss`

- [ ] **Step 3: Strip any remaining `"use client"` directives**

Run: `grep -rln '"use client"' apps/web/src` then delete that first line in each listed file (harmless in Vite, removed for cleanliness).

- [ ] **Step 4: Guard greps — nothing Next remains**

Run:

```bash
grep -rnE "next/|NEXT_PUBLIC|next\.config|use client" apps/web/src apps/web/*.ts apps/web/package.json || echo "clean"
```

Expected: `clean` (no matches).

- [ ] **Step 5: Full monorepo gates**

Run:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all PASS. (`pnpm test` now includes `apps/web` Vitest: `api.test.ts`, `decideRedirect.test.ts`, plus the api `profiles.test.ts` and `static-web.test.ts`.)

- [ ] **Step 6: Final e2e**

Run: `docker compose up -d postgres redis && pnpm --filter @orbix/web test:e2e`
Expected: all specs PASS. Reap servers afterward: `pkill -f "tsx.*watch src/server.ts"; pkill -f vite`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(web): remove Next.js deps + config; final cleanup, all gates green"
```

---

## Self-Review (completed during authoring)

**Spec coverage:**
- Routing conversion → Tasks 5-14. Auth/profile guard server→client → Task 5 (+ Task 1 API change). Data layer (TanStack Query) → Tasks 4, 8-11. Fastify same-origin static serving + SPA fallback → Task 2. Dev proxy → Task 3. Docker collapse + docs → Task 16. Tailwind via Vite plugin → Task 3. `@orbix/ui` resolution (alias) → Task 3. Env (`NEXT_PUBLIC_*`→Vite) → Tasks 3, 15, 16. Player wrapper/lazy + bundled hls.js → Task 11. Vitest added → Tasks 3-5. Playwright updated → Task 15. Risks (RR v8 pin, SSE proxy, SPA-fallback excludes /api, hls bundled) → Global Constraints + Tasks 2, 11, 15. Acceptance criteria (no Next, single container, gates green, e2e green, smaller bundle) → Task 17 + 16.
- **Deviation from spec (flagged in Task 16):** the client-status endpoint is `GET /me/profile` (extended), not `/auth/me` — `/me/profile` already exists for UI gating, so it's the lower-churn vehicle. And the local `docker-compose.yml` keeps a Vite-dev `web` service for HMR (prod stack still collapses to one container).

**Placeholder scan:** no TBD/TODO; every code step shows the code or the exact line edits.

**Type consistency:** `ApiError`/`apiJson` (Task 4) used by `RequireProfile`/`TitlePage` (Tasks 5, 11); `ActiveProfile`/`HomeRow`/`MediaCard` shapes shared via `queries.ts`; `decideRedirect` signature matches its test and caller; `activeProfile` widened type (Task 1) matches the `/me/profile` response consumed by `useMyProfile` (Task 4).
