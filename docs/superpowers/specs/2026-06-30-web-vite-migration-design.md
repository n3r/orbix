# Web UI Migration: Next.js → Vite React SPA

- **Date:** 2026-06-30
- **Status:** Approved (design); ready for implementation plan
- **Owner:** Web UI
- **Related:** `CLAUDE.md` (offline guarantee, ports, gotchas), `deploy/README.md`

## Context

Orbix's web UI is currently **Next.js 15 (App Router)** running as a **Node server** (`next start`) that both serves the UI and proxies `/api/:path*` to Fastify. Every protected page is `force-dynamic` (server-rendered per request, `cache: "no-store"`, reads cookies server-side), so each navigation is a round-trip to the Node web process, which itself calls the API.

For Orbix's actual constraints — **auth-gated (no SEO), served from a NAS over LAN, must be fast on low-end devices** — Next.js's strengths (SSR/SEO, RSC, server runtime) are unused or counterproductive, while its costs land where we care: a heavier JS baseline (~80–130 kB vs ~42 kB for a lean React SPA), a **second Node process** on the NAS, and the worst offline/service-worker ergonomics in the ecosystem (the RSC `_rsc` prefetch model). Real-world precedent agrees: Plex's logged-in web app is a plain React SPA; Jellyfin's web UI is a client SPA.

This migration removes the Next.js/Node overhead and rebuilds the UI as a **static Vite React SPA** served directly by Fastify, keeping all existing React components, Tailwind, the Vidstack/hls.js player, and the auth cookie flow.

## Goal & non-goals

**Goal:** Make the web UI fast on slow devices and eliminate the unnecessary Next.js/Node server overhead, with no loss of existing behavior.

**Non-goals (explicitly out of scope for this work):**
- PWA / installability (manifest, service worker) — deferred; may be added later as its own task.
- Offline resilience / background-sync / IndexedDB caching.
- Offline downloads (watch with NAS off) — separate feature, not a stack change.
- Vidstack → Video.js v10 player migration — separate later task once `@videojs/core` reaches GA (currently beta).
- Any API behavior change beyond (a) serving the static SPA and (b) one additive auth-status field (see "Required API change").

## Current state (verified facts)

- **Next.js 15, App Router.** 22 source files, ~14 carry `'use client'`. Protected pages use `export const dynamic = "force-dynamic"` and read cookies server-side (`apps/web/src/app/(app)/layout.tsx`).
- **Not a PWA:** no manifest, no service worker, no client caching, not installable.
- **Routing/pages:** public `/login`, `/setup`, `/profiles`; protected `(app)` group → `/` (home rows+hero), `/library/[sectionId]`, `/search`, `/title/[id]`, `/title/[id]/fix`, `/admin/libraries` (SSE scan progress), `/admin/settings`.
- **Data fetching:** server components fetch initial data (`/home/rows`, `/items/:id`, `/libraries`, `/profiles`) with `cache: "no-store"`; client components use manual `useState`/`useEffect` + `apiFetch`. No data/cache library today.
- **API surface (Fastify):** `routes/` includes `auth.ts` (`POST /auth/login`, `POST /auth/logout`, `GET /auth/me`), `setup.ts` (`GET /setup/status`), `profiles.ts` (`GET /profiles`, selection sets httpOnly `orbix_profile` cookie), plus catalog/discovery/fix/images/libraries/playstate/refresh/scan/settings/stream/subtitles.
- **API access:** all browser calls are **relative `/api`** via `apiFetch` (`apps/web/src/lib/api.ts`, `credentials: "include"`). Next config rewrites `/api/:path*` → `API_INTERNAL_URL`. No hardcoded origins.
- **Auth:** httpOnly `orbix_session` + httpOnly `orbix_profile` cookies; API routes guard via `apps/api/src/lib/auth.ts`.
- **Player:** `@vidstack/react ^1.0.0` (1.x channel) + bundled `hls.js ^1.6.16`; `Player.tsx` wires bundled hls.js via the provider `library` prop (no CDN). Lazy-loaded via `dynamic(() => import("@/components/Player"), { ssr: false })`.
- **Styling:** Tailwind 4 via `@tailwindcss/postcss`; design tokens in `packages/ui/src/tokens.css`; `packages/ui` exports `./src/index.ts` (raw TS source); consumed via Next `transpilePackages: ["@orbix/ui"]`. No CSS-in-JS.
- **Build/deploy:** `apps/web/Dockerfile` builds with `next build`, runs `next start -p 1060`; root `docker-compose.yml` + `deploy/portainer-stack.yml` run separate `web` and `api` containers. Ports: web 1060, api 1061, postgres 1062, redis 1063.
- **Tests:** Playwright e2e in `apps/web/playwright.config.ts` (`workers: 1`, `reuseExistingServer: true`; web dev `:1060`, api dev `:1061`). No Vitest in `apps/web` yet.

