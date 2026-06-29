# Orbix Phase 4 — Management + Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Orbix manageable and deployable — populate content ratings (unblocking kids-safe profiles), enforce kids filtering server-side, give the admin a manual metadata/poster fix UI and a settings page, add a periodic TMDB refresh job, and ship a Portainer-deployable NAS stack with deploy docs. This completes the MVP.

**Architecture:** Continue the established pattern — pure/DI logic in `packages/core`, thin Fastify routes, Next client pages. Kids filtering is enforced in a single server-side data-access helper (not just the UI). The TMDB client gains a certification fetch so `MediaItem.rating` is populated at enrich time and via a one-off backfill. Manual fix re-runs enrichment against a chosen TMDB id and pins `matchState="manual"`. Deployment is a self-contained `deploy/portainer-stack.yml` plus a `.env.production.example` and a README.

**Tech Stack:** unchanged (TS monorepo; Fastify 5; Next 15; Prisma/Postgres+pgvector; ffmpeg; BullMQ; transformers.js). New: a maturity-rating ordering helper in core; a Portainer/compose production stack.

## Global Constraints

- **Language:** TypeScript, `"strict": true`. Rating-ordering / kids-cap logic in `packages/core` (pure, unit-tested). Apps thin. Env via `@orbix/config` only.
- **Kids safety is server-enforced:** a kids profile must NOT be able to fetch a title above its `maturityCap` from ANY route (home rows, search, library items, item detail, playback decision). The filter lives in a shared data-access helper, applied everywhere a kids profile reads catalog data — never UI-only.
- **TMDB compliance unchanged:** attribution stays; the refresh job re-validates cached metadata (TMDB forbids caching >6 months) and is the mechanism for that policy. Manual fixes still cache images locally (offline).
- **Offline preserved:** nothing added here may require the internet at view time. The refresh job and manual fix are scan-time/admin actions, network-gated and degrade if no TMDB token.
- **Ports/services unchanged** for dev (web 1060/api 1061/postgres 1062/redis 1063). The production Portainer stack uses its own published ports (documented) and named volumes.
- **Per-task verify MUST include `pnpm lint`** (a Phase-3 lint error slipped past test+typecheck). Run lint for every changed package.
- **Commits:** conventional-commit; bodies end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. TDD: failing test first for core logic.

---

## File Structure

```
packages/core/src/ratings/maturity.ts     # parseRating()->numeric tier; allowsRating(cap, rating)
apps/api/src/lib/catalog-filter.ts         # ratingWhereClause(profile) — shared kids filter for Prisma where
apps/api/src/discovery/embedder.ts         # (unchanged)
apps/api/src/metadata/tmdb.ts (core)       # TmdbClient + certification (release_dates) — populate rating
apps/api/src/routes/
  fix.ts                                    # GET /items/:id/match-candidates ; POST /items/:id/match {tmdbId} ; POST /items/:id/poster {url}
  settings.ts                              # extend: encoder, providers, refreshCadence, attribution-safe reads
  refresh.ts                               # POST /maintenance/refresh (admin) + the cron job registration
apps/api/src/jobs/refresh-metadata.ts      # periodic TMDB re-validation (TTL) job
apps/web/src/app/
  admin/settings/page.tsx                  # settings UI (TMDB token status, encoder, providers, refresh)
  title/[id]/fix/page.tsx (or a modal)     # manual match + poster picker (admin)
deploy/
  portainer-stack.yml                      # production stack (web, api, postgres(pgvector), redis, volumes)
  .env.production.example
  README.md                                # NAS / Portainer deploy guide
```

---

### Task 1: Maturity rating model (`packages/core/src/ratings/maturity.ts`) — TDD, pure

