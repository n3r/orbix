# M1 Playback Spike — Go/No-Go Gate Result

**Date:** 2026-07-04
**Verdict:** ✅ **GO — AVPlayer-only is viable.** AVFoundation accepts the SP1 Apple-grade HLS across direct, H.264-remux, and HEVC-remux modes.

## What was tested

Two independent proofs against a live throwaway Orbix server (`NODE_ENV=test`, real ffmpeg, keyframe-seeded fixtures) with a device bearer token minted through the real pairing API:

### 1. `AVPlayerItem` readiness gate (`PlaybackReadinessTests`)

For each fixture: negotiate `POST /api/playback/info` with the tvOS capability profile, resolve the returned `streamUrl` (token embedded by the server), load it into an `AVURLAsset` + `AVPlayerItem` driven by an `AVPlayer`, and assert the item reaches `AVPlayerItem.Status.readyToPlay`. This proves Apple's own HLS stack parses and accepts our playlists — the exact thing the spike ultimately reduces to.

| Fixture | Source | Negotiated mode | Stream | AVPlayerItem status (tvOS 26.5 simulator) |
|---|---|---|---|---|
| `f_direct` | H.264 + AAC, MP4 | `direct` | `/api/play/.../direct` (progressive MP4) | ✅ `.readyToPlay` |
| `f_remux` | H.264 + AAC + SRT, MKV | `remux` | multivariant HLS, fMP4 segments, WebVTT rendition | ✅ `.readyToPlay` |
| `f_hevc` | HEVC + AAC, MKV | `remux` | multivariant HLS, fMP4 HEVC passthrough | ✅ `.readyToPlay` |

All three reached `.readyToPlay` in **~1.3s total** (`** TEST SUCCEEDED **`).

### 2. Full app UI smoke

Built the `Orbix` app, installed it on the "Apple TV 4K (3rd generation)" simulator, and launched with `-orbixBaseURL http://127.0.0.1:2062 -orbixToken <device token>`. The app authenticated with the token, loaded `GET /api/home/rows`, and rendered the titles ("Direct Movie", "HEVC Movie", "Remux Movie") in focusable tvOS rows ("Hidden gems", "Pick something for tonight") with the focus engine working (screenshot captured). Confirms the end-to-end path: bearer auth → home rows → SwiftUI focusable list.

## Caveats / what the simulator does NOT prove

- **HEVC *decode* on real hardware.** The tvOS simulator uses software decode; `.readyToPlay` proves the manifest + tracks are accepted and initialized, but real Apple TV hardware HEVC (Main10 / HDR / Dolby Vision) decode must be confirmed on a physical device before M1 is declared fully passed for HEVC.
- **Actual pixel playback / seek / audio-subtitle picker interaction** were not driven (the readiness gate stops at `.readyToPlay`; the UI smoke stops at the list). Those are exercised in M3 with the real player screen.

## Harness gotchas found (for future live runs)

1. **IPv4 vs IPv6:** the simulator resolves `localhost` to `::1` (IPv6); the Orbix server binds `0.0.0.0` (IPv4 only) → "connection refused". Use an explicit `http://127.0.0.1:<port>` (or the host LAN IP for a real device).
2. **`AVPlayerItem.status` needs a driving `AVPlayer`.** A bare `AVPlayerItem(asset:)` never leaves `.unknown`; it must be attached to an `AVPlayer` for the asset load to start. (Fixed in the gate test.)
3. **`xcodebuild test` does not forward shell env vars** into the sim test process — pass them as trailing build-setting overrides (`... test ORBIX_TEST_BASE_URL=... ORBIX_TEST_TOKEN=... ORBIX_TEST_FILE_IDS=...`); the scheme wires them via `$(VAR)` macros.

## Recommendation

Proceed with **AVPlayer-only** (no VLCKit) as the spec's primary path. The manifest-acceptance risk that motivated the spike is retired for direct/remux/HEVC on the simulator. Keep the spec's recorded VLCKit escape hatch available but do not build it. Re-run this exact gate on real Apple TV hardware (buy/borrow a 4K unit) as the final M1 sign-off before shipping M3.