## Target stack (verified latest stable, 2026-06-30)

| Package | Version | Notes |
|---|---|---|
| `vite` | 8.1 | Rolldown is the default bundler in v8; watch plugin compat. |
| `@vitejs/plugin-react` | 6.0 | Vite 8-era major (SWC variant `@vitejs/plugin-react-swc` 4.3 optional). |
| `react` / `react-dom` | 19.2.7 | Already on 19; keep in lockstep. |
| `react-router` | 8.1 | **Single package** — DOM split removed. v8 GA 2026-06-17. Pin exact; `7.18.1` is the conservative fallback. |
| `@tanstack/react-query` | 5.101 | New client data/cache layer. |
| `tailwindcss` + `@tailwindcss/vite` | 4.3 | Vite-native plugin replaces the PostCSS pipeline. |
| `@vidstack/react` + `hls.js` | ^1.0.0 / 1.6.16 | **Unchanged**; kept behind a thin wrapper. |
| `vitest` | 4.1 | Aligns `apps/web` with the repo's existing vitest (core/api/config). |
| `@fastify/static` | latest | Serves the built SPA from Fastify. |

## Architecture & detailed changes

### 1. Routing (the bulk of the work)

Replace the App Router file tree with a React Router v8 `createBrowserRouter` tree:

- **Root route** → `<html>`-equivalent shell + providers (`QueryClientProvider`, router).
- **Protected layout route** (replaces the `(app)` group): renders the sidebar/header shell and runs the **auth/profile guard** (see §2) as a route `loader` (or guard component). Children:
  - `index` → home (rows + hero)
  - `library/:sectionId`
  - `search`
  - `title/:id`
  - `title/:id/fix`
  - `admin/libraries`
  - `admin/settings`
- **Public routes:** `login`, `setup`, `profiles`.

Swap all framework imports:
- `next/link` `Link` → `react-router` `Link`
- `next/navigation` `useRouter().push` → `useNavigate()`
- `usePathname` → `useLocation().pathname`
- `useParams` → `react-router` `useParams`
- server `redirect()` → `<Navigate>` / `redirect` in loaders
- `dynamic(() => import(...), { ssr: false })` for the Player → plain `React.lazy` + `<Suspense>` (no SSR concept in an SPA).

### 2. Auth/profile gating: server → client

Today `(app)/layout.tsx` is a server component that: checks `/setup/status`, `/auth/me`, then fetches `/libraries` + `/profiles`, redirecting to `/login` / `/setup` / `/profiles` as needed.

After migration this becomes a **client guard** on the protected layout route:
1. `GET /api/setup/status` → if `!complete` redirect `/setup`.
2. `GET /api/auth/me` → if unauthenticated redirect `/login`.
3. Determine selected profile → if none, redirect `/profiles`.

Cookies (`orbix_session`, `orbix_profile`) keep working and get **simpler**: Fastify now serves the SPA **same-origin**, so `credentials: "include"` needs no CORS and no proxy. The API still reads the cookies server-side to guard every route (unchanged).

#### Required API change (the one scope addition)

The selected profile is stored in the **httpOnly `orbix_profile` cookie**, which the browser JS cannot read. The client guard therefore needs the API to reflect selection state back. **Decision:** extend `GET /auth/me` to include `selectedProfileId: string | null` (server reads the `orbix_profile` cookie and echoes the id, or null). This keeps the guard to a single round-trip and avoids a new endpoint. (Alternative considered: a separate `GET /profiles/current` — rejected as an extra request.)

### 3. Data layer: TanStack Query

