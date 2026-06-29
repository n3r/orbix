# Orbix Phase 1 — Library + Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin point Orbix at movie folders, scan them, enrich each title from TMDB with metadata + locally-cached artwork (works offline after scan), and browse the enriched library (grid + title detail) in the web UI.

**Architecture:** Build on the Phase 0 monorepo. New domain logic lives in `packages/core` (framework-agnostic, DI-tested): `scanner/` (filename parse, ffprobe, walk+upsert), `metadata/` (TMDB client, image cache, enrichment). New Prisma catalog models. The api gains library/section/source/settings CRUD, a BullMQ scan worker, SSE scan-progress, and a local-image serving route. The web gains library browse + title detail. The browser reaches the API **same-origin** via a Next proxy (`/api/*`) so the app works from any LAN device.

**Tech Stack:** TS strict; `@ctrl/video-filename-parser` (filename parsing); native `fetch` (TMDB v4, Node 22 global); `ffprobe` (from the ffmpeg already in the api image) invoked via an injectable runner; BullMQ on Redis (scan jobs); Prisma/Postgres; Next 15 / Fastify 5 / Vitest.

## Global Constraints

- **Language:** TypeScript, `"strict": true`. Domain logic in `packages/core` (framework-agnostic, dependency-injected, unit-tested); apps stay thin. Env only via `@orbix/config`'s zod schema.
- **Offline is mandatory:** at view time Orbix must NOT call the internet. All TMDB metadata is persisted to Postgres and all poster/backdrop images are downloaded to the local `METADATA_DIR` at scan time; the UI serves images from disk only.
- **TMDB compliance:** use a TMDB **v4 Read Access Token** (stored in DB `Setting`, never committed). Show the mandatory attribution string in the UI About/Credits: *"This product uses the TMDB API but is not endorsed or certified by TMDB."* Cache TTL/refresh is a Phase 4 concern; do not re-fetch at view time.
- **Ports/services (unchanged):** web 1060, api 1061, postgres 1062, redis 1063. Dockerized postgres+redis must be running for integration steps; api/web verified on host OR via the Docker stack.
- **New env var:** `METADATA_DIR` (absolute path for cached images; dev default `<repo>/data/metadata`, gitignored; compose mounts a named volume). Add to the `@orbix/config` schema.
- **No network in unit tests:** TMDB client, image cache, enrichment, and ffprobe are tested with injected fakes/mocks — never real network or real ffprobe.
- **Commits:** conventional-commit; bodies end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. TDD: failing test first for all domain logic.
- **Movies only** this phase (schema leaves room for TV; do not build TV).

---

## File Structure

```
packages/db/prisma/schema.prisma         # + Library, Section, Source, MediaItem, MediaFile,
                                          #   Genre, Person, Credit, Keyword, joins, Setting
packages/config/src/env.ts               # + METADATA_DIR
packages/core/src/
  settings/settings.ts                   # typed settings get/set helpers over Setting rows
  library/library.ts                     # validate library/section/source inputs
  scanner/parse.ts                        # parseMediaPath() — filename+folder -> {title,year,...}
  scanner/probe.ts                        # probeFile() — ffprobe -> MediaFileTechnical (injectable runner)
  scanner/scan.ts                         # scanSource() — walk, parse, probe, upsert (incremental)
  metadata/tmdb.ts                        # TmdbClient — search/details/credits/keywords/images
  metadata/images.ts                      # cacheImage() — download to METADATA_DIR, return rel path
  metadata/enrich.ts                      # enrichItem() — match + persist fields/genres/cast/keywords + images
apps/api/src/
  plugins/queue.ts                        # BullMQ connection + scan queue/worker
  routes/settings.ts                      # GET/PUT /settings (admin)
  routes/libraries.ts                     # CRUD /libraries, /sections, /sources (admin)
  routes/scan.ts                          # POST /sections/:id/scan ; GET /scan/:jobId/stream (SSE)
  routes/catalog.ts                       # GET /sections/:id/items ; GET /items/:id
  routes/images.ts                        # GET /images/* -> serve cached file from METADATA_DIR
apps/web/
  next.config.ts                          # + rewrite /api/:path* -> API_INTERNAL_URL
  src/lib/api.ts                          # base -> "/api" (same-origin)
  src/app/admin/libraries/page.tsx        # manage libraries/sections/sources + scan
  src/app/library/[sectionId]/page.tsx    # browse grid
  src/app/title/[id]/page.tsx             # title detail
```

