# tvOS Parity Rebuild — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock native live-TV playback on the server (Phase 0) and build the web-parity design system, custom top-bar shell, and restyled onboarding for the tvOS app (Phase 1).

**Architecture:** Spec: `docs/superpowers/specs/2026-07-05-tvos-parity-rebuild-design.md`. Phase 0 wires the existing `queryTokenAuth`/`tokenSuffix` helpers (apps/api/src/lib/device-auth.ts) into the three `/api/tv/proxy/*` routes and mints tokened `src` URLs in `/api/tv/channels/:id/play`. Phase 1 adds `Sources/Orbix/Design/` (tokens + components ported from `packages/ui/src/tokens.css` and web components), a custom top-bar shell (`Sources/Orbix/Shell/`) replacing the stock `TabView` in `RootView`, and restyles onboarding/profile screens. Pure logic that needs unit tests goes in **OrbixKit** (the only tested target).

**Tech Stack:** Fastify + vitest (Phase 0); SwiftUI, tvOS 17, Swift 6, XcodeGen (Phase 1).

## Global Constraints

- Repo gates before declaring any server task done: `pnpm typecheck && pnpm lint && pnpm test` (lint separately per CLAUDE.md — Turbo cache can hide lint-only errors).
- tvOS work: regenerate project after file adds (`cd clients/tvos && xcodegen generate`), then `xcodebuild -project Orbix.xcodeproj -scheme Orbix -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' build CODE_SIGNING_ALLOWED=NO` and the same with `test -scheme OrbixKitTests` for kit changes. If that simulator name is unavailable, pick one from `xcrun simctl list devices available | grep "Apple TV"`.
- Swift 6 language mode: new types crossing actor boundaries must be `Sendable`; UI models are `@MainActor @Observable`.
- Design token values are copied EXACTLY from `packages/ui/src/tokens.css` — do not invent colors.
- No hardcoded server origins or tokens in committed code (existing launch-arg/env mechanism stays).
- Commit after every task (small commits on branch `tv-ui`).

---

### Task 1 (Phase 0): Query-token auth for the live-TV proxy

**Files:**
- Modify: `apps/api/src/routes/tv-play.ts`
- Test: `apps/api/src/routes/tv-play.test.ts` (extend; reuse its origin-fixture harness)

**Interfaces:**
- Consumes: `queryTokenAuth(app)`, `tokenSuffix(req)` from `apps/api/src/lib/device-auth.ts` (already exist; read them first). Token-minting pattern from `apps/api/src/routes/playback.ts:231-241`.
- Produces: `/api/tv/proxy/:streamId/{index.m3u8,p,s}` accept `?token=<deviceToken>`; rewritten playlist child URIs carry `&token=`; `/api/tv/channels/:id/play` returns `sources[].src` with `?token=` appended for bearer- or query-token-authenticated requests. Cookie behavior unchanged.

- [ ] **Step 1: Read the existing harness** — `apps/api/src/routes/tv-play.test.ts` (origin fixture, `buildTvApp`, CRLF playlists) and `apps/api/src/routes/stream.token.test.ts` (`stubAuth` device-token stubbing). You will combine both patterns.

- [ ] **Step 2: Write failing tests** — append a new describe block to `tv-play.test.ts`. Adapt `stubAuth` from `stream.token.test.ts`, but give the device an active *standard* profile (tv access requires a non-kids profile):

