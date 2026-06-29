# Orbix Phase 2 — Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play any movie in the browser — direct-play compatible files, remux/transcode the rest to HLS on the fly via ffmpeg — with a real player (Vidstack + hls.js), subtitles, and per-profile resume / Continue Watching.

**Architecture:** The hard decisions live as pure, unit-tested logic in `packages/core/src/playback` (strategy choice, VOD playlist generation, ffmpeg argument builder) so they're testable with zero ffmpeg. The api owns a transcode-session manager that runs ffmpeg as a child process producing fMP4 HLS segments to a per-session temp dir, serves the playlist + segments (JIT, kill-and-restart on a seek into an untranscoded region), and exposes a `/stream` decision endpoint. The web title page gains a Vidstack player. Per-profile `PlaybackState` drives resume + a Continue Watching home row.

**Tech Stack:** ffmpeg (already in the api Docker image) via `node:child_process`; HLS (fMP4) + hls.js via **Vidstack** (`@vidstack/react`); Prisma `PlaybackState`; Fastify range requests + SSE-free segment serving; Vitest (DI unit tests, no real ffmpeg); Playwright.

## Global Constraints

- **Language:** TypeScript, `"strict": true`. Decision/playlist/arg logic in `packages/core` (framework-agnostic, dependency-injected, unit-tested with NO real ffmpeg/fs). The api session manager is the only place a real ffmpeg process is spawned.
- **Offline:** playback never needs the internet (all from local media + locally-generated HLS). No CDN, no external player assets that require network at runtime (Vidstack/hls.js are bundled).
- **Ports/services unchanged** (web 1060, api 1061, postgres 1062, redis 1063). The api Docker image already has ffmpeg/ffprobe; HOST smoke tests that need ffmpeg should run against the Docker api OR be skipped with a truthful note if ffmpeg is absent on the host.
- **New env var:** `TRANSCODE_DIR` (temp dir for HLS sessions; dev default `./data/transcode`, gitignored; reaped on session end). Add to the `@orbix/config` schema (defaulted, non-breaking).
- **Browser compatibility targets:** direct-play only MP4 + H.264(8-bit) + AAC; everything else goes through HLS (remux when codecs are browser-OK, transcode when not). HLS segments are **fMP4** (`-hls_segment_type fmp4`), ~6 s.
- **Auth:** stream/segment routes require a session (`req.accountId`); use the shared auth preHandler introduced in Task 1. Playback-state routes are scoped to the active profile (`orbix_profile` cookie).
- **No real ffmpeg/network in unit tests.** The session manager's ffmpeg spawn is injected so it can be faked in any api test.
- **Commits:** conventional-commit; bodies end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. TDD: failing test first for all `packages/core` logic.

---

## File Structure

```
packages/db/prisma/schema.prisma     # + PlaybackState; + MediaFile.probedOk Boolean
packages/config/src/env.ts           # + TRANSCODE_DIR
apps/api/src/lib/auth.ts             # shared requireAuth preHandler (replaces 4 duplicated copies)
packages/core/src/playback/
  strategy.ts                        # decideStrategy(file) -> "direct" | "remux" | "transcode" (+ per-stream actions)
  playlist.ts                        # buildVodPlaylist(durationSec, segSec) -> m3u8 string
  ffargs.ts                          # buildHlsArgs({input, startSegment, strategy, audioAction, ...}) -> string[]
  resume.ts                          # nextContinueWatching(states) + isFinished(position,duration)
apps/api/src/playback/
  session.ts                         # TranscodeSession + SessionManager (spawn injected; JIT; seek-restart; reap)
apps/api/src/routes/
  stream.ts                          # GET /play/:fileId/decision ; GET /play/:fileId/direct ; HLS: /master.m3u8, /index.m3u8, /:seg
  playstate.ts                       # GET/PUT /items/:id/progress ; GET /continue-watching
  subtitles.ts                       # GET /play/:fileId/subs/:track.vtt (text->WebVTT)
apps/web/src/
  app/title/[id]/page.tsx            # replace disabled Play with a real player launch
  components/Player.tsx              # Vidstack player (HLS + direct), subtitle + resume wiring
  app/page.tsx (home)                # add a Continue Watching row
```