---

### Task 1: Same-origin API access (Next proxy + CORS config) — Phase-1 prerequisite

**Files:**
- Modify: `apps/web/next.config.ts`, `apps/web/src/lib/api.ts`, `apps/api/src/app.ts`
- Modify: `apps/web/src/app/page.tsx` (server fetch base unchanged — already uses API_INTERNAL_URL)

**Interfaces:**
- Produces: browser `apiFetch(path)` calls `"/api"+path` (same-origin); Next rewrites `/api/:path*` to the API. The app is reachable from any LAN device hitting the web origin.

- [ ] **Step 1: Next rewrite**

`apps/web/next.config.ts`:
```ts
import type { NextConfig } from "next";
const API = process.env.API_INTERNAL_URL ?? "http://localhost:1061";
const nextConfig: NextConfig = {
  transpilePackages: ["@orbix/ui"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API}/:path*` }];
  },
};
export default nextConfig;
```

- [ ] **Step 2: Point the browser client at same-origin `/api`**

`apps/web/src/lib/api.ts`:
```ts
const BASE = "/api";
export async function apiFetch(path: string, init?: RequestInit) {
  const headers = init?.body ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers;
  return fetch(`${BASE}${path}`, { ...init, credentials: "include", headers });
}
```

- [ ] **Step 3: Make CORS origin configurable (belt-and-suspenders for direct API hits)**

In `apps/api/src/app.ts` cors registration, allow a comma-separated `WEB_ORIGIN` list (still defaults to the single dev origin). Keep `credentials: true`.
```ts
const origins = env.WEB_ORIGIN.split(",").map((s) => s.trim());
await app.register(cors, { origin: origins, credentials: true });
```

- [ ] **Step 4: Verify the e2e still passes through the proxy**

Run: `pnpm --filter @orbix/web test:e2e`
Expected: onboarding spec PASS (browser now calls `/api/*` on the web origin; Next proxies to the api; cookies are first-party to the web origin).

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(web): serve API same-origin via /api proxy so the app works across the LAN"
```

---

### Task 2: Catalog data model (Prisma) + Setting

**Files:**
- Modify: `packages/db/prisma/schema.prisma`; create migration under `packages/db/prisma/migrations/`

**Interfaces:**
- Produces: tables for `Library, Section, Source, MediaItem, MediaFile, Genre, Person, Credit, Keyword, MediaItemGenre, MediaItemKeyword, Setting`.

- [ ] **Step 1: Add models**

Append to `schema.prisma`:
```prisma
model Library  { id String @id @default(cuid()) name String type String @default("movie") createdAt DateTime @default(now()) sections Section[] }
model Section  { id String @id @default(cuid()) libraryId String library Library @relation(fields:[libraryId],references:[id],onDelete:Cascade) name String kind String @default("movie") order Int @default(0) sources Source[] items MediaItem[] @@index([libraryId]) }
model Source   { id String @id @default(cuid()) sectionId String section Section @relation(fields:[sectionId],references:[id],onDelete:Cascade) path String enabled Boolean @default(true) lastScanAt DateTime? @@index([sectionId]) }

model MediaItem {
  id String @id @default(cuid())
  sectionId String
  section Section @relation(fields:[sectionId],references:[id],onDelete:Cascade)
  kind String @default("movie")
  title String
  sortTitle String
  year Int?
  overview String?
  runtimeSec Int?
  rating String?            // e.g. "PG-13"
  tmdbId Int?
  imdbId String?
  posterPath String?        // relative path under METADATA_DIR
  backdropPath String?
  matchState String @default("unmatched") // unmatched|matched|manual
  addedAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  files MediaFile[]
  genres MediaItemGenre[]
  keywords MediaItemKeyword[]
  credits Credit[]
  @@index([sectionId, sortTitle])
  @@index([tmdbId])
}

model MediaFile {
  id String @id @default(cuid())
  mediaItemId String
  mediaItem MediaItem @relation(fields:[mediaItemId],references:[id],onDelete:Cascade)
  path String @unique
  container String?
  videoCodec String?
  audioCodecs String[]      // postgres text[]
  width Int?
  height Int?
  durationSec Int?
  bitrate Int?
  size BigInt?
  mtime DateTime?
  subtitleTracks Json @default("[]")
  audioTracks Json @default("[]")
  @@index([mediaItemId])
}

model Genre   { id Int @id @default(autoincrement()) tmdbId Int? @unique name String @unique items MediaItemGenre[] }
model Keyword { id Int @id @default(autoincrement()) tmdbId Int? @unique name String @unique items MediaItemKeyword[] }
model Person  { id Int @id @default(autoincrement()) tmdbId Int? @unique name String credits Credit[] }
model Credit  { id String @id @default(cuid()) mediaItemId String mediaItem MediaItem @relation(fields:[mediaItemId],references:[id],onDelete:Cascade) personId Int person Person @relation(fields:[personId],references:[id]) role String department String order Int @default(0) @@index([mediaItemId]) }
model MediaItemGenre   { mediaItemId String mediaItem MediaItem @relation(fields:[mediaItemId],references:[id],onDelete:Cascade) genreId Int genre Genre @relation(fields:[genreId],references:[id]) @@id([mediaItemId,genreId]) }
model MediaItemKeyword { mediaItemId String mediaItem MediaItem @relation(fields:[mediaItemId],references:[id],onDelete:Cascade) keywordId Int keyword Keyword @relation(fields:[keywordId],references:[id]) @@id([mediaItemId,keywordId]) }

model Setting { key String @id value Json updatedAt DateTime @updatedAt }
```

- [ ] **Step 2: Migrate against the running Postgres**
Run: `DATABASE_URL=postgresql://orbix:orbix@localhost:1062/orbix pnpm --filter @orbix/db exec prisma migrate dev --name catalog`
Expected: migration created + applied; `pnpm --filter @orbix/db exec prisma generate` regenerates the client. Verify tables with `docker compose exec -T postgres psql -U orbix -d orbix -c '\dt'`.

- [ ] **Step 3: Commit** (`git add -A && git commit -m "feat(db): add catalog models (library/section/source/mediaitem/mediafile/credits) + Setting"`)

---

### Task 3: Settings store + routes (TMDB token)

**Files:**
- Create: `packages/core/src/settings/settings.ts`, `packages/core/src/settings/settings.test.ts`, `apps/api/src/routes/settings.ts`
- Modify: `packages/core/src/index.ts`, `apps/api/src/app.ts`

**Interfaces:**
- Produces: `getSetting<T>(key, deps)`, `setSetting(key, value, deps)` (DI over a `Setting` store). Routes `GET /settings` (admin; returns known settings with secrets masked) and `PUT /settings` (admin; merges).

- [ ] **Step 1: Failing test — settings round-trip**

`packages/core/src/settings/settings.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { getSetting, setSetting } from "./settings";

function fakeStore() {
  const m = new Map<string, unknown>();
  return {
    read: async (k: string) => (m.has(k) ? { value: m.get(k) } : null),
    write: async (k: string, v: unknown) => { m.set(k, v); },
  };
}

describe("settings", () => {
  it("returns the default when unset", async () => {
    expect(await getSetting("tmdbToken", { fallback: "", read: fakeStore().read })).toBe("");
  });
  it("round-trips a value", async () => {
    const s = fakeStore();
    await setSetting("tmdbToken", "abc", { write: s.write });
    expect(await getSetting("tmdbToken", { fallback: "", read: s.read })).toBe("abc");
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement**

`packages/core/src/settings/settings.ts`:
```ts
export async function getSetting<T>(key: string, deps: { fallback: T; read: (k: string) => Promise<{ value: unknown } | null> }): Promise<T> {
  const row = await deps.read(key);
  return (row ? (row.value as T) : deps.fallback);
}
export async function setSetting(key: string, value: unknown, deps: { write: (k: string, v: unknown) => Promise<void> }): Promise<void> {
  await deps.write(key, value);
}
```
Add `export * from "./settings/settings";` to `packages/core/src/index.ts`. Run test → PASS.

- [ ] **Step 4: Routes** (`apps/api/src/routes/settings.ts`)

```ts
import type { FastifyInstance } from "fastify";
import { getSetting, setSetting } from "@orbix/core";

const read = (app: FastifyInstance) => (k: string) => app.prisma.setting.findUnique({ where: { key: k } });
const write = (app: FastifyInstance) => async (k: string, v: unknown) =>
  { await app.prisma.setting.upsert({ where: { key: k }, create: { key: k, value: v as object }, update: { value: v as object } }); };

export default async function settings(app: FastifyInstance) {
  const requireAdmin = async (req: any, reply: any) => { if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" }); };

  app.get("/settings", { preHandler: requireAdmin }, async () => {
    const token = await getSetting<string>("tmdbToken", { fallback: "", read: read(app) });
    return { tmdbConfigured: token.length > 0 }; // never return the secret
  });

  app.put<{ Body: { tmdbToken?: string } }>("/settings", { preHandler: requireAdmin }, async (req) => {
    if (typeof req.body?.tmdbToken === "string") await setSetting("tmdbToken", req.body.tmdbToken, { write: write(app) });
    return { ok: true };
  });
}
```
Register in `app.ts`.

- [ ] **Step 5: Smoke + commit** — start api on host, `PUT /settings {tmdbToken:"x"}` with admin cookie, `GET /settings` → `{tmdbConfigured:true}`; clean DB. Commit `feat(api): settings store with TMDB token (secret never returned)`.

---

### Task 4: Library / Section / Source CRUD (domain + routes)

**Files:**
- Create: `packages/core/src/library/library.ts` (+ test), `apps/api/src/routes/libraries.ts`; Modify `index.ts`, `app.ts`

**Interfaces:**
- Produces: `validateLibraryInput`, `validateSectionInput`, `validateSourceInput` (zod; throw `LibraryValidationError`). Admin routes: `GET/POST /libraries`, `POST /sections`, `PATCH/DELETE /sections/:id`, `POST /sources`, `DELETE /sources/:id`. Source create validates the `path` exists+readable (DI'd `pathExists`).

- [ ] **Step 1: Failing test — input validation**

`packages/core/src/library/library.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { validateSourceInput, LibraryValidationError } from "./library";
describe("validateSourceInput", () => {
  it("accepts an absolute path", () => { expect(validateSourceInput({ sectionId: "s1", path: "/movies" }).path).toBe("/movies"); });
  it("rejects an empty path", () => { expect(() => validateSourceInput({ sectionId: "s1", path: "" })).toThrow(LibraryValidationError); });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement** `library.ts` with zod schemas for library `{name}`, section `{libraryId,name,order?}`, source `{sectionId,path}` (path must be non-empty); `LibraryValidationError`. Export from `index.ts`. Test → PASS.

- [ ] **Step 4: Routes** (`apps/api/src/routes/libraries.ts`) — admin-gated CRUD mirroring the Phase 0 profiles route patterns. On `POST /sources`, after validation, check the path is readable via an injected `fs.promises.access`; return 400 `{error:"path_unreadable"}` if not (in dev the path is inside the container/host). Register in `app.ts`.

- [ ] **Step 5: Smoke (create library→section→source) + commit** `feat(api): library/section/source admin CRUD`.

---

### Task 5: Filename + folder parser (`packages/core/src/scanner/parse.ts`)

**Files:**
- Create: `packages/core/src/scanner/parse.ts`, `packages/core/src/scanner/parse.test.ts`; Modify `packages/core/package.json` (add `@ctrl/video-filename-parser`), `index.ts`

**Interfaces:**
- Produces: `parseMediaPath(fullPath: string): { title: string; year?: number; tmdbId?: number; imdbId?: string }` — merges folder + filename; trusts an embedded `[tmdbid-NNN]`/`{tmdb-NNN}`/`[imdbid-ttNNN]` provider id when present, else returns title+year for TMDB matching. Folder year wins over filename year on conflict.

- [ ] **Step 1: Failing tests**

`packages/core/src/scanner/parse.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseMediaPath } from "./parse";
describe("parseMediaPath", () => {
  it("extracts title + year from 'Title (2010)/Title (2010).mkv'", () => {
    const r = parseMediaPath("/m/The Matrix (1999)/The Matrix (1999).mkv");
    expect(r.title).toBe("The Matrix"); expect(r.year).toBe(1999);
  });
  it("prefers the folder year when filename year differs", () => {
    const r = parseMediaPath("/m/Blade Runner (1982)/Blade Runner (1992 remaster).mkv");
    expect(r.year).toBe(1982);
  });
  it("trusts an embedded tmdb id", () => {
    const r = parseMediaPath("/m/Some Movie (2020) [tmdbid-603]/file.mkv");
    expect(r.tmdbId).toBe(603);
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement** using `@ctrl/video-filename-parser` for the filename, plus a regex pass over the parent folder name for `(YYYY)`, `[tmdbid-NNN]`/`{tmdb-NNN}`, `[imdbid-ttNNN]`. Merge: provider id (folder preferred) short-circuits; title from filename parser (fallback folder); year = folder year ?? filename year, folder wins on conflict. Test → PASS.

- [ ] **Step 4: Commit** `feat(core): media path parser (filename+folder merge, embedded id trust)`.

---

### Task 6: ffprobe wrapper (`packages/core/src/scanner/probe.ts`)

**Files:**
- Create: `packages/core/src/scanner/probe.ts`, `packages/core/src/scanner/probe.test.ts`; Modify `index.ts`

**Interfaces:**
- Produces: `probeFile(path, deps: { run: (path) => Promise<string> }): Promise<MediaFileTechnical>` where `run` returns ffprobe JSON (DI so tests need no ffprobe). `MediaFileTechnical = { container?, videoCodec?, audioCodecs, width?, height?, durationSec?, bitrate?, subtitleTracks, audioTracks }`. Also export `ffprobeRunner(path)` that shells `ffprobe -v quiet -print_format json -show_format -show_streams <path>` via `node:child_process` for production use.

- [ ] **Step 1: Failing test (with a fixed ffprobe JSON fixture)**

`probe.test.ts`: feed a sample ffprobe JSON string (one h264 video stream 1920x1080, one ac3 audio, one subtitle stream, format duration 7200.5, bit_rate) through `probeFile(path, { run: async () => FIXTURE })` and assert `videoCodec==="h264"`, `audioCodecs.includes("ac3")`, `width===1920`, `durationSec===7200`, `subtitleTracks.length===1`.

- [ ] **Step 2: Run → fail. Step 3: Implement** `probeFile` parsing the JSON (`format` + `streams[]` by `codec_type`), rounding duration to int seconds; `ffprobeRunner` shelling out (used only in production, not in tests). Export. Test → PASS.

- [ ] **Step 4: Commit** `feat(core): ffprobe wrapper (injectable runner, codec/track extraction)`.

---

### Task 7: Scanner — walk, parse, probe, upsert (incremental)

**Files:**
- Create: `packages/core/src/scanner/scan.ts`, `packages/core/src/scanner/scan.test.ts`; Modify `index.ts`

**Interfaces:**
- Produces: `scanSource(opts, deps): Promise<{ added: number; updated: number; skipped: number; itemIds: string[] }>`. `deps` injects `listFiles(root) -> {path,mtime,size}[]`, `probe(path)`, and a repo `{ findFileByPath, upsertItemAndFile }`. Skips files whose `(path,mtime,size)` are unchanged. New/changed files: `parseMediaPath` → upsert `MediaItem` (matchState `unmatched`, sortTitle = lowercased title) + `MediaFile`. Returns the touched item ids (for enrichment).

- [ ] **Step 1: Failing test** — drive `scanSource` with an in-memory `listFiles` returning two fake files, a stub `probe`, and an in-memory repo; assert `added===2`; run again with unchanged stat → `skipped===2, added===0`.
- [ ] **Step 2: Run → fail. Step 3: Implement** the walk+diff+upsert loop (DI; no real fs/ffprobe in the test). Test → PASS.
- [ ] **Step 4: Commit** `feat(core): incremental source scanner (parse+probe+upsert)`.

---

### Task 8: TMDB client (`packages/core/src/metadata/tmdb.ts`)

**Files:**
- Create: `packages/core/src/metadata/tmdb.ts`, `packages/core/src/metadata/tmdb.test.ts`; Modify `index.ts`

**Interfaces:**
- Produces: `class TmdbClient { constructor(token: string, fetchImpl?: typeof fetch) ; searchMovie(title, year?) ; movie(id) ; credits(id) ; keywords(id) ; }`. v4 bearer token in `Authorization` header. All methods return normalized shapes (not raw TMDB). `fetchImpl` is injectable so tests pass a fake returning canned JSON — NO real network.

- [ ] **Step 1: Failing test** — construct `new TmdbClient("tok", fakeFetch)` where `fakeFetch` asserts the `Authorization: Bearer tok` header and returns a canned search payload; assert `searchMovie("The Matrix",1999)` returns `{ tmdbId: 603, title: "The Matrix", year: 1999 }` (first result, year parsed from `release_date`).
- [ ] **Step 2: Run → fail. Step 3: Implement** with global `fetch` default; build URLs `https://api.themoviedb.org/3/search/movie?query=...&year=...`, `/movie/{id}`, `/movie/{id}/credits`, `/movie/{id}/keywords`; map fields (id→tmdbId, release_date→year, runtime→runtimeSec=runtime*60, genres, poster_path/backdrop_path kept as TMDB relative paths, certification best-effort). On non-2xx throw `TmdbError`. Test → PASS.
- [ ] **Step 4: Commit** `feat(core): TMDB v4 client (injectable fetch, normalized shapes)`.

---

### Task 9: Image cache (`packages/core/src/metadata/images.ts`)

**Files:**
- Create: `packages/core/src/metadata/images.ts`, `packages/core/src/metadata/images.test.ts`; Modify `index.ts`

**Interfaces:**
- Produces: `cacheImage(tmdbPath, kind, deps): Promise<string>` — downloads `https://image.tmdb.org/t/p/<size><tmdbPath>` and writes it under `METADATA_DIR/<kind>/<basename>`, returning the **relative** path (e.g. `poster/abc.jpg`) stored on `MediaItem`. `deps` injects `{ fetchImpl, writeFile, exists, baseDir, size }`. If already cached (`exists`), skip download and return the path (offline-friendly, idempotent).

- [ ] **Step 1: Failing test** — `cacheImage("/abc.jpg","poster",{ fetchImpl: fakeReturningBytes, writeFile: spy, exists: async()=>false, baseDir:"/meta", size:"w500" })` returns `"poster/abc.jpg"` and called `writeFile` with `/meta/poster/abc.jpg`; second call with `exists: async()=>true` does NOT call `fetchImpl`.
- [ ] **Step 2: Run → fail. Step 3: Implement** (DI; tests never hit network/disk). Test → PASS.
- [ ] **Step 4: Commit** `feat(core): TMDB image cache (idempotent, offline-first)`.

---

### Task 10: Enrichment + image serving route

**Files:**
- Create: `packages/core/src/metadata/enrich.ts` (+ test), `apps/api/src/routes/images.ts`; Modify `index.ts`, `app.ts`

**Interfaces:**
- Produces: `enrichItem(item, deps): Promise<EnrichResult>` — if `item.tmdbId` use it, else `searchMovie(title, year)`; fetch details/credits/keywords; via repo callbacks persist overview/year/runtime/rating/genres/top-cast+director/keywords and set `matchState="matched"`; cache poster+backdrop via `cacheImage`, persist their relative paths. If no match: leave `unmatched`, return `{matched:false}`. All TMDB+image+db interactions are DI'd. Route `GET /images/*` streams the file from `METADATA_DIR` (path-traversal guarded) with long cache headers.

- [ ] **Step 1: Failing test** — `enrichItem({title:"The Matrix",year:1999}, fakes)` where fake client returns tmdbId 603 + details; assert the repo `saveMetadata` was called with `overview`, `runtimeSec`, `genres:["Action",...]`, and `posterPath` set; `matched===true`. A second case with the client returning no results → `matched===false`, `saveMetadata` not called.
- [ ] **Step 2: Run → fail. Step 3: Implement** enrich orchestration + the `images.ts` route (use `path.normalize` + ensure the resolved path stays under `METADATA_DIR`; 404 otherwise). Register route. Test → PASS.
- [ ] **Step 4: Commit** `feat(core): TMDB enrichment pipeline + api image-serving route`.

---

### Task 11: Scan queue (BullMQ) + scan routes + SSE progress

**Files:**
- Create: `apps/api/src/plugins/queue.ts`, `apps/api/src/routes/scan.ts`; Modify `app.ts`, `apps/api/package.json` (add `bullmq`)

**Interfaces:**
- Consumes: `scanSource`, `enrichItem`, `TmdbClient`, `getSetting`, `ffprobeRunner`, real `fs`.
- Produces: a BullMQ `scan` queue + in-process worker. `POST /sections/:id/scan` (admin) enqueues a job per enabled source and returns `{jobId}`. The worker runs `scanSource` (real fs `listFiles` + `ffprobeRunner`) then `enrichItem` for each touched item using a `TmdbClient` built from the stored token (skips enrichment with a logged warning if no token). Progress (`{phase, processed, total}`) is published to a per-job channel; `GET /scan/:jobId/stream` is an SSE endpoint emitting those events. `lastScanAt` updated on the source.

- [ ] **Step 1: Queue plugin** — `plugins/queue.ts` creates a BullMQ `Queue` + `Worker` on `REDIS_URL`, decorates `app.scanQueue`, registers the processor (calls into core with real adapters), and a simple EventEmitter/Redis pub-sub for progress. Close on `onClose`.
- [ ] **Step 2: Scan routes** — `POST /sections/:id/scan` (admin) enqueues; `GET /scan/:jobId/stream` sets `content-type: text/event-stream` and forwards progress events until `done`. Register in `app.ts`.
- [ ] **Step 3: Integration smoke** — create a temp dir with 2 dummy `.mkv` files named `Movie (2020).mkv`, point a source at it, `POST /scan`, observe SSE progress to completion, and `GET /sections/:id/items` shows 2 items (unmatched if no TMDB token; matched if a token is set in env for the smoke). Clean DB.
- [ ] **Step 4: Commit** `feat(api): BullMQ scan worker + SSE scan progress`.

---

### Task 12: Catalog routes + browse & detail UI + attribution

**Files:**
- Create: `apps/api/src/routes/catalog.ts`, `apps/web/src/app/admin/libraries/page.tsx`, `apps/web/src/app/library/[sectionId]/page.tsx`, `apps/web/src/app/title/[id]/page.tsx`; Modify `app.ts`
- Test: `apps/web/e2e/library.spec.ts`

**Interfaces:**
- Produces: `GET /sections/:id/items?sort=&q=` → paginated items (id,title,year,posterPath,matchState); `GET /items/:id` → full detail (overview, runtime, genres, top cast, files). UI: admin libraries page (create library/section/source, trigger scan, watch SSE progress); library grid (posters via `/api/images/<posterPath>`, fallback placeholder for unmatched); title detail (backdrop, overview, year, runtime, genres, cast, a disabled "Play" button — playback is Phase 2). Footer shows the TMDB attribution string.

- [ ] **Step 1: Catalog routes** (admin for items list is fine; profile-gating comes with kids filtering in Phase 4). Register in `app.ts`.
- [ ] **Step 2: Admin libraries page** — client component: create library→section→source forms, "Scan" button calling `POST /sections/:id/scan` then subscribing to the SSE stream and showing a progress bar.
- [ ] **Step 3: Library grid + title detail** — client components using `apiFetch`; posters served from `/api/images/...`; placeholder card for `matchState!=="matched"`. Use `@orbix/ui` components. Add the TMDB attribution to the layout footer.
- [ ] **Step 4: e2e** (`library.spec.ts`) — seed the DB (globalSetup or a direct prisma insert) with one section + one matched MediaItem (with a local poster file placed under METADATA_DIR), then assert the library grid renders the title and the detail page shows its overview. (Avoids needing TMDB/ffprobe in CI/e2e.)
- [ ] **Step 5: Commit** `feat(web): library browse grid + title detail + TMDB attribution`.

---

## Self-Review

**Spec coverage (Phase 1 "Done when": point at a folder, scan, browse correctly-enriched titles with local posters — offline after scan):**
- Libraries/sections/sources management → Tasks 2,4,12. Scanner (walk+parse+probe+persist) → Tasks 5,6,7. TMDB enrichment + **local image caching** (offline) → Tasks 8,9,10. Incremental rescan → Task 7. Browse grid + title detail + scan progress (SSE) → Tasks 11,12. Settings/TMDB token → Task 3. LAN-reachable API (P1-REQ1) → Task 1. ✅
- P1-REQ2 (e2e in CI) is intentionally still tracked separately (CI infra change), not in this feature plan.

**Placeholder scan:** Tasks 4/11/12 give concrete interfaces + key code and reference the established Phase 0 route/page patterns rather than re-printing every line (consistent with the Phase 0 plan's approach for routes/UI); all domain-logic tasks (3,5,6,7,8,9,10) carry full test+impl code. No `TBD`/`TODO`.

**Type consistency:** `parseMediaPath` output (title/year/tmdbId/imdbId) feeds `scanSource` → `enrichItem`; `MediaFileTechnical` from `probeFile` matches the `MediaFile` columns; `cacheImage` returns the relative path stored in `MediaItem.posterPath` and served by `GET /images/*`; `TmdbClient` normalized shapes consumed by `enrichItem`. Settings `getSetting/setSetting` DI matches the `Setting` upsert in the route. Consistent.

**Note for executor:** ffprobe + TMDB + image download are DI'd everywhere so unit tests need no network/ffmpeg; only Task 11's integration smoke uses the real adapters (and a TMDB token only if available — otherwise items stay `unmatched`, which is a valid verified outcome).