```ts
import { hashDeviceToken } from "@orbix/core"; // add to existing imports

const RAW = "orb_tv-proxy-token";
const HASH = hashDeviceToken(RAW);

function stubDeviceAuth(app: unknown, opts: { kids?: boolean } = {}) {
  const device = {
    id: "dev1", tokenHash: HASH, name: "TV", platform: "tvos",
    activeProfileId: opts.kids ? "p_kid" : "p_std",
    lastSeenAt: new Date(), createdAt: new Date(), revokedAt: null,
  };
  (app as any).prisma.deviceToken = {
    findUnique: async ({ where }: any) =>
      where.tokenHash === HASH || where.id === "dev1" ? device : null,
    update: async () => device,
  };
  (app as any).prisma.account = { findFirst: async () => ({ id: "a1" }), findUnique: async () => ({ isAdmin: true }) };
  (app as any).prisma.profile = {
    findUnique: async ({ where }: any) =>
      where.id === "p_kid" ? kidsProfile : where.id === "p_std" ? standardProfile : null,
  };
}

describe("query-token auth on /tv/proxy/*", () => {
  it("serves the entry playlist with ?token= and no cookies, and propagates the token into child URIs", async () => {
    const app = await buildTvApp();           // fixture upstream
    stubDeviceAuth(app);
    (app as any).prisma.tvStream = { findUnique: async () => streamRow(), update: async () => ({}) };
    const res = await app.inject({ method: "GET", url: `/api/tv/proxy/st1/index.m3u8?token=${RAW}` });
    expect(res.statusCode).toBe(200);
    // every rewritten child URI must keep u=, sig= AND carry token=
    const lines = res.body.split(/\r?\n/).filter((l: string) => l.includes("/api/tv/proxy/st1/"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain(`token=${encodeURIComponent(RAW)}`);
    await app.close();
  });

  it("401s the entry playlist without credentials and with an unknown token", async () => {
    const app = await buildTvApp();
    stubDeviceAuth(app);
    (app as any).prisma.tvStream = { findUnique: async () => streamRow(), update: async () => ({}) };
    expect((await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8?token=orb_wrong" })).statusCode).toBe(401);
    await app.close();
  });

  it("403s a kids-profile device token (requireTvAccess still enforced)", async () => {
    const app = await buildTvApp(kidsProfile);
    stubDeviceAuth(app, { kids: true });
    (app as any).prisma.tvStream = { findUnique: async () => streamRow(), update: async () => ({}) };
    const res = await app.inject({ method: "GET", url: `/api/tv/proxy/st1/index.m3u8?token=${RAW}` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("follows the tokened chain: nested playlist (p) and segment bytes (s) authenticate via ?token=", async () => {
    const app = await buildTvApp();
    stubDeviceAuth(app);
    (app as any).prisma.tvStream = { findUnique: async () => streamRow(), update: async () => ({}) };
    const entry = await app.inject({ method: "GET", url: `/api/tv/proxy/st1/index.m3u8?token=${RAW}` });
    // pull a rewritten child URI straight from the playlist and fetch it
    const child = entry.body.split(/\r?\n/).find((l: string) => l.startsWith("/api/tv/proxy/st1/p?"));
    expect(child).toBeTruthy();
    const nested = await app.inject({ method: "GET", url: child! });
    expect(nested.statusCode).toBe(200);
    const seg = nested.body.split(/\r?\n/).find((l: string) => l.startsWith("/api/tv/proxy/st1/s?"));
    expect(seg).toBeTruthy();
    const bytes = await app.inject({ method: "GET", url: seg! });
    expect(bytes.statusCode).toBe(200);
    await app.close();
  });

  it("appends ?token= to /tv/channels/:id/play sources for device-token requests, not for cookie requests", async () => {
    const app = await buildTvApp();
    stubDeviceAuth(app);
    (app as any).prisma.tvChannel = {
      findUnique: async () => ({
        id: "ch1", number: 5, name: "One", logoPath: null, country: "RU", quality: "1080p", hidden: false,
        streams: [{ id: "st1", quality: null, label: null, priority: 0, protocol: "hls", status: "ok" }],
      }),
    };
    (app as any).prisma.tvProgramme = { findMany: async () => [] };
    const viaToken = await app.inject({
      method: "GET", url: "/api/tv/channels/ch1/play",
      headers: { authorization: `Bearer ${RAW}` },
    });
    expect(viaToken.statusCode).toBe(200);
    expect(viaToken.json().sources[0].src).toBe(`/api/tv/proxy/st1/index.m3u8?token=${encodeURIComponent(RAW)}`);
    const viaCookie = await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies });
    expect(viaCookie.json().sources[0].src).toBe("/api/tv/proxy/st1/index.m3u8");
    await app.close();
  });
});
```

