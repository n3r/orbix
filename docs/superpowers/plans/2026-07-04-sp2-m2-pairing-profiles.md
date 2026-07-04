# SP2 M2: Pairing UI + Profile Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace M1's launch-arg token stand-in with a real onboarding flow: the TV shows a pairing code, the user approves it from the web (Settings → Devices), the token persists to the Keychain, and a profile picker selects the active viewing profile — after which the app opens to the (spike) home list.

**Architecture:** A small state machine in `AppModel` drives onboarding: `serverURL → pairing → profileSelect → ready`. Pairing uses the existing `OrbixClient.pairInitiate`/`pairPoll` with a poll loop; the token is saved via `TokenStore` and read back at launch (`TokenStore.load()`, previously unwired). Profile selection uses `OrbixClient.profiles()` + a new `selectProfile(id:)` (server persists `activeProfileId` on the device row for bearer clients). All new screens are SwiftUI with the tvOS focus engine; no server changes (the pairing + device-profile-select endpoints shipped in SP1a/SP1b).

**Tech Stack:** Swift 6, SwiftUI, OrbixKit (existing). Verified via `xcodebuild build` + a live pairing smoke against a throwaway server (screenshots of the code screen + profile picker).

**Spec:** `docs/superpowers/specs/2026-07-03-tv-app-and-client-server-contract-design.md` §5 (M2). Consumes SP1a pairing (`/api/pair/*`) + SP1b device-scoped profiles (`/api/profiles/:id/select` persists `DeviceToken.activeProfileId` for bearer).

## Global Constraints

- tvOS code under `clients/tvos/` only; no `apps/`/`packages/`/`pnpm-workspace.yaml` changes; `.xcodeproj` stays gitignored (regenerate with `xcodegen generate`).
- Deployment target tvOS 17; Swift 6 complete concurrency (actors for mutable state, `@MainActor` for view models).
- No hardcoded server address/token/code in committed code.
- Build gate: `xcodebuild -project Orbix.xcodeproj -scheme Orbix -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' build CODE_SIGNING_ALLOWED=NO` → `** BUILD SUCCEEDED **`; `-scheme OrbixKit ... test` stays green.
- SourceKit single-file diagnostics are false positives — the build is authoritative.
- Address the READY-review M2 follow-ups where they land here: wire `TokenStore.load()` into launch token resolution (this plan); leave ImageLoader/PlayerViewController/app-icon for M3.
- Commit after every task.

---

### Task 1: OrbixClient.selectProfile + pairing/profile view models

**Files:**
- Modify: `clients/tvos/Sources/OrbixKit/OrbixClient.swift` (confirm/add `selectProfile(id:)`)
- Create: `clients/tvos/Sources/Orbix/Onboarding/PairingModel.swift`
- Create: `clients/tvos/Sources/Orbix/Onboarding/ProfilePickerModel.swift`
- Modify: `clients/tvos/Tests/OrbixKitTests/DTOTests.swift` (add selectProfile request/҂response decode if it returns a body)

**Interfaces:**
- `OrbixClient.selectProfile(id: String) async throws` — POST `/api/profiles/:id/select` with the bearer token and empty JSON body `{}` (server persists `activeProfileId` on the device; returns `{profileId}`). Decode-tolerant.
- `@MainActor @Observable final class PairingModel`: states `.idle`, `.waiting(code: String)`, `.approved(token: String)`, `.error(String)`. `start(client:name:)` calls `pairInitiate`, moves to `.waiting(code)`, then polls `pairPoll(pollToken:)` every 2s (respecting `expiresInSec`) until `.approved` (captures `deviceToken`) or timeout → `.error`. Cancellable (`stop()`).
- `@MainActor @Observable final class ProfilePickerModel`: `load(client:)` → `profiles: [Profile]`; `select(_:client:)` calls `selectProfile(id:)` then reports success.

- [ ] **Step 1:** Confirm `selectProfile` exists on OrbixClient (from Task 2 interfaces it was specced); if missing, add it. Add a DTO test if it returns a decodable body.
- [ ] **Step 2:** Implement `PairingModel` with the poll loop (use `Task.sleep`; stop on cancel; honor expiry). Implement `ProfilePickerModel`.
- [ ] **Step 3:** `xcodebuild ... -scheme OrbixKit test` (DTO test green, gate still skips) + `-scheme Orbix build` → BUILD SUCCEEDED.
- [ ] **Step 4:** Commit: `feat(tvos): OrbixClient.selectProfile + pairing/profile view models`.

