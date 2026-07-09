# tvOS Parity Rebuild — Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring **ACCOUNT-LITE + i18n + PIN entry + the accumulated polish batch** to the tvOS app: OrbixKit gaps (`updateProfile(id:language:)`, `menuConfig()`, `saveMenu(libraryIds:)`, a `selectProfile(id:pin:)` overload, `hasPin` on `Profile`, an API-error-code carrying `OrbixError`, `menuMoveItem`, a public ISO date parser); a **PIN pad** on the profile picker (attempt-select → 403 `pin_required` → pad → retry with `{pin}`); the **Account** section replacing `ShellView`'s `.account` placeholder (profile card, language switcher that PATCHes the profile and re-localizes the catalog, Switch Profile, per-profile menu editor with enable + reorder + ≥1 enforced, server info, Unlink Device); **full i18n** — a hand-authored String Catalog with all six web languages (en/es/de/pt/ru/fr), keys mirroring the web namespaces, UI language following the active profile's language with system fallback; and the **Phase 3/4 polish ledger** (doc-symbol drift, episode-label parity, failed-still placeholder, leveling glyph, no-media Play icon, bar re-solidify on Library/Wishlist, ISO-parser consolidation, kids/edge-states pass). Exit gate: full gates; live language-switch, menu-editor round-trip, PIN-pad, and unlink smokes vs the NAS (all Phase-5 endpoints verified present on `main`); parity screenshots; recorded deviations.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-05-tvos-parity-rebuild-design.md` (§7.11 account-lite, §9 i18n, §11 phasing row 5; §12's "PIN entry deferred" is **SUPERSEDED by user decision — PIN entry ships this phase**). Builds on Phase 1's design system + onboarding (`ProfilePickerView`/`ProfilePickerModel` are the PIN pad's integration point — its `catch OrbixError.http(403)` "not yet supported" branch is the exact seam to replace), Phase 2's shell (`ShellView`'s `.account` case is the placeholder to replace; `AppModel.activeProfile`/`menuItems`/`loadShellData` feed the Account screen), and OrbixKit's actor client + decode-safe DTOs. New pure logic (DTOs, error-code extraction, `menuMoveItem`, ISO parser) extends **OrbixKit** under TDD; new views live in the **Orbix** app target (`Sources/Orbix/Account/`, `PinPadView` in `Sources/Orbix/Onboarding/`). Web sources of truth: `apps/web/src/pages/account/{AccountLayout,AccountOverview}.tsx`, `apps/web/src/components/account/{ProfileMenuEditor.tsx,menu-order.ts}`, `apps/web/src/components/LanguageSwitcher.tsx`, `apps/web/src/lib/i18n/{languages.ts,tError.ts,useActiveLanguage.ts,index.ts}`, `apps/web/src/locales/<lng>/<ns>.json`. Wire shapes verified against `apps/api/src/routes/{profiles.ts,menu.ts}` and `packages/core/src/profiles/profiles.ts` (PIN is exactly `/^\d{4}$/`; `PROFILE_LANGUAGES = en/es/de/pt/ru/fr`). **Wire-compat note (verified):** this branch's `GET /profiles` sends `{id,name,avatar,kind,maturityCap,language}` — **no `hasPin`** — while `origin/main` (the NAS) has moved ahead and sends `hasPin`/`isGroup`/`members` via `serializeProfile`. The PIN design therefore **never depends on `hasPin`**: the TV attempts select and shows the pad on 403 `pin_required` (identical handler on both: branch `profiles.ts:78-96`, main `:278-283`); `hasPin` is decoded opportunistically as `Bool?` for an optional lock badge. Phase 6 merges `main` into `tv-ui` before NAS deploy.

**Tech Stack:** SwiftUI, tvOS 17, Swift 6, XcodeGen; XCTest (OrbixKitTests); Xcode String Catalogs (`Localizable.xcstrings`, hand-authored JSON — compiled by the Xcode 15+ build system into per-language `.lproj` resources, which is what makes the runtime language-bundle override work). **No server change in Phase 5** — verified: `apps/api/src/routes/menu.ts` is byte-identical to `origin/main` (empty diff), and `PATCH /profiles/:id`, `POST /profiles` (with `pin`), and `POST /profiles/:id/select` (with `{pin}` body, 403 `pin_required`) exist with the same core semantics on both the branch and `main` — so **every Phase-5 endpoint is live-verifiable against the NAS**, unlike Phase 4's playback.

## Global Constraints

- **Web is the visual source of truth.** Read the named `apps/web/src/**` component/page before writing each surface; mirror layout, copy, states. Where a web behavior is mouse/keyboard-specific (`<select>` language switcher, checkbox + ↑/↓ buttons, admin tabs), use the tvOS focus/remote adaptation named in the task rather than inventing one. **Admin surfaces stay web-only:** the TV Account screen is single-screen, no tabs (spec §7.11).
- **DTOs mirror wire shapes verified against route handlers.** Every non-key field is `Optional` (decode-safe). **Test fixtures in `DTOTests.swift` must be real wire shapes copied from the route handler, not invented** — and for profiles, fixtures for **both** wire shapes (this branch's plain select, and `origin/main`'s `serializeProfile` with `hasPin`/`isGroup`/`members`) so the DTO is proven compatible with both.
- **Pure logic / DTOs that need tests go in OrbixKit** (`Sources/OrbixKit/`), tested in `Tests/OrbixKitTests/`. **TDD for all OrbixKit work: write the failing test first, run it to confirm failure, then implement.** `menuMoveItem` ports the web's own `menu-order.test.ts` vectors verbatim.
- **No server change is planned in Phase 5.** If any `apps/api/**` file is nonetheless touched, run repo gates **with lint separately** per CLAUDE.md: `pnpm typecheck && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api test`. No task here should need this.
- **Build/test gates (tvOS):** regenerate after file adds: `cd clients/tvos && xcodegen generate`; then
  `xcodebuild -project Orbix.xcodeproj -scheme Orbix -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' build CODE_SIGNING_ALLOWED=NO`
  and for kit changes `xcodebuild -project Orbix.xcodeproj -scheme OrbixKitTests -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' test CODE_SIGNING_ALLOWED=NO`.
  **Substitution note:** if that simulator name is unavailable, pick one from `xcrun simctl list devices available | grep "Apple TV"` and substitute it in `-destination`.
- **Swift 6 language mode:** new types crossing actor boundaries are `Sendable`; UI models are `@MainActor @Observable`. OrbixKit DTOs are `Codable, Sendable, Equatable`.
- **Token-only colors:** use `OrbixColor`/`OrbixRadius`/`OrbixSpacing`/`OrbixType`. No raw hex or ad-hoc `Color(red:…)` in view code. The hue-hashed avatar/monogram tiles (`AvatarView`, `ChannelLogoView`) remain the one annotated *data-derived* exception — and per **user decision (recorded 2026-07-06)** they **stay**, documented as a deliberate TV adaptation (Task 3 updates the doc comment).
- **No hardcoded server origins or tokens** in committed code (`-orbixBaseURL`/`-orbixToken`, `ORBIX_BASE_URL`/`ORBIX_TOKEN` stay the only mechanism).
- **Authenticated simulator smokes** use the device-token env file at `.superpowers/sdd/dev-device-token.env` (keys `ORBIX_TEST_BASE_URL`, `ORBIX_TEST_TOKEN`). Load it (`set -a; source .superpowers/sdd/dev-device-token.env; set +a`) and pass `"$ORBIX_TEST_TOKEN"` **by reference — never print, echo, or log the token** (this includes `curl -v` headers: use `-sS` and `-H "Authorization: Bearer $ORBIX_TEST_TOKEN"` unquoted-to-screen never).
- **PIN safety (user decision, binding): never ask for, embed, or use the user's real PIN.** Nikita's profile has a real PIN — no smoke may target it, not even with a deliberately wrong PIN. All PIN verification uses a **throwaway profile created via the API with a throwaway PIN** (e.g. `2468`), deleted after, with the device's original active profile restored. Throwaway PINs may appear in plan/docs/smoke commands; real PINs never exist anywhere in this repo.
- **Stale-NAS constraint (updated for Phase 5):** the NAS stays on `main` until Phase 6. Unlike Phase 4, **every Phase-5 endpoint exists on `main`** (verified above), so all smokes run live vs the NAS (`http://192.168.1.95:8080`, paired device token). `origin/main` has moved ahead of this branch on `profiles.ts` (`hasPin`/`isGroup`/`members`) — Phase-5 client code must stay **wire-compatible with both** shapes; **Phase 6 merges `main` into `tv-ui` before deploy**.
- **i18n replaces the "English literals only" rule from Phases 1-4:** every user-facing string moves to the String Catalog with keys mirroring the web namespaces (`<ns>.<path>`, e.g. `account.menu.selectOne` ← web `account:menu.selectOne`). **Port translations from `apps/web/src/locales/<lng>/<ns>.json` verbatim where the string matches**; TV-only strings (pairing, server select, PIN pad, unlink) get web-consistent keys and carefully written translations for all six languages. `accessibilityIdentifier`s are machine identifiers, **not** localized. Region names via `Locale.localizedString(forRegionCode:)` (already in `tvRegionName`).
- **Commit after every task** (small commits on branch `tv-ui`; verify with `git branch --show-current`). Each commit must leave build + kit tests green.

