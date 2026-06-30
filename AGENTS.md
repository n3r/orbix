# Agent Instructions

These instructions apply to the entire repository.

## Start Here

- Read `README.md`, `deploy/README.md`, `docs/superpowers/specs/2026-06-29-orbix-mvp-design.md`, and `.superpowers/sdd/progress.md` before substantial work.
- Treat `.superpowers/sdd/progress.md` as the implementation ledger. It records what has already landed, review findings, phase-specific hazards, and deferred follow-ups.
- Current ledger state: the MVP phases 0-4 are complete on `main`. Phase 4 pre-land fixes are also recorded, including kids-profile gates on admin routes and production deployment hardening.
- If continuing SDD work, update the ledger and any relevant `.superpowers/sdd/*-report.md` files with the real verification results. Do not overwrite old task reports casually; they are historical evidence.

## Product Constraints

Orbix is a self-hosted LAN media server for a household movie library. Preserve these core promises:

- Browsing and playback must work offline after scan/enrichment. Do not add view-time network requirements.
- TMDB and other providers are scan/admin-time inputs only. Metadata and artwork must be cached locally and served from disk.
- HLS playback must use the bundled `hls.js`; do not reintroduce CDN loading.
- Embeddings should use local model files. Runtime remote model downloads are not acceptable by default.
- Kids safety is server-enforced. UI-only filtering is a defect.
- Media mounts are read-only in production. Orbix should not modify user media files.

## Repository Shape

- `apps/web`: Next.js App Router UI, Tailwind, player, admin screens.
- `apps/api`: Fastify API, Prisma access, auth/session cookies, REST/SSE routes, scan/transcode/discovery jobs.
- `packages/core`: framework-independent domain logic. Put hard logic here when feasible and test it without Fastify, Next, a DB, ffmpeg, or network.
- `packages/db`: Prisma schema, migrations, singleton Prisma client, and `@prisma/client` re-exports.
- `packages/config`: zod-validated environment schema and shared TS config.
- `packages/ui`: shared React UI components and tokens.
- `deploy`: Portainer/NAS production stack and deployment docs.
- `.superpowers/sdd`: SDD plans, task briefs/reports, progress ledger, and review fix reports.

Keep application code thin around reusable domain code. Prefer pure functions and dependency injection in `packages/core`; route handlers should mostly validate, authorize, call domain/data helpers, and serialize. Core code may construct values such as paths or URLs, but real DB/network/ffmpeg/filesystem side effects should be supplied through injected adapters. `apps/api/src/plugins/queue.ts` is the main wiring point for real scanner/enrichment adapters.

## Commands

Use Node 22 and the repo-local pnpm 10.22.0 pinned in `packageManager`.

```bash
pnpm install
docker compose up -d
pnpm db:generate
pnpm db:migrate
```

Dev services:

- Web: `http://localhost:1060`
- API: `http://localhost:1061`
- Postgres: `localhost:1062`
- Redis: `localhost:1063`