---

### Task 1: Foundations — shared auth preHandler + schema (`probedOk`, `PlaybackState`) + `TRANSCODE_DIR`

**Files:**
- Create: `apps/api/src/lib/auth.ts`
- Modify: `apps/api/src/routes/{catalog,libraries,scan,settings,profiles}.ts` (use the shared helper), `packages/db/prisma/schema.prisma`, `packages/config/src/env.ts`, `apps/api/src/plugins/queue.ts` (set `probedOk` on upsert)

**Interfaces:**
- Produces: `requireAuth(app)` preHandler (checks `req.accountId`, 401 otherwise) used everywhere admin routes are. `MediaFile.probedOk Boolean @default(true)` set `false` when the resilient probe caught an error. `PlaybackState` model. `env.TRANSCODE_DIR` (default `./data/transcode`).

- [ ] **Step 1: schema** — add to `schema.prisma`:
```prisma
model PlaybackState {
  id          String   @id @default(cuid())
  profileId   String
  mediaItemId String
  positionSec Int      @default(0)
  durationSec Int      @default(0)
  finished    Boolean  @default(false)
  updatedAt   DateTime @updatedAt
  @@unique([profileId, mediaItemId])
  @@index([profileId, updatedAt])
}
```
and add `probedOk Boolean @default(true)` to `MediaFile`. Migrate: `DATABASE_URL=postgresql://orbix:orbix@localhost:1062/orbix pnpm --filter @orbix/db exec prisma migrate dev --name playback`; `prisma generate`.

- [ ] **Step 2: env** — add `TRANSCODE_DIR: z.string().default("./data/transcode")` to the zod schema; `# TRANSCODE_DIR=./data/transcode` in `.env.example`.

- [ ] **Step 3: shared auth** — `apps/api/src/lib/auth.ts`:
```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
export function requireAuth(_app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
  };
}
```
Replace the four duplicated `requireAdmin` definitions (catalog, libraries, scan, settings) and the profiles one with imports of `requireAuth`. (Keep the route behavior identical.)

- [ ] **Step 4: probedOk** — in `queue.ts`, the resilient `probe` adapter: on success set a flag true, on caught error false; thread it into `upsertItemAndFile` so `MediaFile.probedOk` reflects it. (Minimal: have `probe` return `{ ...tech, probedOk }` or pass a parallel flag.)

- [ ] **Step 5: verify + commit** — `pnpm --filter @orbix/api typecheck` exit 0; migration applied (`\d "PlaybackState"`); existing api tests pass. Commit `feat(api): shared auth preHandler, PlaybackState + MediaFile.probedOk, TRANSCODE_DIR`.

---

### Task 2: Playback strategy decision (`packages/core/src/playback/strategy.ts`)

**Files:** Create `strategy.ts` + `strategy.test.ts`; export from `index.ts`.

**Interfaces:**
- Produces: `decideStrategy(input): PlaybackPlan` where
```ts
interface StrategyInput { container?: string; videoCodec?: string; audioCodecs: string[]; }
type PlaybackPlan =
  | { mode: "direct" }
  | { mode: "remux"; audioAction: "copy" | "aac" }
  | { mode: "transcode"; audioAction: "copy" | "aac" };
```
Rules: container in {mp4,mov,m4v} AND videoCodec h264 AND an aac audio present → `direct`. videoCodec h264 (8-bit) but container is mkv/avi/etc OR audio not aac → `remux` (audioAction `aac` if no aac track else `copy`). videoCodec hevc/h265/vp9/mpeg4/other → `transcode` (audioAction `aac` unless an aac track exists). Default unknowns → `transcode`.

- [ ] **Step 1: failing tests** — assert: `{container:"mp4",videoCodec:"h264",audioCodecs:["aac"]}` → `{mode:"direct"}`; `{container:"matroska,webm",videoCodec:"h264",audioCodecs:["ac3"]}` → `{mode:"remux",audioAction:"aac"}`; `{container:"matroska",videoCodec:"hevc",audioCodecs:["aac"]}` → `{mode:"transcode",audioAction:"copy"}`; `{videoCodec:"vp9",audioCodecs:[]}` → `{mode:"transcode",audioAction:"aac"}`.
- [ ] **Step 2: run → fail. Step 3: implement** the rule table. **Step 4: run → pass. Step 5: commit** `feat(core): playback strategy decision (direct/remux/transcode)`.

