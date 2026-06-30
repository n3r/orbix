# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Orbix is a self-hosted, offline-capable media server (Netflix-style profiles, TMDB-enriched library, in-browser HLS playback, embedding-based discovery). Web-first, runs on a NAS via Docker. See `README.md` for the product pitch and `deploy/README.md` for the production (Portainer) stack.

## Commands

TypeScript monorepo on **pnpm 10.22.0** (pinned in `packageManager`) + **Turborepo**, **Node 22**. Always use the repo-local pnpm.

```bash
pnpm install
docker compose up -d            # postgres(+pgvector):1062, redis:1063, api:1061, web:1060
                                # api container runs `prisma migrate deploy` on start
# Then open http://localhost:1060 → setup wizard → add library → set TMDB token in Settings → scan
```

Gates (run before any review/merge — Turbo caches results across packages):

```bash
pnpm typecheck                  # tsc --noEmit in every package
pnpm lint                       # eslint flat config (shared root eslint.config.js)
pnpm test                       # vitest run (core, api, config, web)
pnpm build                      # turbo build (db = prisma generate, web = vite build)
```

Scoped / single-test workflows:

```bash
pnpm --filter @orbix/core test                          # one package's vitest suite
pnpm --filter @orbix/core exec vitest run src/playback/strategy.test.ts   # one file
pnpm --filter @orbix/core exec vitest run -t "remux"    # tests matching a name
pnpm --filter @orbix/api lint                           # scoped lint (see gotcha below)
pnpm --filter @orbix/web test:e2e                       # Playwright e2e (needs postgres+redis up)
```

Database (host-side; the api container applies migrations itself):

```bash
pnpm db:migrate                 # prisma migrate dev  (schema is packages/db/prisma/schema.prisma)
pnpm db:generate                # prisma generate
```

## Architecture

**Monorepo layout** (`pnpm-workspace.yaml` → `apps/*`, `packages/*`):

- `apps/web` — Vite + React SPA (React Router v8 client routing, TanStack Query) + Tailwind (`@tailwindcss/vite`). UI, Vidstack player (lazy-loaded), admin pages. Built to static `dist/`; the API serves it in production.
- `apps/api` — Fastify + Prisma. REST + SSE under an `/api` prefix; serves the built SPA via `@fastify/static` (same origin) in prod; owns all I/O (DB, ffmpeg, TMDB network, BullMQ, embeddings).
- `packages/core` — framework-agnostic domain logic. **No DB/network/ffmpeg/fs imports**; everything is injected.
- `packages/db` — Prisma schema + migrations. Exports a singleton `prisma` and re-exports `@prisma/client` (so `Prisma`, types).
- `packages/ui` — shared design-system components (Vite resolves the workspace TS source via the package `exports` map).
- `packages/config` — `loadEnv()`: a zod schema (`Env` type) that fail-fasts on bad/missing env at boot.
- `deploy/` — Portainer NAS production stack (`portainer-stack.yml`) + guide.

**The core/api split is the load-bearing design decision.** All hard logic — transcode strategy, HLS playlist + ffmpeg arg building, filename parsing, similarity/NL-constraint/rank discovery, maturity-rating tiers, metadata enrichment — lives in `packages/core` as pure functions that take **injected adapters** (a `run` for ffprobe, a `fetchImpl`, `read`/`write` for files, `client` for TMDB). `apps/api` supplies the real adapters; tests supply fakes. Consequence: **core tests must never require a network, a DB, ffmpeg, or real model files.** `apps/api/src/plugins/queue.ts` is the canonical example — it wires real `probeFile`/`scanSource`/`enrichItem`/`cacheImage` adapters around the pure scanner.