**Interfaces:**
- Produces: `ratingTier(rating: string | null | undefined): number` mapping US certs to an ordinal (`G`=0, `PG`=1, `PG-13`=2, `R`=3, `NC-17`=4; unknown/null = a high "unrated" tier, e.g. 99, so unrated content is treated as most-restricted for kids). `allowsRating(maturityCap: number | null, rating): boolean` — `true` if `maturityCap` is null (unrestricted) OR `ratingTier(rating) <= maturityCap`. Also `CERT_TIERS` map exported.

- [ ] **Step 1: failing tests** — `ratingTier("PG")===1`, `ratingTier("R")===3`, `ratingTier(null)===99`; `allowsRating(null,"R")===true` (unrestricted profile); `allowsRating(2,"PG-13")===true`, `allowsRating(2,"R")===false`, `allowsRating(2,null)===false` (unrated blocked for a capped kid). **Step 2: fail → 3: implement → 4: pass → 5: commit** `feat(core): maturity rating tiers + kids cap check`.

---

### Task 2: TMDB certification → populate `MediaItem.rating`

**Files:** `packages/core/src/metadata/tmdb.ts` (add `releaseCertification(id)` via `/movie/{id}/release_dates`, US first); `apps/api/src/discovery/...` no; `apps/api/src/.../enrich` wiring + a `POST /maintenance/backfill-ratings` admin route (or fold into refresh). Modify `enrichItem`/`saveMetadata` to set `rating`.

**Interfaces:**
- Produces: `TmdbClient.releaseCertification(tmdbId): Promise<string | undefined>` (parse `results[].iso_3166_1==="US"` → first non-empty `release_dates[].certification`). `enrichItem` now fetches it and passes `rating` into `saveMetadata`, which writes `MediaItem.rating`. A backfill embeds rating for already-matched items lacking one.

- [ ] **Step 1: failing test** — fake fetch returns a release_dates payload; assert `releaseCertification` returns "PG-13"; assert `enrichItem` (fake client) calls `saveMetadata` with `rating:"PG-13"`. **Step 2-4: TDD.** **Step 5:** wire saveMetadata to persist `rating` (raw field on MediaItem.update); a `backfillRatings(prisma, client)` for matched items with null rating. **Step 6: smoke (if TMDB token)** best-effort + commit `feat(metadata): fetch TMDB certification and populate MediaItem.rating`.

---

### Task 3: Server-side kids filtering (`apps/api/src/lib/catalog-filter.ts`) + apply everywhere

**Files:** create the helper; modify `routes/catalog.ts` (`/sections/:id/items`, `/items/:id`), `routes/discovery.ts` (`/home/rows`, `/search`), `routes/stream.ts` (`/play/:fileId/decision`) to apply it when the active profile is a kids profile.

**Interfaces:**
- Consumes: `allowsRating`/`ratingTier`, the active profile (`orbix_profile` cookie → load profile `kind`/`maturityCap`).
- Produces: `kidsRatingFilter(profile): Prisma.MediaItemWhereInput | null` — null for standard profiles; for kids, a where-clause restricting `rating` to tiers ≤ cap. Because tiers are ordinal and `rating` is a string, the helper resolves the allowed cert STRINGS (`certsAtOrBelow(cap)`) and returns `{ rating: { in: allowedCerts } }` — and CRITICALLY also decides the policy for `rating IS NULL` (unrated): kids profiles EXCLUDE unrated (safer default). Every catalog read for a kids profile ANDs this clause; `/items/:id` and `/play/:fileId/decision` for a kids profile return 404/403 if the item is above cap (a kid must not even resolve a blocked title by id).

- [ ] **Step 1: helper + unit test** (`certsAtOrBelow(2)` → `["G","PG","PG-13"]`; kids where excludes null rating). **Step 2:** apply in catalog list + item detail (kid: filtered list; blocked id → 404). **Step 3:** apply in /home/rows + /search candidate queries. **Step 4:** apply in /play decision (blocked id for kid → 403). **Step 5: smoke** — create a kids profile cap=PG-13; seed a G item, a PG-13 item, an R item, an unrated item; as the kids profile: list shows only G+PG-13, `/items/<R id>`→404, `/play/<R file>/decision`→403; as a standard profile: all visible. **Step 6: commit** `feat(api): server-side kids-safe catalog filtering`.

