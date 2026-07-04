# Orbix TV: native tvOS app + client/server contract — design

**Date:** 2026-07-03
**Status:** Draft pending user review (assumptions flagged in §9 — adopted while the user was away; approval-by-exception)
**Sub-projects:** SP1 (server: device-client contract), SP2 (tvOS app). Each gets its own implementation plan; SP1 first.

## 1. Context and goal

Orbix is a self-hosted media server: Fastify API + React SPA served same-origin from one container on a NAS, HLS playback via hls.js, ffmpeg transcoding, cookie-session auth. Real usage happens on TVs; the goal is a fully working **native Apple TV app**.

Four research passes (API/auth audit, playback-pipeline audit, tvOS/AVPlayer platform research, Jellyfin/Plex prior art) established the central finding: **the tvOS app is the easy half.** Stock `AVPlayerViewController` + SwiftUI delivers the client, *provided* the server speaks Apple-spec HLS and offers a non-cookie auth path. Neither is true today. The real project is the server contract.

### Current-state facts the design rests on

- Auth is cookie-only (`orbix_session` + `orbix_profile`); no `Authorization` header path exists anywhere. AVPlayer does not send cookies on segment fetches without special wiring.
- The HLS pipeline already emits fMP4 segments (good — HEVC in HLS *requires* fMP4 on Apple devices) but:
  - the master playlist is a hardcoded 3-liner with no `CODECS`/`RESOLUTION`/`FRAME-RATE` (Apple authoring-spec MUSTs);
  - the media playlist declares fixed 6-second `EXTINF`s while ffmpeg is never told to force keyframes at that cadence — declared timing diverges from real segment content. hls.js tolerates this; AVPlayer fails hard (black screen / `.failed` status);
  - subtitles are an out-of-band sidecar `.vtt` consumed by a browser `<track>` element; there is no `EXT-X-MEDIA` anywhere, so AVPlayer cannot see subtitles at all;
  - HEVC/VP9/AV1 sources are always re-encoded to H.264 — wasteful for Apple TV, which hardware-decodes HEVC Main10;
  - AC-3/E-AC-3 are always downmixed to stereo AAC although AVPlayer plays them natively (5.1 is thrown away);
  - transcode sessions are keyed `fileId:"default"` — all devices watching the same file share one ffmpeg and one seek pointer.
- Apple TV (tvOS 17+, 4K models) direct-play matrix: video H.264 (≤High L5.2), HEVC Main10 (≤L5.1, fMP4 only); audio AAC (incl. multichannel), AC-3, E-AC-3 (+JOC/Atmos), FLAC-in-fMP4. Not playable: DTS, TrueHD, Opus, AV1 (no hw decode on shipping devices). Subtitles: in-manifest WebVTT renditions only; no first-class sidecar API.
- tvOS has **no local-network permission prompt** (TN3179) and plain-HTTP LAN streaming is allowed with ATS Info.plist keys — LAN playback is frictionless.
- Prior art (Jellyfin/Plex): explicit one-endpoint playback decisions; `playSessionId` as the spine; per-device bearer tokens with pairing codes + a devices registry; restart-at-offset seeking; keep server+web bundled (both do); clients consume a published contract, not server internals.

## 2. Goals / non-goals

**Goals**
1. A device-grade API contract on the existing server: pairing + per-device bearer tokens, capability-negotiated playback decisions, Apple-spec HLS, per-device playback sessions, OpenAPI as the published contract.
2. A native tvOS app (SwiftUI, AVPlayer) covering the lean living-room MVP: pairing, profile picker, home rails, browse/search, title/season/episode pages, playback with resume + subtitles + audio-track choice + next-episode, EN/RU UI localization.
3. Web client keeps working throughout (it migrates to the same playback contract).
4. Offline guarantee preserved: no new runtime internet dependencies.

**Non-goals (this cycle)**
- Mobile apps (the contract must serve them later; no mobile code now).
- Physical repo/service split, ABR bitrate ladders, DRM, TLS/remote access, PGS burn-in, in-manifest audio rendition groups, Bonjour discovery, trick-play I-frame playlists (listed as post-MVP options).
- Admin/library management on TV (stays web-only).

## 3. Architecture decision

**Approach A — contract split; monolith deployment stays.** One repo, one NAS deployable. `apps/api` remains the single server, serving web same-origin exactly as today. The "split into clients and server" is realized contractually: a versioned-by-compatibility API surface any client consumes. Rationale: Jellyfin/Plex/Emby all bundle web with the server; client independence comes from the API contract, not repo topology. A physical split (separate web hosting, separate repos) reintroduces CORS/proxy bug classes and triples maintenance for zero functional gain at single-household scale; service decomposition (separate transcoder service) is pure cost at ≤4 concurrent sessions on an N100.