- Wrap the app in `QueryClientProvider` with a shared `QueryClient`.
- Replace server-component initial fetches **and** manual `useState`/`useEffect` client fetches with `useQuery` / `useMutation`, using the existing `apiFetch` as the fetcher (relative `/api`, `credentials: "include"`).
- Query keys per resource (`["home","rows"]`, `["item", id]`, `["libraries"]`, `["search", q]`, `["profiles"]`, etc.).
- `staleTime` tuned so back-navigation renders instantly from cache; `invalidateQueries` on mutations (after a scan completes, after settings/library changes).
- **Not** Query-managed: the SSE scan-progress stream (keep `EventSource` as-is) and the player's periodic progress `POST`s (keep as-is).

### 4. Build & serving

- **Build:** `vite build` → static `dist/` (hashed assets + `index.html` app shell).
- **Dev:** `vite` dev server on **:1060** with `server.proxy = { "/api": { target: "http://localhost:1061", changeOrigin: true } }`, replacing Next rewrites so relative `/api` works in dev. SSE proxying must not buffer (configure proxy for the scan stream).
- **Prod:** Fastify serves `dist/` via `@fastify/static` at `/`, with an **SPA fallback** (return `index.html` for non-`/api`, non-asset `GET`s) so deep links resolve client-side. The fallback must explicitly exclude `/api/*` and static asset paths.
- **API prefix (discovered during planning):** Fastify routes are currently *bare* (`/auth/me`, `/me/profile`, …); the browser's `/api/*` calls work today only because Next's rewrite strips `/api`. Same-origin production has no proxy to strip it, so **all API routes are mounted under an `/api` prefix** (with `/health` kept at root for the Docker healthcheck). Consequently the Vite dev proxy forwards `/api/*` **without** a path rewrite. This supersedes the original idea of stripping the prefix at the edge.

### 5. Docker / deploy

- **Multi-stage build:** a web-build stage runs `vite build`; the `dist/` output is copied into the **api image** (or a final stage that runs Fastify and ships `dist/`).
- **Remove the `web` service** from `docker-compose.yml` and `deploy/portainer-stack.yml`. The user-facing port maps to Fastify.
- **Port story:** Fastify listens on 1061 and now also serves the UI. Externally, keep the existing user-facing port mapping to Fastify (document that the UI is now served by the API container). `API_INTERNAL_URL` (web→api rewrite target) is no longer needed in prod; dev uses the Vite proxy target.
- Update the api container **healthcheck**, `apps/web/Dockerfile` (becomes a build stage feeding the api image), README, CLAUDE.md (ports/architecture sections), and `deploy/README.md`.

### 6. Tailwind v4 + workspace packages

- Replace `apps/web/postcss.config.mjs` (`@tailwindcss/postcss`) with the `@tailwindcss/vite` plugin in `vite.config.ts`. Keep `globals.css` (`@import "tailwindcss"`) and `packages/ui/src/tokens.css`.
- Drop `transpilePackages`. Ensure Vite transpiles `@orbix/ui`'s raw TS source (it exports `./src/index.ts`). Because workspace deps can be skipped by Vite's node_modules handling, add a resolve alias (`@orbix/ui` → `packages/ui/src`) or otherwise ensure the source is processed by esbuild/the React plugin. Verify during impl.

### 7. Env

- `NEXT_PUBLIC_*` → `import.meta.env.VITE_*`. Audit expected to be near-empty since the app uses relative `/api` throughout. Any dev-only proxy target can be a Vite env var with a `http://localhost:1061` default.

### 8. Player

- Keep `@vidstack/react` + bundled `hls.js` exactly as wired (provider `library` prop = bundled `Hls`, no CDN). Place the player behind a **thin wrapper component** so the future Video.js v10 swap is isolated to one module. Load it via `React.lazy` + `<Suspense>`.

## What stays identical

- All React components (Player, Hero, PosterCard, rows, forms, admin pages) — only `next/*` imports change.
- Tailwind tokens, `globals.css`, and `packages/ui`.
- `apiFetch` and the auth cookie flow (now same-origin, simpler).
- The Vidstack/hls.js bundled-player behavior.
- The entire Fastify API, except: + static SPA serving, + `selectedProfileId` on `/auth/me`.

## Testing