---

### Task 3: VOD HLS playlist generation (`packages/core/src/playback/playlist.ts`)

**Files:** Create `playlist.ts` + `playlist.test.ts`; export from `index.ts`.

**Interfaces:**
- Produces: `buildVodPlaylist(durationSec: number, segSec = 6): string` — a COMPLETE VOD `#EXTM3U` playlist with `#EXT-X-VERSION:7`, `#EXT-X-TARGETDURATION`, fMP4 `#EXT-X-MAP:URI="init.mp4"`, one `#EXTINF:<segSec>,` + `seg<N>.m4s` line per segment (last segment = remainder), and `#EXT-X-ENDLIST`. This is emitted IMMEDIATELY (before any segment exists) so the scrubber spans the whole movie.

- [ ] **Step 1: failing test** — `buildVodPlaylist(20, 6)` → 4 segments (6,6,6,2), contains `#EXT-X-ENDLIST`, `#EXT-X-MAP:URI="init.mp4"`, `#EXT-X-PLAYLIST-TYPE:VOD`, last `#EXTINF:2.000,`. `buildVodPlaylist(12,6)` → exactly 2 full segments.
- [ ] **Step 2: run → fail. Step 3: implement. Step 4: pass. Step 5: commit** `feat(core): VOD fMP4 HLS playlist generation`.

---

### Task 4: ffmpeg HLS argument builder (`packages/core/src/playback/ffargs.ts`)

**Files:** Create `ffargs.ts` + `ffargs.test.ts`; export from `index.ts`.

**Interfaces:**
- Produces: `buildHlsArgs(opts): string[]` (argv for ffmpeg, NO shell string) where
```ts
interface HlsArgsOpts {
  input: string; startSegment: number; segSec: number; outDir: string;
  mode: "remux" | "transcode"; audioAction: "copy" | "aac"; encoder?: "libx264";
}
```
Emits: `-ss <startSegment*segSec>` (input seek) when `startSegment>0`; `-i input`; `-map 0:v:0 -map 0:a:0`; video `-c:v copy` (remux) or `-c:v libx264 -preset veryfast -crf 21` (transcode); audio `-c:a copy` or `-c:a aac -b:a 192k`; HLS muxer flags `-f hls -hls_segment_type fmp4 -hls_time <segSec> -hls_playlist_type vod -hls_flags independent_segments -start_number <startSegment> -hls_segment_filename <outDir>/seg%d.m4s -hls_fmp4_init_filename init.mp4 <outDir>/index_live.m3u8`. (We serve OUR pre-built VOD playlist, not ffmpeg's; ffmpeg's output playlist is ignored.)