The tvOS app lives in this repo at `clients/tvos/` — **outside** the pnpm workspace globs (`apps/*`, `packages/*`); pnpm/turbo ignore it, Xcode tooling doesn't compose with them anyway. One checkout gives agents atomic server+client iteration.

**Player engine: AVPlayer-only, deliberately.** Swiftfin and Plex ship VLCKit/MPV because they serve arbitrary servers they don't control. We control the transcoder, so the server compensates (remux to fMP4 HLS, audio transcode matrix, WebVTT renditions). Escape hatch if reality disagrees: VLCKit as a second engine behind the same PlaybackInfo contract (decision recorded here so it's a pivot, not a rewrite).

**API versioning stance:** no `/api/v1` path stamp. Single-household reality: server and clients are updated by the same person. Instead: `GET /api/server-info` returns `{serverName, version, apiVersion}`; the TV app refuses/warns on incompatible `apiVersion`; the OpenAPI document is the contract of record; breaking changes bump `apiVersion` and are called out in commit/PR descriptions. Revisit path versioning only if third-party clients appear.

## 4. SP1 — server: device-client contract

### 4.1 Device auth & pairing

New Prisma model `DeviceToken`:

```
id            String   @id @default(cuid())
tokenHash     String   @unique        // sha256 of the bearer token; token itself never stored
name          String                  // "Living Room Apple TV"
platform      String                  // "tvos" | future: "ios" | "android" | ...
activeProfileId String?               // device-scoped equivalent of the orbix_profile cookie
lastSeenAt    DateTime @updatedAt
createdAt     DateTime @default(now())
revokedAt     DateTime?
```

Pairing flow (Quick-Connect shape, minus multi-tenant extras):
1. `POST /api/pair/initiate` (public) → `{code, pollToken, expiresInSec}`. `code` = 6 chars, unambiguous alphabet (no 0/O/1/I), single-use, TTL 10 min; `pollToken` = high-entropy opaque secret. In-memory store (Redis not needed; pairing is ephemeral and single-node).
2. TV displays the code and polls `GET /api/pair/poll?token=<pollToken>` (public; returns `{status:"pending"}` → `{status:"approved", deviceToken, deviceId}`; single-use redemption).
3. Signed-in web user approves via `POST /api/pair/approve {code, name}` (session auth + `requireNonKids`) from a new **Settings → Devices** page.
4. Rate limiting: initiate and poll endpoints get a simple in-memory IP throttle (pairing is the only public brute-forceable surface; codes are 6 chars — throttle + TTL + single-use makes this a non-issue on LAN).

Token acceptance — one change in `apps/api/src/plugins/session.ts`: if `Authorization: Bearer <token>` is present, sha256-lookup in `DeviceToken` (reject if `revokedAt`), set `req.accountId` (the single admin account) + `req.deviceId`, touch `lastSeenAt` (throttled, e.g. ≥60s between writes). Cookie path unchanged. Query-param acceptance `?token=<deviceToken>` **only** on `/api/play/*` routes (AVPlayer cannot attach headers to segment fetches; the server embeds the query token in every URI line of generated playlists). Images stay public (already shipped behavior).

Profile selection for devices: `POST /api/profiles/:id/select` when Bearer-authed writes `device.activeProfileId` (PIN check unchanged) instead of setting a cookie. `activeProfile()` in `apps/api/src/lib/catalog-filter.ts` resolves: Bearer → `device.activeProfileId`; cookie → as today. All existing kids enforcement then applies to devices with zero further changes.

Devices registry: `GET /api/devices` (admin) `[{id, name, platform, lastSeenAt, activeProfile, createdAt}]`; `POST /api/devices/:id/revoke`; `PATCH /api/devices/:id {name}`. Web Settings gains a Devices tab (list, rename, revoke) and the pairing-approval affordance.

### 4.2 Playback decision (PlaybackInfo)

`POST /api/playback/info` (session or bearer):

