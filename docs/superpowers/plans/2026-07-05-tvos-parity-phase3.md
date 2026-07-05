# tvOS Parity Rebuild — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the tvOS Title page to full web parity (cinematic hero + RatingBadges, meta line, 3-line overview, Play/Resume with the "No media" disabled state, optimistic wishlist toggle, season **tabs** + episode grid with per-episode progress and unowned states, cast rail, "More Like This", details, unmatched notice, and series first-owned-episode autoplay), and add the player **Quality / Audio-leveling** transport-bar menu with mid-playback re-negotiation. Exit gate: side-by-side vs web title page (movie + series) and a playback smoke against the NAS including a mid-playback quality switch.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-05-tvos-parity-rebuild-design.md` (§7.4 Title page, §8 Player upgrades, §10 testing, §11 phasing row 3). Builds on Phase 1's design system (`Sources/Orbix/Design/`) and Phase 2's Home/Library/Search/Wishlist + OrbixKit endpoints. New reusable art (`RatingBadges`, `TitleHeroView`, inline `SeasonEpisodeListView`) lives in the app target; new/extended DTOs + the `renegotiate` session logic extend OrbixKit/`Sources/Orbix/Player`. Web components under `apps/web/src/**` are the visual source of truth; server wire shapes are verified against `apps/api/src/routes/**`. **The production player plumbing (`PlaybackController` progress-report serialization + teardown, `PlayerViewController` observer lifecycle, resume seek, next-episode autoplay) is preserved and extended, not rewritten** — the quality switch reuses the existing resume-seek path.

**Tech Stack:** SwiftUI, tvOS 17, Swift 6, XcodeGen; XCTest (OrbixKitTests). **No server change in Phase 3** — verified: the item-detail handler (`apps/api/src/routes/catalog.ts:64-224`) already sends `imdbRating`/`imdbVotes`/`rtRating`/`metacritic`/`tmdbScore`/`rating`/`matchState`, and `apps/api/src/routes/playback.ts:255-279` already sends `quality`/`audioMode`/`qualities[]`/`audioModes[]`. The tvOS DTOs simply need to decode them.

## Global Constraints

- **Web is the visual source of truth.** Read the named `apps/web/src/**` component/page before writing each surface; mirror layout, art treatment, badges, states. Where a web behavior is mouse/hover-specific (`<select>`, hover play-overlay, `aria-pressed` toggle, chevron paddles), use the TV adaptation named in the task rather than inventing one.
- **DTOs mirror wire shapes verified against route handlers.** Every non-key field is `Optional` (decode-safe convention; a missing key and explicit `null` both decode to `nil`). Test fixtures in `DTOTests.swift` must be real wire shapes copied from the route handler, not invented.
- **Pure logic / DTOs that need tests go in OrbixKit** (`Sources/OrbixKit/`), tested in `Tests/OrbixKitTests/`. **TDD for all OrbixKit work: write the failing test first, run it to confirm failure, then implement.**
- **No server change is planned in Phase 3.** If any `apps/api/**` file is nonetheless touched, run repo gates **with lint separately** per CLAUDE.md: `pnpm typecheck && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api test` (Turbo cache can hide lint-only errors). No task here should need this.
- **Build/test gates (tvOS):** regenerate after file adds: `cd clients/tvos && xcodegen generate`; then
  `xcodebuild -project Orbix.xcodeproj -scheme Orbix -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' build CODE_SIGNING_ALLOWED=NO`
  and for kit changes `xcodebuild -project Orbix.xcodeproj -scheme OrbixKitTests -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' test CODE_SIGNING_ALLOWED=NO`.
  **Substitution note:** if that simulator name is unavailable, pick one from `xcrun simctl list devices available | grep "Apple TV"` and substitute it in `-destination`.
