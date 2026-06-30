# Orbix — MVP Design Spec

- **Status:** Draft for review
- **Date:** 2026-06-29
- **Author:** Nikita Fedorov (with Claude)

## 1. Summary

Orbix is a self-hosted, open-source media server that runs on a home NAS via Docker. It deliberately wins on three fronts where existing self-hosted servers fall short:

1. **Discovery for large libraries** — smart, auto-generated home rows *and* natural-language "mood" search, so you can find something to watch tonight without scrolling thousands of titles.
2. **Works during an internet outage** — all metadata and artwork are cached to local disk at scan time; browsing and playback never require internet.
3. **A genuinely nice, responsive UI/UX** — modern, fast, and pleasant, with no account friction and no dated interface.

The MVP targets **movies** (the data model leaves room for TV later), with multi-profile households, multi-source libraries, full enrichment, browser playback with real transcoding, and the discovery features above.

### Non-goals (MVP)
- TV shows / episodes (schema-ready, not built).
- Native TV or mobile apps (web only; the web UI is responsive).
- Music, photos, live TV, DVR.
- Multi-server federation / remote access / sharing outside the LAN.
- User-facing plugin system (metadata providers are pluggable internally, not user-installable yet).

## 2. Personas & key journeys

- **Admin (you):** installs Orbix on the NAS, runs the setup wizard, adds libraries/sources, fixes the occasional bad match, manages profiles.
- **Household member (Personal/Family profile):** picks their profile, browses smart rows, searches by mood, plays a movie, resumes later.
- **Kid (Kids profile):** sees only age-appropriate titles; PIN-gated exit from the profile.

**Headline journey — "find something for tonight":** Open Orbix → pick profile → home shows *Continue Watching*, *Because you watched X*, *Pick something for tonight* → or type "something tense and under 2 hours" → get a ranked shortlist → press play → it streams (transcoding transparently if needed) → resume tomorrow where you stopped. All of this works with the internet down.

## 3. Architecture

TypeScript monorepo (pnpm workspaces + Turborepo).

```
orbix/
├─ apps/
│  ├─ web/          Next.js (App Router) + Tailwind — UI, player, admin
│  └─ api/          Fastify + Prisma — REST + SSE, auth, scan, stream, recs
├─ packages/
│  ├─ db/           Prisma schema, migrations, seed
│  ├─ core/         scanner, filename parser, metadata clients, recommender,
│  │                transcode orchestration, embeddings — framework-agnostic
│  ├─ ui/           shared design-system components (Radix + Tailwind + cva)
│  └─ config/       shared tsconfig, eslint, env schema (zod)
├─ workers/         (logical, runs in api container for MVP)
│  ├─ scan-worker        BullMQ consumer: parse → match → enrich → embed
│  └─ transcode-worker   BullMQ consumer: ffmpeg JIT HLS sessions
├─ docker-compose.yml          dev: web, api, postgres(+pgvector), redis, ffmpeg
├─ deploy/portainer-stack.yml  NAS: single deployable stack (web, api, db, redis)
└─ docs/superpowers/specs/
```