---

### Task 4: Manual metadata/poster fix (`apps/api/src/routes/fix.ts` + UI)

**Files:** `apps/api/src/routes/fix.ts`; `apps/web/src/app/title/[id]/fix/page.tsx` (admin); link from the title page (admin only).

**Interfaces:**
- Produces (admin):
  - `GET /items/:id/match-candidates?q=` → search TMDB (using the stored token) → `[{tmdbId,title,year,posterPath(remote thumb)}]` (network action; 503 if no token). Lets the admin find the right movie.
  - `POST /items/:id/match {tmdbId}` → re-run enrichment for THIS item against the chosen tmdbId (overwrites metadata/genres/cast/keywords, re-caches poster/backdrop, sets `matchState="manual"`, re-embeds). Returns the updated item.
  - `POST /items/:id/poster {tmdbPosterPath}` → cache that specific TMDB poster locally and set it as `posterPath` (without changing the rest), `matchState="manual"`.
  - Future scans must NOT overwrite `matchState="manual"` items (verify the scanner already skips/preserves manual; if not, guard it).
- UI: an admin "Fix match" action on the title detail → a page/modal with a TMDB search box, candidate list (poster thumbnails), "Use this match" buttons, and a poster picker.

- [ ] **Step 1:** routes (match-candidates, match, poster) reusing the TMDB client + enrich + cacheImage; guard `matchState="manual"` against rescan overwrite. **Step 2:** the fix UI page (admin-gated client component). **Step 3: smoke (best-effort with token)** — mismatch an item, search, re-match, confirm metadata+poster updated and matchState="manual". typecheck+build. **Step 4: commit** `feat(web): manual metadata + poster fix UI`.

---

### Task 5: Settings UI + extended settings (`apps/web/src/app/admin/settings/page.tsx`)

**Files:** extend `apps/api/src/routes/settings.ts` (encoder `software|vaapi|qsv|nvenc`, provider keys OMDb/Fanart optional, refresh cadence); the settings page.

**Interfaces:**
- Produces: `GET /settings` returns `{ tmdbConfigured, encoder, omdbConfigured, fanartConfigured, refreshCadenceDays }` (no secrets). `PUT /settings` accepts/updates those (secrets write-only). The transcode session manager reads `encoder` from settings (default `software`) when building ffmpeg args (wire `buildHlsArgs` encoder param). Settings page: TMDB token field (masked, shows configured state), encoder dropdown, optional OMDb/Fanart keys, refresh cadence, and the TMDB attribution.

- [ ] **Step 1:** extend settings get/put + wire encoder into the transcode args (default software; never break existing playback). **Step 2:** settings page UI. **Step 3:** typecheck+build+lint; smoke set encoder→reflected in /settings. **Step 4: commit** `feat(web): admin settings (encoder, providers, refresh) UI`.

---

### Task 6: Periodic TMDB metadata refresh job (`apps/api/src/jobs/refresh-metadata.ts`)

**Files:** the job + a `POST /maintenance/refresh` admin trigger; register a periodic schedule (BullMQ repeatable job or a simple interval at startup, cadence from settings).