---

### Task 1: OrbixKit — profile/menu endpoints, PIN-aware select, API-error codes, `menuMoveItem`, public ISO parser (TDD)

**Files:**
- Modify: `clients/tvos/Sources/OrbixKit/OrbixClient.swift` (extend `// MARK: - Profiles` and `// MARK: - Menu`; change `OrbixError`)
- Modify: `clients/tvos/Sources/OrbixKit/DTOs.swift` (add `hasPin` to `Profile`; add `MenuConfig`)
- Create: `clients/tvos/Sources/OrbixKit/MenuOrder.swift`
- Create: `clients/tvos/Sources/OrbixKit/ISODate.swift`
- Modify: `clients/tvos/Sources/OrbixKit/Billboard.swift`, `clients/tvos/Sources/OrbixKit/TvGridLayout.swift` (delegate their private ISO parsing to `ISODate.swift`)
- Modify (compiler-forced by the `OrbixError` change): `clients/tvos/Sources/Orbix/AppModel.swift:252`, `Sources/Orbix/Title/SeasonEpisodeListView.swift:516`, `Sources/Orbix/Title/TitlePage.swift:458`, `Sources/Orbix/Onboarding/PairingModel.swift:112`, `Sources/Orbix/Onboarding/ProfilePickerModel.swift:70`, `Sources/Orbix/TV/TvChannelView.swift:669`, plus the doc mention at `Sources/OrbixKit/DTOs.swift:1052`
- Test: `clients/tvos/Tests/OrbixKitTests/DTOTests.swift` (extend), `clients/tvos/Tests/OrbixKitTests/MenuOrderTests.swift` (create), `clients/tvos/Tests/OrbixKitTests/ISODateTests.swift` (create)

**Interfaces:**
- Produces (DTOs):
  - `Profile` gains `public var hasPin: Bool?` (decode-safe: absent on this branch's wire → `nil`; present on `origin/main`'s `serializeProfile` wire → `true`/`false`; `isGroup`/`members` are **not** modeled — unknown keys are ignored by `Codable`, and group profiles are out of scope until the Phase-6 merge).
  - `MenuConfig { libraries: [MenuItem]; enabled: [String] }` — `GET /me/menu/config` (`menu.ts:30-38`): `libraries` = every library via `resolveProfileMenu(libraries, [])`, `enabled` = the ordered enabled ids.
- Produces (client methods):
  - `updateProfile(id:language:) -> Profile` — `PATCH /api/profiles/:id` body `{language}`. Branch response: `{id,name,kind,language}` (`profiles.ts:64`) — decodes into `Profile` (`avatar`/`maturityCap`/`hasPin` → `nil`); main's response carries the full `serializeProfile` shape — also decodes. The handler triggers `ensureMetadataLanguage` server-side (the catalog re-localization the web relies on).
  - `menuConfig() -> MenuConfig` — `GET /api/me/menu/config`.
  - `saveMenu(libraryIds:) -> [MenuItem]` — `PUT /api/me/menu` body `{libraryIds}`; response `{items:[...]}` (reuse `MenuResponse`, unwrap). Server rejects empty (`400 {error:"empty"}`), duplicates, unknown ids.
  - `selectProfile(id:pin:)` — the existing method gains `pin: String? = nil` (source-compatible; a `nil` pin encodes to `{}` via `encodeIfPresent`, exactly the current body).
- Produces (error plumbing): `OrbixError.http` gains the API error code:

```swift
public enum OrbixError: Error, @unchecked Sendable {
    /// `code` is the machine-readable `{error: "<code>"}` body the API sends
    /// on most non-2xx responses (e.g. "pin_required", "no_active_profile"),
    /// or nil when the body has no such shape. Carried on the same case
    /// (rather than a new one) so the compiler forces every existing
    /// `case .http(N)` match site to acknowledge it — no silent misses.
    case http(Int, code: String?)
    case decoding(Error)
    case transport(Error)

    /// Extracts `{error: "<code>"}` from a non-2xx body. Public + pure so
    /// it's directly unit-testable (perform() itself is private actor API).
    public static func apiCode(from data: Data) -> String? {
        struct ErrorBody: Decodable { let error: String }
        return (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
    }
}
```
  `perform` changes its throw to `throw OrbixError.http(http.statusCode, code: OrbixError.apiCode(from: data))`. Every existing match site updates mechanically: `case .http(401, _)` (AppModel), `case .http(404, _)` (SeasonEpisodeListView, TitlePage, PairingModel, TvChannelView); ProfilePickerModel's 403 catch is rewritten properly in Task 2 — for this task just make it compile as `catch OrbixError.http(403, _)`.
- Produces (pure logic):
  - `public func menuMoveItem<T>(_ list: [T], index: Int, dir: Int) -> [T]` — 1:1 port of `apps/web/src/components/account/menu-order.ts` `moveItem` (swap toward `dir`, no-op copy at the ends).
  - `public func orbixParseISODate(_ iso: String) -> Date?` in `ISODate.swift` — the two-formatter idiom (fractional `ISO8601DateFormatter` first, then plain), extracted from `Billboard.parseISODate`; `TvGridLayout.tvParseMs` delegates to it (`orbixParseISODate(iso)?.timeIntervalSince1970 * 1000`). The Orbix-app private copies are consolidated in Task 6.

**Verified wire shapes (copied from handlers):**
- `PATCH /profiles/:id` (branch `profiles.ts:39-76`) body `{language:"ru"}` → `{id,name,kind,language}`; **400** `{error:"invalid_profile"}` on a non-supported language; **404** `{error:"not_found"}`. Language change triggers `ensureMetadataLanguage`.
- `POST /profiles/:id/select` (branch `profiles.ts:78-96`, main `:278-296`) body `{}` or `{pin:"1234"}` → `{profileId}`; **403** `{error:"pin_required"}` when the profile has a `pinHash` and the pin is missing **or wrong** (same code both cases, both wires). Device clients persist `activeProfileId` on the device row.
- `GET /me/menu/config` (`menu.ts:30-38`, identical on main) → `{libraries:[{libraryId,name}...], enabled:["<id>"...]}`.
- `PUT /me/menu` (`menu.ts:40-77`) body `{libraryIds:[...]}` → `{items:[{libraryId,name}...]}`; **400** `{error:"no_active_profile"|"invalid"|"empty"|"duplicate"|"unknown_library"}`.
- `GET /profiles` — branch: `[{id,name,avatar,kind,maturityCap,language}]`; **main/NAS:** each profile additionally has `isGroup`, `hasPin`, `members:[...]`.

- [ ] **Step 1: Read the handlers** — `apps/api/src/routes/profiles.ts` (branch) **and** `git show origin/main:apps/api/src/routes/profiles.ts` (the `serializeProfile` shape), `apps/api/src/routes/menu.ts`, `packages/core/src/profiles/profiles.ts` (PIN regex, `PROFILE_LANGUAGES`), `apps/web/src/components/account/menu-order.ts` + `.test.ts`.