Adapt stub shapes to whatever the existing harness in this file already provides (e.g. `loadNowNext` may need `tvProgramme` stubs — copy from the file's existing `/play` tests). Do not weaken the assertions.

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @orbix/api exec vitest run src/routes/tv-play.test.ts`. Expected: new tests FAIL with 401s where 200 was expected / missing `token=` in URIs.

- [ ] **Step 4: Implement** in `apps/api/src/routes/tv-play.ts`:

```ts
import { queryTokenAuth, tokenSuffix } from "../lib/device-auth"; // add import

// inside the plugin, next to `guards`:
const playerGuards = { preHandler: [queryTokenAuth(app), requireAuth(app), requireTvAccess(app)] };

// toProxy gains the token suffix of the *incoming* request:
const toProxy = (streamId: string, tokenQuery: string) => (absUrl: string, kind: "playlist" | "bytes") =>
  `/api/tv/proxy/${streamId}/${kind === "playlist" ? "p" : "s"}` +
  `?u=${encodeUpstream(absUrl)}&sig=${signProxyPayload(env.SESSION_SECRET, streamId, absUrl)}` +
  tokenQuery;
```

- Switch the three proxy routes (`/tv/proxy/:streamId/index.m3u8`, `/p`, `/s`) from `guards` to `playerGuards`, add `token?: string` to their Querystring generics, and pass `tokenSuffix(req)` at both `rewritePlaylist(..., toProxy(stream.id, tokenSuffix(req)))` call sites.
- In `/tv/channels/:id/play` (keeps `guards`), mint tokened src — same pattern as `playback.ts:237-239`:

```ts
const auth = req.headers.authorization;
const raw = auth?.startsWith("Bearer ") ? auth.slice(7) : (req.query as { token?: string } | undefined)?.token;
const srcSuffix = req.deviceId && raw ? `?token=${encodeURIComponent(raw)}` : "";
// ...
sources: ordered.slice(0, MAX_SOURCES).map((s) => ({
  streamId: s.id,
  src: `/api/tv/proxy/${s.id}/index.m3u8${srcSuffix}`,
  quality: s.quality,
  label: s.label,
})),
```

(add `Querystring: { token?: string }` to that route's generics too, and `queryTokenAuth` to its preHandler so `?token=` also works there — harmless for cookies since the hook no-ops when already authenticated).

- [ ] **Step 5: Run tests** — `pnpm --filter @orbix/api exec vitest run src/routes/tv-play.test.ts`. Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 6: Repo gates** — `pnpm typecheck && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api test`. Expected: green.

- [ ] **Step 7: Commit** — `git add apps/api/src/routes/tv-play.ts apps/api/src/routes/tv-play.test.ts && git commit -m "feat(api): query-token auth for live-TV proxy (native clients)"`

---

### Task 2 (Phase 1): Design tokens

**Files:**
- Create: `clients/tvos/Sources/Orbix/Design/Tokens.swift`

**Interfaces:**
- Produces (used by every later view task):
  - `extension Color { init(hex: UInt32) }`
  - `enum OrbixColor` with static `Color` constants: `bg, surface, surface2, surface3, text, textMuted, textDim, accent, accent2, accentStrong, danger, dangerStrong, live, success, warning` and `scrim` (black 0.62 opacity).
  - `enum OrbixRadius { static let sm: CGFloat = 12; static let md: CGFloat = 18; static let lg: CGFloat = 24 }` (web 8/12/16 × 1.5).
  - `enum OrbixSpacing { static let cardGap: CGFloat = 12; static let railGap: CGFloat = 40; static let pageMargin: CGFloat = 80 }`
  - `enum OrbixType { static func wordmark(size: CGFloat) -> Font; static let heroTitle: Font; static let rowHeading: Font }`

- [ ] **Step 1: Read the source of truth** — `packages/ui/src/tokens.css`. Copy hex values exactly.

- [ ] **Step 2: Write the file** (complete content):

```swift
import SwiftUI

extension Color {
    /// 0xRRGGBB → opaque sRGB color (design-token values from packages/ui/src/tokens.css).
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// 1:1 port of packages/ui/src/tokens.css. Values must stay in sync by hand.
enum OrbixColor {
    static let bg = Color(hex: 0x0B0D12)
    static let surface = Color(hex: 0x14171F)
    static let surface2 = Color(hex: 0x1C212B)
    static let surface3 = Color(hex: 0x232936)
    static let text = Color(hex: 0xE8EAF0)
    static let textMuted = Color(hex: 0xC2C8D4)
    static let textDim = Color(hex: 0x9AA3B2)
    static let accent = Color(hex: 0x6D7BFF)
    static let accent2 = Color(hex: 0xA06DFF)
    static let accentStrong = Color(hex: 0x4B57D6)
    static let danger = Color(hex: 0xEF4444)
    static let dangerStrong = Color(hex: 0xDC2626)
    static let live = Color(hex: 0xEF4444)
    static let success = Color(hex: 0x34D399)
    static let warning = Color(hex: 0xFBBF24)
    static let scrim = Color.black.opacity(0.62)
}

/// Web radii ×1.5 for 10-ft viewing (8/12/16px → 12/18/24pt).
enum OrbixRadius {
    static let sm: CGFloat = 12
    static let md: CGFloat = 18
    static let lg: CGFloat = 24
}

enum OrbixSpacing {
    static let cardGap: CGFloat = 12
    static let railGap: CGFloat = 40
    static let pageMargin: CGFloat = 80
}

enum OrbixType {
    /// Tracked-uppercase wordmark (web: font-extrabold uppercase tracking-[0.25em]).
    static func wordmark(size: CGFloat) -> Font { .system(size: size, weight: .heavy) }
    static let heroTitle: Font = .system(size: 76, weight: .heavy)
    static let rowHeading: Font = .system(size: 31, weight: .bold)
}
```

- [ ] **Step 3: Build gate** — `cd clients/tvos && xcodegen generate && xcodebuild -project Orbix.xcodeproj -scheme Orbix -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' build CODE_SIGNING_ALLOWED=NO`. Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit** — `git add clients/tvos/Sources/Orbix/Design/Tokens.swift && git commit -m "feat(tvos): design tokens ported from @orbix/ui"`

---

### Task 3 (Phase 1): Core components — buttons, focus-promote, scrims, skeleton

**Files:**
- Create: `clients/tvos/Sources/Orbix/Design/OrbixButton.swift`
- Create: `clients/tvos/Sources/Orbix/Design/FocusPromote.swift`
- Create: `clients/tvos/Sources/Orbix/Design/ScrimView.swift`
- Create: `clients/tvos/Sources/Orbix/Design/SkeletonView.swift`

**Interfaces:**
- Produces:
  - `struct OrbixButtonStyle: ButtonStyle` with `enum Variant { case primary, ghost, danger }` — init `OrbixButtonStyle(_ variant: Variant)`. Primary: white bg, black label (web Play). Ghost: white 0.2 opacity bg, `OrbixColor.text` label (web "More info"). Danger: `OrbixColor.danger` bg, white label. All: `OrbixRadius.sm` rounded, focused state brightens bg and scales 1.05.
  - `extension View { func focusPromote(_ isFocused: Bool) -> some View }` — scale 1.04 + shadow when focused, `.animation(.easeOut(duration: 0.2))` (web hover-promote: `hover:scale-[1.04] duration-200`).
  - `struct BottomScrim: View`, `struct LeftVignette: View`, `struct TopBarScrim: View` — the web billboard's three legibility gradients (bottom dissolve to `OrbixColor.bg`, left radial-ish vignette black 0.55→clear, top black 0.5→clear).
  - `struct SkeletonView: View` — `init(cornerRadius: CGFloat = OrbixRadius.sm)`; surface2-colored rounded rect pulsing opacity 0.55⇄1.0, 1s ease-in-out repeat, `.accessibilityHidden(true)`.

- [ ] **Step 1: Read the web sources** for exact visual intent: `packages/ui/src/components/Button.tsx` (or equivalent export in `packages/ui/src/index.ts`), `packages/ui/src/components/Skeleton.tsx`, and the scrim layers in `apps/web/src/components/billboard/HomeBillboard.tsx`.

- [ ] **Step 2: Implement the four files.** Complete code for the two nontrivial ones; the scrims/skeleton follow the interface block above (linear gradients + opacity pulse — keep each file <60 lines):

`OrbixButton.swift`:
```swift
import SwiftUI

struct OrbixButtonStyle: ButtonStyle {
    enum Variant { case primary, ghost, danger }
    let variant: Variant
    @Environment(\.isFocused) private var isFocused

    init(_ variant: Variant) { self.variant = variant }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 29, weight: .semibold))
            .padding(.horizontal, 36)
            .padding(.vertical, 14)
            .background(background)
            .foregroundStyle(foreground)
            .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
            .scaleEffect(isFocused ? 1.05 : 1.0)
            .animation(.easeOut(duration: 0.2), value: isFocused)
    }

    private var background: Color {
        switch variant {
        case .primary: return isFocused ? .white : .white.opacity(0.9)
        case .ghost: return .white.opacity(isFocused ? 0.3 : 0.2)
        case .danger: return isFocused ? OrbixColor.dangerStrong : OrbixColor.danger
        }
    }

    private var foreground: Color {
        switch variant {
        case .primary: return .black
        case .ghost, .danger: return OrbixColor.text
        }
    }
}
```

`FocusPromote.swift`:
```swift
import SwiftUI

/// Web hover-promote (`hover:scale-[1.04] duration-200`) translated to the
/// tvOS focus engine. Apply to card-like content; pair with `.focusable()`
/// or a Button wrapper that reports focus via `@Environment(\.isFocused)`.
struct FocusPromote: ViewModifier {
    let isFocused: Bool
    func body(content: Content) -> some View {
        content
            .scaleEffect(isFocused ? 1.04 : 1.0)
            .shadow(color: .black.opacity(isFocused ? 0.5 : 0), radius: 18, y: 10)
            .animation(.easeOut(duration: 0.2), value: isFocused)
    }
}

extension View {
    func focusPromote(_ isFocused: Bool) -> some View { modifier(FocusPromote(isFocused: isFocused)) }
}
```

- [ ] **Step 3: Build gate** (same xcodebuild command as Task 2). Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit** — `git add clients/tvos/Sources/Orbix/Design && git commit -m "feat(tvos): core design components (buttons, focus-promote, scrims, skeleton)"`

---

### Task 4 (Phase 1): Components — badges, progress bars, avatar (with tested hue hash)

**Files:**
- Create: `clients/tvos/Sources/OrbixKit/AvatarHue.swift` (pure logic — lives in the tested target)
- Create: `clients/tvos/Sources/Orbix/Design/Badges.swift`
- Create: `clients/tvos/Sources/Orbix/Design/ProgressBars.swift`
- Create: `clients/tvos/Sources/Orbix/Design/AvatarView.swift`
- Test: `clients/tvos/Tests/OrbixKitTests/AvatarHueTests.swift`

**Interfaces:**
- Consumes: `OrbixColor`, `OrbixRadius` (Task 2).
- Produces:
  - `public func avatarHue(_ name: String) -> Double` and `public func avatarInitials(_ name: String) -> String` in OrbixKit — port of the web's hue-hash + initials (see `apps/web/src/lib/tv.ts` `channelHue`/`channelInitials` and `packages/ui` `Avatar`): FNV-1a-style accumulating hash of the name → hue 0..<360 (as Double /360 for SwiftUI `Color(hue:)`), initials = first characters of the first two words, uppercased.
  - `struct NewBadge: View` — "NEW" caps chip, `OrbixColor.accentStrong` bg, white text (web `spotlight.ts` visual).
  - `struct QualityChip: View { let label: String }` — small translucent chip.
  - `struct ProgressBarView: View { let fraction: Double }` — 4pt accent bar on white-0.25 track (web h-[3px] accent).
  - `struct NowProgressBar: View { let fraction: Double }` — same geometry, `OrbixColor.live` fill.
  - `struct AvatarView: View { let name: String; let imageURL: URL?; let size: CGFloat }` — image if set, else initials on `Color(hue: avatarHue(name)/360, saturation: 0.45, brightness: 0.55)` circle.

- [ ] **Step 1: Read the web hue/initials logic** — `apps/web/src/lib/tv.ts` (`channelHue`, `channelInitials`) and the shared `Avatar` in `packages/ui/src`. Port the exact algorithm so colors match the web per name.

- [ ] **Step 2: Write failing tests** in `AvatarHueTests.swift`:

```swift
import XCTest
@testable import OrbixKit

final class AvatarHueTests: XCTestCase {
    func testHueIsDeterministicAndInRange() {
        let h1 = avatarHue("Nikita")
        XCTAssertEqual(h1, avatarHue("Nikita"))
        XCTAssertGreaterThanOrEqual(h1, 0)
        XCTAssertLessThan(h1, 360)
        XCTAssertNotEqual(avatarHue("Alice"), avatarHue("Bob"))
    }

    func testInitials() {
        XCTAssertEqual(avatarInitials("Nikita Fedorov"), "NF")
        XCTAssertEqual(avatarInitials("kids"), "K")
        XCTAssertEqual(avatarInitials(""), "?")
    }
}
```

- [ ] **Step 3: Run to verify failure** — `xcodebuild -project Orbix.xcodeproj -scheme OrbixKitTests -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' test CODE_SIGNING_ALLOWED=NO` (after `xcodegen generate`). Expected: FAIL (symbols undefined).

- [ ] **Step 4: Implement** `AvatarHue.swift` (match the web algorithm exactly — if the web hash differs from this sketch, the web wins):

```swift
/// Port of apps/web/src/lib/tv.ts channelHue/channelInitials — keep in sync.
public func avatarHue(_ name: String) -> Double {
    var hash: UInt32 = 0
    for u in name.unicodeScalars { hash = hash &* 31 &+ u.value }
    return Double(hash % 360)
}

public func avatarInitials(_ name: String) -> String {
    let words = name.split(separator: " ").prefix(2)
    let initials = words.compactMap { $0.first.map(String.init) }.joined().uppercased()
    return initials.isEmpty ? "?" : initials
}
```

Then the three SwiftUI files per the interface block.

- [ ] **Step 5: Run tests + build** — kit tests PASS, app builds.

- [ ] **Step 6: Commit** — `git add clients/tvos/Sources/OrbixKit/AvatarHue.swift clients/tvos/Sources/Orbix/Design clients/tvos/Tests && git commit -m "feat(tvos): badges, progress bars, avatar with web-matching hue hash"`

---

### Task 5 (Phase 1): OrbixKit — menu + createProfile endpoints

**Files:**
- Modify: `clients/tvos/Sources/OrbixKit/OrbixClient.swift`
- Modify: `clients/tvos/Sources/OrbixKit/DTOs.swift`
- Test: `clients/tvos/Tests/OrbixKitTests/DTOTests.swift` (extend)

**Interfaces:**
- Consumes: existing `perform`/decode plumbing in `OrbixClient`, decode-safe DTO conventions (every non-key field Optional).
- Produces:
  - `public struct MenuItem: Decodable, Sendable { public let libraryId: String?; public let name: String?; public let kind: String? }` (match `apps/web/src/lib/types.ts` `MenuItem` exactly — read it first; adjust fields to the real shape).
  - `public func menu() async throws -> [MenuItem]` — `GET /api/me/menu`.
  - `public func createProfile(name: String, language: String) async throws -> Profile` — `POST /api/profiles` body `{name, kind: "standard", language}`.
  - `MeProfile` gains `kind`/`language` if missing (check `apps/api/src/routes/profiles.ts` response shape).

- [ ] **Step 1: Read the server shapes** — `GET /me/menu` handler in `apps/api/src/routes/menu.ts` and `POST /profiles` in `apps/api/src/routes/profiles.ts`, plus `apps/web/src/lib/types.ts` `MenuItem`. DTO fields must match the wire shape.

- [ ] **Step 2: Write failing DTO decode tests** in `DTOTests.swift` (follow the file's existing fixture style — JSON string → decode → assert). Cover: menu list happy path, menu entry with nulls, created-profile response, MeProfile with kind/language.

- [ ] **Step 3: Run kit tests to verify failure.**

- [ ] **Step 4: Implement DTOs + client methods** following the existing `homeRows()`/`profiles()` patterns (same actor, same `perform`).

- [ ] **Step 5: Run kit tests — PASS.**

- [ ] **Step 6: Commit** — `git commit -m "feat(orbixkit): menu + createProfile endpoints"` (add the three files).

---

### Task 6 (Phase 1): Shell — section model, custom top bar, routed content

**Files:**
- Create: `clients/tvos/Sources/Orbix/Shell/AppSection.swift`
- Create: `clients/tvos/Sources/Orbix/Shell/OrbixTopBar.swift`
- Create: `clients/tvos/Sources/Orbix/Shell/ShellView.swift`
- Modify: `clients/tvos/Sources/Orbix/RootView.swift` (`.ready` case only)
- Modify: `clients/tvos/Sources/Orbix/AppModel.swift` (add `activeProfile` + `menuItems` state)

**Interfaces:**
- Consumes: `menu()`, `meProfile()` (OrbixKit), Design components (Tasks 2–4), existing `HomeView`, `SearchView`.
- Produces:
  - `enum AppSection: Hashable { case home, tv, category(String), wishlist, search, account }`
  - `struct ShellView: View { let model: AppModel }` — owns `@State selection: AppSection = .home`, renders `OrbixTopBar` overlaid on the selected section's content; each section hosts its own `NavigationStack`. Placeholder `ContentUnavailableView`s for `.tv`, `.category`, `.wishlist`, `.account` (filled in Phases 2–5).
  - `struct OrbixTopBar: View` — left: wordmark (tracked uppercase, accent), Home, TV (hidden when `model.activeProfile?.kind == "kids"`), up to 6 categories from `model.menuItems` + "More" menu; right: heart (wishlist), magnifier (search), `AvatarView` (account). Focused item = white text + underline-ish scale; selected = `OrbixColor.text`, others `textDim`. Background: `LinearGradient` black 0.7→clear normally; solid `OrbixColor.bg.opacity(0.95)` when `isScrolled` binding is true.
  - `AppModel` additions: `private(set) var activeProfile: MeProfile?`, `private(set) var menuItems: [MenuItem]`, `func loadShellData() async` (fetches both via the client, tolerates failures by leaving empties), and `activeProfile` set inside `checkActiveProfile` from the `meProfile()` result it already fetches; `profileSelected()` triggers a `Task { await loadShellData() }`.

- [ ] **Step 1: Read the web TopNav** — `apps/web/src/components/shell/TopNav.tsx` + `NavCategories` + `apps/web/src/components/shell/icons.tsx` for the exact item order, states, and scrolled behavior.

- [ ] **Step 2: Implement `AppSection` + `AppModel` additions.** Keep `checkActiveProfile`'s retry/401 semantics untouched — only capture the successful `me` into `activeProfile`.

- [ ] **Step 3: Implement `OrbixTopBar` + `ShellView`.** Bar is a horizontal `HStack` inside a focus section (`.focusSection()`); items are `Button`s with plain styling; wordmark = `Text("ORBIX").font(OrbixType.wordmark(size: 34)).kerning(8).foregroundStyle(OrbixColor.accent)`. Content below in a `ZStack(alignment: .top)` so the billboard can ride under the transparent bar. Track scroll via a `@Binding isScrolled: Bool` that sections set from their scroll geometry (Home wires it in Phase 2; placeholders pass a constant).

- [ ] **Step 4: Rewire `RootView.ready`** — replace the stock `TabView` block with `ShellView(model: model)`. Delete the two `.tabItem` entries (Home/Search now render inside ShellView; pass the same `model`).

- [ ] **Step 5: Build gate + manual smoke** — build, then run in the simulator against the NAS (`xcrun simctl launch` with `-orbixBaseURL http://192.168.1.95:8080 -orbixToken <dev token>` per README) and confirm: bar renders over Home, focus moves along the bar, Search opens, placeholders show for TV/My List/Account, kids profile hides TV. Screenshot for the phase record: `xcrun simctl io booted screenshot shell.png`.

- [ ] **Step 6: Commit** — `git add clients/tvos/Sources/Orbix && git commit -m "feat(tvos): custom web-parity top-bar shell"`

---

### Task 7 (Phase 1): Restyle onboarding (server select + pairing)

**Files:**
- Create: `clients/tvos/Sources/Orbix/Design/OnboardingChrome.swift`
- Modify: `clients/tvos/Sources/Orbix/RootView.swift` (server-selection views)
- Modify: `clients/tvos/Sources/Orbix/Onboarding/PairingView.swift`

**Interfaces:**
- Consumes: Tokens/components (Tasks 2–3). Existing `AppModel` + `PairingModel` logic — behavior must not change, visuals only.
- Produces: `struct OnboardingChrome<Content: View>: View` — full-screen `OrbixColor.bg`, centered content card (`OrbixColor.surface`, `OrbixRadius.lg`, subtle border white 0.06) with an orbit-glow behind it (radial gradient `OrbixColor.accent`→`accent2`→clear at ~0.35 opacity, blurred), wordmark above (web Login/Setup look — see `apps/web/src/pages/LoginPage.tsx`).

- [ ] **Step 1: Read `apps/web/src/pages/LoginPage.tsx`** for the exact auth-screen composition (wordmark, card, glow).

- [ ] **Step 2: Implement `OnboardingChrome` and wrap** the three server-selection states (scanning / list / manual) and `PairingView`'s code display in it. Pairing code: large monospaced-digit text, `kerning(16)`, on a `surface2` plate — visually the star of the screen. Keep all existing accessibility identifiers (`scanningIndicator`, `baseURLField`, `checkServerButton`, `server_*`, `reachabilityStatus`) — the live tests reference them.

- [ ] **Step 3: Build + simulator smoke** — onboarding renders on-brand with no logic change; both flows still reach Home against the NAS.

- [ ] **Step 4: Commit** — `git commit -m "feat(tvos): on-brand onboarding chrome"` (add modified files).

---

### Task 8 (Phase 1): Profile picker — "Who's watching?" parity + add profile

**Files:**
- Modify: `clients/tvos/Sources/Orbix/Onboarding/ProfilePickerView.swift`
- Modify: `clients/tvos/Sources/Orbix/Onboarding/ProfilePickerModel.swift`

**Interfaces:**
- Consumes: `AvatarView` (Task 4), `createProfile(name:language:)` (Task 5), `OnboardingChrome` (Task 7), existing `profiles()`/`selectProfile(id:)`.
- Produces: web-parity picker (see `apps/web/src/pages/ProfilesPage.tsx`): centered "Who's watching?" heading, tile grid (AvatarView size ~160 + name, focus-promote), an "Add profile" tile opening a form (name `TextField`, language picker over the 6 codes en/es/de/pt/ru/fr with native labels English/Español/Deutsch/Português/Русский/Français), `pin_required` error surfaced as text (web parity: no PIN entry UI). `ProfilePickerModel` gains `func addProfile(name: String, language: String) async` calling `createProfile` then refreshing the list.

- [ ] **Step 1: Read `apps/web/src/pages/ProfilesPage.tsx`** for layout/copy, then implement view + model changes.

- [ ] **Step 2: Build + simulator smoke** — pick a profile → Home; add a test profile against the NAS, see it appear (then delete it via web UI if desired).

- [ ] **Step 3: Commit** — `git commit -m "feat(tvos): web-parity profile picker with add-profile"`.

---

### Task 9 (Phase 1): Phase gate — full build, tests, visual record

**Files:** none created (verification only)

- [x] **Step 1: Full gates** — `xcodegen generate`; app scheme builds; `OrbixKitTests` pass; server: `pnpm typecheck && pnpm lint && pnpm test` still green.

- [x] **Step 2: Visual record** — simulator against the NAS: screenshots of (a) server select, (b) pairing, (c) profile picker, (d) shell over Home, (e) Search. Compare against the web side-by-side; note deviations for the Phase 2 backlog rather than gold-plating now.

- [x] **Step 3: Commit any fixes; update the plan checkboxes.** No fixes needed (0 deviations found in the new Phase 1 surfaces). See `.superpowers/sdd/task-9-report.md` for full gate output + screenshot-by-screenshot notes.

---

## Self-review notes

- Spec coverage: Phase 0 = spec §3 fully. Phase 1 = spec §5 (tokens/components subset needed now), §6 (shell), §7.1 (onboarding + profiles). BoxArtCard/PosterCard/RatingBadges/rails intentionally live in the Phase 2 plan (they belong to Home/Library/Title work). ChannelLogoView → Phase 4 plan.
- Type consistency: `OrbixColor`/`OrbixRadius`/`OrbixSpacing`/`OrbixType` names used consistently across Tasks 3–8; `avatarHue`/`avatarInitials` public in OrbixKit; `AppSection`/`ShellView`/`OrbixTopBar` defined in Task 6 before use in 7–8 (none).
- No placeholders: every code step has real code or an exact interface + the web source file to read; test steps have real test code.