- **Vitest (new in `apps/web`, v4):** unit-test the auth/profile guard logic and router loaders; a couple of component smoke tests. Align with the repo's existing vitest setup.
- **Playwright e2e:** keep `apps/web/playwright.config.ts` (`workers: 1`, serial to avoid first-admin setup-wizard races). Swap the web `webServer.command` from `next dev` → `vite` (still `url: http://localhost:1060`); api server unchanged. Add a production-mode smoke (build + Fastify-static) if feasible.
- **Manual smoke:** `vite build` → serve via Fastify → login → select profile → browse home/library/search → open title → play (HLS + direct) → admin scan with live SSE progress. Reap host dev servers afterward (`pkill -f "tsx.*watch src/server.ts"`, free 1060/1061) per CLAUDE.md to avoid EMFILE / stale-server reuse.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `react-router` v8 only ~2 weeks GA at decision time | Pin exact version; `7.18.1` is a tested fallback (v8 changes are minimal/pre-adoptable in v7). |
| Vite 8 defaults to Rolldown (newer bundler) | Verify all plugins build; pin known-good versions; fall back to Vite 7.3.x (`previous` tag) if a blocker appears. |
| Client can't read httpOnly `orbix_profile` | Extend `/auth/me` with `selectedProfileId` (the one required API change). |
| `@orbix/ui` raw-TS source not transpiled by Vite | Add resolve alias to `packages/ui/src` or ensure the package is processed; verify in dev + build. |
| SPA deep-link fallback could shadow `/api` or assets | Fallback handler must exclude `/api/*` and static asset routes; covered by e2e deep-link test. |
| SSE scan stream broken by dev proxy buffering | Configure the Vite proxy (and any prod path) to stream without buffering; smoke-test scan progress. |
| Vidstack frozen / 1.x prerelease | Keep behind a wrapper now; Video.js v10 swap is a separate task when GA. |
| Playwright `reuseExistingServer` reuses stale Next dev server during transition | Ensure ports freed and the command points to `vite` before running e2e. |

## Migration sequencing (high level; detailed steps in the implementation plan)

1. **Scaffold** the Vite app in `apps/web` alongside the existing Next setup: `vite.config.ts` (`@vitejs/plugin-react`, `@tailwindcss/vite`, dev `/api` proxy, `@orbix/ui` resolution), `index.html` entry, `main.tsx` with `QueryClientProvider` + router, new `package.json` scripts (`dev`/`build`/`preview`).
2. **Routing skeleton + auth guard:** the router tree and the protected-layout guard (depends on the `/auth/me` `selectedProfileId` change — sequence that API change first or in parallel).
3. **Port pages one-by-one:** home → library → search → title (+ player wrapper) → fix → admin libraries (SSE) → admin settings; swap `next/*` → `react-router` and move fetches to TanStack Query as each page is ported.
4. **Serving:** add `@fastify/static` + SPA fallback to the API; wire the dev proxy; verify same-origin cookies.
5. **Docker/deploy/docs:** multi-stage build feeding the api image; remove the `web` service; update compose, portainer stack, healthcheck, README, CLAUDE.md, `deploy/README.md`.
6. **Tests & cleanup:** add Vitest; update Playwright; full manual smoke; remove Next deps/config (`next`, `@tailwindcss/postcss`, `postcss.config.mjs`, `next.config.ts`, `next-env.d.ts`, `app/` once fully ported).

## Acceptance criteria

- No Next.js dependency or Node web process remains; Fastify serves both the SPA and `/api` from a single container.
- All existing routes/pages function identically (login, setup, profiles, home, library, search, title detail, fix, admin libraries with live SSE, admin settings).
- Auth + kids/maturity filtering behavior unchanged (server-enforced; the SPA change must not weaken it).
- HLS + direct playback work with bundled hls.js (no CDN), subtitles intact, progress saved/resumed.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all pass; Playwright e2e passes against the new setup.
- Measured First Load JS is materially smaller than the Next build (record before/after).

## Out of scope / follow-ups

- PWA (manifest + service worker) for installability and instant repeat loads.
- Offline resilience (app-shell precache, runtime caching, background-sync for progress, IndexedDB catalog snapshot).
- Offline downloads feature.
- Vidstack → Video.js v10 player swap when GA.