```jsonc
// request
{
  "fileId": "…",
  "capabilities": {
    "protocol": "hls",                       // future: "dash"
    "containers": ["mp4"],                    // direct-play containers
    "videoCodecs": [ {"codec":"h264","maxLevel":52}, {"codec":"hevc","maxLevel":153,"profiles":["main","main10"]} ],
    "audioCodecs": ["aac","ac3","eac3","flac"],
    "maxAudioChannels": 6,
    "subtitleDelivery": "hlsVtt",             // web sends "sidecarVtt"
    "hlsMultichannelAacBroken": false          // web sends true (hls.js/MSE quirk)
  },
  "audioTrackIndex": 0                         // optional; default first
}
// response
{
  "playSessionId": "…",                        // server-generated
  "mode": "direct" | "remux" | "transcode",
  "streamUrl": "/api/play/<fileId>/master.m3u8?playSessionId=…&token=…",  // or /direct?token=…
  "container": "mp4", "videoCodec": "hevc", "audioCodec": "eac3",
  "audioTracks":    [ {"index":0,"codec":"ac3","language":"ru","channels":6,"selected":true}, … ],
  "subtitleTracks": [ {"index":2,"codec":"subrip","language":"en","forced":false,"available":true},
                      {"index":3,"codec":"hdmv_pgs_subtitle","language":"ru","available":false,"reason":"image_based"} ]
}
```

`packages/core/src/playback/strategy.ts` becomes `decideStrategy(source, capabilities)`:
- **direct** — container ∈ `capabilities.containers`, video codec+level within a declared ceiling, selected audio codec ∈ `audioCodecs`.
- **remux** — video codec acceptable but container isn't (e.g. HEVC/H.264 in MKV → fMP4 HLS, `-c:v copy`). Audio: copy if the *selected* track's codec ∈ `audioCodecs` (channels ≤ `maxAudioChannels`, honoring `hlsMultichannelAacBroken`), else transcode audio only.
- **transcode** — video codec unacceptable (or keyframe-index fallback, §4.4) → H.264 encode as today.

Audio transcode target: AAC at `min(sourceChannels, maxAudioChannels)` channels (192k stereo / 384k 5.1). The web profile keeps today's exact behavior (stereo AAC, no multichannel copy) — its capability object encodes the current hardcoded assumptions, so this is a pure refactor for web. Audio *track selection* maps to ffmpeg `-map 0:a:<n>` (the `audioTracks[]` probe data already sits unused in the DB); switching tracks = new PlaybackInfo call → new session (documented; in-manifest audio groups are post-MVP).

The legacy `GET /api/play/:fileId/decision` route is deleted in the same change that migrates the web player — we control both ends and deploy atomically.

### 4.3 Playback sessions

`SessionManager` keyed by `playSessionId` (not `fileId:default`): per-device/per-viewing isolation; two devices playing one file get two ffmpeg processes. LRU cap (`MAX_TRANSCODE_SESSIONS`) and idle reaping stay. New: `POST /api/playback/:playSessionId/stop` (eager teardown on player exit); `PUT /api/items/:id/progress` gains optional `playSessionId` and doubles as heartbeat (`lastAccess` touch). Sessions carry their decided plan (mode, audio track, token) so segment requests need no re-derivation.

### 4.4 Apple-grade HLS

**Multivariant playlist** (generated per session): `#EXT-X-VERSION:7`, `EXT-X-INDEPENDENT-SEGMENTS`, one `EXT-X-STREAM-INF` with `BANDWIDTH`/`AVERAGE-BANDWIDTH` (estimated from probe bitrate; peak≈avg for VOD remux), `CODECS` (video+audio, e.g. `hvc1.2.4.L123.B0,ec-3`), `RESOLUTION`, `FRAME-RATE`, `VIDEO-RANGE` when the source is HDR (PQ/HLG from probe color transfer), plus `EXT-X-MEDIA:TYPE=SUBTITLES` entries per available text track and `SUBTITLES="subs"` on the stream-inf. Probe (`packages/core/src/scanner/probe.ts` + schema) gains `videoProfile`, `videoLevel`, `colorTransfer` (+ frame rate if not already captured); scan backfills; codec strings computed with conservative fallbacks when fields are missing.