- [ ] **Step 2: Write failing tests.** In `DTOTests.swift` (`// MARK: - Account/PIN (Phase 5 Task 1)`): decode `MenuConfig` from the real config shape; decode the PATCH response `{"id":"p1","name":"Katya","kind":"standard","language":"ru"}` into `Profile` (asserting `avatar == nil`, `hasPin == nil`); decode a **main-wire** profile `{"id":"p2","name":"Nikita","avatar":null,"kind":"standard","maturityCap":null,"language":"en","isGroup":false,"hasPin":true,"members":[]}` (asserting `hasPin == true` and that the unmodeled keys don't fail decoding); `OrbixError.apiCode` from `{"error":"pin_required"}` → `"pin_required"`, from `not json` → `nil`, from `{"error":123}` → `nil`. In `MenuOrderTests.swift`: the web vectors (middle up/down swap, index-0 up no-op copy, last-index down no-op copy, single-element). In `ISODateTests.swift`: fractional ISO parses, plain ISO parses, junk → `nil`, round-trip vs a known epoch.

- [ ] **Step 3: Run to verify failure** — `cd clients/tvos && xcodegen generate` then the `OrbixKitTests` `test` gate. Expected: FAIL.

- [ ] **Step 4: Implement** — DTO additions, `OrbixError` change + `perform` throw, client methods (mirroring the existing doc-comment + idiom conventions), `MenuOrder.swift`, `ISODate.swift`, the `Billboard`/`TvGridLayout` delegation, and the six mechanical match-site updates in the app target.

- [ ] **Step 5: Run tests — PASS.** All new suites green; every pre-existing suite green (BillboardTests/TvGridLayoutTests prove the parser consolidation changed nothing).

- [ ] **Step 6: Gates** — `xcodegen generate`; app `build` SUCCEEDED; `OrbixKitTests` `test` passing.

- [ ] **Step 7: Commit** — `git add clients/tvos && git commit -m "feat(orbixkit): profile PATCH/menu-config/save, PIN-aware select, API error codes, menu-order + ISO parser"`

---

### Task 2: PIN entry — `PinPadView` + profile-picker integration

**Files:**
- Create: `clients/tvos/Sources/Orbix/Onboarding/PinPadView.swift`
- Modify: `clients/tvos/Sources/Orbix/Onboarding/ProfilePickerModel.swift` (replace the "not yet supported" 403 branch with the pad state machine)
- Modify: `clients/tvos/Sources/Orbix/Onboarding/ProfilePickerView.swift` (present the pad; optional `hasPin` lock badge)

**Interfaces:**
- Consumes: `selectProfile(id:pin:)` + `OrbixError.http(403, code:)` (Task 1), `OrbixButtonStyle`, `OrbixColor`, `AvatarView`, `AppModel.profileSelected()`.
- Produces:
  - `struct PinPadView: View` — a focus-friendly 4-digit PIN pad: profile name header, four dot indicators, a 3×4 digit grid (1-9 / delete · 0 · blank), an error line, Cancel. Auto-submits at 4 digits; clears on error.
  - `ProfilePickerModel` gains `pinPrompt: Profile?` (non-nil → pad shown), `pinError: String?`, `isVerifyingPin: Bool`, `cancelPinEntry()`, and the extended `select(_:pin:client:)`.

**Design (works against BOTH wire shapes — the load-bearing decision):** the TV **never gates on `hasPin`**. Selecting any profile attempts `POST /profiles/:id/select` without a pin; the **only** 403 that route sends (verified on the branch *and* on `origin/main`) is `{error:"pin_required"}`, so a 403 with no pin opens the pad, and a 403 **with** a pin means "wrong PIN". `hasPin` (NAS wire only) drives nothing but a cosmetic lock badge on the tile — against a branch-wire server the badge simply never renders.

**`ProfilePickerModel` state machine (complete):**

```swift
/// Non-nil while the PIN pad is up for this profile (attempt-select hit
/// 403 pin_required). The pad is the tvOS adaptation the web doesn't have —
/// web parity used to stop at a localized error (spec §12), superseded by
/// the Phase-5 user decision to ship PIN entry.
private(set) var pinPrompt: Profile?
private(set) var pinError: String?
private(set) var isVerifyingPin = false

func cancelPinEntry() {
    pinPrompt = nil
    pinError = nil
}

@discardableResult
func select(_ id: String, pin: String? = nil, client: OrbixClient) async -> Bool {
    guard selectingId == nil else { return false }
    selectingId = id
    defer { selectingId = nil }
    if pin != nil {
        // nil→message transitions drive the pad's clear-on-error; reset to
        // nil at the start of every attempt so consecutive wrong PINs still
        // produce a fresh transition.
        pinError = nil
        isVerifyingPin = true
    }
    defer { isVerifyingPin = false }

    do {
        try await client.selectProfile(id: id, pin: pin)
        pinPrompt = nil
        pinError = nil
        return true
    } catch OrbixError.http(403, _) {
        // The only 403 this route sends is {error:"pin_required"} — on this
        // branch (profiles.ts:81-85) and on origin/main (:281-283) alike.
        if pin == nil {
            pinPrompt = profiles.first { $0.id == id }
        } else {
            pinError = "Wrong PIN. Try again."   // → profiles.pin.wrong (Task 4)
        }
        return false
    } catch {
        if pin == nil {
            loadError = "Couldn't select profile: \(error)"
        } else {
            pinError = "Couldn't verify PIN. Try again."  // → profiles.pin.failed
        }
        return false
    }
}
```

**`PinPadView` (complete core):**

```swift
struct PinPadView: View {
    let profileName: String
    let errorText: String?
    let isVerifying: Bool
    let onSubmit: (String) -> Void
    let onCancel: () -> Void

    @State private var entered = ""
    private static let pinLength = 4

    var body: some View {
        VStack(spacing: 36) {
            Text("Enter PIN")                       // → profiles.pin.title (Task 4)
                .font(.title.bold()).foregroundStyle(OrbixColor.text)
            Text(profileName)
                .font(.title3).foregroundStyle(OrbixColor.textDim)

            HStack(spacing: 20) {                    // 4-dot display
                ForEach(0..<Self.pinLength, id: \.self) { i in
                    Circle()
                        .fill(i < entered.count ? OrbixColor.text : OrbixColor.surface3)
                        .frame(width: 22, height: 22)
                }
            }
            .accessibilityIdentifier("pinDots")

            if let errorText {
                Text(errorText).font(.callout).foregroundStyle(.red)
                    .accessibilityIdentifier("pinErrorMessage")
            }

            VStack(spacing: 16) {                    // focusable 3×4 grid
                ForEach([[1, 2, 3], [4, 5, 6], [7, 8, 9]], id: \.self) { row in
                    HStack(spacing: 16) { ForEach(row, id: \.self, content: digitKey) }
                }
                HStack(spacing: 16) {
                    key(label: Image(systemName: "delete.left"), id: "pinKey_delete") {
                        if !entered.isEmpty { entered.removeLast() }
                    }
                    digitKey(0)
                    key(label: Text("Cancel"), id: "pinKey_cancel", action: onCancel)
                }
            }
            .focusSection()
            .disabled(isVerifying)
        }
        .onChange(of: entered) { _, new in
            guard new.count == Self.pinLength, !isVerifying else { return }
            onSubmit(new)
        }
        .onChange(of: errorText) { _, new in
            if new != nil { entered = "" }           // wrong PIN → clear the dots
        }
    }

    private func digitKey(_ n: Int) -> some View {
        key(label: Text("\(n)").monospacedDigit(), id: "pinKey_\(n)") {
            guard entered.count < Self.pinLength else { return }
            entered.append(String(n))
        }
    }
    // `key(label:id:action:)` = a square focus-promoted Button on OrbixColor.surface2,
    // OrbixRadius corners, the ProfileTileButtonStyle focus treatment.
}
```

- [ ] **Step 1: Re-read** `ProfilePickerView.swift`/`ProfilePickerModel.swift` (the `showAddForm` same-screen state-swap idiom to mirror, `ProfileTileButtonStyle`) and both wires' `profiles.ts` select handlers.

- [ ] **Step 2: Implement `PinPadView.swift`** (above, plus the `key` helper + `#Preview`s: clean, error-state, verifying).

- [ ] **Step 3: Rewire `ProfilePickerModel`** with the state machine above (delete the "PIN entry is not yet supported" branch and its doc comment).

- [ ] **Step 4: Present the pad in `ProfilePickerView`** — same state-swap shape as `showAddForm`: when `profileModel.pinPrompt != nil`, render `PinPadView(profileName:errorText:isVerifying:onSubmit:onCancel:)` (inside `OnboardingChrome`) instead of the grid; `onSubmit` runs `Task { if await profileModel.select(prompt.id, pin: pin, client: client) { model.profileSelected() } }`; `onCancel` = `profileModel.cancelPinEntry()`. Add the cosmetic lock badge on tiles when `profile.hasPin == true` (`Image(systemName: "lock.fill")` mini-plate, mirroring the KIDS badge placement; annotate: NAS wire only — this branch's server never sends it, by design).

- [ ] **Step 5: Build gate** — `xcodegen generate` + app `build` SUCCEEDED; kit tests still green.

- [ ] **Step 6: Authenticated smoke (vs NAS — 403 path only, no real PINs).** Launch the sim app with the env-file token (Task-7 recipe). The picker renders; **do not** touch Nikita's profile. Verification of the full wrong/right PIN flow happens in the Task-7 gate with a throwaway PIN profile; here, confirm only that profiles load and plain (PIN-less) selection still works, and capture the pad via `#Preview`/screenshot `.superpowers/sdd/phase5-pinpad.png` (pad visible with dots + grid).

- [ ] **Step 7: Commit** — `git add clients/tvos/Sources/Orbix/Onboarding && git commit -m "feat(tvos): PIN pad on profile select (attempt-select → 403 pin_required → pad)"`

---

### Task 3: Account section — profile card, language switcher, switch profile, menu editor, server info, unlink device

**Files:**
- Create: `clients/tvos/Sources/Orbix/Account/AccountView.swift`
- Create: `clients/tvos/Sources/Orbix/Account/AccountModel.swift`
- Modify: `clients/tvos/Sources/Orbix/Shell/ShellView.swift` (replace the `.account` placeholder; drop the now-unused `placeholder` helper)
- Modify: `clients/tvos/Sources/Orbix/AppModel.swift` (add `switchProfile()`, `unlinkDevice()`, `applyMenu(_:)`, `profileLanguageChanged(_:)`)
- Modify: `clients/tvos/Sources/Orbix/Design/AvatarView.swift` (doc comment only — record the user decision)

**Interfaces:**
- Consumes: `updateProfile`/`menuConfig`/`saveMenu`/`menuMoveItem` (Task 1), `AvatarView`, `OrbixButton`, `AppModel` (`activeProfile`, `menuItems`, `baseURL`, `client`).
- Produces: `struct AccountView: View` + `@MainActor @Observable final class AccountModel` — a single scrolling Account screen (NO tabs — spec §7.11 TV adaptation, admin surfaces stay web-only), sections top-to-bottom, each a `.focusSection()`:
  1. **Profile card** (web `AccountOverview.tsx:23-31`): `AvatarView(name:imageURL:size: 96)` + name + kind line (`kind == "kids"` → "Kids profile" else "Standard profile" — web `account:profileKind.*`).
  2. **Language** (web `LanguageSwitcher.tsx`, TV-adapted from `<select>` to a row of six focusable chips): native labels (`English/Español/Deutsch/Português/Русский/Français` — the web's `LANGUAGE_LABELS`, which are deliberately **never** localized), selected chip accent-tinted (the `SortChipStyle` idiom from `LibraryBrowseView`). Selecting: optimistic local flip → `updateProfile(id: activeProfile.id, language:)` → `model.profileLanguageChanged(code)` — revert on throw. The PATCH triggers `ensureMetadataLanguage` server-side (catalog re-localization); **UI-string flipping arrives in Task 5** (annotate the bridge: until then the choice persists + re-localizes the catalog but the chrome stays English).
  3. **Switch Profile** (web `nav:switchProfile`): ghost `OrbixButton` → `model.switchProfile()` (→ the picker, which now has the PIN pad — the Account switch path gets PIN entry for free through Task 2's single integration point).
  4. **My Menu** (web `ProfileMenuEditor.tsx`, TV-adapted): intro line (`account:menu.intro`), a list of every library row — a focusable **toggle** (checkbox adaptation: `Image(systemName: enabled ? "checkmark.square.fill" : "square")` + name, Select flips) and **↑/↓ reorder buttons** (disabled at the ends, exactly the web's `aria-label`ed buttons) — then Save (disabled while saving or when none enabled) + "Select at least one category." / "Saved." status line.
  5. **Server** (TV-only block, spec §7.11): server URL (`model.baseURL?.absoluteString`) + app version (`CFBundleShortVersionString (CFBundleVersion)` from `Bundle.main`).
  6. **Unlink Device** (TV-only, spec §7.11): danger-styled `OrbixButton` → `.alert("Unlink this device?", …)` with a destructive Unlink + Cancel; confirm → `Task { await model.unlinkDevice() }`.

**`AppModel` additions (the traced teardown paths — complete):**

```swift
/// Account "Switch Profile": back to the picker. The token and client stay;
/// the shell data is cleared so the bar never renders a stale avatar/menu
/// while picking. Re-entry runs the normal profileSelected() → loadShellData().
func switchProfile() {
    activeProfile = nil
    menuItems = []
    phase = .needsProfile
}

/// Account "Unlink Device": clears the persisted device token and resets to
/// pairing — the same teardown the 401 path in checkActiveProfile performs
/// (store.clear() → token = nil → .needsPairing), plus shell-data reset and
/// detaching the token from the live client. Client-side only by design
/// (spec §7.11 "clear token → onboarding"): the server-side revoke lives on
/// the web admin Devices page, so the token itself remains valid server-side.
func unlinkDevice() async {
    await tokenStore.clear()
    if let client { await client.setToken(nil) }
    token = nil
    activeProfile = nil
    menuItems = []
    phase = .needsPairing
}

/// Account menu editor saved: PUT /me/menu already returned the fresh items —
/// apply them directly (the TV's analogue of the web's ["menu"] query invalidation).
func applyMenu(_ items: [MenuItem]) {
    menuItems = items
}

/// Account language switch: mirror the PATCHed language onto the local
/// activeProfile (so the switcher + Task 5's uiLanguage recompute read the
/// new value) and refresh the shell nav. Task 5 extends this with applyUILanguage().
func profileLanguageChanged(_ language: String) {
    if var me = activeProfile { me.language = language; activeProfile = me }
    Task { await loadShellData() }
}
```

**`AccountModel` menu-editor core (complete logic):**

```swift
@MainActor @Observable
final class AccountModel {
    private(set) var config: MenuConfig?
    private(set) var order: [String] = []
    private(set) var enabled: Set<String> = []
    private(set) var isSavingMenu = false
    private(set) var menuSaved = false
    private(set) var menuError: String?
    private(set) var languageError: String?

    var noneEnabled: Bool { enabled.isEmpty }

    /// Seed exactly like the web (ProfileMenuEditor.tsx:19-25): enabled ids
    /// first in saved order, then the rest in default (library) order.
    func loadMenuConfig(client: OrbixClient) async {
        guard config == nil else { return }
        do {
            let cfg = try await client.menuConfig()
            config = cfg
            let rest = cfg.libraries.map(\.libraryId).filter { !cfg.enabled.contains($0) }
            order = cfg.enabled + rest
            enabled = Set(cfg.enabled)
        } catch { menuError = "Couldn't load menu settings." }
    }

    func toggle(_ id: String) {
        if enabled.contains(id) { enabled.remove(id) } else { enabled.insert(id) }
        menuSaved = false
    }

    func move(_ index: Int, _ dir: Int) {
        order = menuMoveItem(order, index: index, dir: dir)
        menuSaved = false
    }

    func saveMenu(client: OrbixClient, appModel: AppModel) async {
        let libraryIds = order.filter(enabled.contains)
        guard !libraryIds.isEmpty, !isSavingMenu else { return } // ≥1 enforced (server 400s "empty" too)
        isSavingMenu = true
        menuError = nil
        do {
            let items = try await client.saveMenu(libraryIds: libraryIds)
            appModel.applyMenu(items)
            menuSaved = true
        } catch { menuError = "Couldn't save the menu. Try again." }
        isSavingMenu = false
    }
}
```

- [ ] **Step 1: Read the web sources** — `apps/web/src/pages/account/{AccountLayout,AccountOverview}.tsx`, `components/account/ProfileMenuEditor.tsx`, `components/LanguageSwitcher.tsx`, `apps/web/src/lib/i18n/languages.ts`, and `apps/web/src/locales/en/{account,nav,common}.json` for the exact copy. Re-read `LibraryBrowseView.swift` (chip style), `ShellView.swift` (`.account` case + Menu-walk doc), `AppModel.swift` (the 401 teardown to mirror).

- [ ] **Step 2: Implement `AccountModel`** (above, plus the language-switch call: optimistic flip via `appModel.profileLanguageChanged` after a successful `updateProfile`, revert + `languageError` on throw).

- [ ] **Step 3: Implement `AccountView`** — the six sections, `NavigationStack`-wrapped with `.onExitCommand`-based `onMenuExit` (the shell's established per-section pattern; Account pushes no routes, so a plain exit → `.home` is correct). `.accessibilityIdentifier`s: `accountView`, `accountLanguage_<code>`, `accountSwitchProfile`, `accountMenuRow_<libraryId>`, `accountMenuUp_<id>`/`accountMenuDown_<id>`, `accountMenuSave`, `accountUnlink`, `accountUnlinkConfirm`.

- [ ] **Step 4: Add the `AppModel` methods** (above) and wire `ShellView`'s `.account` case to `AccountView(model: model, onMenuExit: { selection = .home })`; delete the `placeholder` helper (Account was its last consumer) and update the `ShellView` doc comment's `.account` paragraph (part of the Task-6 doc-drift sweep too — do the local edit here).

- [ ] **Step 5: Document the avatar decision** — extend `AvatarView.swift`'s doc comment: hue-hashed tile colors are a **deliberate TV adaptation kept by user decision (2026-07-06)** — richer than the web `Avatar`'s flat fallback, shared hash with `ChannelLogoView` so identity colors are stable across surfaces.

- [ ] **Step 6: Build gate** — `xcodegen generate` + app `build` SUCCEEDED.

- [ ] **Step 7: Authenticated smoke (vs NAS).** Launch with the env token; open **Account** from the top-bar avatar: profile card (hue avatar/name/kind), language chips (current language selected), menu editor lists the NAS libraries with the profile's current enabled set, server block shows the NAS URL + 0.1 (1), Unlink shows the confirm dialog (**Cancel it** — the real unlink flow is gated in Task 7). Toggle a library off → Save → the top bar's categories update live → toggle back on + reorder to the original → Save (round-trip restore). Capture `.superpowers/sdd/phase5-account.png`.

- [ ] **Step 8: Commit** — `git add clients/tvos/Sources/Orbix && git commit -m "feat(tvos): Account section — profile card, language switcher, menu editor, server info, unlink"`

---

### Task 4: i18n infrastructure — `L10n` + hand-authored `Localizable.xcstrings` (en) + full literal migration

**Files:**
- Create: `clients/tvos/Sources/Orbix/L10n.swift`
- Create: `clients/tvos/Resources/Localizable.xcstrings` (en values only in this task)
- Modify: `clients/tvos/project.yml` (add the catalog to the Orbix target), `clients/tvos/Resources/Info.plist` (add `CFBundleLocalizations` = the six codes)
- Modify (literal migration — the full inventory from `grep -rn 'Text("' clients/tvos/Sources/Orbix`, 21 files): `Design/{Badges,OnboardingChrome,RatingBadges}.swift`, `Home/HomeView.swift`, `Library/LibraryBrowseView.swift`, `Onboarding/{PairingView,ProfilePickerView,PinPadView}.swift`, `RootView.swift`, `Search/SearchView.swift`, `Shell/{OrbixTopBar,ShellView}.swift`, `Title/{SeasonEpisodeListView,TitleHeroView,TitlePage}.swift`, `TV/{ChannelCard,ChannelNowNextView,LiveTvOverlay,TvChannelView,TvGuideGridView,TvGuideView,TvHomeView}.swift`, `Wishlist/WishlistView.swift`, `Account/AccountView.swift`, plus model-owned strings (`ProfilePickerModel`, `PairingModel`, `AccountModel`, `LiveTvController` toasts)

**Mechanism (researched + specified — the load-bearing design):** String Catalogs compile at build time into per-language `.lproj/Localizable.strings` inside the app bundle, so runtime language override = resolving through the right **language bundle**, not the system-chosen main-bundle localization. UI re-render on language change = **`.id(model.uiLanguage)` on the shell root** (language changes are rare and the web reloads its queries anyway — a full view-tree rebuild is the honest, reliable tvOS-17 mechanism; no reliance on `\.locale`-driven `Text` re-resolution, which is preview-grade) plus `.environment(\.locale, L10n.locale)` for SwiftUI's own date/number formatting. Strings are resolved at render time through `L10n`:

```swift
/// Resolves UI strings against the active profile's language (spec §9), not
/// the system language. `override == nil` (onboarding, no profile yet) falls
/// through to Bundle.main — the system language with normal en fallback —
/// mirroring the web's detectInitialLanguage() → profile-override split.
enum L10n {
    /// "en"…"fr", or nil to follow the system. Written only from the main
    /// actor (AppModel.applyUILanguage, Task 5); views re-render via
    /// ShellView/RootView's `.id(uiLanguage)`, not observation of this static.
    nonisolated(unsafe) static var override: String?

    private static let missing = "\u{1}orbix.missing\u{1}"

    static func bundle(for code: String?) -> Bundle {
        guard let code,
              let path = Bundle.main.path(forResource: code, ofType: "lproj"),
              let bundle = Bundle(path: path) else { return .main }
        return bundle
    }
    private static let english = bundle(for: "en")

    /// Key lookup with an explicit en fallback: a language .lproj that lacks
    /// a key does NOT fall back across languages on its own — it would return
    /// the key. Missing everywhere → the key itself (visible in dev, never blank).
    static func t(_ key: String) -> String {
        let s = bundle(for: override).localizedString(forKey: key, value: missing, table: nil)
        if s != missing { return s }
        let en = english.localizedString(forKey: key, value: missing, table: nil)
        return en == missing ? key : en
    }

    /// Format-style lookup ("title.episodeNumber" = "Episode %lld").
    static func t(_ key: String, _ args: CVarArg...) -> String {
        String(format: t(key), locale: locale, arguments: args)
    }

    /// Plural-variation lookup: xcstrings plural variations compile to the
    /// stringsdict mechanism; String(format:locale:) applies the plural rule
    /// for the override language (e.g. ru one/few/many) at format time.
    static func plural(_ key: String, _ count: Int) -> String {
        String(format: t(key), locale: locale, count)
    }

    static var locale: Locale { override.map(Locale.init(identifier:)) ?? .current }

    /// Port of the web errorMessage (tError.ts): {error: code} → errors.<code>,
    /// unknown/missing code → errors.unknown — never a raw code on screen.
    static func errorMessage(_ code: String?) -> String {
        guard let code, !code.isEmpty else { return t("errors.unknown") }
        let msg = t("errors.\(code)")
        return msg == "errors.\(code)" ? t("errors.unknown") : msg
    }
}
```

**Catalog format (hand-authored JSON — `.xcstrings` is a documented, editable format; keys are manual, never Xcode-extracted, so mark every entry `"extractionState": "manual"` to survive any future IDE extraction pass):**

```json
{
  "sourceLanguage": "en",
  "version": "1.0",
  "strings": {
    "account.title": {
      "extractionState": "manual",
      "localizations": { "en": { "stringUnit": { "state": "translated", "value": "Account" } } }
    },
    "tv.guidePage.channelCount": {
      "extractionState": "manual",
      "localizations": { "en": { "variations": { "plural": {
        "one":   { "stringUnit": { "state": "translated", "value": "%lld channel" } },
        "other": { "stringUnit": { "state": "translated", "value": "%lld channels" } }
      } } } }
    }
  }
}
```

**Key inventory (keys mirror web `<ns>:<path>` → `<ns>.<path>`; port en values verbatim from `apps/web/src/locales/en/<ns>.json`):**

| Namespace | Screens (files) | Representative keys (not exhaustive — the migration step enumerates ALL literals via grep) |
|---|---|---|
| `common` | everywhere | `common.language`, `common.actions.{retry,cancel,save,close,confirm}`, `common.status.{loading,saving,empty}` |
| `nav` | OrbixTopBar, ShellView | `nav.{home,tv,search,wishlist,account,more,switchProfile}` |
| `catalog` | HomeView, LibraryBrowseView, TitleHeroView | `catalog.rows.{continue,hiddenGems,tonight}`, `catalog.browse.{title,searchPlaceholder,empty,sort.title,sort.added,sort.year}`, `catalog.hero.{play,moreInfo}`, `catalog.spotlight.new`, `catalog.home.{emptyTitle,emptyBody,errorTitle,errorBody}` |
| `search` | SearchView | `search.{title,placeholder,landing,empty,emptyHint,searching}`, `search.mode.{semantic,keyword}`, `search.results` (plural) |
| `title` | TitlePage, TitleHeroView, SeasonEpisodeListView | `title.{play,noMedia,notInLibrary,noEpisodes,episodesHeading,episodeNumber,specials,seasonNumber,runtime.m,runtime.hm}` |
| `wishlist` | WishlistView | `wishlist.{heading,empty,emptyHint}` |
| `player` | PlayerViewController menus | `player.controls.quality`, `player.audio.{standard,leveling}`, `player.quality.auto`, `player.error.*` |
| `tv` | TV/* | `tv.{title,guide}`, `tv.rails.{recents,favorites}`, `tv.empty.{title,memberBody}`, `tv.badges.offline`, `tv.categories.*` (the full category map — replaces Phase 4's capitalize-the-id), `tv.card.{favorite,unfavorite}`, `tv.guidePage.{title,viewList,viewGrid,searchPlaceholder,all,favorites,empty,noEpg,next,channelCount(plural)}`, `tv.grid.{now,prev,next,today,tomorrow,showingOf}`, `tv.channel.{number,watch,schedule,today,tomorrow,onNow,noSchedule,notFound}`, `tv.player.{loading,offline,nextChannel,reconnecting,tryingSource,source,miniGuide}` |
| `profiles` | ProfilePickerView, PinPadView | `profiles.{title,addProfile,emptyHint}`, `profiles.form.{title,nameLabel,namePlaceholder}`, `profiles.language.{label,help}`, `profiles.errors.{loadFailed,selectFailed}`; **TV-only:** `profiles.pin.{title,wrong,failed}` |
| `account` | AccountView | `account.title`, `account.profileKind.{standard,kids}`, `account.menu.{intro,save,saved,selectOne,moveUp,moveDown}`; **TV-only:** `account.server.{heading,url,version}`, `account.unlink.{button,confirmTitle,confirmBody}` |
| `errors` | `L10n.errorMessage` | `errors.{unknown,network,pin_required,not_found,no_active_profile,not_allowed_for_kids,blocked_by_rating,invalid_profile,…}` (the full web `errors.json`) |
| TV-only (no web ns) | PairingView, RootView server select | `pairing.*`, `server.*` — web-consistent naming, keep grouped |

**ON-NOW special case:** web `tv:channel.onNow` = "On now" but Phase 4 shipped the uppercase "ON NOW" badge treatment — keep the value "On now" and let the badge apply `.uppercase` styling, exactly like the web's CSS.

- [ ] **Step 1: Read** `apps/web/src/lib/i18n/{index.ts,languages.ts,tError.ts,useActiveLanguage.ts}` and `apps/web/src/locales/en/*.json` in full. Inventory every literal: `grep -rn 'Text("\|placeholder:\|Label("\|ContentUnavailableView' clients/tvos/Sources/Orbix` plus model-owned message strings (`grep -rn '= "' Sources/Orbix/**/*Model*.swift`).

- [ ] **Step 2: Implement `L10n.swift`** (above) and author `Localizable.xcstrings` with **every** key, en values only — web values verbatim where the string matches (the phases used exact web copy, so most map 1:1), TV-only strings keeping their current shipped copy.

- [ ] **Step 3: Wire the project** — `project.yml`: add `- path: Resources/Localizable.xcstrings, buildPhase: resources` to the Orbix target's sources; `Info.plist`: `CFBundleLocalizations` array `[en, es, de, pt, ru, fr]`. `xcodegen generate`.

- [ ] **Step 4: Migrate every literal** to `L10n.t("<key>")` / `L10n.t(key, args)` / `L10n.plural(key, count)`. Formatted strings become format keys (`"Episode %lld"`, `"Source %lld/%lld"`, `"%lldh %lldm"`). Keep `accessibilityIdentifier`s untouched. `LiveTvController`'s toasts and every model's error strings go through `L10n` (`errorMessage` where an API code exists — surfacing `OrbixError.http(_, code:)` from Task 1 instead of `"\(error)"` interpolations, e.g. `profiles.errors.selectFailed`).

- [ ] **Step 5: Build gate + catalog verification** — `xcodegen generate`; app `build` SUCCEEDED; then verify the catalog actually compiled: `find ~/Library/Developer/Xcode/DerivedData -path '*Orbix.app*' -name 'Localizable.strings' | head` shows `en.lproj/Localizable.strings` (only en exists yet). If the `.lproj` is missing, fix the `project.yml` resource entry before proceeding — this is the pipeline proof this task exists to deliver.

- [ ] **Step 6: Authenticated smoke (vs NAS)** — launch; walk Home/Library/Search/Wishlist/TV/Title/Account: every string renders exactly as before (en values verbatim ⇒ zero visual diff). Any visible raw key = a missed/mistyped catalog entry — fix before commit.

- [ ] **Step 7: Commit** — `git add clients/tvos && git commit -m "feat(tvos): i18n infrastructure — L10n bundle override + String Catalog (en) + full literal migration"`

---

### Task 5: i18n — the five translations + UI-language-follows-profile wiring

**Files:**
- Modify: `clients/tvos/Resources/Localizable.xcstrings` (add es/de/pt/ru/fr to every key)
- Modify: `clients/tvos/Sources/Orbix/AppModel.swift` (`uiLanguage` + `applyUILanguage()`)
- Modify: `clients/tvos/Sources/Orbix/RootView.swift` (`.id`/locale environment), `clients/tvos/Sources/Orbix/Account/AccountView.swift` (language switch now flips the UI)
- Modify (locale plumbing): `clients/tvos/Sources/Orbix/TV/{TvChannelView,TvGuideGridView,TvHomeView,TvGuideView}.swift` (`DateFormatter.locale = L10n.locale`; `tvRegionName(code, locale: L10n.locale)`)

**Interfaces (the wiring — complete):**

```swift
// AppModel:
/// The resolved UI language, recomputed from the active profile (spec §9:
/// profile language overrides; system fallback). Drives RootView's `.id`
/// (full re-render on change) and L10n.override (string resolution).
private(set) var uiLanguage: String = "en"

private static let supportedLanguages = ["en", "es", "de", "pt", "ru", "fr"]

private func applyUILanguage() {
    if let code = activeProfile?.language, Self.supportedLanguages.contains(code) {
        L10n.override = code
        uiLanguage = code
    } else {
        // No profile / unsupported value → follow the system (web
        // detectInitialLanguage parity); uiLanguage still tracks the resolved
        // 2-letter code so `.id` changes if the effective language does.
        L10n.override = nil
        let sys = Locale.current.language.languageCode?.identifier ?? "en"
        uiLanguage = Self.supportedLanguages.contains(sys) ? sys : "en"
    }
}
```

`applyUILanguage()` is called after **every** `activeProfile` write: `checkActiveProfile`'s success path, `loadShellData`'s `meProfile` fetch, `profileLanguageChanged` (before `loadShellData`), `switchProfile()`, and `unlinkDevice()`. `RootView` wraps its phase `switch` in a container with `.id(model.uiLanguage)` and `.environment(\.locale, L10n.locale)` — the rebuild re-runs every visible screen's `.task` loaders, which is exactly what re-fetches the now-re-localized catalog (`meProfile`-language-driven server-side), the TV analogue of the web's query refetch on `useSyncProfileLanguage`.

**Translation port:** for every catalog key with a web counterpart, copy the es/de/pt/ru/fr values **verbatim** from `apps/web/src/locales/<lng>/<ns>.json` (including their plural variants — note ru uses `_one/_few/_many` in i18next; map to xcstrings plural categories `one/few/many/other`). TV-only keys (`profiles.pin.*`, `account.server.*`, `account.unlink.*`, `pairing.*`, `server.*`, the ~6 TV-only strings from earlier phases) get carefully written translations in the same register as the surrounding web copy — flag them with a `"comment"` field naming them TV-only so the Phase-6 audit can review them as a set.

- [ ] **Step 1: Port the five languages** into `Localizable.xcstrings` (script-assisted comparison is fine — e.g. `python3` reading the web JSONs and the xcstrings to report key coverage — but the catalog file itself is the artifact). Every key must have all six languages (mirror the web's own `parity.test.ts` stance).

- [ ] **Step 2: Wire `applyUILanguage`** (above) + `RootView` `.id`/locale + `AccountView`: the language chip handler already PATCHes + calls `profileLanguageChanged` — no change needed beyond confirming the rebuild path (the Account screen itself re-renders in the new language after `.id` changes).

- [ ] **Step 3: Locale plumbing** — every `DateFormatter` in TV views sets `locale = L10n.locale` at use (not in a cached `static let` that would outlive a language change — the `.id` rebuild recreates views, so per-view formatters are safe; audit the `static` ones in `TvGuideGridView`/`TvChannelView` and make them instance/computed or explicitly re-localed); `tvRegionName` call sites pass `L10n.locale`. Times/numbers keep `.monospacedDigit()`.

- [ ] **Step 4: Build gate + catalog verification** — build SUCCEEDED; the built app now contains all six `.lproj/Localizable.strings`.

- [ ] **Step 5: Authenticated live smoke (vs NAS) — the language-switch flow.** Launch with the env token. Record the active profile's current language first (`GET /api/profiles` via curl with the bearer env var — never echo the token). In **Account → Language → Русский**: the PATCH lands, the whole UI rebuilds in Russian (top bar, Account, Home row headings like "Продолжить просмотр" per the web's ru `catalog.json`), and the catalog re-fetch carries the ru profile language (server-side re-localization; metadata may translate progressively as `ensureMetadataLanguage` caches — note, don't block on it). Region names in TV render via ru locale. Switch back to **English** → UI flips back. **Restore the profile's original language** (verify via `GET /api/profiles`). Capture `.superpowers/sdd/phase5-account-ru.png` + `.superpowers/sdd/phase5-home-ru.png`.

- [ ] **Step 6: Commit** — `git add clients/tvos && git commit -m "feat(tvos): six-language catalog + UI language follows active profile"`

---

### Task 6: Polish batch (Phase 3/4 ledger)

**Files:**
- Modify: `clients/tvos/Sources/Orbix/Title/SeasonEpisodeListView.swift` (episode label + failed-still placeholder)
- Modify: `clients/tvos/Sources/Orbix/Title/TitleHeroView.swift` (no-media Play icon)
- Modify: `clients/tvos/Sources/Orbix/Player/PlayerViewController.swift:306` (leveling glyph)
- Create: `clients/tvos/Sources/Orbix/Shell/SectionScrollDetector.swift` (extracted from `HomeView.swift`)
- Modify: `clients/tvos/Sources/Orbix/Home/HomeView.swift`, `Library/LibraryBrowseView.swift`, `Wishlist/WishlistView.swift`, `Shell/ShellView.swift` (isScrolled threading)
- Modify: `clients/tvos/Sources/Orbix/TV/{ChannelNowNextView,TvChannelView,TvGuideGridView}.swift` (ISO parser consolidation — delete the private copies, call `orbixParseISODate`)
- Modify (doc-drift sweep): the ~7 stale references located by grep (known from the ledger: the castCard doc citing the deleted `seasonChip`; the wishlist doc saying `createdAt` vs actual `addedAt`; the `.task`-refires-on-pop comment overclaim; the Phase-4 report's a11y-id placement note; plus whatever `grep -rn "seasonChip\|createdAt" clients/tvos/Sources` and a read-through of flagged files surface)

**The seams (verified against current source):**
1. **Untitled-episode label parity** — `SeasonEpisodeListView.episodeLabel` (line 344) returns `"Episode 3"` for untitled episodes; web (`SeasonEpisodeList.tsx:132,174`) computes `title = ep.title ?? t("title:episodeNumber")` then always renders `"{n}. {title}"` → **"3. Episode 3"**. Fix:

```swift
/// Web parity (SeasonEpisodeList.tsx:174): ALWAYS "N. Title", where an
/// untitled episode's title falls back to the localized "Episode N" —
/// so an untitled E3 reads "3. Episode 3", exactly like the web.
private func episodeLabel(_ episode: Episode) -> String {
    "\(episode.episodeNumber). \(episodeDisplayTitle(episode))"
}
```
2. **Failed-still → number placeholder** — web shows the big episode number plate when there's no still (`:157`); tvOS currently shows the plate only for `stillPath == nil` and a blank surface on a **failed** load. Track the load failure in the episode card's art view (the `ImageLoader` `.task(id:)` result) and render the same number plate on failure.
3. **Leveling glyph** — `speaker.wave.2` collides with AVKit's own audio-track glyph (ledger minor). Use `waveform` (present in SF Symbols on tvOS 17; verify it renders in the transport menu — if it doesn't, keep `speaker.wave.2` and record the deviation).
4. **"No media" Play icon** — `TitleHeroView` (line ~171): when `!canPlay`, drop the play glyph and render the label only (web renders the disabled button as bare `t("title:noMedia")` text — re-read `TitlePage.tsx`'s disabled-button branch to confirm before editing).
5. **Bar re-solidifies on Library/Wishlist scroll** — extract `HomeScrollDetector` + the coordinate-space offset reader from `HomeView.swift` into `SectionScrollDetector.swift` (same tvOS-17/18 dual path), thread `isScrolled: Binding<Bool>` into `LibraryBrowseView` and `WishlistView` exactly as `HomeView`, and change `ShellView`'s `.onChange(of: selection)` to reset `isScrolled = false` on **every** section switch (each section owns fresh scroll state). `.search` keeps no bar; `.tv`/`.account` roots don't scroll under the bar today — leave them, note it.
6. **ISO parser consolidation** — delete `ChannelNowNextView`'s and `TvChannelView`'s private formatter pairs and `TvGuideGridView`'s ad-hoc `ISO8601DateFormatter()` uses; all call `orbixParseISODate` (Task 1). Preview-only `ISO8601DateFormatter().string(from:)` **encoders** may stay (they serialize, not parse).
7. **Doc-symbol drift sweep** — fix the ~7 stale doc references (list above); each fix is a comment-only diff.
8. **Kids/edge-states pass** — a read-through + fix pass over every section's loading/empty/error states against their web counterparts (Home empty/error, Library empty, Search error, Wishlist empty hint, TV member-empty, guide empty, channel `notFound`), now all localized; verify the kids gating points still hold in code (`OrbixTopBar.isKids` hides TV; server 403s carry `not_allowed_for_kids` → `L10n.errorMessage`). Live kids verification happens in the gate.

- [ ] **Step 1:** Fix items 1-4 (each is a small, isolated diff; re-read the named web lines first).
- [ ] **Step 2:** Item 5 — extract the detector, thread the bindings, adjust the `ShellView` doc comment (it currently claims "Only Home scrolls its content under the bar").
- [ ] **Step 3:** Items 6-7 — consolidation + doc sweep (`grep` verification: `grep -rn "isoFractional\|isoPlain" clients/tvos/Sources/Orbix` returns nothing).
- [ ] **Step 4:** Item 8 — the states pass; fix anything found, record anything deferred.
- [ ] **Step 5: Gates** — `xcodegen generate`; app `build` SUCCEEDED; `OrbixKitTests` green.
- [ ] **Step 6: Authenticated smoke (vs NAS)** — Title page of a series with untitled episodes (label "3. Episode 3"), a failed still shows the number plate, Library + Wishlist scrolling re-solidifies the bar, player menu shows the new leveling glyph. Capture `.superpowers/sdd/phase5-polish-episodes.png`.
- [ ] **Step 7: Commit** — `git add clients/tvos && git commit -m "polish(tvos): episode-label/still parity, leveling glyph, no-media icon, bar solidify on Library/Wishlist, ISO parser consolidation, doc sweep"`

---

### Task 7: Phase 5 gate — full gates, live smokes vs NAS (language / menu / PIN / kids / unlink), parity screenshots + deviations

**Files:** none (verification + record only). If a defect surfaces, fix it in the owning task's files and re-run that task's gate first.

- [ ] **Step 1: Full gates** — `cd clients/tvos && xcodegen generate`; app `build` SUCCEEDED; `OrbixKitTests` all green. No server change → no `pnpm` gates (confirm `git status` shows no `apps/api/**` edits).

- [ ] **Step 2: Record the pre-smoke server state (vs NAS).** `set -a; source .superpowers/sdd/dev-device-token.env; set +a`. Via curl with `-H "Authorization: Bearer $ORBIX_TEST_TOKEN"` (never echoed): `GET /api/profiles` → record each profile's `id`/`language`; `GET /api/me/profile` → record the device's active profile id (the restore target). Note: the NAS responds with the **main** wire (`hasPin`/`isGroup`/`members` present) — this is expected and exactly what the Task-1 DTO fixtures cover.

- [ ] **Step 3: Throwaway profiles (never the real ones).** Create via curl: `POST /api/profiles` `{"name":"Phase5 Smoke","kind":"standard","language":"en","pin":"2468"}` (PIN accepted on both wires — branch `profiles.ts:25`, main `:181`) and `{"name":"Phase5 Kids","kind":"kids","maturityCap":9,"language":"en"}`. **Never target Nikita's profile in any PIN flow, even with a wrong PIN.**

- [ ] **Step 4: PIN-pad flow (sim, vs NAS).** Launch the app with the env token. Account → **Switch Profile** → the picker shows the throwaway with the lock badge (NAS sends `hasPin:true`) → select it → the **PIN pad** appears (403 `pin_required`) → enter `1111` → "Wrong PIN. Try again." + dots clear → enter `2468` → enters the shell as "Phase5 Smoke". Capture `.superpowers/sdd/phase5-pinpad-live.png`. Also verify Cancel returns to the grid without selecting.

- [ ] **Step 5: Language-switch + menu round-trip on the throwaway** (keeps real profiles untouched; Task 5's smoke already exercised the real profile with restore). Account → Русский → full UI flips + catalog re-fetch; back to English. Menu editor: disable all but one library + reorder → Save → top bar updates → verify `GET /api/me/menu` via curl reflects it → restore all libraries → Save.

- [ ] **Step 6: Kids smoke.** Switch to "Phase5 Kids" (no PIN): the top bar hides **TV**, catalog is server-filtered, Account shows "Kids profile" and no admin anything (there are no admin surfaces at all — confirm nothing over-renders). Capture `.superpowers/sdd/phase5-kids-home.png`.

- [ ] **Step 7: Unlink-device flow — safe to run for real.** Traced guarantee: `unlinkDevice()` is client-side only (Keychain clear + phase reset; the device token is **not** revoked server-side), and the simulator re-auths from the launch-arg env token on next launch — so the session's pairing survives. In Account (as any throwaway profile): **Unlink Device** → confirm dialog → confirm → app lands on the pairing screen (phase `.needsPairing`). Relaunch with `-orbixBaseURL "$ORBIX_TEST_BASE_URL" -orbixToken "$ORBIX_TEST_TOKEN"` → back in. Capture `.superpowers/sdd/phase5-unlink-confirm.png` (the dialog, pre-confirm).

- [ ] **Step 8: Restore + delete throwaways (mandatory).** Re-select the original profile recorded in Step 2 (via the sim picker, or `POST /api/profiles/:origId/select` with the bearer token) and verify `GET /api/me/profile` matches the Step-2 record. `DELETE /api/profiles/:id` for both throwaways; verify `GET /api/profiles` matches Step 2 exactly (ids, languages). Zero server-side state left dirty.

- [ ] **Step 9: Parity + deviations.** Side-by-side vs the web Account page (overview card, language switcher, menu editor) on the same profile. Record deviations in `.superpowers/sdd/progress.md` (expected ones: single-screen Account vs web tabs — by design; hue-hashed avatars — user-decided keep; PIN pad — TV-only adaptation, wire-compatible with both `profiles.ts` shapes; TV-only translation set flagged for Phase-6 review). **Add the Phase-6 reminder: `origin/main` has moved ahead (`hasPin`/`isGroup`/`members` on profiles) — Phase 6 merges `main` into `tv-ui` before the NAS deploy and re-runs the profile/PIN smokes on the merged wire.**

- [ ] **Step 10: Commit** — if `.superpowers/sdd/progress.md` changed: `git add .superpowers/sdd/progress.md && git commit -m "docs(tvos): phase 5 gate — account/i18n/PIN live record vs NAS"`.

---

## Self-review notes

- **Spec coverage:** §7.11 — profile card, language switcher (PATCH → `ensureMetadataLanguage` re-localization → UI flip), switch profile, menu editor (enable + reorder, ≥1 enforced client- and server-side), server info + unlink (Task 3); §9 — String Catalog ×6, keys mirror web namespaces, profile-language override with system fallback applied at select + change (`applyUILanguage` on every `activeProfile` write), `Locale` region names, `tError` port (Tasks 4-5); §11 row 5 — language + kids smokes (Task 7); §12's PIN deferral superseded by user decision — PIN pad ships (Task 2), verified against a throwaway PIN profile only (Task 7).
- **Wire-compat honesty:** the branch and `origin/main` disagree on the profiles read shape (`hasPin`/`isGroup`/`members` on main only); the PIN design depends only on the select handler's 403 — identical on both — and `hasPin` is a decode-safe optional driving a cosmetic badge. Both shapes are pinned in DTO fixtures. Phase 6 merges main before deploy (noted in the gate).
- **`OrbixError` change is compiler-enforced:** carrying `code` on the existing `.http` case (not a new case) breaks every `case .http(N)` match at compile time — all six sites are listed — so no status-handling path can silently miss the new shape.
- **i18n mechanism is the boring-reliable one:** language-bundle resolution (String Catalogs compile to `.lproj` at build) + explicit en fallback + `.id(uiLanguage)` full rebuild + `\.locale` for formatters — no reliance on `Text`/`\.locale` runtime re-resolution folklore; the rebuild also re-runs `.task` loaders, which is what re-fetches the re-localized catalog. Task 4 proves the pipeline with en-only (zero visual diff), Task 5 adds the translations — failures isolate cleanly.
- **Ordering rationale (kept T1→T7):** kit gaps first (everything consumes them); PIN before Account so Account's Switch-Profile path inherits the pad through the picker (one integration point); Account before i18n so the migration sweep (Task 4) covers its literals in the same pass; translations + wiring after the en pipeline is proven; polish isolated where nothing depends on it; gate last with all server-state restore steps mandatory.
- **Safety rails:** tokens only ever by env-var reference; no real PINs anywhere (throwaway `2468` profile, created + deleted in the gate, device's original active profile recorded first and restored); unlink verified for real only because it's provably client-side-only and the sim re-auths from launch args.
- **No placeholders in load-bearing code:** the PIN pad state machine (auto-submit, error-transition clear, re-entrancy guards), the `AppModel` teardown paths, the menu-editor seed/toggle/move/save logic, and the `L10n` resolver (bundle override, en fallback, format/plural, error mapping) are complete; view scaffolding follows the established `LibraryBrowseView`/`ProfilePickerView` idioms.