---

### Task 2: Pairing + profile-picker views + onboarding routing

**Files:**
- Create: `clients/tvos/Sources/Orbix/Onboarding/PairingView.swift`
- Create: `clients/tvos/Sources/Orbix/Onboarding/ProfilePickerView.swift`
- Modify: `clients/tvos/Sources/Orbix/AppModel.swift` (onboarding state machine + Keychain token load/persist + selected-profile tracking)
- Modify: `clients/tvos/Sources/Orbix/RootView.swift` (route by onboarding phase)

**Interfaces:**
- `AppModel` gains an onboarding phase: `.needsServer` → `.needsPairing` → `.needsProfile` → `.ready`. Resolution at launch: load persisted token via `TokenStore.load()` (falls back to launch-arg/env for dev); if a token exists, `GET /api/me/profile` decides `.needsProfile` vs `.ready`; else `.needsPairing`. On pairing approval, `TokenStore.save(token:)` + advance. On profile select, advance to `.ready` (routes to the M1 `SpikeListView`, which M3 replaces).
- `PairingView`: large centered 6-char code + "Open Settings → Devices on another device and enter this code", a spinner while polling, error/retry. Auto-starts pairing on appear.
- `ProfilePickerView`: focusable row of profiles (name + avatar via ImageLoader; kids badge when `kind=="kids"`), select → advance.

- [ ] **Step 1:** Implement the views + AppModel state machine + RootView routing. Keep the dev launch-arg token path working (so the M1 gate/harness still functions).
- [ ] **Step 2:** `xcodebuild ... build` → BUILD SUCCEEDED; OrbixKit tests still green.
- [ ] **Step 3 — live pairing smoke (controller or subagent):** throwaway server (SP1c/M1 harness pattern); launch the app with only `-orbixBaseURL` (no token); screenshot the pairing code; approve it via `POST /api/pair/approve` (using the setup cookie) with the displayed code; confirm the app advances to the profile picker (screenshot); select a profile; confirm it reaches the home list. Teardown thoroughly.
- [ ] **Step 4:** Commit: `feat(tvos): pairing + profile-picker onboarding flow`.

---

### Task 3: Gates + M2 doc

- [ ] **Step 1:** `xcodebuild build` + `xcodebuild test` (OrbixKit) both green; confirm no `.xcodeproj`/DerivedData staged; no hardcoded secrets (grep).
- [ ] **Step 2:** Update `clients/tvos/README.md` with the onboarding flow (server URL → pair code → approve in web → profile → app) and that the launch-arg token remains a dev shortcut.
- [ ] **Step 3:** Commit: `docs(tvos): M2 onboarding flow in README`.

---

## Beyond M2 (planned after M2)

- **M3 the app:** home rails (`.focusSection()` per row), title/season/episode pages, search, continue-watching resume, progress reporting (10s + pause/exit, with `playSessionId` heartbeat + `/stop` on exit), next-episode autoplay, kids profiles verified end-to-end. Absorbs the READY-review follow-ups: ImageLoader NSCache/coalescing; PlayerViewController observer teardown (`dismantleUIViewController`); empty-state screens; app icon (`Assets.xcassets`) before device/TestFlight.
- **M4 polish:** Top Shelf (continue watching), info-panel `externalMetadata`, EN/RU String Catalogs, optional I-frame trick-play; re-run the M1 gate on real Apple TV hardware for HEVC decode signoff.

## Self-review notes

- Spec §5 (M2) coverage: pairing UI ✓ (T1/T2), Keychain persistence ✓ (T2 — closes the READY-review `TokenStore.load()` gap), profile picker ✓ (T1/T2), device visible/revocable in web ✓ (already server-side, no client work). 
- No server changes — all endpoints shipped in SP1a/SP1b and are smoke-proven.
- Dev launch-arg token path preserved so the M1 readiness gate + harness keep working.