- [ ] **Step 1: failing tests** — assert argv contains `-c:v copy` for remux; `libx264` for transcode; `-c:a aac` when audioAction aac else `-c:a copy`; input-side `-ss 12` when startSegment=2,segSec=6; `-hls_segment_type fmp4`; no shell metacharacters (it's an array). **Step 2: fail. Step 3: implement. Step 4: pass. Step 5: commit** `feat(core): ffmpeg HLS argument builder`.

---

### Task 5: Resume / Continue-Watching domain (`packages/core/src/playback/resume.ts`)

**Files:** Create `resume.ts` + `resume.test.ts`; export from `index.ts`.

**Interfaces:**
- Produces: `isFinished(positionSec, durationSec): boolean` (finished when `position >= 0.9*duration` and duration>0); `continueWatching(states): {mediaItemId, positionSec, durationSec}[]` — filter to in-progress (`positionSec>0 && !finished`), sort by `updatedAt` desc.

- [ ] **Step 1: failing tests** — `isFinished(95,100)` true; `isFinished(50,100)` false; `continueWatching([...])` returns only unfinished in-progress, newest first. **Step 2: fail. Step 3: implement. Step 4: pass. Step 5: commit** `feat(core): resume + continue-watching domain`.

---

### Task 6: Direct-play + decision routes (`apps/api/src/routes/stream.ts`, part 1)

**Files:** Create `stream.ts` (decision + direct play); Modify `app.ts`.

**Interfaces:**
- Consumes: `decideStrategy`, the `MediaFile` row.
- Produces (auth-gated): `GET /play/:fileId/decision` → `{ mode, url }` where `url` is `/api/play/:fileId/direct` (direct) or `/api/play/:fileId/master.m3u8` (remux/transcode). `GET /play/:fileId/direct` → streams the file with HTTP Range support (`206 Partial Content`, `Accept-Ranges: bytes`, correct `Content-Range`/`Content-Length`, content-type by container). 404 if the file/row is missing.

- [ ] **Step 1** — implement the decision route (load MediaFile, `decideStrategy`, return mode + url). **Step 2** — implement direct streaming with a correct range parser (handle `bytes=start-`, `bytes=start-end`, no-range→200 full). **Step 3** — smoke (Docker api, a real small mp4): `curl -r 0-1023 .../direct` → 206 with 1024 bytes; full GET → 200. **Step 4** — commit `feat(api): /play decision + direct-play range streaming`.

---

### Task 7: Transcode session manager + HLS routes (`apps/api/src/playback/session.ts`, `stream.ts` part 2)

**Files:** Create `session.ts`; extend `stream.ts`; Modify `app.ts` (TRANSCODE_DIR, reap on close).

**Interfaces:**
- Consumes: `buildVodPlaylist`, `buildHlsArgs`, `decideStrategy`, an injected `spawn` (defaults to `node:child_process.spawn`).
- Produces: a `SessionManager` keyed by `(fileId, profileId)` that: on first segment request, spawns ffmpeg (`buildHlsArgs`) into `TRANSCODE_DIR/<session>/`; serves `GET /play/:fileId/master.m3u8` (a tiny master pointing at `index.m3u8`), `GET /play/:fileId/index.m3u8` (our `buildVodPlaylist` from ffprobe duration — served instantly), and `GET /play/:fileId/seg:n.m4s` / `init.mp4` (waits briefly for ffmpeg to produce the requested segment; on a request for a segment far ahead of what ffmpeg is producing → **kill ffmpeg, restart with `-ss`/`-start_number` at that segment**). Idle sessions reaped (ffmpeg killed, dir removed) after a timeout and on app close.

- [ ] **Step 1** — `SessionManager` with injected `spawn`; an api-level unit test with a FAKE spawn (no real ffmpeg) asserting: requesting `index.m3u8` returns the VOD playlist immediately; requesting a segment starts the (fake) ffmpeg; a seek-ahead request triggers a kill+restart with the right start segment. **Step 2** — wire the HLS routes. **Step 3** — Docker-api smoke with a real HEVC or MKV sample: load `master.m3u8`, fetch a few segments, seek to the middle and confirm new segments arrive (truthfully report if no sample/ffmpeg available). **Step 4** — commit `feat(api): JIT fMP4 HLS transcode session manager + seek-restart`.

---

### Task 8: Subtitles (`apps/api/src/routes/subtitles.ts`)

**Files:** Create `subtitles.ts`; Modify `app.ts`; (core helper `packages/core/src/playback/subs.ts` for SRT→WebVTT if pure).

**Interfaces:**
- Produces: `GET /play/:fileId/subs` → list of text subtitle tracks (from `MediaFile.subtitleTracks`); `GET /play/:fileId/subs/:index.vtt` → the track converted to WebVTT (extract via ffmpeg `-map 0:s:<i> -f webvtt` OR convert an external `.srt`). Image subs (PGS/VobSub) are listed but flagged `burnIn:true` (not served as VTT this phase). The SRT→WebVTT timestamp conversion (`,`→`.`, add `WEBVTT` header) is a pure function unit-tested in core.

- [ ] **Step 1: failing test** — `srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nHi\n")` → starts with `WEBVTT`, contains `00:00:01.000 --> 00:00:02.000`. **Step 2: fail → 3: implement core helper → 4: pass.** **Step 5** — the route (ffmpeg extract for embedded, helper for external). **Step 6** — commit `feat(api): subtitle tracks as WebVTT (text) + image-sub flagging`.

---

### Task 9: Playback-state routes + resume (`apps/api/src/routes/playstate.ts`)

**Files:** Create `playstate.ts`; Modify `app.ts`.

**Interfaces:**
- Consumes: `isFinished`, `continueWatching`, the active-profile cookie (`orbix_profile`).
- Produces (require a selected profile): `PUT /items/:id/progress` `{positionSec,durationSec}` → upsert `PlaybackState` (set `finished` via `isFinished`); `GET /items/:id/progress` → `{positionSec,durationSec,finished}` (or zeros); `GET /continue-watching` → enriched list (item id/title/posterPath + positionSec/durationSec) for the active profile, newest first, finished excluded.

- [ ] **Step 1** — implement the three routes (read profileId from `orbix_profile`; 400 if no profile selected). **Step 2** — smoke: select a profile, PUT progress, GET progress returns it, GET continue-watching lists it; after PUT a near-end position, it's marked finished and drops off continue-watching. **Step 3** — commit `feat(api): per-profile playback progress + continue-watching`.

---

### Task 10: Player UI + Continue Watching row + e2e

**Files:** Create `apps/web/src/components/Player.tsx`; Modify `apps/web/src/app/title/[id]/page.tsx`, `apps/web/src/app/page.tsx` (home Continue Watching), `apps/web/package.json` (`@vidstack/react`); Test `apps/web/e2e/playback.spec.ts`.

**Interfaces:**
- Produces: a `Player` component that calls `/api/play/:fileId/decision`, then plays either the direct URL or the HLS `master.m3u8` via Vidstack (hls.js engine), wires WebVTT subtitle tracks, seeks to the saved resume position on load, and PUTs progress every ~10 s and on pause/unload. The title page's "Play" launches it (the file = the item's primary `MediaFile`). The home page shows a Continue Watching row from `/api/continue-watching`.