**Interfaces:**
- Produces: `refreshMetadata(prisma, client)` — for matched items whose metadata is older than the cadence (default 90 days), re-fetch from TMDB and update (respecting `matchState="manual"` poster choices but refreshing other fields; re-cache images; re-validate per TMDB's 6-month rule). Admin `POST /maintenance/refresh` runs it now. Skips cleanly with no token. A `DELETE /maintenance/cache` clears cached metadata+images (TMDB uninstall/clear path).

- [ ] **Step 1:** the refresh function (DI'd client; pure selection of stale items unit-testable) + the routes + the schedule registration (cadence from settings). **Step 2:** typecheck+build+lint; smoke trigger (best-effort). **Step 3: commit** `feat(api): periodic TMDB metadata refresh + clear-cache`.

---

### Task 7: Portainer NAS deploy stack + docs (`deploy/`)

**Files:** `deploy/portainer-stack.yml`, `deploy/.env.production.example`, `deploy/README.md`; a production `apps/api/Dockerfile` + `apps/web/Dockerfile` (multi-stage build → `next build`/`tsc`, run `next start`/node) distinct from the dev Dockerfiles.

**Interfaces:**
- Produces: production multi-stage Dockerfiles (build once, run lean; bake the embedding model into the api image OR document mounting a models volume); `deploy/portainer-stack.yml` defining `web`, `api` (with migrate-on-start + scan/transcode workers + ffmpeg + the model), `postgres` (pgvector, named volume), `redis`, named volumes for `metadata`/`transcode`/`models`, the user's media mounted read-only, published ports, healthchecks, restart policies, an optional commented `/dev/dri` block for HW transcode; `.env.production.example` (DATABASE_URL, SESSION_SECRET generation note, METADATA_DIR=/data/metadata, TRANSCODE_DIR=/data/transcode, MODELS_DIR=/data/models, etc.); `README.md` — step-by-step Portainer deploy (add stack, set env, mount media, first-run setup wizard, where data lives, backup notes).

- [ ] **Step 1:** production Dockerfiles (`next build` succeeds; `tsc` build for api with a real outDir — note: Phase 0 removed the dead api build scripts; add a WORKING production build now: compile api + its workspace deps, or run via a bundled output). Verify `docker build` of each succeeds. **Step 2:** the stack yml + env example + README. **Step 3: verify** `docker compose -f deploy/portainer-stack.yml config` parses; ideally `docker compose -f deploy/portainer-stack.yml up -d --build` brings the prod stack healthy and `/health` is db:true and the web serves (best-effort — report truthfully; the dev stack already proves the app, this proves the prod packaging). **Step 4: commit** `feat(deploy): Portainer NAS production stack + deploy docs`.

---

## Self-Review

**Spec coverage (Phase 4 "Done when": fix a bad match, lock down a kids profile, deploy via Portainer):**
- Manual metadata/poster fix → Task 4. Kids-safe filtering + the rating it depends on → Tasks 1,2,3. Settings (encoder/providers/refresh) → Task 5. Quarterly refresh + clear-cache → Task 6. Portainer NAS stack + docs → Task 7. ✅
- Addresses the master spec's carried prerequisites: `rating` population (Phase 1/3 reviews flagged it) → Task 2; `ratingMax` now enforceable → Task 3; encoder setting wired → Task 5; a real production build (Phase 0 removed the dead one) → Task 7.

**Placeholder scan:** core tasks (1) full TDD; integration tasks give interfaces + key behavior + smokes following established patterns. The TMDB-dependent smokes (2,4,6) are best-effort with a token, degrade-tested without. No `TBD`.

**Type consistency:** `ratingTier`/`allowsRating` (Task 1) feed `kidsRatingFilter`/`certsAtOrBelow` (Task 3); `MediaItem.rating` populated by Task 2 is what Task 3 filters on; the encoder setting (Task 5) feeds `buildHlsArgs`'s `encoder` param (Phase 2). Manual fix (Task 4) reuses TmdbClient+enrich+cacheImage and sets `matchState="manual"` which Task 6's refresh respects. Consistent.

**Note for executor:** kids filtering MUST be server-enforced on EVERY catalog read for a kids profile (list, detail, rows, search, playback decision) — a UI-only filter is a defect. Unrated content is excluded for capped kids (safer default). Run `pnpm lint` per task. TMDB-network smokes are best-effort; the deterministic deliverables (rating tiers, kids filter, settings wiring, prod build parse) are the must-pass.