**Segment-timing correctness** (the deepest technical risk, resolved structurally):
- New `MediaFile.keyframes` data (JSON array of keyframe timestamps, or a side table): extracted by an ffprobe packet scan (`-select_streams v:0 -show_packets` reading `pts_time` + key flags). Full-file read ⇒ minutes per large file ⇒ run as a **BullMQ job**: enqueued per file at scan time, backfilled for the existing library, and opportunistically enqueued at first play of an unindexed file.
- **Remux with index present:** segment boundaries = actual keyframe timestamps nearest the 6s target; the media playlist lists *real* per-segment `EXTINF`s summing to the true duration; ffmpeg cuts with explicit `-f segment`-style times / `segment_times`; seek restarts use the exact keyframe timestamp for `-ss` and correct `-start_number`. Declared timing == real timing, by construction.
- **Remux wanted but index absent:** PlaybackInfo returns **transcode** instead (with `-force_key_frames expr:gte(t,n_forced*<segSec>)` making fixed `EXTINF`s exact by construction) and enqueues extraction — first play of a fresh file is a transcode; subsequent plays remux. Correctness never depends on luck.
- **Transcode path** always forces keyframes at the segment cadence (also fixes today's web-facing drift).
- Existing web playback keeps working at every intermediate step.

**Subtitle renditions:** for each non-image track, a subtitle media playlist (`/api/play/:fileId/subs/:index/index.m3u8?…`) declaring a single full-duration WebVTT segment (spec-legal; playlist spans the whole duration) with `X-TIMESTAMP-MAP` aligning cue time to the media timeline, reusing the existing ffmpeg→VTT extraction. Native tvOS subtitle picker then works with zero client code. Image-based tracks (PGS/VobSub) are reported `available:false, reason:"image_based"` — honest absence; burn-in is post-MVP. The web `<track>` sidecar path keeps working unchanged.

**Validation harness:** a repo script (`scripts/validate-hls.sh` or similar) runs Apple's `mediastreamvalidator`/`hlsreport` against a local server playing fixture files; it is the definition-of-done gate for every SP1 HLS task (macOS dev machine; CI macOS-runner integration best-effort).

### 4.5 Contract publication & hardening

- Zod/JSON-schema definitions on the viewer-surface routes (auth/pair, profiles, menu, catalog, series, discovery, playstate, playback, subtitles, server-info) → generated **OpenAPI document** checked into the repo (`docs/api/openapi.json` + generation script). Admin routes may follow later.
- `GET /api/server-info` (public): `{serverName, version, apiVersion, pairingEnabled}` — reachability probe + compatibility gate for clients.
- Global `setErrorHandler` normalizing uncaught errors to the `{error:"internal"}` envelope (today's two error shapes confuse typed clients).
- Freebie fixes from the audit: `requireAdmin` on `POST /api/embeddings/backfill`; auth the scan SSE stream (session cookie or bearer). (Kids-profile ability to manage profiles is a known gap — tracked separately, not blocking.)

## 5. SP2 — tvOS app

**Stack:** Swift 6.x, SwiftUI-first (UIKit reserve for focus/recycling edge cases), stock `AVPlayerViewController`. **Deployment target tvOS 17, build SDK 26** (covers every Apple TV 4K generation; nothing MVP-critical needs 26-only API). Project generated by **XcodeGen** (`project.yml` in git, `.xcodeproj` gitignored). Location `clients/tvos/`. ATS: `NSAllowsLocalNetworking` + `NSAllowsArbitraryLoads`; declare `NSLocalNetworkUsageDescription` for hygiene (no prompt on tvOS).

**Structure:** `OrbixKit` (framework/module): `actor OrbixClient` (async URLSession + Codable DTOs, generated from OpenAPI via swift-openapi-generator with a hand-written fallback if the generator fights), Keychain store (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), image loader (downsampling + disk cache — not bare `AsyncImage`). App layer: Onboarding (server URL entry → `server-info` probe → pairing screen → profile picker), Home (rails from `/home/rows`, `.focusSection()` per rail), Library/Search, Title page (+ seasons/episodes), Player wrapper (`AVPlayerViewController` + PlaybackInfo + progress loop + `externalMetadata` + custom audio-track menu via `transportBarCustomMenuItems`), Settings (device name, sign-out, server info).

**Milestones (each gated on the previous):**
- **M0 scaffold** — XcodeGen project builds and runs in the simulator; OrbixClient hits `server-info` against dev server.
- **M1 playback spike (go/no-go gate for everything)** — manual URL + pre-issued token (dev-only server flag or manually inserted DeviceToken row); flat item list; play via PlaybackInfo through `AVPlayerViewController`. Validated **on real hardware** against a fixture matrix: H.264-MP4 direct, H.264-MKV remux, HEVC-MKV remux, DTS→AAC transcode, subtitle picker shows VTT renditions, seek/scrub/resume behave. `mediastreamvalidator` clean on all fixtures.
- **M2 auth** — pairing UI (code screen + poll), Keychain persistence, profile picker (server-side `activeProfileId`), sign-out, device visible/revocable in web Settings.
- **M3 the app** — home rails, title/season/episode pages, search, continue-watching resume, progress reporting (10s cadence + pause/exit flush), next-episode autoplay, kids profiles verified end-to-end.
- **M4 polish** — Top Shelf extension (continue watching), info-panel metadata, empty/error states, EN/RU String Catalogs (server already localizes catalog metadata per profile), optional I-frame trick-play playlist server-side.

**Distribution:** develop with free Apple ID (wireless Xcode deploy; 7-day re-sign); recommend the $99 Developer Program + TestFlight internal testing once the app becomes the household daily driver. Documented in `clients/tvos/README.md`.

## 6. Data flow summaries

**Pairing:** TV `pair/initiate` → code on screen → user approves in web Settings → TV poll returns token → Keychain → `Authorization: Bearer` everywhere; stream/playlist URLs carry `?token=` embedded by the server in playlist URIs.

**Playback:** TV posts capabilities to `playback/info` → `{playSessionId, mode, streamUrl, tracks}` → AVPlayer loads multivariant playlist (CODECS/renditions) → segments generated per-session (remux-from-keyframes or forced-keyframe transcode) → progress PUTs every 10s (heartbeat) → `playback/stop` on exit; idle reaper as backstop. Seek: AVPlayer requests segment N → out-of-window ⇒ kill + respawn at exact keyframe offset with `-start_number N`.

**Profiles/kids:** device holds `activeProfileId` server-side; every catalog/rows/progress/stream route already enforces maturity caps server-side — unchanged and automatically effective for TV.

## 7. Error handling

- Uniform `{error: code}` envelope (global error handler added); clients map codes → localized messages.
- 401 on missing/revoked token → app drops to pairing screen (single retry after re-auth).
- PlaybackInfo failures are explicit codes (`not_probed`, `no_sources`, `blocked_by_rating` — 404-shaped for kids to avoid leaking existence, matching current convention).
- Segment 504 (encoder can't keep up): app surfaces a stall → error alert with retry; server kills the hung process (existing behavior retained).
- AVPlayer failures: log `AVPlayerItem.errorLog` to an in-app debug screen (dev builds) — the primary diagnostic for playlist non-compliance in the field.

## 8. Testing

- **Core (pure, no ffmpeg/network):** strategy-with-capabilities decision table (web profile parity + Apple profile matrix incl. DTS/TrueHD/Opus/FLAC/multichannel cases); playlist generation from keyframe fixtures (EXTINF sums, tag correctness); ffargs construction (map/force_key_frames/segment cutting); codec-string builder; VTT rendition playlist + `X-TIMESTAMP-MAP`.
- **API (integration, test DB):** pairing lifecycle (initiate/approve/poll, TTL, single-use, revoke), bearer + query-param auth paths, per-device profile selection, per-session isolation (two sessions on one file), kids-gates on every new endpoint, progress-as-heartbeat, stop teardown.
- **HLS conformance:** `mediastreamvalidator` script against fixture media through a live dev server — required local gate per HLS task; CI best-effort (macOS runner).
- **Web e2e:** existing Playwright suite stays green across the web-player migration to PlaybackInfo (throwaway-DB workflow per repo rules).
- **tvOS:** XCTest for OrbixClient/DTOs (recorded fixtures), pairing-flow unit tests with a stubbed server; manual smoke matrix on hardware per milestone (M1 matrix above); UI tests deferred.

## 9. Assumptions pending user confirmation

Adopted while the user was away (two unanswered question rounds); each is cheap to reverse at the noted point:
1. **Approach A** (contract split, monolith stays) — reversal point: before SP2 M2; SP1 work survives any answer.
2. **Lean living-room MVP scope** (admin stays web-only) — reversal: scope additions become M5+.
3. **Deployment target tvOS 17 / SDK 26** — hedges unknown hardware generation; reversal: raise/lower the target, trivial pre-M1.
4. **Free Apple ID initially**; $99 + TestFlight recommended when the app becomes the daily driver — affects distribution only.
5. **AVPlayer-only engine** with VLCKit as the recorded escape hatch — reversal point: after M1 spike evidence.

## 10. Risks

| Risk | Mitigation |
|---|---|
| AVPlayer rejects generated playlists in ways the validator misses | M1 spike on real hardware gates all UI work; errorLog diagnostics; VLCKit escape hatch |
| Keyframe packet-scan too slow on large SMB files | Background queue + transcode fallback means playback never blocks on it; measure on NAS during SP1 |
| swift-openapi-generator ergonomics | Hand-written DTO fallback is explicitly allowed (viewer surface is ~20 endpoints) |
| Dolby Vision behavior (spec docs contradict: P5 vs 8.1) | Out of MVP; verify empirically post-M1; HDR10 via `VIDEO-RANGE` only |
| N100 transcode headroom for 4K DTS sources | Audio-only transcode on remux path is cheap; video transcode capped by existing session limit; VAAPI already proven on the NAS |
| 7-day free-tier expiry annoyance | Documented; TestFlight upgrade path |