Main gates:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --filter @orbix/web test:e2e
```

Useful package-scoped gates:

```bash
pnpm --filter @orbix/core test
pnpm --filter @orbix/core exec vitest run src/playback/strategy.test.ts
pnpm --filter @orbix/core exec vitest run -t "remux"
pnpm --filter @orbix/api test
pnpm --filter @orbix/api lint
pnpm --filter @orbix/web build
pnpm --filter @orbix/api typecheck
pnpm --filter @orbix/web typecheck
```

Production stack parse check:

```bash
docker compose -f deploy/portainer-stack.yml config
```

The progress ledger notes a previous lint slip; run lint for every changed package, not only tests and typecheck.

## Environment

The runtime env schema is in `packages/config/src/env.ts`. Required values include:

- `DATABASE_URL`
- `REDIS_URL`
- `API_PORT`
- `WEB_PORT`
- `SESSION_SECRET` with at least 32 characters
- `WEB_ORIGIN`

Optional/defaulted values:

- `METADATA_DIR`
- `TRANSCODE_DIR`
- `MODELS_DIR`
- `EMBEDDINGS_ENABLED`, which accepts exactly `"true"` or `"false"` through `loadEnv`

Do not read, print, or commit real secret files such as `.env` or `deploy/.env` unless explicitly asked. Prefer `.env.example` and `deploy/.env.production.example` for documentation.

## API And Auth Rules

- Register new API routes in `apps/api/src/app.ts`.
- Use `requireAuth(app)` for authenticated routes.
- Use `requireNonKids(app)` from `apps/api/src/lib/catalog-filter.ts` for admin/management routes that must be blocked for active kids profiles.
- Active profile selection is stored in the `orbix_profile` cookie. The known MVP limitation is that no profile cookie is treated as unrestricted; this is documented in `deploy/README.md`.
- Do not return secret settings. Settings routes should return configured booleans for provider keys/tokens, not raw values.
- Keep browser API calls same-origin through `/api` using `apps/web/src/lib/api.ts`. Do not reintroduce browser calls to the client's `localhost:1061`.
- Be careful with JSON serialization of Prisma `BigInt` fields such as `MediaFile.size`; convert to string before returning JSON.

## Kids Filtering

Kids-profile enforcement must cover every way a profile can fetch or use catalog content:

- Library and section item lists
- Item detail routes
- Home rows
- Search and discovery
- Playback decisions
- Direct streams, HLS segments, subtitles, and progress/continue-watching routes
- Admin/management routes, which should return `403 not_allowed_for_kids`

Use the shared helpers in `apps/api/src/lib/catalog-filter.ts`:

- `activeProfile`
- `kidsRatingWhere`
- `profileAllowsItem`
- `requireNonKids`
- `assertFileAllowed`

Unrated content is blocked for capped kids profiles. A kids profile with a null cap must fail safe to G-only, not unrestricted. Ratings are expected in canonical TMDB/US casing such as `G`, `PG`, `PG-13`, `R`, `NC-17`.

## Database And Migrations

- Prisma schema lives in `packages/db/prisma/schema.prisma`.
- Create migrations with `pnpm db:migrate`; regenerate Prisma with `pnpm db:generate`.
- Do not hand-edit existing migrations after they have landed unless explicitly doing a migration repair.
- Postgres uses the `vector` extension for 384-dimensional embeddings.
- Prefer Prisma for normal queries. Use raw SQL only where needed, such as pgvector ranking, and keep it parameterized.

## Playback And External Processes

- ffmpeg/ffprobe execution must use argument arrays or `execFile`-style APIs, never shell string interpolation.
- Preserve path traversal guards around cached images, subtitles, and HLS segment paths.
- HLS segment generation relies on fMP4 VOD playlists, seek restart behavior, temp-file segment writes, and process cleanup on timeout. Re-run playback tests for changes in this area.
- Direct-play range handling must stay RFC-compliant, including clamped range ends and correct `416` handling.
- Unit tests should use injected fake runners/processes. Real ffmpeg smokes are useful, but not a substitute for deterministic tests.

## Metadata, Images, And Discovery

- TMDB enrichment should cache posters/backdrops under `METADATA_DIR`; never hot-link remote artwork in normal browsing.
- Manual metadata/poster fixes set `matchState = "manual"` and must not be overwritten by later scans or refresh jobs.
- Periodic refresh is an admin/background action and should skip cleanly when no TMDB token is configured.
- Embedding generation and search must degrade without a model or when embeddings are disabled; do not turn missing embeddings into 500s.
- Guard vector literals against non-finite numbers before pgvector casts.

## Web UI

- Use existing `@orbix/ui` components and `packages/ui/src/tokens.css` where possible.
- Keep API calls through `apiFetch`.
- The app is a product UI, not a marketing page. Prefer dense, usable screens for browsing, playback, and admin workflows.
- Vidstack player sources should use explicit `{ src, type }` objects. HLS providers must receive the local `hls.js` constructor.
- Hide admin-only affordances for kids profiles as UX polish, but rely on server gates for security.

## Testing Expectations

- Add focused unit tests for changed domain logic, especially in `packages/core`.
- Add or update API route tests when authorization, filtering, serialization, or error envelopes change.
- Use Playwright for cross-app flows: setup, profiles, library, playback, discovery, and admin flows.
- Playwright is configured with `workers: 1` to avoid first-admin/setup races. Be wary of `reuseExistingServer: true`; stale dev servers have caused false failures before.
- After local smokes, kill host dev servers/watchers when done, especially listeners on ports 1060 and 1061.
- If tests cannot be run, report exactly what was not run and why.

## Deployment Notes

- Dev uses `docker-compose.yml`.
- Production uses `deploy/portainer-stack.yml`.
- The production API image intentionally runs via `tsx` for MVP robustness and runs `prisma migrate deploy` on start.
- The API image bakes the embedding model into `/app/data/models`; alternatively, production can mount an external model volume as documented.
- Production media is mounted at `/media:ro`.
- Persistent production data is in named Docker volumes: database, metadata, and transcode cache.
- Keep Portainer docs, env examples, and stack comments in sync when deployment behavior changes.

## Known Follow-Ups And Hazards

Check `.superpowers/sdd/progress.md` for the freshest list. Notable items from the ledger:

- Bind active profile selection to the server-side session in a future hardening pass; cookie-only profile selection has a documented bypass if a user can edit cookies.
- Add an expired-session sweep job.
- Consider a DB-level single-admin/setup race guard.
- Continue-watching has a known N+1 query opportunity.
- Some source paths are not root-allowlisted; this is acceptable for the self-hosted MVP but should be revisited if threat assumptions change.
- Avoid stale dev servers during e2e and smoke tests; old watchers previously caused EMFILE and misleading Playwright failures.

## Git And Change Hygiene

- Keep changes scoped to the requested behavior.
- Do not revert user work or unrelated dirty files.
- Use conventional commits only when asked to commit.
- Historical SDD notes may mention previous worker-specific commit trailers; do not add inaccurate trailers unless the user explicitly asks for them.
- Before finishing a code change, summarize the files changed and the verification run.
