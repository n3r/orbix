# Orbix tvOS client

Native Apple TV (tvOS) app for Orbix, generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen): one `Orbix` app target (SwiftUI, `NavigationStack` + the tvOS focus engine) plus an `OrbixKit` framework target holding the API client, DTOs, auth/token storage, and image loading — all exercised by `OrbixKitTests`.

Pair a TV with an Orbix server, pick a profile, and get a genuinely usable living-room app: Netflix-style home rails, a title/detail page (or a series' season/episode list), a production AVKit player with resume/progress/native track selection/next-episode, and search — all driven by the existing Orbix server contract (no server changes). See **Features** below for the full M3 feature set.

This client lives outside the pnpm workspace — it's a separate Swift/Xcode toolchain, not part of the `apps/*` / `packages/*` TypeScript monorepo.

## Prerequisites

- Xcode 26 (tvOS 26 SDK, Swift 6 toolchain)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`
- A tvOS Simulator runtime installed (Xcode → Settings → Platforms), e.g. tvOS 26.x

## Generate the Xcode project

The `.xcodeproj` is **generated, not committed** (see `.gitignore`: `*.xcodeproj/`). Regenerate it any time `project.yml` or the `Sources`/`Resources` layout changes:

```bash
cd clients/tvos
xcodegen generate
open Orbix.xcodeproj
```

## Build

From the command line, against the tvOS Simulator:

```bash
cd clients/tvos
xcodebuild -project Orbix.xcodeproj -scheme Orbix \
  -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' \
  build CODE_SIGNING_ALLOWED=NO
```

If that simulator name isn't available on your machine, list what is and substitute an available 4K one:

```bash
xcrun simctl list devices available | grep "Apple TV"
```

Or just build/run from Xcode: open `Orbix.xcodeproj`, pick an "Apple TV" simulator destination, and hit Run.

## Deployment target

tvOS **17.0**. Swift 6 language mode (`SWIFT_VERSION: "6.0"` in `project.yml`).

## App Transport Security (LAN access)

Orbix is a self-hosted, offline-capable media server that clients reach over the local network — often at a bare LAN IP with no TLS certificate. `Resources/Info.plist` sets:

- `NSAllowsArbitraryLoads = true` — permits plain-HTTP connections to the NAS.
- `NSAllowsLocalNetworking = true` — permits connections to local-network hosts even under ATS.
- `NSLocalNetworkUsageDescription` — required by tvOS/iOS to prompt the user for local-network access permission.

This mirrors the "offline guarantee" / LAN-first architecture of the rest of Orbix (see the root `CLAUDE.md`): the app talks to a server on the same network, not the public internet, so ATS is relaxed rather than requiring per-host exceptions.

## Onboarding flow

On first launch (and on any launch without a usable device token), the app walks through a short setup flow before it reaches the home screen:

1. **Server URL** — enter (or confirm) the Orbix server's address, e.g. `http://192.168.1.10:1061`; the app checks `GET /health` and won't proceed until it gets a response.
2. **Pairing code** — once the server is reachable, the TV requests a pairing code and displays it full-screen: a 6-character code.
3. **Approve from another device** — on a phone, tablet, or computer already signed in to the same Orbix server, open **Orbix → Account → Devices**, enter the code, and approve it. The TV is polling in the background and picks up the approval automatically.
4. **Pick a profile** — once paired, the TV shows the household's profiles; select one to make it this device's active profile.
5. **Home** — the app opens to the home list for the selected profile.

The device token issued by pairing is persisted to the Keychain, so subsequent launches skip straight past steps 1–4 (reachability permitting) — the app calls `GET /api/me/profile` to confirm the token is still valid and a profile is already selected, and falls back to the pairing screen if not (e.g. the device was revoked from **Account → Devices**).

**Dev shortcut:** the `-orbixBaseURL <url>` and `-orbixToken <token>` launch arguments (Xcode scheme "Arguments Passed On Launch", or the `ORBIX_BASE_URL`/`ORBIX_TOKEN` environment variables) bypass steps 1–3 for local development — the app uses the given URL/token directly instead of showing the reachability or pairing screens. Never commit real values for these; they're only ever read at runtime.

**Simulator Keychain caveat:** the tvOS Simulator has no Keychain access-group entitlement (`errSecMissingEntitlement`), so a token saved during pairing (or via `-orbixToken`) does **not** persist across relaunches in the simulator — the pairing screen reappears every launch there. On a real Apple TV, the token persists normally across relaunches.

## Features

Everything below is driven entirely by the existing Orbix server contract (`apps/api`) — SP2 M3 shipped zero server changes.

- **Home** (`Sources/Orbix/Home/HomeView.swift`) — Netflix-style rails loaded from `GET /api/home/rows` (Continue Watching, recently added, genre/mood rows, …), each its own focus-sectioned horizontal rail of `PosterCard`s. A poster shows a thin resume-progress bar when the profile has an in-progress position for that title. A bounded `ImageLoader` (memory `NSCache` + capped disk cache + in-flight request coalescing, so concurrent misses for the same URL share one fetch) backs every remote image in the app.
- **Title / detail page** (`Sources/Orbix/Title/TitlePage.swift`) — full-bleed backdrop, logo (or title text if there's no logo art), a year · rating · runtime · genres metadata row, overview, a resume-aware **Play**/**Resume** button for a movie, and a "More Like This" rail (`GET /api/items/:id/similar`, best-effort). A series shows a season strip instead of a Play button.
- **Season / episode navigation** (`Sources/Orbix/Title/SeasonEpisodeView.swift`) — a season's episode list (still art, overview, runtime, per-episode resume bar); a playable row opens the production player with `episodeId`-scoped progress. Reaching the end of an episode auto-advances into the next one in the season (a fresh play session each time), same teardown path as any other exit.
- **Production player** (`Sources/Orbix/Player/`) — `AVPlayerViewController` wrapped by a `PlaybackController` that negotiates `POST /api/playback/info` with the tvOS device capability profile (`Capabilities.appleTV`: fMP4/HLS, H.264/HEVC, up to 5.1 AAC/AC-3/E-AC-3/FLAC, subtitles delivered as in-manifest HLS renditions rather than app-drawn sidecars), seeks to any saved resume position once the item is ready to play, reports progress roughly every 10 seconds plus on pause/teardown (`PUT /api/items/:id/progress`), and calls `POST /api/playback/:id/stop` on exit. Native tvOS audio/subtitle track pickers come for free from the HLS manifest's renditions — no app-drawn track-selection UI. The Menu button (`.onExitCommand`) reliably tears the player down (time observer removed in `dismantleUIViewController`) rather than leaving a stuck player or a leaked observer.
- **Search** (`Sources/Orbix/Search/SearchView.swift`) — the tvOS-idiomatic `.searchable` affordance, debounced (~350ms) against `GET /api/search`, results in the same poster-card grid as Home.
- **Kids profiles** — enforced entirely server-side (home rows, item detail, seasons/episodes, search, and playback all filter or 404 for a maturity-capped profile); the app never applies its own filtering. A kids-blocked (or otherwise unreachable) title's detail/season page degrades to a graceful "Not available" state rather than crashing.
- **Empty / loading / error states** — every list-shaped screen (Home, Search, Title, Season/Episode) models loading/empty/error(/not-found) as a single `loadState` enum rendered via `ContentUnavailableView`, so those states can't drift out of sync with each other; Search additionally has a "type to search" prompt state before any query is entered, and a title with no overview/backdrop/logo/metadata just omits those pieces rather than rendering a broken-looking gap.

## App Icon

`Resources/Assets.xcassets/App Icon & Top Shelf Image.brandassets` is a tvOS "Brand Assets" catalog: a small (400×240) and large/App Store (1280×768) App Icon, each a layered `.imagestack` with Front/Middle/Back `.imagestacklayer`s (1x/2x PNGs apiece), plus a Top Shelf Image (1920×720) and Top Shelf Image Wide (2320×720). `project.yml` sets `ASSETCATALOG_COMPILER_APPICON_NAME: "App Icon & Top Shelf Image"` on the `Orbix` target.

Status: **done** — placeholder art only (a dark backdrop, an accent ring, and the "Orbix" wordmark; generated with a small script + ImageMagick), but the catalog structure is real and verified: `actool` compiles it with zero warnings, and the icon renders correctly in the tvOS Simulator Home Screen (the small `App Icon.imagestack`) next to Settings. Swap the PNGs under each `.imagestacklayer/Content.imageset/` and the two `Top Shelf Image*.imageset/`s for real brand art whenever that's ready — the catalog structure itself shouldn't need to change.

## Project layout

```
clients/tvos/
  project.yml                # XcodeGen spec — source of truth for the Xcode project
  .gitignore                  # excludes the generated .xcodeproj, build products
  Resources/
    Info.plist                 # app target's Info.plist
    Assets.xcassets/            # tvOS Brand Assets App Icon & Top Shelf Image (see above)
  Sources/
    Orbix/                     # app target
      OrbixApp.swift            # @main entry point
      RootView.swift             # routes on AppModel.OnboardingPhase (reachability/pairing/profile/ready)
      AppModel.swift             # session state: base URL, client, active profile
      Onboarding/                 # server-reachability, pairing, profile-picker screens
      Home/                       # HomeView + PosterCard (rails)
      Title/                      # TitlePage + SeasonEpisodeView
      Player/                     # PlaybackController + PlayerViewController (AVKit)
      Search/                     # SearchView
    OrbixKit/                  # framework target: DTOs, OrbixClient, Keychain/TokenStore, ImageLoader
  Tests/OrbixKitTests/        # OrbixKit unit tests (DTO decode, image cache, playback progress + readiness gate, token store)
```

Do not commit `Orbix.xcodeproj`, `.build/`, or `DerivedData/` — they're all generated/ephemeral and gitignored.

## Distribution

Two paths, not yet decided:

- **Free Apple ID sideload** — build and install directly to a personal Apple TV via Xcode with a free developer account. Zero cost, but the app's provisioning profile expires after **7 days**, after which it must be reinstalled from Xcode. Fine for local development and short-lived testing.
- **Apple Developer Program ($99/year) + TestFlight** — enables ad-hoc/TestFlight distribution without the 7-day reinstall cycle, and is required for eventual App Store distribution. Adds an annual cost and enrollment overhead.

The app icon (see **App Icon** above) — previously the one hard blocker for an on-device/TestFlight install — is now in place. No distribution decision is needed for simulator-only development; revisit once the app needs to run on physical hardware for longer than a week or be shared with testers. Hardware signoff (HEVC/HDR hardware decode on a real Apple TV 4K) is still outstanding — see `.superpowers/sdd/progress.md`.
