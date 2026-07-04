# Orbix tvOS client

Native Apple TV (tvOS) app for Orbix, generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen). This is a scaffold: one `Orbix` app target with a placeholder screen, plus an `OrbixKit` framework target that will hold the API client, auth, and media helpers in later tasks.

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

## Project layout

```
clients/tvos/
  project.yml              # XcodeGen spec — source of truth for the Xcode project
  .gitignore                # excludes the generated .xcodeproj, build products
  Sources/Orbix/            # app target: entry point + views
  Sources/OrbixKit/         # framework target: API client / auth / media helpers (later tasks)
  Resources/Info.plist      # app target's Info.plist
```

Do not commit `Orbix.xcodeproj`, `.build/`, or `DerivedData/` — they're all generated/ephemeral and gitignored.

## Distribution (decision deferred to the M1 gate)

Two paths, not yet decided:

- **Free Apple ID sideload** — build and install directly to a personal Apple TV via Xcode with a free developer account. Zero cost, but the app's provisioning profile expires after **7 days**, after which it must be reinstalled from Xcode. Fine for local development and short-lived testing.
- **Apple Developer Program ($99/year) + TestFlight** — enables ad-hoc/TestFlight distribution without the 7-day reinstall cycle, and is required for eventual App Store distribution. Adds an annual cost and enrollment overhead.

No distribution decision is needed for this scaffold (simulator-only). Revisit when the app needs to run on physical hardware for longer than a week or be shared with testers.