**Services / data flow**
- **web (Next.js)** talks to **api (Fastify)** over REST + SSE (scan progress, transcode readiness).
- **api** owns the DB (Postgres + `pgvector`), enqueues jobs to **Redis (BullMQ)**, and runs the scan + transcode workers (in-process for MVP; extractable to separate containers later).
- **Postgres** is the single source of truth (catalog, profiles, history, embeddings). **Redis** is queues + ephemeral transcode-session state. **ffmpeg** is a binary invoked by the transcode worker.
- **Storage volumes:** `media` (read-only mounts of the user's movie folders), `metadata` (downloaded posters/backdrops, app-managed), `transcode-cache` (HLS segments, ephemeral), `models` (embedding model files, baked or mounted).

**Why this shape:** one language end-to-end; clean separation between framework code (`apps/`) and reusable domain logic (`packages/core`) so the hard parts (scanning, transcoding, recs) are testable in isolation and don't depend on Fastify/Next.

## 4. Tech stack (research-backed)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) | end-to-end |
| Monorepo | pnpm workspaces + Turborepo | task caching |
| Frontend | Next.js (App Router) + React + Tailwind | SSR for fast first paint |
| UI primitives | Radix UI + `cva` + `lucide-react` | accessible, headless |
| Player | **Vidstack** (UI) + **hls.js** (engine) | best UX/effort; native HLS on Safari |
| Backend | Fastify + `@fastify/*` plugins | fast, light, good DX |
| ORM/DB | Prisma + **Postgres 16** + **pgvector 0.8** | single datastore |
| Queue | **BullMQ** on Redis | scan + transcode jobs |
| Auth | Lucia-style sessions (cookie) + argon2 | simple, self-hosted |
| Embeddings | **`@huggingface/transformers` v4**, `bge-small-en-v1.5` int8 (~34 MB, 384-dim) | onnxruntime-node; offline |
| Vector search | pgvector **brute-force** (`<=>`, no index) | sub-ms at thousands of rows |
| Filename parsing | **`@ctrl/video-filename-parser`** | Radarr/Sonarr port; + folder-path merge |
| Metadata | **TMDB v4 token** (primary); OMDb/Fanart.tv optional | mandatory attribution; quarterly refresh |
| Transcode | ffmpeg (libx264 default; QSV/VAAPI behind flag) | JIT fMP4 HLS |
| Validation | zod (env + API DTOs) | shared schemas |
| Tests | Vitest (unit), Playwright (e2e) | TDD per feature |

## 5. Data model (Prisma — abridged)

```prisma
// Identity & profiles
model Account   { id, email, passwordHash, isAdmin, createdAt }
model Profile   { id, name, avatar, kind /*standard|kids*/, pinHash?, maturityCap?, createdAt }
// (MVP: one Account = the household; multiple Profiles selected after login)

// Libraries & sources
model Library   { id, name, type /*movie*/, createdAt }
model Section   { id, libraryId, name, kind /*movie*/, order }
model Source    { id, sectionId, path, enabled, lastScanAt }

// Catalog
model MediaItem { id, sectionId, kind /*movie*/, title, sortTitle, year,
                  overview, runtimeSec, rating /*MPAA-ish*/, tmdbId?, imdbId?,
                  posterPath?, backdropPath?, addedAt, matchState /*matched|unmatched|manual*/ }
model MediaFile { id, mediaItemId, path, container, videoCodec, audioCodecs[],
                  width, height, durationSec, bitrate, size, mtime,
                  subtitleTracks Json, audioTracks Json }
model Genre     { id, name }  // + MediaItemGenre join
model Person    { id, tmdbId, name, kind /*actor|director*/ }  // + Credit join (role, order)
model Keyword   { id, tmdbId, name }  // + MediaItemKeyword join (drives "more like this")
model Embedding { mediaItemId @id, vector vector(384), text, model, updatedAt } // pgvector

// Per-profile state
model PlaybackState { id, profileId, mediaItemId, positionSec, durationSec,
                      finished, updatedAt }      // -> Continue Watching / resume
model ListEntry     { id, profileId, mediaItemId, addedAt }  // "My List"
model PlayEvent      { id, profileId, mediaItemId, at }       // history -> recs

// Ops
model ScanJob   { id, sourceId, state, stats Json, startedAt, finishedAt }
model Setting   { key @id, value Json }  // tmdb token, transcode encoder, refresh cadence...
```

Indexes: `MediaFile.path` unique; `MediaItem(sectionId, sortTitle)`; `PlaybackState(profileId, updatedAt)`; pgvector column queried by brute-force cosine.

## 6. Subsystem designs

### 6.1 Auth & profiles
- **First-run setup wizard** (`/setup`): create admin (email + argon2 password), set TMDB token, name the first library. Idempotent; blocked once an admin exists.
- **Login** → cookie session. **"Who's watching?"** screen lists profiles; selecting one sets the active-profile cookie. **Kids** profiles and PIN-protected profiles prompt for the 4-digit PIN.
- **Authorization:** admin-only routes (sources, settings, manual fix, profile management) gated by `isAdmin`. Active profile scopes all per-profile reads/writes.
- **Kids enforcement:** server-side filter — kids profiles only see `MediaItem.rating <= maturityCap`; the filter lives in the data-access layer, not just the UI.

### 6.2 Libraries, sections, sources
- Admin CRUD for libraries → sections → sources. A source is a path mounted into the container (validated to exist + be readable on save).
- "Scan" actions: per-source, per-section, or full. Scans enqueue a `ScanJob`; progress streamed to the admin UI via SSE.

### 6.3 Scanner & filename parsing (`packages/core/scanner`)
- Walk source paths for video extensions. For each file: **merge folder-path + filename** through `@ctrl/video-filename-parser` to extract title, year, resolution, codecs, edition.
- **If an embedded `[tmdbid-…]`/`{tmdb-…}` ID is present, trust it; skip fuzzy matching.** Otherwise queue a TMDB match by title+year.
- `ffprobe` each file once → persist container/codecs/tracks/duration into `MediaFile` (drives the direct-play vs transcode decision later).
- Incremental: skip files whose `(path, mtime, size)` are unchanged. Removed files mark items as missing.

### 6.4 Metadata enrichment & offline caching (`packages/core/metadata`)
- **TMDB client** (v4 read token) fetches movie details, credits, keywords, genres, images.
- **Cache everything locally:** write fields to Postgres; **download poster + backdrop image files** to the `metadata` volume; the app serves images from disk only — never hot-links TMDB. This is what delivers offline operation.
- **Provider interface** so OMDb (ratings) and Fanart.tv (artwork) can enrich on scan if keys are configured. TheTVDB intentionally excluded (paid).
- **Compliance:** show the mandatory TMDB attribution string + logo in About/Credits. A **quarterly refresh job** re-validates cached metadata (TMDB forbids caching >6 months) and a "clear metadata cache" admin action exists.

### 6.5 Playback & transcoding (`packages/core/transcode` + api `/stream`)
- On play, api inspects the `MediaFile` and picks a strategy:
  - **Direct play:** MP4 + H.264(8-bit) + AAC → serve the file with range requests.
  - **Remux:** compatible video/audio in MKV, or AC3/EAC3/DTS audio → fMP4 HLS, `-c:v copy`, transcode only the offending stream (e.g. `-c:a aac`).
  - **Full transcode:** HEVC/VP9/10-bit video → `libx264` (default) → fMP4 HLS.
- **JIT HLS (VOD-playlist pattern):** ffprobe duration → emit a **complete VOD `.m3u8`** (every `#EXTINF` + `#EXT-X-ENDLIST`) immediately so scrubbing works before segments exist. Transcode lazily; on a seek into an untranscoded region, **kill ffmpeg and restart** with input-side `-ss` + `-start_number N` to fill the promised slots.
- **Subtitles:** text (SRT/ASS) → converted to **WebVTT sidecars**, toggled in the player. Image subs (PGS/VobSub) → burned in (forces video transcode), flagged as a heavier path.
- **HW accel:** encoder is a setting (`software|vaapi|qsv|nvenc`), default `software` (libx264). VAAPI/QSV documented for Intel-iGPU NAS boxes (`/dev/dri/renderD128` + `group_add: render`).
- **Session lifecycle:** transcode sessions keyed by `(mediaFileId, profileId)`, segments in `transcode-cache`, reaped on stop/idle.

### 6.6 Discovery (`packages/core/recommender` + embeddings)
- **Smart rows (content-based, offline):** computed from genre/cast/director/keyword overlap + per-profile `PlayEvent`/`PlaybackState`. Rows: *Continue Watching*, *Because you watched X*, *More like this*, *Hidden gems* (highly-rated, never-played), *Pick something for tonight* (a small curated shuffle weighted by affinity).
- **NL mood search:**
  1. Embed each item's `title + overview + genres + keywords` with `bge-small` at scan time → `Embedding.vector`.
  2. At query time: **regex constraint extraction** ("under 2 hours", "from the 90s", genre/rating words) → structured filters; the residual free-text is embedded (with bge's `query:` prefix) and ranked by brute-force cosine over the filtered candidate set.
  3. Constraint parser is a **swappable interface** so a local LLM (Ollama + Qwen2.5-3B) can replace the regex layer later — not in MVP.
- **Fully offline:** model files baked into the image (or mounted), `env.allowRemoteModels=false`, cache on a `models` volume so rebuilds don't lose them.

### 6.7 Manual metadata/poster fix
- Admin opens an item → **re-search TMDB** by title → pick the correct match (or paste a TMDB/IMDb ID) → re-enrich. **Choose a different poster/backdrop** from TMDB's image list. Sets `matchState = manual` so future scans don't overwrite the manual choice.

### 6.8 Kids-safe profiles
- Profile `kind = kids` + `maturityCap` → server-side library filtering; simplified, playful UI skin; PIN required to switch out of a kids profile.

## 7. UI/UX & design system

- **Visual direction:** dark-first, cinematic, poster-forward — polished, fast, and clean. Tailwind tokens for color/space/typography; Radix for accessible primitives; `cva` for component variants.
- **Key screens:** Setup wizard · "Who's watching?" · Home (smart rows) · Library grid (filter/sort) · Title detail (cast, related, play/resume, fix-match for admin) · Player (Vidstack: quality, subtitles, audio track, resume) · Search (NL + filters) · Admin (libraries/sources/scan, profiles, settings, manual fix).
- **Responsive:** fluid grid; works on laptop, tablet, large desktop, and TV-browser widths. Keyboard + pointer friendly.
- **Performance:** SSR home/library shells, image thumbnails generated and served at display size, optimistic resume.

## 8. Deployment & dev environment

- **Dev (`docker-compose.yml`):** `web` (1060), `api` (1061), `postgres`+pgvector (1062), `redis` (1063). Hot reload for web + api; sample media folder mounted; ffmpeg in the api image. Ports reserved via **port-manager** (`orbix/dev`).
- **NAS (`deploy/portainer-stack.yml`):** single stack deployable through **Portainer** — `web`, `api` (with scan+transcode workers in-process), `postgres`, `redis`; named volumes for `metadata`, `transcode-cache`, `models`; the user's movie shares mounted read-only; an optional `devices: /dev/dri/renderD128` block (commented) for HW transcode.
- **Config** via env (zod-validated) + DB `Setting` rows; secrets (TMDB token) set in setup wizard, stored in DB.
- *"portmanger" was ambiguous — covered both: port-manager for dev ports, and a Portainer-ready NAS stack.*

## 9. Roadmap / phasing

Each phase ships something usable, has its own implementation plan, and ends with acceptance criteria. (This master spec → per-phase plan → implementation, repeated.)

### Phase 0 — Foundations
Monorepo (pnpm + Turbo), `db`/`core`/`ui`/`config` packages, dev `docker-compose` (web/api/postgres+pgvector/redis), env + health checks, Prisma schema + first migration, auth (account + argon2 + sessions), setup wizard, profile model + "Who's watching?", base design system + app shell.
**Done when:** `docker compose up` boots the stack; you complete setup, create profiles, and pick one; CI runs lint/typecheck/tests.

### Phase 1 — Library + Metadata
Library/section/source admin CRUD; scanner (walk → parse → ffprobe → persist); TMDB enrichment + **local image caching** (offline); incremental rescan; library browse grid + title detail; scan progress via SSE.
**Done when:** point Orbix at a movie folder, scan, and browse correctly-enriched titles with local posters — with the network unplugged after scan.

### Phase 2 — Playback
`/stream` strategy (direct/remux/transcode); JIT fMP4 HLS via ffmpeg; Vidstack + hls.js player; subtitles (text→WebVTT); per-profile resume + Continue Watching; seek-restart handling.
**Done when:** an MKV/HEVC file plays and seeks in-browser, subtitles toggle, and resume works across sessions and profiles.

### Phase 3 — Discovery
Embedding pipeline (bge-small → pgvector) at scan time; smart home rows; NL mood search with regex constraint parsing + vector ranking.
**Done when:** the home page shows relevant personalized rows and "something funny under 2 hours" returns a sensible, correctly-filtered shortlist — offline.

### Phase 4 — Management + polish
Manual metadata/poster fix UI; kids-safe filtering + PIN; settings (encoder, refresh cadence, providers); quarterly metadata refresh job; responsive/visual polish; **Portainer NAS stack** + deploy docs.
**Done when:** you can fix a bad match, lock down a kids profile, and deploy the stack on the NAS via Portainer.

## 10. Risks & mitigations

- **Transcoding is the hardest part.** Mitigate: start with direct-play + remux, get JIT-HLS + seek-restart correct on libx264 before any HW accel; lean on the documented JIT-HLS VOD-playlist approach.
- **Embedding model in Docker / offline.** Mitigate: bake model into image or mount `models` volume; `allowRemoteModels=false`; pin platform/arch for `onnxruntime-node` native binaries.
- **TMDB compliance (6-month cache + attribution).** Mitigate: quarterly refresh job, attribution UI, clear-cache action — designed in from Phase 1/4.
- **Scope (ambitious MVP).** Mitigate: strict phasing; each phase independently usable; YAGNI on anything not serving the three differentiators.
- **NAS hardware variance (HW accel).** Mitigate: software default that works everywhere; HW behind a clearly-documented flag.

## 11. Open assumptions (callable corrections)

- One household account (admin) + multiple selectable profiles, **not** separate per-person logins. (Brief said "user with multiple profiles.")
- MVP catalog = **movies only**; TV is schema-ready but unbuilt.
- "portmanger" = both port-manager (dev ports) **and** a Portainer-deployable NAS stack.
- LAN-only access for MVP (no remote/secure-internet exposure feature).