- **Swift 6 language mode:** new types crossing actor boundaries are `Sendable`; UI models are `@MainActor @Observable`. OrbixKit DTOs are `Codable, Sendable, Equatable`.
- **Token-only colors:** use `OrbixColor`/`OrbixRadius`/`OrbixSpacing`/`OrbixType`. No raw hex or ad-hoc `Color(red:…)` in view code (exception: the IMDb chip's brand yellow `#f5c518`, which the web hardcodes too — see Task 2).
- **No hardcoded server origins or tokens** in committed code (the existing launch-arg/env mechanism stays: `-orbixBaseURL`/`-orbixToken`, `ORBIX_BASE_URL`/`ORBIX_TOKEN`).
- **Authenticated simulator smokes** use the device-token env file at `.superpowers/sdd/dev-device-token.env` (keys `ORBIX_TEST_BASE_URL`, `ORBIX_TEST_TOKEN`). Load it into the shell (`set -a; source .superpowers/sdd/dev-device-token.env; set +a`) and pass `"$ORBIX_TEST_TOKEN"` by reference — **never print or echo the token**. (Simulator keychain does not persist; launch args are the only auth path there.)
- **English literals only** (i18n / String Catalogs are Phase 5). Use the exact web copy where it exists (e.g. `title:noMedia` → "No media", `title:notInLibrary` → "Not in library").
- **Commit after every task** (small commits on branch `tv-ui`; verify with `git branch --show-current`). Each commit must leave build + kit tests green.

---

### Task 1: OrbixKit — ItemDetail ratings + PlaybackInfo quality/audio ladder DTOs + request params (TDD)

**Files:**
- Modify: `clients/tvos/Sources/OrbixKit/DTOs.swift`
- Modify: `clients/tvos/Sources/OrbixKit/OrbixClient.swift`
- Test: `clients/tvos/Tests/OrbixKitTests/DTOTests.swift` (extend)

**Interfaces:**
- Consumes: existing `send`/`encodeBody` plumbing; decode-safe DTO conventions.
- Produces (OrbixKit):
  - `ItemDetail` gains `imdbRating: Double?`, `imdbVotes: Int?`, `rtRating: Int?`, `metacritic: Int?`, `tmdbScore: Double?` (all decode-safe Optional; update memberwise `init`).
  - New `public struct QualityOption: Codable, Sendable, Equatable { id: String; label: String; width: Int?; height: Int?; bandwidth: Int? }`.
  - New `public struct AudioModeOption: Codable, Sendable, Equatable { id: String; label: String }`.
  - `PlaybackInfo` gains `quality: String?`, `audioMode: String?`, `qualities: [QualityOption]?`, `audioModes: [AudioModeOption]?` (decode-safe; update `init`).
  - `PlaybackInfoRequest` gains `quality: String?`, `audioMode: String?` (encoded via `encodeIfPresent` → omitted when nil so the server applies its defaults).
  - `playbackInfo(fileId:capabilities:audioTrackIndex:quality:audioMode:)` — new optional `quality`/`audioMode` params, defaulted `nil` (existing callers unaffected).

**Verified wire shapes (copied from handlers):**
- `GET /items/:id` (`apps/api/src/routes/catalog.ts:182-224`) sends, alongside the already-modeled fields: `tmdbScore` (float|null), `imdbRating` (float|null), `imdbVotes` (int|null), `rtRating` (int|null), `metacritic` (int|null), `rating` (MPAA string|null, already modeled as `ItemDetail.rating`), `matchState` (string).
- `POST /playback/info` (`apps/api/src/routes/playback.ts:255-279`) response includes `quality: string` (the quality id, e.g. `"source"`), `audioMode: "standard"|"leveled"`, `qualities: [{id,label,width,height,bandwidth}]` (from `buildPlaybackQualities`, `packages/core/src/playback/quality.ts`; `width`/`height` nullable, `bandwidth` a number), `audioModes: [{id,label}]` (the `AUDIO_MODES` const: `standard`/`leveled`).

- [ ] **Step 1: Read the handlers** — `apps/api/src/routes/catalog.ts:64-224` (item detail response block), `apps/api/src/routes/playback.ts:78-280` (the `/playback/info` response), `packages/core/src/playback/quality.ts` (`buildPlaybackQualities` label/width/height/bandwidth), and `apps/web/src/lib/types.ts:102-164` (`Ratings`/`TitleDetail`) + `apps/web/src/components/Player.tsx:52-63,143-158` (the web `PlaybackInfo` shape + `negotiate` body). Confirm the field names/types above.

- [ ] **Step 2: Write failing DTO decode/encode tests** in `DTOTests.swift` (follow the file's fixture style). Real fixtures:

```swift
// MARK: - ItemDetail ratings (Phase 3 Task 1)

func testDecodeItemDetailRatingsNowModeled() throws {
    // apps/api/src/routes/catalog.ts:195-199 — ratings sent on every item.
    // (Same shape the existing movie fixture already carries; now decoded.)
    let json = """
    {"id":"m1","kind":"movie","title":"Arrival","rating":"PG-13",
     "tmdbScore":7.9,"imdbRating":7.9,"imdbVotes":700000,"rtRating":94,"metacritic":81,
     "matchState":"matched"}
    """.data(using: .utf8)!
    let d = try JSONDecoder().decode(ItemDetail.self, from: json)
    XCTAssertEqual(d.imdbRating, 7.9)
    XCTAssertEqual(d.tmdbScore, 7.9)
    XCTAssertEqual(d.imdbVotes, 700000)
    XCTAssertEqual(d.rtRating, 94)
    XCTAssertEqual(d.metacritic, 81)
    XCTAssertEqual(d.rating, "PG-13")
}

func testDecodeItemDetailRatingsAllNull() throws {
    // A movie missing every rating (catalog.ts sends explicit nulls) — must
    // decode to nil, not throw; matchState still present.
    let json = """
    {"id":"m2","kind":"movie","title":"Untitled Import",
     "tmdbScore":null,"imdbRating":null,"imdbVotes":null,"rtRating":null,"metacritic":null,
     "rating":null,"matchState":"unmatched"}
    """.data(using: .utf8)!
    let d = try JSONDecoder().decode(ItemDetail.self, from: json)
    XCTAssertNil(d.imdbRating)
    XCTAssertNil(d.rtRating)
    XCTAssertNil(d.metacritic)
    XCTAssertNil(d.rating)
    XCTAssertEqual(d.matchState, "unmatched")
}

// MARK: - PlaybackInfo quality/audio ladder (Phase 3 Task 1)

func testDecodePlaybackInfoQualityLadder() throws {
    // apps/api/src/routes/playback.ts:255-279 for a 2160p source: buildPlaybackQualities
    // (quality.ts) yields source + 1080p/720p/480p; AUDIO_MODES yields standard/leveled.
    let json = """
    {"playSessionId":"sess-1","mode":"transcode",
     "streamUrl":"/api/play/f1/master.m3u8?playSessionId=sess-1&token=orb_x",
     "container":"matroska,webm","videoCodec":"h264",
     "quality":"source","audioMode":"standard",
     "qualities":[
       {"id":"source","label":"Original (2160p)","width":3840,"height":2160,"bandwidth":24000000},
       {"id":"1080p","label":"1080p","width":1920,"height":1080,"bandwidth":5500000},
       {"id":"720p","label":"720p","width":1280,"height":720,"bandwidth":3000000},
       {"id":"480p","label":"480p","width":854,"height":480,"bandwidth":1600000}],
     "audioModes":[{"id":"standard","label":"Standard"},{"id":"leveled","label":"Leveling"}],
     "audioTracks":[{"index":0,"codec":"ac3","channels":6,"language":"en","selected":true}],
     "subtitleTracks":[]}
    """.data(using: .utf8)!
    let info = try JSONDecoder().decode(PlaybackInfo.self, from: json)
    XCTAssertEqual(info.quality, "source")
    XCTAssertEqual(info.audioMode, "standard")
    XCTAssertEqual(info.qualities?.map(\.id), ["source", "1080p", "720p", "480p"])
    XCTAssertEqual(info.qualities?.first?.label, "Original (2160p)")
    XCTAssertEqual(info.qualities?.last?.height, 480)
    XCTAssertEqual(info.audioModes?.map(\.id), ["standard", "leveled"])
}

func testDecodePlaybackInfoToleratesMissingQualityFields() throws {
    // A response with no quality ladder at all (older/other shape) must still
    // decode — every new field is Optional.
    let json = """
    {"playSessionId":"s2","mode":"direct","streamUrl":"/api/play/f2/direct",
     "container":null,"videoCodec":null,"audioTracks":[],"subtitleTracks":[]}
    """.data(using: .utf8)!
    let info = try JSONDecoder().decode(PlaybackInfo.self, from: json)
    XCTAssertNil(info.quality)
    XCTAssertNil(info.qualities)
    XCTAssertNil(info.audioMode)
    XCTAssertNil(info.audioModes)
}

func testEncodePlaybackInfoRequestOmitsQualityAudioWhenNil() throws {
    // nil quality/audioMode must NOT appear on the wire (server applies defaults).
    let plain = PlaybackInfoRequest(fileId: "f1", capabilities: .appleTV)
    let plainStr = String(data: try JSONEncoder().encode(plain), encoding: .utf8)!
    XCTAssertFalse(plainStr.contains("quality"))
    XCTAssertFalse(plainStr.contains("audioMode"))
    // Set values round-trip through the wire.
    let picked = PlaybackInfoRequest(fileId: "f1", capabilities: .appleTV, quality: "720p", audioMode: "leveled")
    let pickedStr = String(data: try JSONEncoder().encode(picked), encoding: .utf8)!
    XCTAssertTrue(pickedStr.contains("\"quality\":\"720p\""))
    XCTAssertTrue(pickedStr.contains("\"audioMode\":\"leveled\""))
}
```

- [ ] **Step 3: Run to verify failure** — `cd clients/tvos && xcodegen generate` then the `OrbixKitTests` `test` gate. Expected: FAIL (symbols/fields undefined; encode assertions fail).

- [ ] **Step 4: Implement DTOs** in `DTOs.swift`:
  - Add the five ratings properties to `ItemDetail` and its memberwise `init` (defaults `nil`), placed with the other rating-adjacent fields; extend the type doc comment to mention them.
  - Add `QualityOption` and `AudioModeOption` near `PlaybackInfo`.
  - Add `quality`/`audioMode`/`qualities`/`audioModes` to `PlaybackInfo` + its `init` (defaults `nil`).
  - Add `quality`/`audioMode` to `PlaybackInfoRequest` + its `init` (defaults `nil`).

```swift
public struct QualityOption: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var width: Int?
    public var height: Int?
    public var bandwidth: Int?
    public init(id: String, label: String, width: Int? = nil, height: Int? = nil, bandwidth: Int? = nil) {
        self.id = id; self.label = label; self.width = width; self.height = height; self.bandwidth = bandwidth
    }
}

public struct AudioModeOption: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public init(id: String, label: String) { self.id = id; self.label = label }
}
```

- [ ] **Step 5: Implement the client method** in `OrbixClient.swift` — extend `playbackInfo` with the two optional params (keep the existing default-nil signature working):

```swift
/// `POST /api/playback/info`. `quality`/`audioMode` are omitted from the wire
/// when nil (initial negotiation) so the server picks its defaults; the player's
/// Quality / Audio-leveling menu passes them to re-negotiate (see
/// `PlaybackController.renegotiate`).
public func playbackInfo(
    fileId: String,
    capabilities: Capabilities,
    audioTrackIndex: Int? = nil,
    quality: String? = nil,
    audioMode: String? = nil
) async throws -> PlaybackInfo {
    let body = PlaybackInfoRequest(
        fileId: fileId, capabilities: capabilities,
        audioTrackIndex: audioTrackIndex, quality: quality, audioMode: audioMode
    )
    let data = try encodeBody(body)
    return try await send(method: "POST", url: baseURL.appending(path: "api/playback/info"), body: data)
}
```

- [ ] **Step 6: Run tests — PASS.** `OrbixKitTests` green (new + all pre-existing decode tests, incl. `testDecodePlaybackInfoRemux`/`Direct` which still decode with the new Optionals `nil`).

- [ ] **Step 7: Gates** — `xcodegen generate`; app `build` SUCCEEDED (existing callers of `playbackInfo` compile via defaults); `OrbixKitTests` `test` passing.

- [ ] **Step 8: Commit** — `git add clients/tvos/Sources/OrbixKit clients/tvos/Tests/OrbixKitTests/DTOTests.swift && git commit -m "feat(orbixkit): ItemDetail ratings + PlaybackInfo quality/audio ladder DTOs"`

---

### Task 2: RatingBadges (Design/) + TitleHeroView (reusable cinematic hero)

**Files:**
- Create: `clients/tvos/Sources/Orbix/Design/RatingBadges.swift`
- Create: `clients/tvos/Sources/Orbix/Title/TitleHeroView.swift`

**Interfaces:**
- Consumes: `OrbixColor`/`OrbixRadius`/`OrbixType`, `NewBadge` (unused here), `TopBarScrim`/`LeftVignette`/`BottomScrim` (ScrimView.swift), `OrbixButtonStyle`, `ImageLoader` + `ItemDetail` (OrbixKit), the Task-1 rating fields, `formattedRuntime`.
- Produces:
  - `struct RatingBadges: View` — `imdbRating: Double?`, `rtRating: Int?`, `tmdbScore: Double?`, `metacritic: Int?`, `mpaa: String?`; renders only present chips, `EmptyView` when none (web `apps/web/src/components/RatingBadges.tsx`).
  - `struct TitleHeroView: View` — the full-bleed hero used by `TitlePage` for movie **and** series (web `apps/web/src/components/TitleHero.tsx`).

**Web→TV adaptations (explicit):**
- **RatingBadges** (web lines 29-61): IMDb chip = brand yellow `#f5c518` bg, **black** text, "IMDb" (small bold) + one-decimal rating (`String(format: "%.1f", imdbRating)`). RT chip = `OrbixColor.surface2` bg, tomato/splat emoji (`rtRating >= 60 ? "🍅" : "🤢"`) + `"\(rtRating)%"`. TMDB chip = `surface2` bg, "TMDB" tinted `OrbixColor.accent` + one-decimal score. Metacritic chip = `surface2` bg, "MC" + `"\(metacritic)"`. MPAA plate = bordered (`OrbixColor.textDim.opacity(0.4)` stroke), `OrbixColor.textDim` text, the `mpaa` string. Chip radius `OrbixRadius.chip`. **The `#f5c518` literal is allowed** (a brand color the web also hardcodes, not a design token) — annotate it.
- **TitleHeroView** (web lines 43-124): `ZStack(alignment: .bottomLeading)` — backdrop art (`ImageLoader`, `detail.backdropPath`; gradient plate fallback) → `TopBarScrim` (top) → `LeftVignette` + `BottomScrim` (bottom dissolve into `OrbixColor.bg`) → copy block. Copy: logo art (`detail.logoPath`, `.fit`, max ~800×220 leading) or `OrbixType.heroTitle` text; a **meta row** (`RatingBadges` + year + seasons·episodes/runtime + up to 3 genres, each genre as `"· \(g)"`, joined into one focus-friendly `HStack(spacing: 12)`, `OrbixColor.textMuted`); 3-line `overview` (`lineLimit(3)`); a **Play** button (`OrbixButtonStyle(.primary)`, `Label` with `play.fill`, label `resumeAvailable ? "Resume" : (canPlay ? "Play" : "No media")`, `.disabled(!canPlay)`) and, when `inWishlist != nil`, a **wishlist** ghost button (`OrbixButtonStyle(.ghost)`, `"✓ In Wishlist"` when true / `"+ Add to Wishlist"` when false).

```swift
struct TitleHeroView: View {
    let detail: ItemDetail
    let baseURL: URL?
    let imageLoader: ImageLoader
    let canPlay: Bool
    let resumeAvailable: Bool
    /// nil while wishlist membership is unknown (ids still loading / fetch failed)
    /// → the toggle is hidden, mirroring web's `inWishlist === undefined`.
    let inWishlist: Bool?
    var onPlay: () -> Void
    var onToggleWishlist: () -> Void
    // ...
}
```

- **Meta line** — helper `metaParts` mirrors web exactly:
  - year (`detail.year`),
  - series → `"\(seasonCount) season(s)"` + (episodeCount>0 ? `" · \(episodeCount) episode(s)"` : ""), where `seasonCount = detail.seasons?.count`, `episodeCount = detail.seasons?.reduce(0){ $0 + ($1.episodeCount ?? 0) }`; movie → `formattedRuntime(detail.runtimeSec)`,
  - genres: `detail.genres?.prefix(3)`, each rendered as its own `Text("· \(g)")`.
  Use **`" · "` (single space each side)** as the separator anywhere a join is used (the correct web separator — do not repeat the billboard's double-space bug; Task 3 fixes that instance).
- **Play button label:** English literals per web `title.json` — `"Play"`, `"Resume"` (tvOS resume-aware enhancement, movie only), `"No media"` (web `title:noMedia`, shown when `!canPlay`). Wishlist labels: `"In Wishlist"` / `"Add to Wishlist"` (web `title:inWishlist` / `title:addToWishlist`), prefixed with a plain `"✓ "` / `"+ "` glyph (web's `aria-hidden` marker).

- [ ] **Step 1: Read the web sources** — `apps/web/src/components/RatingBadges.tsx` and `apps/web/src/components/TitleHero.tsx` (+ `apps/web/src/locales/en/title.json` for exact copy). Re-read `clients/tvos/Sources/Orbix/Home/HomeBillboardView.swift` for the backdrop-loading + scrim-layering pattern to mirror, and `clients/tvos/Sources/Orbix/Design/ScrimView.swift`/`OrbixButton.swift` for the reusable pieces.

- [ ] **Step 2: Implement `RatingBadges.swift`** — a small `HStack(spacing: 8)` of chips gated on presence; `EmptyView` (via `if hasAny`) when nothing present. One-decimal formatter `String(format: "%.1f", value)`. Chips use `RoundedRectangle(cornerRadius: OrbixRadius.chip, style: .continuous)`. Add `.accessibilityIdentifier("ratingBadges")`. Include a `#Preview` exercising all five.

- [ ] **Step 3: Implement `TitleHeroView.swift`** — the `ZStack` described above, with private `HeroBackdrop`/`HeroLogo` image sub-views (port from `TitlePage`'s `BackdropImage`/`LogoImage` — Task 3 removes those from `TitlePage`). Meta row built from `metaParts` + inline `genres.prefix(3)` texts. Buttons wired to `onPlay`/`onToggleWishlist`. `.accessibilityIdentifier("titleHero_\(detail.id)")`, Play button `"titlePagePlayButton"` (preserve the existing id so any UI checks keep working), wishlist button `"titlePageWishlistButton"`. Add a `#Preview` with a sample movie `ItemDetail`.

- [ ] **Step 4: Build gate** — `xcodegen generate` + app `build`. BUILD SUCCEEDED (these are not yet wired into `TitlePage` — that's Task 3; they must compile standalone).

- [ ] **Step 5: Commit** — `git add clients/tvos/Sources/Orbix/Design/RatingBadges.swift clients/tvos/Sources/Orbix/Title/TitleHeroView.swift && git commit -m "feat(tvos): RatingBadges + reusable cinematic TitleHeroView (web parity)"`

---

### Task 3: TitlePage hero rebuild — movie path, wishlist toggle, cast/similar/details/unmatched, billboard separator fix

**Files:**
- Modify: `clients/tvos/Sources/Orbix/Title/TitlePage.swift`
- Modify: `clients/tvos/Sources/Orbix/Home/HomeBillboardView.swift` (one-line separator fix)

**Interfaces:**
- Consumes: `TitleHeroView`/`RatingBadges` (Task 2), `itemDetail`/`similar`/`getProgress`/`wishlistIds`/`addToWishlist`/`removeFromWishlist` (OrbixKit), `PosterCard` (More Like This), the preserved `PlaybackTarget`/`fullScreenCover`/`PlayerScreen` movie-playback plumbing, `TitleRoute`.
- Produces:
  - `TitleModel` gains wishlist membership + an optimistic toggle: `private(set) var inWishlist: Bool?` and `func toggleWishlist(client:) async`.
  - `TitlePage` renders `TitleHeroView` (replacing the inline hero), then a page body (unmatched notice → cast rail → "More Like This" → details), preserving the movie `fullScreenCover` player, `autoplayIfNeeded` (movie), and `refreshAfterPlayback`. **Series still uses the existing season strip in this task** (Task 4 replaces it with inline tabs + grid and retires `SeasonRoute`).

**Web→TV adaptations (explicit)** (web `apps/web/src/pages/TitlePage.tsx`):
- **Hero:** `TitleHeroView(detail:, canPlay:, resumeAvailable:, inWishlist:, onPlay:, onToggleWishlist:)`. `canPlay` = movie: `detail.files?.first != nil`; series: `(detail.seasons?.count ?? 0) > 0`. `resumeAvailable` = `titleModel.resumeAvailable` for a movie, `false` for a series. `onPlay` = movie: `presentPlayer(files.first)`; series: **temporary** — push the default-season `SeasonRoute` (existing plumbing) so the hero Play does something until Task 4 wires inline first-episode play. Annotate this as a Task-4 bridge.
- **Wishlist toggle (optimistic, web lines 34-37,111-113):** `TitleModel.load` also fetches `wishlistIds()` (best-effort) → `inWishlist = ids.map { $0.contains(itemId) }` (nil if the fetch throws → hero hides the toggle, matching web `undefined`). `toggleWishlist` flips `inWishlist` immediately, calls `add/removeFromWishlist`, and **reverts on error**:

```swift
func toggleWishlist(client: OrbixClient) async {
    guard let current = inWishlist else { return }   // unknown → nothing to toggle
    inWishlist = !current                            // optimistic flip (web aria-pressed)
    do {
        if current { try await client.removeFromWishlist(itemId: itemId) }
        else       { try await client.addToWishlist(itemId: itemId) }
    } catch {
        inWishlist = current                         // revert on failure
    }
}
```
  Wire the hero's `onToggleWishlist` to `Task { await titleModel.toggleWishlist(client: client) }`.
- **Unmatched notice (web lines 142-144):** when `detail.matchState != "matched" && detail.matchState != "manual"`, a yellow (`OrbixColor.warning`) line: `"Metadata not matched yet — scan with a TMDB token to enrich."` (web `title:unmatchedNotice`). **No fix-match control on TV.**
- **Cast rail (web lines 146-161):** when `detail.cast` non-empty, heading "Cast" + a horizontal `.focusSection()` rail of name+character cards (`OrbixColor.surface` plate, `OrbixColor.text` name / `OrbixColor.textDim` character, both `lineLimit(1)`).
- **More Like This (web line 165):** reuse the existing `moreLikeThisRail(similar)` (`PosterCard` rail) — keep as-is.
- **Details (web lines 167-179):** when present, a block with `"Director: \(name)"` and `"Genres: \(genres.joined(separator: ", "))"` (label in `OrbixColor.text`, value in `OrbixColor.textDim`).
- **Billboard separator fix:** in `HomeBillboardView.swift`, change `Text(parts.joined(separator: "  ·  "))` → `Text(parts.joined(separator: " · "))` (web `HomeBillboard.tsx:71` `meta.join(" · ")`).

- [ ] **Step 1: Read the web source** — `apps/web/src/pages/TitlePage.tsx` (hero props, wishlist toggle, unmatched notice, cast, similar, details ordering). Re-read the current `clients/tvos/Sources/Orbix/Title/TitlePage.swift` to preserve verbatim: `TitleRoute`, `body`'s `.fullScreenCover(item: $playbackTarget)`, `PlaybackTarget`, `presentPlayer`, `refreshAfterPlayback`, `autoplayIfNeeded` (movie), `TitleModel.load`'s detail/similar/resume logic, and `imageURL`.

- [ ] **Step 2: Extend `TitleModel`** — add `private(set) var inWishlist: Bool?`; in `load`, after `detail`/`similar`, `inWishlist = (try? await client.wishlistIds()).map { $0.contains(itemId) }`; add `toggleWishlist(client:)` (above). Reset `inWishlist = nil` at the top of `load` (fresh unknown state on reload).

- [ ] **Step 3: Rebuild `TitlePage.detailView`/`hero`** — replace the inline hero (`hero`/`titleOrLogo`/`metadataRow`/`metadataParts`/`overviewText`/`playButton` + the private `BackdropImage`/`LogoImage` structs, now living in `TitleHeroView`) with a single `TitleHeroView(...)`. Compute `canPlay`/`resumeAvailable` per kind; wire `onPlay`/`onToggleWishlist`. Keep `formattedRuntime` only if still used; otherwise remove. Add the unmatched notice, cast rail, and details block into the `detailView` `VStack` (order: hero → [series: season strip — unchanged this task] → unmatched notice → cast → More Like This → details). Preserve `.accessibilityIdentifier("titlePage_\(detail.id)")` and all playback-target plumbing.

- [ ] **Step 4: Fix the billboard separator** in `HomeBillboardView.swift` (`"  ·  "` → `" · "`).

- [ ] **Step 5: Build gate** — `xcodegen generate` + app `build`. BUILD SUCCEEDED.

- [ ] **Step 6: Authenticated smoke + screenshot** — boot the sim, build+install, then:
  `set -a; source .superpowers/sdd/dev-device-token.env; set +a`
  `BUNDLE_ID=$(xcodebuild -project clients/tvos/Orbix.xcodeproj -scheme Orbix -showBuildSettings 2>/dev/null | awk -F' = ' '/PRODUCT_BUNDLE_IDENTIFIER/{print $2; exit}')`
  `xcrun simctl launch booted "$BUNDLE_ID" -orbixBaseURL "$ORBIX_TEST_BASE_URL" -orbixToken "$ORBIX_TEST_TOKEN"` (token never echoed).
  Open a **movie** title page: confirm the cinematic hero (backdrop + scrims + logo/title), RatingBadges, meta line, 3-line overview, Play/Resume, cast rail, More Like This, details, and — if the NAS wishlist server fix is deployed — the wishlist toggle flips and persists (see the Task 6 stale-NAS note otherwise). Confirm a title with no file shows the disabled "No media" Play. Capture `xcrun simctl io booted screenshot .superpowers/sdd/phase3-title-movie.png`.

- [ ] **Step 7: Commit** — `git add clients/tvos/Sources/Orbix/Title/TitlePage.swift clients/tvos/Sources/Orbix/Home/HomeBillboardView.swift && git commit -m "feat(tvos): title page hero rebuild (ratings, wishlist toggle, cast/similar/details, unmatched); billboard separator fix"`

---

### Task 4: Season/episode parity — inline tabs + episode grid + series autoplay; retire SeasonRoute; PosterCard dead-bar cleanup

**Files:**
- Rework: `clients/tvos/Sources/Orbix/Title/SeasonEpisodeView.swift` → an inline `SeasonEpisodeListView` (drop the pushed-route form + `SeasonRoute`)
- Modify: `clients/tvos/Sources/Orbix/Title/TitlePage.swift` (embed the inline list for series; remove the season strip + `SeasonRoute` push; wire series autoplay)
- Modify: `clients/tvos/Sources/Orbix/Home/HomeView.swift`, `clients/tvos/Sources/Orbix/Search/SearchView.swift`, `clients/tvos/Sources/Orbix/Wishlist/WishlistView.swift`, `clients/tvos/Sources/Orbix/Library/LibraryBrowseView.swift` (remove the now-dead `.navigationDestination(for: SeasonRoute.self)` registrations)
- Modify: `clients/tvos/Sources/Orbix/Home/PosterCard.swift` (strip the legacy hardcoded-red `ResumeProgressBar`)

**Interfaces:**
- Consumes: `episodes(itemId:season:)` (OrbixKit), `ProgressBarView` (Design), `ImageLoader`, the preserved `EpisodePlaybackTarget`/`fullScreenCover`/end-of-item observer/`handlePlayerDismiss`/next-episode-autoplay/`SeasonEpisodeModel` plumbing, `ItemDetail.SeasonSummary`.
- Produces:
  - `struct SeasonEpisodeListView: View { let seriesId: String; let seasons: [ItemDetail.SeasonSummary]; let model: AppModel; let playFirstToken: Int }` — season **tabs** + episode grid, rendered **inline** on the title page (web `apps/web/src/components/SeasonEpisodeList.tsx`), carrying the full episode-playback + next-episode-autoplay machinery.
  - `TitlePage` gains `@State private var seriesPlayToken = 0`, embeds `SeasonEpisodeListView(...)` for a series, and bumps the token from the hero's series `onPlay` and from `autoplayIfNeeded` (series branch — the deferred-from-P2 first-owned-episode autoplay).

**Web→TV adaptations (explicit)** (web `SeasonEpisodeList.tsx`):
- **Season tabs (web `role=tablist`, lines 84-105):** a horizontal `.focusSection()` row of focusable chip buttons, one per season **sorted ascending**; the selected chip tinted `OrbixColor.accent` (bottom border/fill), others `OrbixColor.textDim`. **Default selection = first non-specials season** (`seasons.sorted{…}.first{ $0.seasonNumber > 0 } ?? first`). Label port (`seasonLabel`, lines 23-28): `seasonNumber == 0` → `name ?? "Specials"`; else `name` unless it matches `^season ` (case-insensitive) → `"Season \(n)"`.
- **Episode grid (web lines 107-187):** `LazyVGrid` of episode cards (reuse the Library/Search grid lockup). Each card: still art (`ep.stillPath`) or the big episode number when absent (web line 156); a per-episode **accent** progress bar via `ProgressBarView(fraction:)` pinned to the still's bottom when in progress (web `bg-[var(--accent)]` — **use `ProgressBarView`, not the old red `EpisodeResumeBar`**); `"\(episodeNumber). \(title)"` + runtime; unowned (`fileId == nil`) episodes are `.disabled` + dimmed with a `"Not in library"` italic line (web `title:notInLibrary`, lines 178-180). Progress fraction: `finished ? 1.0 : (dur > 0 ? pos/dur : 0)`, bar drawn only when `> 0`. Play affordance is **focus-driven** (focus-promote + a `play.fill` glyph on the focused card) rather than the web hover overlay.
- **Loading/empty (web lines 108-120):** skeleton grid while the selected season loads (never "No episodes" for a season that just hasn't loaded); `"No episodes found for this season."` (web `title:noEpisodes`) when truly empty.
- **Series first-episode autoplay (web `playFirstToken`/`handledToken`, lines 62-75):** when `playFirstToken > 0 && playFirstToken != handled && episodes present`, play the first owned (`fileId != nil`) episode of the selected season — driven by both a `playFirstToken` change **and** episodes finishing loading (web's `useEffect([playFirstToken, episodes])`).
- **Next-episode autoplay + player teardown:** port verbatim from the current `SeasonEpisodeView` — `EpisodePlaybackTarget`, the `.task(id: playbackTarget?.id)` end-of-item observer, `handlePlayerDismiss` (`reachedEnd` gating, `episode(after:)`), `presentPlayer`. **Do not alter the teardown/progress-serialization path.**

**PosterCard cleanup (verified dead):** `PosterCard`'s internal `ResumeProgressBar` fires only when `card.progress != nil`. The remaining `PosterCard` call sites — Library (`libraryItems`), Search (`search`), Wishlist (`wishlist`), and the title page's More Like This (`similar`) — all use the narrow `{id,title,year,posterPath,matchState}` shape with **no `progress`**, so the bar never draws. Home rails use `BoxArtCard`, not `PosterCard`. Remove the private `ResumeProgressBar` struct, the `resumeFraction` computed property, and the `if let resumeFraction` overlay from `PosterCard.artwork` (leaving just the poster art). Update `PosterCard`'s doc comment (drop the "resume-progress bar" clause) and drop the progress arg from its `#Preview`.

- [ ] **Step 1: Read the web source** — `apps/web/src/components/SeasonEpisodeList.tsx` (tabs `role=tablist`, default season, grid, `playFirstToken`, progress pct, unowned state). Re-read the current `clients/tvos/Sources/Orbix/Title/SeasonEpisodeView.swift` to lift its player plumbing verbatim, and confirm the four sections' `SeasonRoute` registrations (grep already done: Home:53-55, Search:69-71, Wishlist:78-80, Library:81-83).

- [ ] **Step 2: Rework the file into `SeasonEpisodeListView`** — remove `struct SeasonRoute` and the pushed-route view identity; keep `SeasonEpisodeModel`, `EpisodePlaybackTarget`, `EpisodeStillArtwork`. Add `@State private var selectedSeason: Int` (initialised to the default season), `@State private var handledPlayToken = 0`. Render tabs + grid (with `ProgressBarView`) + the preserved `fullScreenCover`/observer/`handlePlayerDismiss`. Load the selected season via `.task(id: selectedSeason)` and reset stale episodes on switch so the skeleton shows (extend `SeasonEpisodeModel.load` to clear `episodes`/`hasLoaded` when the season changes). Add `playFirstOwnedIfNeeded(token:)` called from the season-load completion and from `.onChange(of: playFirstToken)`. Keep the season heading/`seasonLabel` port and all `accessibilityIdentifier`s (`seasonEpisodeList_…`, `episodeRow_…`, and a new `seasonTab_\(n)`).

- [ ] **Step 3: Embed in `TitlePage`** — for a series, render `SeasonEpisodeListView(seriesId: itemId, seasons: detail.seasons ?? [], model: model, playFirstToken: seriesPlayToken)` in place of the old `seasonStrip`/`seasonChip`. Remove `seasonStrip`/`seasonChip`/`seasonLabel` and the `SeasonRoute` push. Add `@State private var seriesPlayToken = 0`; the hero's series `onPlay` (from Task 3's bridge) becomes `seriesPlayToken += 1`; extend `autoplayIfNeeded` with a **series** branch: `autoplay && !didAutoplay && detail.kind == "series" && (detail.seasons?.count ?? 0) > 0` → `didAutoplay = true; seriesPlayToken += 1` (the deferred-from-P2 behavior).

- [ ] **Step 4: Remove dead `SeasonRoute` registrations** — delete the `.navigationDestination(for: SeasonRoute.self) { … SeasonEpisodeView(…) }` block from `HomeView.swift`, `SearchView.swift`, `WishlistView.swift`, `LibraryBrowseView.swift`. Update the stale doc comments in those files (and `TitlePage.swift`/`HomeView.swift`) that reference `SeasonRoute` being carried on the path. The `path`/`NavigationPath` binding and the `TitleRoute` registration/threading are **unchanged** (the preserved contract).

- [ ] **Step 5: PosterCard dead-bar cleanup** — strip `ResumeProgressBar`/`resumeFraction`/the overlay from `PosterCard.swift` as described; fix the doc comment + `#Preview`.

- [ ] **Step 6: Build gate** — `xcodegen generate` + app `build`. BUILD SUCCEEDED (verify no dangling `SeasonRoute`/`SeasonEpisodeView`/`ResumeProgressBar` references remain: `grep -rn "SeasonRoute\|SeasonEpisodeView\|ResumeProgressBar" clients/tvos/Sources` returns nothing).

- [ ] **Step 7: Authenticated smoke + screenshots** — launch as in Task 3 Step 6. Open a **series** title page: confirm season tabs (default = first non-specials), the episode grid with stills/number + accent per-episode progress + "Not in library" on unowned episodes; selecting an owned episode plays it; on end-of-episode it auto-advances to the next owned episode; the hero **Play** starts the first owned episode of the selected season; and a billboard/deep-link `autoplay` on a series starts the first owned episode. Capture `.superpowers/sdd/phase3-title-series.png` and `.superpowers/sdd/phase3-episode-grid.png`.

- [ ] **Step 8: Commit** — `git add clients/tvos/Sources/Orbix/Title clients/tvos/Sources/Orbix/Home/HomeView.swift clients/tvos/Sources/Orbix/Home/PosterCard.swift clients/tvos/Sources/Orbix/Search/SearchView.swift clients/tvos/Sources/Orbix/Wishlist/WishlistView.swift clients/tvos/Sources/Orbix/Library/LibraryBrowseView.swift && git commit -m "feat(tvos): inline season tabs + episode grid, series autoplay; retire SeasonRoute; drop PosterCard legacy resume bar"`

---

### Task 5: Player Quality / Audio-leveling transport-bar menu + mid-playback re-negotiation

**Files:**
- Modify: `clients/tvos/Sources/Orbix/Player/PlaybackController.swift`
- Modify: `clients/tvos/Sources/Orbix/Player/PlayerViewController.swift`

**Interfaces:**
- Consumes: `playbackInfo(...quality:audioMode:)`, `stopPlayback` (Task 1 / existing), `QualityOption`/`AudioModeOption` (Task 1), `AVPlayerViewController.transportBarCustomMenuItems` (tvOS 15+; `import UIKit` for `UIMenu`/`UIAction`).
- Produces:
  - `PlaybackController` captures the ladder from `start()`'s `playbackInfo` and adds `renegotiate(quality:audioMode:positionSec:)` — captures the position (passed in from the Coordinator, which owns the player), fetches a fresh session, **stops the previous session**, and emits a new `.ready(streamURL:resumeSeconds:)` so the existing resume-seek path restores the position.
  - `PlayerViewController`/`Coordinator` builds the transport-bar menu (Quality submenu + Audio-leveling submenu) reflecting the current selection, each action reading the player's current time and calling `renegotiate`.

**Preserved invariants (read the doc comments in both files first):** `PlaybackController` **never touches `AVPlayer`** — the Coordinator supplies the captured position. The single-final-write progress chain (`reportChain`) is reused across the re-negotiation (same `PlaybackController` instance, same itemId/episodeId; only `playSessionId`/`loadState`/ladder change). Observer teardown for the replaced `AVPlayer` still runs via `Coordinator.attach`'s `detachObservers()` (called before attaching to the new player) and the guaranteed `dismantleUIViewController` → `teardown()` on screen dismissal. `teardown()` stops the **current** (latest) session; the previous session is already stopped by `renegotiate`.

**Web→TV adaptations (explicit)** (web `apps/web/src/components/Player.tsx:143-158,300-332,398-444`):
- **Re-negotiation flow** = web `renegotiate`: capture current time → fetch new `playbackInfo(quality, audioMode)` (a fresh `playSessionId`) → if the previous session id differs, `POST /playback/:prev/stop` → swap in the new stream/ladder → seek back to the captured time on the new session. tvOS realises the "key remount" as **rebuilding the `AVPlayer`** when `streamURL` changes; the captured time rides in `.ready`'s `resumeSeconds`, and `Coordinator.seekToResumeIfReady` performs the seek-then-play exactly as for a fresh resume.
- **Quality menu:** a `UIMenu(title: "Quality")` whose children are one `UIAction` per `qualities` entry (title = `label`, `.state = .on` for the current `quality`). Shown only when `qualities.count > 1` (a lone `source` has nothing to switch). Choosing a different id re-negotiates at the current audio mode (web `handleQualityChange`).
- **Audio-leveling menu:** shown only when `audioModes` contains `leveled` (web `audioLevelingAvailable`); a `UIMenu(title: "Audio")` with two `UIAction`s — "Standard" / "Audio leveling" (labels from `audioModes`, `.state` on the current `audioMode`) — re-negotiating at the current quality (web `handleAudioModeChange`). English literals per web `player.json` (`player:controls.quality` → "Quality"; `player:audio.leveling` → "Audio leveling"; `player:audio.standard` → "Standard").
- Native audio/subtitle **track** pickers stay untouched (in-manifest HLS renditions).

- [ ] **Step 1: Read the sources** — `apps/web/src/components/Player.tsx` (`negotiate`/`renegotiate`/`rememberPlaybackTime`/`handleQualityChange`/`handleAudioModeChange`, the `key={info.streamUrl}` remount, `handleCanPlay`'s `pendingSeekRef`). Re-read `clients/tvos/Sources/Orbix/Player/PlaybackController.swift` and `PlayerViewController.swift` end-to-end — preserve every documented invariant.

- [ ] **Step 2: Extend `PlaybackController`** — capture the ladder in `start()` and add `renegotiate`:

```swift
// New observable state (defaults so the menu is inert until start() fills it).
private(set) var quality: String = "source"
private(set) var audioMode: String = "standard"
private(set) var qualities: [QualityOption] = []
private(set) var audioModes: [AudioModeOption] = []

// In start(), right after `playSessionId = info.playSessionId`:
quality   = info.quality ?? "source"
audioMode = info.audioMode ?? "standard"
qualities = info.qualities ?? []
audioModes = info.audioModes ?? []

/// Web `renegotiate`: fetch a fresh session at the requested quality/audio mode,
/// stop the previous session (releases its ffmpeg), and re-emit `.ready` with the
/// captured position as the resume seek so playback resumes in place on the new
/// stream. `positionSec` is supplied by the Coordinator (this type never touches
/// AVPlayer). A failure is a no-op: the current session keeps playing rather than
/// tearing down a working stream (the menu selection reverts on the next update
/// because `quality`/`audioMode` are unchanged).
func renegotiate(quality newQuality: String, audioMode newMode: String, positionSec: Double) async {
    guard newQuality != quality || newMode != audioMode else { return }
    let previousSessionId = playSessionId
    do {
        let info = try await client.playbackInfo(
            fileId: fileId, capabilities: .appleTV, quality: newQuality, audioMode: newMode
        )
        guard let streamURL = URL(string: info.streamUrl, relativeTo: baseURL)?.absoluteURL else { return }
        if let previousSessionId, previousSessionId != info.playSessionId {
            await client.stopPlayback(playSessionId: previousSessionId)
        }
        playSessionId = info.playSessionId
        quality   = info.quality ?? newQuality
        audioMode = info.audioMode ?? newMode
        qualities = info.qualities ?? qualities
        audioModes = info.audioModes ?? audioModes
        loadState = .ready(streamURL: streamURL, resumeSeconds: max(0, positionSec))
    } catch {
        // no-op — keep the current session playing
    }
}
```

- [ ] **Step 3: Rebuild the AVPlayer on stream-URL change** in `PlayerScreen` (`PlayerViewController.swift`) — move the player construction so it re-runs when `streamURL` changes (initial load **and** re-negotiation), not only on the nil→url transition:

```swift
case .ready(let streamURL, let resumeSeconds):
    Group {
        if let player {
            PlayerViewController(
                player: player, playbackController: controller,
                resumeSeconds: resumeSeconds, videoTitle: title
            )
            .ignoresSafeArea()
            .onExitCommand { dismiss() }
        } else {
            Color.clear   // one-frame gap before the .task builds the player
        }
    }
    // Rebuild the AVPlayer whenever the negotiated stream URL changes — the
    // tvOS analogue of the web player's key={streamUrl} remount. On a quality/
    // audio switch this hands updateUIViewController a new player, which
    // detaches the old player's observers and attaches to the new one, then
    // seeks to `resumeSeconds` (the captured position).
    .task(id: streamURL) { player = AVPlayer(url: streamURL) }
```

- [ ] **Step 4: Build the transport-bar menu** in `PlayerViewController`/`Coordinator` — add `import UIKit`. Pass the ladder + selection into the representable as plain values read from the (observable) `playbackController` in `PlayerScreen.body`, so `updateUIViewController` re-runs on change; build the menu in the Coordinator (it owns `attachedPlayer` for position capture):

```swift
// PlayerViewController gains inputs (read in PlayerScreen.body from the controller,
// establishing observation so the menu updates on selection/ladder change):
let qualities: [QualityOption]
let audioModes: [AudioModeOption]
let selectedQuality: String
let selectedAudioMode: String

// makeUIViewController / updateUIViewController:
context.coordinator.updateTransportMenu(
    on: controller, qualities: qualities, audioModes: audioModes,
    selectedQuality: selectedQuality, selectedAudioMode: selectedAudioMode
)

// Coordinator:
func updateTransportMenu(
    on vc: AVPlayerViewController,
    qualities: [QualityOption], audioModes: [AudioModeOption],
    selectedQuality: String, selectedAudioMode: String
) {
    var items: [UIMenuElement] = []
    if qualities.count > 1 {
        let actions = qualities.map { q in
            UIAction(title: q.label, state: q.id == selectedQuality ? .on : .off) { [weak self] _ in
                self?.renegotiate(quality: q.id, audioMode: selectedAudioMode)
            }
        }
        items.append(UIMenu(title: "Quality", children: actions))
    }
    if audioModes.contains(where: { $0.id == "leveled" }) {
        let actions = audioModes.map { m in
            UIAction(title: m.label, state: m.id == selectedAudioMode ? .on : .off) { [weak self] _ in
                self?.renegotiate(quality: selectedQuality, audioMode: m.id)
            }
        }
        items.append(UIMenu(title: "Audio", children: actions))
    }
    vc.transportBarCustomMenuItems = items
}

/// Captures the live position off the AVPlayer this Coordinator owns and hands it
/// to PlaybackController.renegotiate — keeping AVPlayer access on this side of the
/// split (PlaybackController stays player-free and independently testable).
private func renegotiate(quality: String, audioMode: String) {
    let pos = attachedPlayer?.currentItem?.currentTime().seconds ?? 0
    let safePos = pos.isFinite ? max(0, pos) : 0
    let controller = playbackController
    Task { await controller.renegotiate(quality: quality, audioMode: audioMode, positionSec: safePos) }
}
```

- [ ] **Step 5: Build gate** — `xcodegen generate` + app `build`. BUILD SUCCEEDED.

- [ ] **Step 6: Live playback smoke (most delicate) + screenshot** — launch as in Task 3 Step 6 against the NAS. On a title whose source is high-res enough to expose a quality ladder (source height > ~496, so 720p/480p appear): start playback; open the transport bar (swipe down / Menu-region) and confirm a **Quality** submenu (current marked) and an **Audio** submenu (when leveling is offered); switch quality **mid-playback** and confirm playback resumes at the same position on the new stream (no restart-from-zero, no black frame), the previous ffmpeg session is released, and progress still saves; toggle Audio leveling and confirm the same. Verify a normal Menu-exit still tears down cleanly (final progress PUT + `/stop`). Capture `.superpowers/sdd/phase3-player-menu.png`.

- [ ] **Step 7: Commit** — `git add clients/tvos/Sources/Orbix/Player/PlaybackController.swift clients/tvos/Sources/Orbix/Player/PlayerViewController.swift && git commit -m "feat(tvos): player Quality/Audio-leveling transport menu + mid-playback renegotiation"`

---

### Task 6: Phase 3 gate — build, tests, authenticated visual record vs web (+ search no-results header polish)

**Files:**
- Modify: `clients/tvos/Sources/Orbix/Search/SearchView.swift` (fold-in polish: show the results header on the no-results state; mode chip → pill)
- Modify: `clients/tvos/Sources/Orbix/Shell/ShellView.swift` (Menu-walk consolidation)
- Modify: `clients/tvos/Sources/Orbix/Home/BoxArtCard.swift` (title-plate proportion)

- [ ] **Step 0a: Shell Menu-walk consolidation (Phase-2 review carryover)** — Menu handling is inconsistent across hub sections: `.category` has `.onExitCommand { selection = .home }` while `.wishlist`/`.tv`/`.account` have none, and Menu pressed while focus is on the BAR at a non-Home section backgrounds the app (gate-reproduced). Unify: at any non-Home hub section root (`.category`, `.wishlist`, `.tv`, `.account` — NOT `.search`, which already has its own handler), Menu returns to `.home`; at `.home` root, system behavior (background) stands — spec §6 "Menu walks: player → page → section root → Home". Attach the `.onExitCommand` at the ShellView level for the selected-section content (one place, not per-view), remove the now-duplicated one inside the `.category` wiring, and live-verify: Menu from Wishlist root → Home; Menu with focus ON THE BAR at Wishlist → Home (not background); Menu inside a pushed TitlePage still pops the NavigationStack first (must NOT be swallowed — verify by driving one push+Menu).

- [ ] **Step 0b: Visual nits (Phase-2 review carryover)** — (1) Search mode chip: web `rounded-full` → swap the `RoundedRectangle(cornerRadius: OrbixRadius.chip)` background for `Capsule()` on the mode chip only (NewBadge/QualityChip keep the app-wide chip radius). (2) `BoxArtCard.titlePlate`: replace the fixed `.frame(height: 120)` with content-sized padding over the gradient (web `pt-8 pb-2` ≈ top-heavy fade ~24-39% of card height) — gradient anchored to the text block's natural height + ~32pt fade headroom.

- [ ] **Step 1: Search no-results header polish (folded carryover)** — the web `SearchPage.tsx` (lines 79-100) renders the **"N results" count + mode chip header even when `results.length === 0`**, then the empty message below it; the tvOS `SearchView` routes zero results to a full-screen `ContentUnavailableView` (`.noResults`), dropping the header. Change the `.noResults` presentation to render `resultsHeader(count: 0, usedEmbeddings:)` followed by the web empty copy — `"No results found."` (web `search:empty`) + `"Try a different title, or a broader search."` (web `search:emptyHint`) — reusing the existing `resultsHeader`/`modeChip`. Keep the `searchNoResultsState` accessibility id. (This is the only shared-search/grid change; the billboard separator and PosterCard-bar carryovers landed in Tasks 3/4.)

- [ ] **Step 2: Full gates** — `cd clients/tvos && xcodegen generate`; app `build` SUCCEEDED; `OrbixKitTests` `test` all pass (Task-1 DTO suite green; existing suites still green). No server change → no `pnpm` gates required (confirm `git status` shows no `apps/api/**` edits).

- [ ] **Step 3: Per-surface visual record vs web** — launch in the simulator against the NAS (`set -a; source .superpowers/sdd/dev-device-token.env; set +a`; launch with `-orbixBaseURL`/`-orbixToken` as in Task 3 Step 6; token never printed). Capture and side-by-side compare with the web app: movie title page (hero + RatingBadges + meta + overview + Play/Resume + cast + More Like This + details), series title page (season tabs + episode grid + unowned states), the player Quality/Audio menus (mid-playback switch), billboard **Play** → movie playback, and series **autoplay** (first owned episode). Screenshots: `.superpowers/sdd/phase3-{title-movie,title-series,episode-grid,player-menu}.png`.

- [ ] **Step 4: Wishlist round-trip check** — USER DECISION (2026-07-06): the NAS stays on main until Phase 6, so the wishlist server fix is NOT live. The toggle will optimistically flip then revert on `400 no_profile` — verify exactly that behavior renders gracefully (flip → revert, no crash, no stuck state) and record it as the known stale-NAS constraint (vitest covers the server path; full round-trip verifies at the Phase 6 deploy).

- [ ] **Step 5: Parity + kids checks** — confirm RatingBadges/meta/overview match web on the same titles; the episode grid's per-episode progress + "Not in library" match web; a kids profile still shows only server-filtered catalog on the title page and its similar/episodes (server-enforced — confirm nothing over-renders). Note any deviations for the Phase 4 backlog rather than gold-plating.

- [ ] **Step 6: Commit** — `git add clients/tvos/Sources/Orbix/Search/SearchView.swift && git commit -m "polish(tvos): search no-results header parity; phase 3 gate — visual record vs web"`

---

## Self-review notes

- **Spec coverage:** §7.4 Title page — cinematic hero (Task 2/3), RatingBadges (Task 2, verified rating fields exist server-side, Task 1), meta line + 3-line overview (Task 2/3), Play/Resume + "No media" disabled (Task 2/3), optimistic wishlist toggle (Task 3), season tabs + episode grid + unowned states (Task 4), cast/More-Like-This/details/unmatched notice (Task 3), series autoplay (Task 4, the deferred-from-P2 item); §8 Player upgrades — Quality selector + Audio-leveling via `transportBarCustomMenuItems` with position-preserving re-negotiation (Task 5); §10 testing — DTO decode/encode tests (Task 1) + authenticated simulator record incl. mid-playback quality switch (Task 5/6). Live TV / Account / i18n stay out of Phase 3.
- **Preserved plumbing:** the `PlaybackController` progress chain + teardown, `PlayerViewController` observer lifecycle, resume seek, and next-episode autoplay are moved/extended, never rewritten; the quality switch reuses the resume-seek path via a rebuilt `AVPlayer` (the tvOS analogue of the web `key={streamUrl}` remount). The `TitleRoute(autoplay:)` contract and the shared `NavigationPath` threading are unchanged.
- **Carryovers folded:** billboard `"  ·  "` → `" · "` (Task 3); PosterCard legacy red resume bar removed after verifying all remaining call sites pass no `progress` (Task 4); search no-results header parity (Task 6).
- **No server change:** verified the item-detail handler already sends the ratings and `playback.ts` already sends the quality/audio ladder — Phase 3 is client-only, unlike Phase 2's wishlist fix.
- **Green builds per commit:** Task 1's new `playbackInfo` params are defaulted; Task 3 keeps the series season strip until Task 4 replaces it and removes `SeasonRoute` in one cohesive commit; Task 5's DTO fields were already added in Task 1.
- **No placeholders:** every DTO fixture is a real wire shape from the named handler; `renegotiate`, the menu build, the wishlist toggle, RatingBadges, and the season-default/label ports are complete code.
```
