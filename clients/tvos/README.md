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

## Localization (EN/RU)

The app ships **English + Russian** (the household library is heavily Russian). User-facing strings across `RootView`, `Onboarding/*`, `Home/*`, `Title/*`, `Search/*`, and `Player/*` are localized:

- **Where the strings live.** App UI strings are in a String Catalog at `Resources/Localizable.xcstrings`. Most SwiftUI `Text("…")`/`Button("…")`/`Label` call sites are string literals, so they localize automatically via `LocalizedStringKey` against `Bundle.main` — the catalog just supplies the Russian value keyed by the English string, no call-site change. The few *computed* strings that render verbatim (`Season %lld`, `Episode %lld`, the `%lldh %lldm` runtime, the season chip's `%lld episodes` count) were switched to `String(localized:)` / a pluralized catalog entry so they localize too — including the Russian one/few/many plural forms that a hand-rolled `"s"` can't express.
- **Registration.** `Resources/Info.plist` sets `CFBundleDevelopmentRegion = en` and `CFBundleLocalizations = [en, ru]`, so tvOS runs the app in Russian when the device language is Russian and lists it under Settings → language.
- **What stays English.** Home-row titles ("Continue Watching", "Hidden gems", …) come from the **server** (`/api/home/rows`) and are sent in English regardless of profile language — that's a server-side concern, unchanged here. Item titles/genres/ratings are catalog data. The raw `\(error)` tails on diagnostic error messages are also left as-is (the human-readable label above each one *is* localized).
- **Shared strings.** OrbixKit carries its **own** catalog (`Sources/OrbixKit/Localizable.xcstrings`) for the handful of strings its Top Shelf extension needs ("Continue Watching", "Recommended") — the extension is a separate process that can't reach the app bundle, so it resolves them from the framework bundle via `OrbixLocalized(_:)` / `Bundle.orbixKit`. This is the catalog the unit tests assert against (`LocalizationTests`), since the test bundle can reach the framework but not the app.

## Top Shelf extension

`OrbixTopShelf` is a tvOS **Top Shelf content extension** (`Sources/OrbixTopShelf/`, target `type: app-extension`, embedded in the app's PlugIns). It renders the profile's **Continue Watching** and **Recommended** rows above the app icon on the Apple TV home screen, as `TVTopShelfSectionedContent` (poster-shaped items with resume-progress bars). Selecting an item deep-links into the app via `orbix://item/<id>` (registered in the app's `CFBundleURLTypes`, handled in `RootView`'s `.onOpenURL` → the Home tab pushes that title page).

- **Content logic is pure + tested.** The extension itself is a thin TVServices bridge; the `/api/home/rows` → sections mapping is `buildTopShelfContent(from:baseURL:)` in OrbixKit (`Sources/OrbixKit/TopShelf.swift`), unit-tested in `TopShelfContentTests` with no extension process involved. "Continue Watching" is server row key `continue`; "Recommended" is `tonight` (falling back to `hiddenGems`).
- **Cross-process sharing (App Group + shared Keychain).** The extension runs in its own process, so it reads the two things it needs from shared storage the app writes (`Sources/OrbixKit/SharedStore.swift`):
  - the server **`baseURL`** via the App Group `group.dev.orbix.tvos` (`UserDefaults`), written in `AppModel.configure`;
  - the **device token** via a shared Keychain access group (`$(AppIdentifierPrefix)dev.orbix.tvos.shared`) — `TokenStore` now takes an `accessGroup:`, and both the app and the extension construct it with `OrbixSharedStore.keychainAccessGroup`.
  Both require matching entitlements (`Resources/Orbix.entitlements`, `Sources/OrbixTopShelf/OrbixTopShelf.entitlements`: `com.apple.security.application-groups` + `keychain-access-groups`).
- **Simulator caveat / remaining device wiring.** Neither the App Group container nor the shared Keychain is enforceable on the tvOS **Simulator** (no entitlement sandbox — the same limitation that already stops device tokens persisting in the Simulator). So the extension builds and its logic is fully exercised by unit tests, but the *live* cross-process read (the app's paired token reaching the extension) only actually happens on **real hardware**, where the entitlement's `$(AppIdentifierPrefix)` resolves the team-prefixed Keychain group. That's the one piece to verify during on-device bring-up; the plumbing itself is complete. Every failure mode (not paired, not onboarded, offline, Simulator) returns `nil`, so tvOS falls back to the static Top Shelf image rather than erroring.

## Trick-play (scrubbing thumbnails) — deferred (needs server work)

`AVPlayerViewController` shows scrubbing thumbnails when the HLS **multivariant** playlist advertises an I-frame-only trick-play variant (`#EXT-X-I-FRAME-STREAM-INF` → an I-frame media playlist). Orbix's VOD playlist builder (`packages/core/src/playback/apple-playlist.ts` `buildMultivariantPlaylist`) currently emits a single `#EXT-X-STREAM-INF` variant + WebVTT subtitle renditions and **no** I-frame variant, so the player only offers the default single-frame scrubber. (The `#EXT-X-I-FRAME-STREAM-INF` handling that does exist is in the live-TV proxy, `packages/core/src/tv/proxy.ts`, not the VOD path.)

Adding it is a **server milestone**, not a client change — once the server advertises the I-frame variant, `AVPlayerViewController` picks it up automatically. What it requires:

1. **An I-frame index per file.** The existing keyframes job (`MediaFile.keyframes`) stores keyframe *timestamps* for keyframe-accurate `EXTINF`s — trick-play additionally needs each I-frame's **byte offset + length** within the fMP4 segments (e.g. `ffprobe -select_streams v -show_packets` filtered to `flags=K`, or letting ffmpeg emit an I-frame playlist directly). New extraction + a place to persist it (extend the keyframes job + `MediaFile`).
2. **Serving the I-frame playlist.** Add an `#EXT-X-I-FRAME-STREAM-INF` line to `buildMultivariantPlaylist` (gated on the index existing) and an API route serving the I-frame media playlist with `#EXT-X-BYTERANGE` entries; the segment routes must honor byte-range requests.
3. **Transcode path.** For non-direct playback the segments are ephemeral per session, so trick-play assets would need to be **pre-generated at scan time** (storage + ffmpeg cost, but offline-guarantee-friendly) rather than derived live.

Per the M4 brief ("if it needs significant server work, do not half-build it"), this is left as a documented follow-up spanning `packages/core/src/playback`, the keyframes queue job, the `MediaFile` schema, and `apps/api` stream routes.

## App Icon

`Resources/Assets.xcassets/App Icon & Top Shelf Image.brandassets` is a tvOS "Brand Assets" catalog: a small (400×240) and large/App Store (1280×768) App Icon, each a layered `.imagestack` with Front/Middle/Back `.imagestacklayer`s (1x/2x PNGs apiece), plus a Top Shelf Image (1920×720) and Top Shelf Image Wide (2320×720). `project.yml` sets `ASSETCATALOG_COMPILER_APPICON_NAME: "App Icon & Top Shelf Image"` on the `Orbix` target.

Status: **done** — placeholder art only (a dark backdrop, an accent ring, and the "Orbix" wordmark; generated with a small script + ImageMagick), but the catalog structure is real and verified: `actool` compiles it with zero warnings, and the icon renders correctly in the tvOS Simulator Home Screen (the small `App Icon.imagestack`) next to Settings. Swap the PNGs under each `.imagestacklayer/Content.imageset/` and the two `Top Shelf Image*.imageset/`s for real brand art whenever that's ready — the catalog structure itself shouldn't need to change.

## Project layout

```
clients/tvos/
  project.yml                # XcodeGen spec — source of truth for the Xcode project
  .gitignore                  # excludes the generated .xcodeproj, build products
  Resources/
    Info.plist                 # app target's Info.plist (EN/RU + orbix:// URL scheme)
    Orbix.entitlements          # App Group + shared Keychain group (Top Shelf sharing)
    Assets.xcassets/            # tvOS Brand Assets App Icon & Top Shelf Image (see above)
    Localizable.xcstrings       # app UI String Catalog (en + ru)
  Sources/
    Orbix/                     # app target
      OrbixApp.swift            # @main entry point
      RootView.swift             # routes on AppModel.OnboardingPhase; onOpenURL deep-link handling
      AppModel.swift             # session state: base URL, client, active profile, deep-link intake
      Onboarding/                 # server-reachability, pairing, profile-picker screens
      Home/                       # HomeView + PosterCard (rails)
      Title/                      # TitlePage + SeasonEpisodeView
      Player/                     # PlaybackController + PlayerViewController (AVKit)
      Search/                     # SearchView
    OrbixKit/                  # framework target: DTOs, OrbixClient, Keychain/TokenStore, ImageLoader
      Localization.swift          # Bundle.orbixKit + OrbixLocalized(_:) (shared-string resolver)
      Localizable.xcstrings       # OrbixKit String Catalog (Top Shelf shared strings, en + ru)
      SharedStore.swift           # App Group baseURL + shared Keychain group constants
      TopShelf.swift              # pure HomeRows → Top Shelf mapping + orbix:// deep links
    OrbixTopShelf/             # Top Shelf content extension (app-extension target)
      TopShelfContentProvider.swift  # TVTopShelfContentProvider → TVTopShelfSectionedContent
      Info.plist                  # NSExtension (com.apple.tv-top-shelf) + principal class
      OrbixTopShelf.entitlements  # App Group + shared Keychain group
  Tests/OrbixKitTests/        # OrbixKit unit tests (DTO decode, image cache, playback progress +
                              # readiness gate, token store, localization RU lookups, Top Shelf mapping)
```

Do not commit `Orbix.xcodeproj`, `.build/`, or `DerivedData/` — they're all generated/ephemeral and gitignored.

## Distribution

Two paths, not yet decided:

- **Free Apple ID sideload** — build and install directly to a personal Apple TV via Xcode with a free developer account. Zero cost, but the app's provisioning profile expires after **7 days**, after which it must be reinstalled from Xcode. Fine for local development and short-lived testing.
- **Apple Developer Program ($99/year) + TestFlight** — enables ad-hoc/TestFlight distribution without the 7-day reinstall cycle, and is required for eventual App Store distribution. Adds an annual cost and enrollment overhead.

The app icon (see **App Icon** above) — previously the one hard blocker for an on-device/TestFlight install — is now in place. No distribution decision is needed for simulator-only development; revisit once the app needs to run on physical hardware for longer than a week or be shared with testers. Hardware signoff (HEVC/HDR hardware decode on a real Apple TV 4K) is still outstanding — see `.superpowers/sdd/progress.md`.