**Request/data flow:**
- The SPA **only ever calls relative `/api/...`** (via `apps/web/src/lib/api.ts` `apiFetch`/`apiJson`, which send `credentials: "include"`). Never hardcode an absolute API origin in browser code — that breaks LAN access and CORS. In **dev**, the Vite server (`apps/web/vite.config.ts`) proxies `/api` → `API_INTERNAL_URL` (no path rewrite). In **prod**, Fastify serves the SPA and the API on the same origin.
- Fastify is assembled in `apps/api/src/app.ts`: register cors→cookie→db→session→queue, then `health` at root and every other `routes/*.ts` under the **`/api` prefix**, then `staticWebPlugin` last (serves `dist/` with an SPA fallback; inert when no build is present). Routes that need env are factory functions (`imagesRoute(env)`, `streamRoute(env)`).
- Auth: password account (single-household, single admin) → session cookie; then a profile-selection cookie (`orbix_profile`). Routes guard via the shared helper in `apps/api/src/lib/auth.ts`.
- Scanning is async: a route enqueues a BullMQ `scan` job (Redis); the worker (in `queue.ts`) walks files → parses → ffprobes → upserts → enriches via TMDB → caches images, emitting progress over an in-process `EventEmitter` that the SSE route streams. Late subscribers read `scanDoneCache`.
- Persistence: **Postgres 16 + pgvector** (catalog, profiles, history, `Embedding` = `vector(384)`). Embeddings are generated locally via transformers.js (bge-small); discovery degrades gracefully when the model is absent.

## Conventions & gotchas

- **Offline guarantee is a hard requirement.** Metadata + posters/backdrops are cached to disk at scan time (`METADATA_DIR`); browsing and playback must never need the internet at runtime. hls.js is bundled (not CDN-loaded) for the same reason.
- **Kids filtering is server-enforced on *every* route** (list, by-id, rows, search, play, direct-stream, subtitles, continue-watching, progress). UI-only filtering is a defect. Capped kids profiles also exclude unrated titles (fail-safe). See `packages/core/src/ratings/maturity.ts` + `apps/api/src/lib/catalog-filter.ts`.
- **`MediaFile.size` is a Prisma `BigInt`** → call `.toString()` (or `Number()`) before `JSON.stringify` in any catalog/stream route, or serialization throws.
- **Libraries own sources directly (no "sections").** A `Library` has many `Source`s (`kind` = `local` | `smb`); items belong to a library (`MediaItem.libraryId`) and are mixed-content (`MediaItem.kind` per item). **SMB sources are mounted inside the container** (cifs-utils) to `MOUNTS_DIR` (`/data/mounts/<sourceId>`); core stays mount-agnostic — resolution lives in `apps/api/src/lib/source-root.ts` (+ `smb.ts`, `mount-runtime.ts`), and the pure scanner only ever sees a local `root`. SMB passwords are AES-256-GCM encrypted (`apps/api/src/lib/secrets.ts`, key from `SESSION_SECRET`) and never returned by the API. Mounting needs `cap_add: SYS_ADMIN` + `security_opt: apparmor:unconfined`; without them SMB sources degrade to `status="error"` and local libraries still work.
- **Run lint per change, not just typecheck+test.** A lint-only error (e.g. `no-useless-escape`) can pass typecheck + test and be hidden by Turbo's cache. Run `pnpm lint` (or `pnpm --filter <pkg> lint`) before declaring a task done.
- **Reap host dev servers after manual smokes.** Leftover `tsx watch src/server.ts` / `vite` processes exhaust the macOS file-watcher budget (`EMFILE`) and Playwright's `reuseExistingServer` then reuses stale servers. After smoking on the host: `pkill -f "tsx.*watch src/server.ts"; pkill -f vite` and free ports 1060/1061. Playwright e2e runs serially (`workers: 1`) to avoid first-admin setup-wizard races. **The e2e `global-setup` wipes accounts/profiles** — run it only against a throwaway DB, never a populated dev DB.
- **Env is validated at boot** via `loadEnv()`; `SESSION_SECRET` must be ≥32 chars. Copy `.env.example` → `.env`. `EMBEDDINGS_ENABLED=false` disables embedding generation.
- Ports: web dev (Vite) **1060**, api **1061**, postgres **1062**, redis **1063**. In production there is no separate web port — the API container serves the UI and `/api` together (mapped to host `WEB_PORT`, default 8080). `/data/` (postgres data, metadata cache, transcode temp, model files) is gitignored.

## Project state

This is a completed 5-phase MVP. `.superpowers/sdd/progress.md` is the per-task SDD ledger (status, commits, deferred minors, and known risks per phase) — consult it for the rationale behind a decision or the list of intentionally-deferred cleanups before "fixing" something that looks off.