- [ ] **Step 1** — add `@vidstack/react`; build `Player.tsx` (decision → source; resume seek; progress PUT throttle; subtitle `<Track>`s). **Step 2** — wire the title page Play button + the home Continue Watching row. **Step 3** — typecheck + build. **Step 4** — e2e (`playback.spec.ts`): seed a MediaItem with a small **direct-play MP4** placed under the media root (commit a tiny test mp4 fixture, or generate one), onboard+select profile, open the title, press Play, assert the `<video>`/Vidstack element is present and `currentTime` advances or a progress PUT fires; reload and assert resume. (Transcoding paths are smoke-tested in Tasks 7/8 against Docker, not in the headless e2e.) **Step 5** — commit `feat(web): Vidstack player, resume, and Continue Watching row`.

---

## Self-Review

**Spec coverage (Phase 2 "Done when": an MKV/HEVC file plays + seeks in-browser, subtitles toggle, resume works across sessions/profiles):**
- Strategy (direct/remux/transcode) → Tasks 2,6,7. JIT fMP4 HLS + seek-restart → Tasks 3,4,7. Player + seek → Tasks 7,10. Subtitles → Task 8,10. Per-profile resume + Continue Watching → Tasks 1,5,9,10. probedOk + shared auth prereqs → Task 1. ✅
- HEVC-plays + seek is verified by the Docker-api smoke in Task 7 (headless e2e uses a direct-play MP4 to stay deterministic) — flagged truthfully.

**Placeholder scan:** Tasks 6/7/8/9/10 give interfaces + key code and the integration smokes; the testable core (strategy/playlist/ffargs/resume/srtToVtt) has full TDD code. No `TBD`.

**Type consistency:** `decideStrategy` `PlaybackPlan.mode`/`audioAction` feed `buildHlsArgs`; `buildVodPlaylist` segment naming (`seg<N>.m4s`, `init.mp4`) matches the HLS routes + `buildHlsArgs` `-hls_segment_filename`/`-hls_fmp4_init_filename`; `PlaybackState` fields match the playstate routes + `isFinished`/`continueWatching`; the Player's decision `{mode,url}` matches the `/play/:fileId/decision` response. Consistent.

**Note for executor:** real ffmpeg only runs in the api (Docker has it); ALL `packages/core` tests and the SessionManager api test use injected fakes — never spawn real ffmpeg in a unit test. Smokes that need ffmpeg run against the Docker api or are reported as skipped-with-reason, never faked.
