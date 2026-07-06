# tvOS Parity Rebuild — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring **Full Live TV** to the tvOS app at web parity: OrbixKit TV catalog/EPG/play endpoints + DTOs; the EPG grid layout-math port; the channel presentation components (hue-hashed `ChannelLogoView`, `ChannelCard`, now/next line); a lightweight **live player** (its own zap/failover controller, NOT the VOD `PlaybackController`) with a zap OSD, mini-guide, offline panel, and multi-source failover; the **TV Home** rails screen; the **TV Guide** (list + filter chips + list/grid toggle, then the TiviMate-style time×channel EPG grid); and the **TV Channel** page. Exit gate: catalog + EPG UI verified live in the simulator against the NAS; tokened live **playback** verified end-to-end against a throwaway local stack built from this branch; parity screenshots vs the web app; recorded deviations.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-05-tvos-parity-rebuild-design.md` (§3 server change — **already landed in Phase 0**, commit `6293760`; §7.7 TV Home, §7.8 TV Guide list+grid, §7.9 Channel page, §7.10 Live player; §10 testing; §11 phasing row 4; §13 risks — EPG grid focus, live HLS variability). Builds on Phase 1's design system (`Sources/Orbix/Design/`), Phase 2's shell (`OrbixTopBar` already renders the **TV** nav item for non-kids; `ShellView`'s `.tv` case is a placeholder to replace), OrbixKit's actor client + decode-safe DTOs + `ImageLoader` + `avatarHue`/`avatarInitials`, and Phase 3's title/player work. New pure logic (TV DTOs, EPG/time math) extends **OrbixKit** under TDD; new views live in the **Orbix** app target (`Sources/Orbix/TV/`, plus `ChannelLogoView` in `Sources/Orbix/Design/`). Web components under `apps/web/src/**` are the visual source of truth; server wire shapes are verified against `apps/api/src/routes/tv-catalog.ts` + `tv-play.ts`. **The VOD player plumbing (`PlaybackController`/`PlayerViewController`) is NOT reused for live** — the spec's zap/failover model needs its own lightweight controller (`LiveTvController`) with no progress chain, no resume seek, no `/playback/info` negotiation.

**Tech Stack:** SwiftUI, tvOS 17, Swift 6, XcodeGen; XCTest (OrbixKitTests); AVFoundation (`AVPlayer` + `AVPlayerLayer`, `streamType`-live behavior via defaults). **No server change in Phase 4** — verified: the §3 tv-proxy query-token change landed in Phase 0 (`6293760`: `queryTokenAuth` on the three `/tv/proxy/*` routes, `?token=` propagated into rewritten child URIs, `/tv/channels/:id/play` mints tokened `src` for bearer clients, `requireTvAccess` kids-403 preserved), and every TV **catalog** route (`/tv/home`, `/tv/guide`, `/tv/grid`, `/tv/channels/:id`, `/tv/channels/:id/programmes`, `/tv/favorites`, `/tv/events/:id`, `/tv/streams/:id/health`) was bearer-ready on `main` already. The tvOS DTOs simply need to decode them.

## Global Constraints

- **Web is the visual source of truth.** Read the named `apps/web/src/**` component/page before writing each surface; mirror layout, art treatment, badges, states. Where a web behavior is mouse/hover/keyboard-specific (`aria-pressed` toggle, hover heart, chevron paddles, `<Input>`/`<select>`, `PageUp`/`g`/`l` keys), use the tvOS focus/remote adaptation named in the task rather than inventing one.
- **DTOs mirror wire shapes verified against route handlers.** Every non-key field is `Optional` (decode-safe convention; a missing key and an explicit `null` both decode to `nil`). The genuinely-always-present defining fields of a value (a programme slot's `title`/`start`/`stop`, a stream's `protocol`/`status`/`priority`) may stay non-`Optional`, matching the existing `AudioTrack.index`/`selected` precedent. **Test fixtures in `DTOTests.swift` must be real wire shapes copied from the route handler, not invented.**
- **Pure logic / DTOs that need tests go in OrbixKit** (`Sources/OrbixKit/`), tested in `Tests/OrbixKitTests/`. **TDD for all OrbixKit work: write the failing test first, run it to confirm failure, then implement.** The EPG/time math port reuses the web's own `.test.ts` vectors verbatim (same precedent as `BillboardTests`/`AvatarHueTests`).
- **No server change is planned in Phase 4.** If any `apps/api/**` file is nonetheless touched, run repo gates **with lint separately** per CLAUDE.md: `pnpm typecheck && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api test` (Turbo cache can hide lint-only errors). No task here should need this.
- **Build/test gates (tvOS):** regenerate after file adds: `cd clients/tvos && xcodegen generate`; then
  `xcodebuild -project Orbix.xcodeproj -scheme Orbix -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' build CODE_SIGNING_ALLOWED=NO`
  and for kit changes `xcodebuild -project Orbix.xcodeproj -scheme OrbixKitTests -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' test CODE_SIGNING_ALLOWED=NO`.
  **Substitution note:** if that simulator name is unavailable, pick one from `xcrun simctl list devices available | grep "Apple TV"` and substitute it in `-destination`. New source folders (`Sources/Orbix/TV/`) and new OrbixKit files are picked up by `project.yml`'s directory globs — regenerate before building.
- **Swift 6 language mode:** new types crossing actor boundaries are `Sendable`; UI models are `@MainActor @Observable`. OrbixKit DTOs are `Codable, Sendable, Equatable`. The live controller is `@MainActor @Observable` and **never touches `AVPlayer`** (the AVFoundation observers live on the player representable's coordinator, which calls into the controller — same split as `PlaybackController`/`PlayerViewController.Coordinator`, so the controller's failover/health logic stays independently reasoned).
- **Token-only colors:** use `OrbixColor`/`OrbixRadius`/`OrbixSpacing`/`OrbixType`. No raw hex or ad-hoc `Color(red:…)` in view code. **One derived exception (annotated):** the channel monogram gradient is a *data-derived* color (`hsl(channelHue 45% {34,28,18}%)`, ported from the web's `ChannelLogo`), not a design token — it is computed from `avatarHue(channelId)` via the `Color(tvHueDegrees:saturation:lightness:)` helper added in Task 3, exactly as the web hardcodes those HSL stops. The live-line/now-progress red is `OrbixColor.live` (already a token).
- **No hardcoded server origins or tokens** in committed code (the existing launch-arg/env mechanism stays: `-orbixBaseURL`/`-orbixToken`, `ORBIX_BASE_URL`/`ORBIX_TOKEN`).
- **Authenticated simulator smokes** use the device-token env file at `.superpowers/sdd/dev-device-token.env` (keys `ORBIX_TEST_BASE_URL`, `ORBIX_TEST_TOKEN`). Load it into the shell (`set -a; source .superpowers/sdd/dev-device-token.env; set +a`) and pass `"$ORBIX_TEST_TOKEN"` by reference — **never print or echo the token**. (Simulator keychain does not persist; launch args are the only auth path there.)
- **Live-playback verification constraint (user decision, recorded 2026-07-06):** the NAS stays on `main` until Phase 6, so its `/api/tv/proxy/*` routes **lack the Phase-0 query-token auth** — tokened live-stream **playback cannot be verified against the NAS**. All TV **catalog/EPG** routes were bearer-ready on `main`, so TV Home / Guide list / Guide grid / Channel page **can** live-verify vs the NAS (`http://192.168.1.95:8080`, paired device token). For **playback**, Task 8 stands up a **throwaway local stack from this branch** (fresh containers + a throwaway DB — **never** the dev `orbix` DB / the compose `./data/postgres` volume, per the memory-documented divergent-migration hazard) and exercises the real Phase-0 tokened proxy path end-to-end. Reap any host dev server and free the ports after (CLAUDE.md "reap host dev servers after manual smokes").
- **English literals only** (i18n / String Catalogs are Phase 5). Use the exact web copy where it exists (e.g. `tv:player.offline`, `tv:player.nextChannel`, `tv:channel.onNow` → "ON NOW", `tv:guidePage.noEpg` → "No guide data", `tv:grid.now/prev/next/today/tomorrow`, `common:actions.retry` → "Retry"). Region names ARE localized via `Locale` even in this phase (spec §7.7) — port `regionName` (Task 2).
- **Commit after every task** (small commits on branch `tv-ui`; verify with `git branch --show-current`). Each commit must leave build + kit tests green.

---

### Task 1: OrbixKit — TV catalog/EPG/play endpoints + DTOs (TDD)

**Files:**
- Modify: `clients/tvos/Sources/OrbixKit/DTOs.swift` (append a `// MARK: - TV (Phase 4)` section)
- Modify: `clients/tvos/Sources/OrbixKit/OrbixClient.swift` (append a `// MARK: - Live TV` section)
- Test: `clients/tvos/Tests/OrbixKitTests/DTOTests.swift` (extend with a `// MARK: - TV (Phase 4)` block)

**Interfaces:**
- Consumes: existing `send`/`perform`/`encodeBody` plumbing; decode-safe DTO conventions; bearer-token auth already attached by `OrbixClient`.
- Produces (OrbixKit DTOs — all `public …: Codable, Sendable, Equatable`):
  - `TvProgrammeSlot { title: String; start: String; stop: String }` (the now/next slot; `title`/`start`/`stop` always present).
  - `TvChannelCard { id: String; number: Int; name: String; country: String?; categories: [String]; quality: String?; logo: String?; healthy: Bool; favorite: Bool; now: TvProgrammeSlot?; next: TvProgrammeSlot? }` — `now`/`next` are `Optional` (present-but-null on `/tv/guide`/`/tv/home`, **absent entirely** on `/tv/favorites` cards — both decode to `nil`).
  - `TvCountryRail { code: String; channels: [TvChannelCard] }`, `TvCategoryRail { id: String; channels: [TvChannelCard] }`, `TvHome { recents: [TvChannelCard]; favorites: [TvChannelCard]; countries: [TvCountryRail]; categories: [TvCategoryRail] }`.
  - `TvGuideResponse { total: Int; offset: Int?; limit: Int?; channels: [TvChannelCard] }` (mirrors web `TvGuideResponse` + the wire's `offset`/`limit`, modeled Optional).
  - `TvGridProgramme { id: String; title: String; start: String; stop: String; category: String? }`, `TvGridChannel { id: String; number: Int; name: String; country: String?; categories: [String]; quality: String?; logo: String?; healthy: Bool; favorite: Bool; programmes: [TvGridProgramme] }` (card fields **minus** now/next, **plus** `programmes`), `TvGridResponse { start: String; hours: Int; total: Int; offset: Int?; limit: Int?; channels: [TvGridChannel] }`.
  - `TvNowNext { now: TvProgrammeSlot?; next: TvProgrammeSlot? }`, `TvPlaySource { streamId: String; src: String; quality: String?; label: String? }`, `TvPlayChannel { id: String; number: Int; name: String; logo: String?; country: String?; quality: String? }`, `TvPlayResponse { channel: TvPlayChannel; nowNext: TvNowNext; sources: [TvPlaySource] }`.
  - `TvStreamRef { id: String; quality: String?; label: String?; protocol: String; status: String; priority: Int }` — **`protocol` is a Swift keyword**: declare the property `` `protocol` `` (backticked) and rely on synthesized coding keys (Codable maps the backticked name to the JSON key `"protocol"` correctly).
  - `TvChannelDetail { id: String; number: Int; name: String; rawName: String?; country: String?; languages: [String]; categories: [String]; website: String?; epgId: String?; quality: String?; logo: String?; healthy: Bool; favorite: Bool; streams: [TvStreamRef] }`.
  - `TvProgramme { id: String; start: String; stop: String; title: String; description: String?; category: String? }`.
  - Response envelopes: `TvProgrammesResponse { programmes: [TvProgramme] }`, `TvFavoritesResponse { favorites: [TvChannelCard] }`.
- Produces (OrbixClient methods):
  - `tvHome() -> TvHome` — `GET /api/tv/home`.
  - `tvGuide(country:category:favorites:q:offset:limit:) -> TvGuideResponse` — `GET /api/tv/guide` (omit each query param when nil/false/empty; `favorites` sent as `"true"` only when `true`).
  - `tvGrid(start:hours:country:category:favorites:q:offset:limit:) -> TvGridResponse` — `GET /api/tv/grid` (`start` is an ISO-8601 string, `hours` an Int).
  - `tvChannel(id:) -> TvChannelDetail` — `GET /api/tv/channels/:id`.
  - `tvProgrammes(id:day:) -> [TvProgramme]` — `GET /api/tv/channels/:id/programmes?day=` (unwrap `{programmes}`; omit `day` when nil).
  - `tvChannelPlay(id:) -> TvPlayResponse` — `GET /api/tv/channels/:id/play`.
  - `tvFavorites() -> [TvChannelCard]` — `GET /api/tv/favorites` (unwrap `{favorites}`).
  - `setTvFavorite(channelId:on:) async throws` — `PUT` (on) / `DELETE` (off) `/api/tv/favorites/:channelId` via `perform` (the UI's optimistic toggle needs success/failure to revert, like wishlist — hence `throws`).
  - `postTvEvent(channelId:) async` — `POST /api/tv/events/:channelId`, **best-effort** (`async`, not `throws`, swallows failure — a `sendBeacon`-equivalent tune log, same convention as `stopPlayback`).
  - `postTvStreamHealth(streamId:ok:code:) async` — `POST /api/tv/streams/:streamId/health` with body `{ok}` or `{ok, code}`, **best-effort** (`async`, swallows failure).

**Verified wire shapes (copied from handlers):**
- `GET /tv/home` (`tv-catalog.ts:74-173`) → `{recents:[card…], favorites:[card…], countries:[{code,channels:[card…]}], categories:[{id,channels:[card…]}]}`. Each `card` is `toCard(...)` (`tv-catalog.ts:56-68`) → `{id,number,name,country,categories:[string],quality,logo,healthy,favorite}` **plus** `{now,next}` from `loadNowNext` (`dec` at `:165-171`); each of `now`/`next` is `{title,start,stop}` or `null` (`tv-now-next.ts:3-6`). `logo` is `"/api/images/<logoPath>"` or `null`; `healthy` = "some hls stream not dead".
- `GET /tv/guide` (`tv-catalog.ts:185-227`) → `{total, offset, limit, channels:[card+now/next…]}`.
- `GET /tv/grid` (`tv-catalog.ts:243-302`) → `{start:ISO, hours:Int, total, offset, limit, channels:[{…card fields, programmes:[{id,title,start,stop,category}]}]}` (no now/next on grid rows; `loadProgrammeWindow`).
- `GET /tv/channels/:id` (`tv-catalog.ts:339-363`) → `{id,number,name,rawName,country,languages:[string],categories:[string],website,epgId,quality,logo,healthy,favorite,streams:[{id,quality,label,protocol,status,priority}]}` (streams ordered by priority asc). **404** `{error:"not_found"}` when missing/hidden.
- `GET /tv/channels/:id/programmes?day=YYYY-MM-DD` (`tv-catalog.ts:394-396`) → `{programmes:[{id,start,stop,title,description,category}]}` (`start`/`stop` ISO). **400** `{error:"invalid_day"}` on a malformed day; **404** for a hidden/missing channel.
- `GET /tv/channels/:id/play` (`tv-play.ts:137-153`, Phase-0 tokened) → `{channel:{id,number,name,logo,country,quality}, nowNext:{now,next}, sources:[{streamId,src,quality,label}]}`. For a **bearer** request `src` = `"/api/tv/proxy/<streamId>/index.m3u8?token=<rawBearer>"` (`tv-play.ts:133-135,149`); for a cookie request the `?token=` is absent (verified in `tv-play.test.ts:405-423`). **409** `{error:"no_playable_stream"}` when no ordered stream; **404** when missing/hidden. Max 3 sources.
- `GET /tv/favorites` (`tv-catalog.ts:438-450`) → `{favorites:[card…]}` **without** now/next (plain `toCard`, no `dec`). `{favorites:[]}` when no profile.
- `PUT /tv/favorites/:channelId` → `{ok:true}` (idempotent add; **400** `no_profile`, **404** not_found). `DELETE` → **204** no body.
- `POST /tv/events/:channelId` → `{ok:true}` (**400** `no_profile`, **404** not_found). `POST /tv/streams/:id/health` (`tv-play.ts:273-299`) body `{ok?:bool, code?:string}` → `{ok:true}` (**404** not_found).

- [ ] **Step 1: Read the handlers** — `apps/api/src/routes/tv-catalog.ts` (the six catalog response builders + `toCard`), `apps/api/src/routes/tv-play.ts:103-155,273-300` (play sources + tokened `src`; health), `apps/api/src/lib/tv-now-next.ts:3-45` (slot shape), and `apps/web/src/lib/types.ts:165-266` (`TvProgrammeSlot`/`TvChannelCard`/`TvHome`/`TvGuideResponse`/`TvGridChannel`/`TvGridResponse`/`TvPlaySource`/`TvNowNext`/`TvPlayResponse`/`TvProgramme`). Confirm every field name/nullability above.

- [ ] **Step 2: Write failing DTO decode/void tests** in `DTOTests.swift` (follow the file's fixture style; real wire shapes only):

```swift
// MARK: - TV (Phase 4 Task 1)

func testDecodeTvHomeRailsAndNowNext() throws {
    // tv-catalog.ts:167-172 — rails of toCard()+dec() cards; now/next present-or-null.
    let json = """
    {"recents":[
       {"id":"ch1","number":5,"name":"BBC One","country":"UK","categories":["news","general"],
        "quality":"1080p","logo":"/api/images/channel/ch1.png","healthy":true,"favorite":true,
        "now":{"title":"News at Six","start":"2026-07-06T17:00:00.000Z","stop":"2026-07-06T17:30:00.000Z"},
        "next":{"title":"Weather","start":"2026-07-06T17:30:00.000Z","stop":"2026-07-06T17:35:00.000Z"}}],
     "favorites":[],
     "countries":[{"code":"UK","channels":[
       {"id":"ch2","number":6,"name":"ITV","country":"UK","categories":[],"quality":null,
        "logo":null,"healthy":false,"favorite":false,"now":null,"next":null}]}],
     "categories":[{"id":"news","channels":[]}]}
    """.data(using: .utf8)!
    let home = try JSONDecoder().decode(TvHome.self, from: json)
    XCTAssertEqual(home.recents.first?.id, "ch1")
    XCTAssertEqual(home.recents.first?.now?.title, "News at Six")
    XCTAssertEqual(home.countries.first?.code, "UK")
    XCTAssertEqual(home.countries.first?.channels.first?.healthy, false)
    XCTAssertNil(home.countries.first?.channels.first?.now)
    XCTAssertEqual(home.categories.first?.id, "news")
}

func testDecodeTvGuidePage() throws {
    // tv-catalog.ts:227 — {total, offset, limit, channels}.
    let json = """
    {"total":altTotal,"offset":0,"limit":100,"channels":[
      {"id":"ch1","number":1,"name":"One","country":"RU","categories":["general"],"quality":"HD",
       "logo":null,"healthy":true,"favorite":false,"now":null,"next":null}]}
    """.replacingOccurrences(of: "altTotal", with: "342").data(using: .utf8)!
    let page = try JSONDecoder().decode(TvGuideResponse.self, from: json)
    XCTAssertEqual(page.total, 342)
    XCTAssertEqual(page.channels.count, 1)
}

func testDecodeTvGridWindowAndProgrammes() throws {
    // tv-catalog.ts:301 — {start, hours, total, offset, limit, channels:[{…,programmes}]}.
    let json = """
    {"start":"2026-07-06T14:00:00.000Z","hours":4,"total":2,"offset":0,"limit":50,"channels":[
      {"id":"ch1","number":1,"name":"One","country":"RU","categories":["general"],"quality":null,
       "logo":null,"healthy":true,"favorite":false,
       "programmes":[{"id":"p1","title":"Show","start":"2026-07-06T14:30:00.000Z",
                      "stop":"2026-07-06T15:30:00.000Z","category":"series"}]},
      {"id":"ch2","number":2,"name":"Two","country":"RU","categories":[],"quality":null,
       "logo":null,"healthy":true,"favorite":false,"programmes":[]}]}
    """.data(using: .utf8)!
    let grid = try JSONDecoder().decode(TvGridResponse.self, from: json)
    XCTAssertEqual(grid.hours, 4)
    XCTAssertEqual(grid.channels.first?.programmes.first?.title, "Show")
    XCTAssertEqual(grid.channels.last?.programmes.count, 0)
}

func testDecodeTvChannelDetailStreamsProtocolKeyword() throws {
    // tv-catalog.ts:339-363 — note the `protocol` JSON key → backticked Swift prop.
    let json = """
    {"id":"ch1","number":5,"name":"BBC One","rawName":"BBC ONE HD","country":"UK",
     "languages":["eng"],"categories":["news"],"website":"https://bbc.co.uk","epgId":"bbc1",
     "quality":"1080p","logo":"/api/images/channel/ch1.png","healthy":true,"favorite":true,
     "streams":[{"id":"st1","quality":"1080p","label":"Main","protocol":"hls","status":"ok","priority":0},
                {"id":"st2","quality":null,"label":null,"protocol":"hls","status":"degraded","priority":1}]}
    """.data(using: .utf8)!
    let ch = try JSONDecoder().decode(TvChannelDetail.self, from: json)
    XCTAssertEqual(ch.languages, ["eng"])
    XCTAssertEqual(ch.streams.first?.`protocol`, "hls")
    XCTAssertEqual(ch.streams.last?.status, "degraded")
    XCTAssertEqual(ch.streams.first?.priority, 0)
}

func testDecodeTvProgrammesDaySchedule() throws {
    let json = """
    {"programmes":[
      {"id":"p1","start":"2026-07-06T06:00:00.000Z","stop":"2026-07-06T07:00:00.000Z",
       "title":"Breakfast","description":"Morning news","category":"news"},
      {"id":"p2","start":"2026-07-06T07:00:00.000Z","stop":"2026-07-06T08:00:00.000Z",
       "title":"Cartoons","description":null,"category":null}]}
    """.data(using: .utf8)!
    let res = try JSONDecoder().decode(TvProgrammesResponse.self, from: json)
    XCTAssertEqual(res.programmes.count, 2)
    XCTAssertNil(res.programmes.last?.description)
}

func testDecodeTvPlayResponseTokenedSources() throws {
    // tv-play.ts:137-153 — bearer request carries ?token= on each src.
    let json = """
    {"channel":{"id":"ch1","number":5,"name":"One","logo":null,"country":"RU","quality":"1080p"},
     "nowNext":{"now":{"title":"Live","start":"2026-07-06T17:00:00.000Z","stop":"2026-07-06T18:00:00.000Z"},"next":null},
     "sources":[
       {"streamId":"st1","src":"/api/tv/proxy/st1/index.m3u8?token=orb_x","quality":"1080p","label":"Main"},
       {"streamId":"st2","src":"/api/tv/proxy/st2/index.m3u8?token=orb_x","quality":"720p","label":null}]}
    """.data(using: .utf8)!
    let play = try JSONDecoder().decode(TvPlayResponse.self, from: json)
    XCTAssertEqual(play.channel.number, 5)
    XCTAssertEqual(play.sources.count, 2)
    XCTAssertTrue(play.sources[0].src.contains("token=orb_x"))
    XCTAssertEqual(play.nowNext.now?.title, "Live")
}

func testDecodeTvFavoritesEnvelopeWithoutNowNext() throws {
    // tv-catalog.ts:447-449 — plain toCard(), no now/next keys at all → decode to nil.
    let json = """
    {"favorites":[{"id":"ch1","number":5,"name":"One","country":"UK","categories":["news"],
      "quality":"HD","logo":null,"healthy":true,"favorite":true}]}
    """.data(using: .utf8)!
    let res = try JSONDecoder().decode(TvFavoritesResponse.self, from: json)
    XCTAssertEqual(res.favorites.first?.id, "ch1")
    XCTAssertNil(res.favorites.first?.now) // absent key decodes to nil (decode-safe)
}
```

- [ ] **Step 3: Run to verify failure** — `cd clients/tvos && xcodegen generate` then the `OrbixKitTests` `test` gate. Expected: FAIL (types undefined).

- [ ] **Step 4: Implement the DTOs** in `DTOs.swift` under a `// MARK: - TV (Phase 4)` section, each with a memberwise `init` (Optionals default `nil`) and a doc comment naming the handler. `TvStreamRef.protocol` uses the backticked property name so Codable's synthesized keys map `"protocol"` correctly; no custom `CodingKeys` needed.

- [ ] **Step 5: Implement the client methods** in `OrbixClient.swift` under `// MARK: - Live TV`, mirroring the existing query-building idioms (`appending(queryItems:)`, omit-when-nil) and unwrap conventions (`menu()`/`similar()` for the `{programmes}`/`{favorites}` envelopes). `setTvFavorite`:

```swift
/// `PUT /api/tv/favorites/:channelId` (add) or `DELETE` (remove) — idempotent
/// per the handler (tv-catalog.ts:403-435). Throws so the UI's optimistic
/// favorite toggle can revert on failure (same shape as add/removeFromWishlist).
public func setTvFavorite(channelId: String, on: Bool) async throws {
    let url = baseURL.appending(path: "api/tv/favorites/\(channelId)")
    _ = try await perform(method: on ? "PUT" : "DELETE", url: url)
}

/// `POST /api/tv/events/:channelId` — fire-and-forget tune log (recents rail).
/// Best-effort (async, not throws): the failure is swallowed, same as
/// `stopPlayback` — a missed recents write must never disrupt tuning.
public func postTvEvent(channelId: String) async {
    _ = try? await perform(method: "POST", url: baseURL.appending(path: "api/tv/events/\(channelId)"))
}

/// `POST /api/tv/streams/:streamId/health` — player health feedback
/// (tv-play.ts:273-300). Best-effort; `code` is the failure reason on `ok:false`.
public func postTvStreamHealth(streamId: String, ok: Bool, code: String? = nil) async {
    struct Body: Encodable { let ok: Bool; let code: String? }
    let data = try? encodeBody(Body(ok: ok, code: code))
    _ = try? await perform(method: "POST",
        url: baseURL.appending(path: "api/tv/streams/\(streamId)/health"), body: data)
}
```

- [ ] **Step 6: Run tests — PASS.** All new decode tests green; existing suites still green.

- [ ] **Step 7: Gates** — `xcodegen generate`; app `build` SUCCEEDED (DTOs/methods compile standalone; nothing consumes them yet); `OrbixKitTests` `test` passing.

- [ ] **Step 8: Commit** — `git add clients/tvos/Sources/OrbixKit clients/tvos/Tests/OrbixKitTests/DTOTests.swift && git commit -m "feat(orbixkit): live-TV catalog/EPG/play endpoints + DTOs"`

---

### Task 2: OrbixKit — EPG grid layout + TV time-display math port (TDD)

**Files:**
- Create: `clients/tvos/Sources/OrbixKit/TvGridLayout.swift`
- Test: `clients/tvos/Tests/OrbixKitTests/TvGridLayoutTests.swift`

**Interfaces:**
- Consumes: `Foundation` only (pure math + `Calendar`/`Locale` for the local-day/region helpers). No fetch/UI.
- Produces (1:1 ports of `apps/web/src/lib/tv-grid-layout.ts`, `tv-time.ts`, and `regionName` from `tv.ts` — the window/geometry math is timezone-free (epoch-ms + ISO-with-`Z`), so it reuses the web's exact numeric vectors; the calendar helpers use the local calendar like the web's `Date` local methods):
  - `func tvFloorToHour(_ d: Date, calendar: Calendar = .current) -> Date` — zeroes minute/second/nanosecond, keeps the local hour.
  - `func tvShiftHours(_ d: Date, _ hours: Int) -> Date` — `d + hours*3600s` (pure ms shift; Prev/Next nav).
  - `func tvPrimeTimeOnDay(offsetDays: Int, hour: Int, from: Date = Date(), calendar: Calendar = .current) -> Date` — the given local hour on `from`'s day + `offsetDays` (Tomorrow-prime-time chip).
  - `struct TvBlockRect: Equatable { let left: Double; let width: Double }` + `func tvComputeBlockRect(startISO: String, stopISO: String, windowStartMs: Double, windowMs: Double) -> TvBlockRect` — window-relative percentages, clamped to `[0,100]` on both edges; degenerate `windowMs<=0` → `{0,0}`.
  - `struct TvTimeTick: Equatable { let ms: Double; let leftPct: Double }` + `func tvGenerateTimeTicks(windowStartMs: Double, windowMs: Double, stepMs: Double = 30*60_000) -> [TvTimeTick]` — inclusive of both edges.
  - `func tvNowLinePercent(windowStartMs: Double, windowMs: Double, atMs: Double = Date().timeIntervalSince1970*1000) -> Double?` — `nil` outside the half-open `[start, start+windowMs)`.
  - `func tvNowProgressFraction(startISO: String, stopISO: String, atMs: Double = …) -> Double` — elapsed fraction `0...1` (port of `nowProgressPercent`/100; feeds `NowProgressBar(fraction:)`).
  - `func tvDayString(offsetDays: Int, from: Date = Date(), calendar: Calendar = .current) -> String` — local `"YYYY-MM-DD"` (Today/Tomorrow schedule tabs → the `?day=` param).
  - `func tvRegionName(_ code: String?, locale: Locale = .current) -> String?` — `Locale.localizedString(forRegionCode:)` with the iptv-org `UK→GB` fix; echoes junk codes, `nil` for nil/empty.
  - private `func tvParseMs(_ iso: String) -> Double?` — ISO-8601 → epoch ms (fractional then plain, same two-formatter idiom as `Billboard.parseISODate`); returns `nil` on unparseable input so callers guard like `Date.parse`'s `NaN`.

**Web→Swift adaptations (explicit):**
- `computeBlockRect`/`generateTimeTicks`/`nowLinePercent`/`nowProgressFraction` operate on `Double` epoch-ms — timezone-independent, so the ported tests assert the **same numbers** as `tv-grid-layout.test.ts`/`tv-time` (25.0, 12.5, 100.0, `nil` at the half-open upper bound, etc.).
- `floorToHour`/`shiftHours`/`primeTimeOnDay`/`tvDayString` use `Calendar.current` (local), matching the web's local `Date` semantics; tests build inputs via `DateComponents` in the current calendar and assert local hour/day components (mirroring the web tests' `new Date(2026,6,3,14,37,…)` construction).
- `tvRegionName` mirrors `regionName`: `code.uppercased() == "UK" ? "GB" : code.uppercased()`, then `locale.localizedString(forRegionCode:)`; on `nil` return `code` (echo) — asserts `"UK"→"United Kingdom"`, `"RU"→"Russia"`, `"ZZZZ"→"ZZZZ"`, `nil→nil` (the web `tv.test.ts` vectors, with `Locale(identifier: "en_US")`).

- [ ] **Step 1: Read the web sources** — `apps/web/src/lib/tv-grid-layout.ts` + `.test.ts`, `apps/web/src/lib/tv-time.ts`, and `regionName` in `apps/web/src/lib/tv.ts` + its `tv.test.ts` cases. Re-read `clients/tvos/Sources/OrbixKit/Billboard.swift` (its two-formatter ISO parser) and `Tests/OrbixKitTests/BillboardTests.swift` (the "port with web vectors" test shape to mirror).

- [ ] **Step 2: Write the failing test file** `TvGridLayoutTests.swift` — port every `describe`/`it` from `tv-grid-layout.test.ts` (floorToHour zeroes/no-mutate, shiftHours forward/back/rollover, primeTimeOnDay, computeBlockRect inside/clamp-left/clamp-right/whole-window/outside/after, generateTimeTicks 9-ticks + custom step, nowLinePercent inside/before/at-end/at-lower-bound, `windowMs<=0` guard) plus `tv-time`'s `nowProgressPercent` cases (as fraction: 0.25 inside, 0 for stop≤start, clamp) and `tvDayString`, and `tv.test.ts`'s `regionName` cases. Real vectors, e.g.:

```swift
func testComputeBlockRectInsideWindow() {
    let start = tvParseMs("2026-07-03T14:00:00.000Z")!
    let rect = tvComputeBlockRect(startISO: "2026-07-03T15:00:00.000Z",
                                  stopISO: "2026-07-03T16:00:00.000Z",
                                  windowStartMs: start, windowMs: 4*3_600_000)
    XCTAssertEqual(rect.left, 25, accuracy: 0.001)
    XCTAssertEqual(rect.width, 25, accuracy: 0.001)
}
func testNowLineHalfOpenUpperBound() {
    let start = tvParseMs("2026-07-03T14:00:00.000Z")!
    XCTAssertNil(tvNowLinePercent(windowStartMs: start, windowMs: 4*3_600_000, atMs: start + 4*3_600_000))
    XCTAssertEqual(tvNowLinePercent(windowStartMs: start, windowMs: 4*3_600_000, atMs: start), 0)
}
func testRegionNameUKMapsToGB() {
    XCTAssertEqual(tvRegionName("UK", locale: Locale(identifier: "en_US")), "United Kingdom")
    XCTAssertEqual(tvRegionName("RU", locale: Locale(identifier: "en_US")), "Russia")
    XCTAssertEqual(tvRegionName("ZZZZ", locale: Locale(identifier: "en_US")), "ZZZZ")
    XCTAssertNil(tvRegionName(nil))
}
```

- [ ] **Step 3: Run to verify failure** — `OrbixKitTests` `test` gate: FAIL (symbols undefined).

- [ ] **Step 4: Implement `TvGridLayout.swift`** — the functions above. The three geometry functions are direct arithmetic ports; e.g.:

```swift
public struct TvBlockRect: Equatable, Sendable { public let left: Double; public let width: Double }

/// Port of tv-grid-layout.ts `computeBlockRect`: a programme's rect as
/// percentages of the window, both edges clamped to [0,100] (partial blocks at
/// the window edges render flush, never spill). Degenerate window → {0,0}.
public func tvComputeBlockRect(startISO: String, stopISO: String,
                               windowStartMs: Double, windowMs: Double) -> TvBlockRect {
    guard windowMs > 0, let startMs = tvParseMs(startISO), let stopMs = tvParseMs(stopISO) else {
        return TvBlockRect(left: 0, width: 0)
    }
    let rawLeft  = ((startMs - windowStartMs) / windowMs) * 100
    let rawRight = ((stopMs  - windowStartMs) / windowMs) * 100
    let left  = min(100, max(0, rawLeft))
    let right = min(100, max(0, rawRight))
    return TvBlockRect(left: left, width: max(0, right - left))
}
```

- [ ] **Step 5: Run tests — PASS.** All ported vectors green; existing suites green.

- [ ] **Step 6: Gates** — `xcodegen generate`; app `build` SUCCEEDED; `OrbixKitTests` `test` passing.

- [ ] **Step 7: Commit** — `git add clients/tvos/Sources/OrbixKit/TvGridLayout.swift clients/tvos/Tests/OrbixKitTests/TvGridLayoutTests.swift && git commit -m "feat(orbixkit): EPG grid layout + TV time/region math port (web test vectors)"`

---

### Task 3: Live player — ChannelLogoView + now/next line + LiveTvController (failover ladder) + LiveTvPlayerView + LiveTvOverlay

**Files:**
- Create: `clients/tvos/Sources/Orbix/Design/ChannelLogoView.swift`
- Create: `clients/tvos/Sources/Orbix/TV/ChannelNowNextView.swift`
- Create: `clients/tvos/Sources/Orbix/TV/LiveTvController.swift`
- Create: `clients/tvos/Sources/Orbix/TV/LiveTvPlayerView.swift`
- Create: `clients/tvos/Sources/Orbix/TV/LiveTvOverlay.swift`

**Interfaces:**
- Consumes: `OrbixColor`/`OrbixRadius`/`OrbixType`, `QualityChip` (Badges), `NowProgressBar` (ProgressBars), `avatarHue`/`avatarInitials` + `tvNowProgressFraction` + `tvRegionName` (OrbixKit), `ImageLoader`, `TvPlayResponse`/`TvChannelCard`/`TvProgrammeSlot`/`TvPlaySource` (OrbixKit), `OrbixClient`, `AVFoundation` (`AVPlayer`, `AVPlayerLayer`, `AVPlayerItem`), `UIKit`.
- Produces:
  - `struct ChannelLogoView: View` — cached logo (via shared `ImageLoader`) centered on the hue-hashed monogram fallback; the fallback also shows when the logo fetch fails (web `ChannelLogo`'s `onError`). Sizing/shape/background are caller props (`className` analogues), so the guide row, OSD, mini-guide, hero, and 16:9 tile each keep their look — only the img-vs-monogram switch is shared. Plus a `Color(tvHueDegrees:saturation:lightness:)` extension (exact HSL→sRGB) so the monogram matches the web's `hsl(hue 45% 34/28/18%)` stops.
  - `struct ChannelNowNextView: View` — the now/next line (now title + `HH:MM–HH:MM` + red `NowProgressBar`, or "No guide data", + a compact "Next · HH:MM Title" line) shared by guide rows and the mini-guide (port of web `ChannelNowNext.tsx`).
  - `@MainActor @Observable final class LiveTvController` — the lightweight live controller: tune (posts the watch event, fetches ordered sources), the multi-source **failover ladder**, per-source health reporting, offline/exhaustion state. **Never touches `AVPlayer`** (the player representable's coordinator calls into it).
  - `struct LiveTvPlayerView: UIViewControllerRepresentable` — hosts a bare `AVPlayer` + `AVPlayerLayer` (no `AVPlayerViewController` transport UI — the overlay owns all chrome), configured for live (`automaticallyWaitsToMinimizeStalling = false` off the live edge is AVPlayer default; no custom catch-up), rebuilds the `AVPlayerItem` on `streamURL` change, and reports item-status/failed/stall/first-frame back to the controller.
  - `struct LiveTvOverlay: View` — the full-screen live cinema (presented via `.fullScreenCover`): the player, the zap OSD (auto-hide 4 s), the mini-guide drawer, the offline panel, and the tvOS remote surface. Public API mirrors the web: `LiveTvOverlay(channels: [TvChannelCard], initialId: String, model: AppModel, onClose: () -> Void)`.

**Web→TV adaptations (explicit):**

- **`ChannelLogoView` monogram (web `ChannelLogo.tsx:50-60`):** reuse `avatarHue(channelId)` + `avatarInitials(name)` (verified: OrbixKit's `avatarHue`/`avatarInitials` are the byte-for-byte port of `tv.ts`'s `channelHue`/`channelInitials` — same hash, same code-point-aware initials, pinned in `AvatarHueTests`). Gradient tile = `LinearGradient(135°)` between `hsl(hue 45% 34%)` and `hsl(hue 45% 18%)`; flat tile = `hsl(hue 45% 28%)`. SwiftUI has no HSL initializer, so add (in this file) a small exact HSL→sRGB helper and use it for both stops:

```swift
extension Color {
    /// Exact CSS-HSL → sRGB (SwiftUI's Color(hue:saturation:brightness:) is HSB,
    /// a different model). Ports the web ChannelLogo monogram's hsl(h 45% L%)
    /// tiles faithfully so the tvOS channel art matches the web's byte-for-byte.
    init(tvHueDegrees h: Double, saturation s: Double, lightness l: Double) {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360)) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        let (r1, g1, b1): (Double, Double, Double)
        switch hp {
        case 0..<1: (r1, g1, b1) = (c, x, 0)
        case 1..<2: (r1, g1, b1) = (x, c, 0)
        case 2..<3: (r1, g1, b1) = (0, c, x)
        case 3..<4: (r1, g1, b1) = (0, x, c)
        case 4..<5: (r1, g1, b1) = (x, 0, c)
        default:    (r1, g1, b1) = (c, 0, x)
        }
        let m = l - c / 2
        self.init(.sRGB, red: r1 + m, green: g1 + m, blue: b1 + m, opacity: 1)
    }
}
```
  `ChannelLogoView(logo:name:channelId:baseURL:imageLoader:gradient:contentMax:)`: resolves `logo` (already `"/api/images/…"`) against `baseURL`, loads via `ImageLoader` (same `.task(id:)` idiom as `BoxArtImage`), and on nil/failed shows the monogram with `avatarInitials(name)` over the gradient/flat tile. `.accessibilityIdentifier("channelLogo_\(channelId)")`.

- **`LiveTvController` — the failover ladder (complete logic; web `LiveTvPlayer.tsx` adapted to AVPlayer):** hls.js's NETWORK-vs-MEDIA distinction has no AVPlayer analogue, so the ladder becomes *one in-place reload per source, then advance* (the same "retry-once-then-next" shape), plus a fast **dead-channel watchdog** so a source that never produces a first frame fails over in a few seconds (spec §13 acceptance). Health is reported per source: fail on advance (`postTvStreamHealth(ok:false, code:)`), ok once after 30 s of stable playback.

```swift
@MainActor
@Observable
final class LiveTvController {
    enum LoadState: Equatable { case loading, playing(URL), offline }

    private(set) var channelId: String
    private(set) var play: TvPlayResponse?
    private(set) var sourceIndex = 0
    private(set) var loadState: LoadState = .loading
    /// Transient status line ("Reconnecting…", "Trying source 2/3") shown by the overlay.
    private(set) var toast: String?
    /// Bumped on offline-panel Retry → re-tune the same channel from source 0.
    private(set) var attempt = 0

    private let client: OrbixClient
    private let baseURL: URL

    // Per-source ladder state.
    private var reloadedOnce = false
    private var reportedOk = false
    private var healthTask: Task<Void, Never>?
    private var watchdogTask: Task<Void, Never>?
    private var toastTask: Task<Void, Never>?

    private static let healthOkAfterNs: UInt64 = 30_000_000_000  // web HEALTH_OK_AFTER_MS
    private static let deadChannelWatchdogNs: UInt64 = 8_000_000_000 // ~ manifest policy timeout
    private static let toastNs: UInt64 = 4_000_000_000

    init(channelId: String, client: OrbixClient, baseURL: URL) {
        self.channelId = channelId; self.client = client; self.baseURL = baseURL
    }

    var currentSource: TvPlaySource? {
        guard let play, sourceIndex < play.sources.count else { return nil }
        return play.sources[sourceIndex]
    }
    var streamURL: URL? {
        guard let src = currentSource?.src else { return nil }
        return URL(string: src, relativeTo: baseURL)?.absoluteURL
    }

    /// Tune a channel: log the event (fire-and-forget), fetch ordered sources,
    /// start from source 0. A 409/404/network or empty sources → offline.
    func tune(to id: String) async {
        cancelTimers()
        channelId = id; play = nil; sourceIndex = 0; reloadedOnce = false
        reportedOk = false; toast = nil; loadState = .loading
        await client.postTvEvent(channelId: id)
        do {
            let p = try await client.tvChannelPlay(id: id)
            guard channelId == id else { return } // superseded by a newer tune
            guard !p.sources.isEmpty else { loadState = .offline; return }
            play = p
            loadState = streamURL.map { .playing($0) } ?? .offline
            startWatchdog()
        } catch {
            guard channelId == id else { return }
            loadState = .offline
        }
    }

    /// Offline-panel Retry: re-tune from source 0 with a fresh attempt id
    /// (the player key includes `attempt`, forcing a rebuild).
    func retry() { attempt += 1; Task { await tune(to: channelId) } }

    /// AVPlayer reported a fatal failure for the current source (item .failed,
    /// failed-to-play-to-end, or the watchdog). Web ladder → one in-place reload,
    /// then advance to the next source; every failed source bumps failCount.
    func playbackFailed(code: String) {
        guard let play, let src = currentSource else { return }
        if !reloadedOnce {
            reloadedOnce = true
            showToast("Reconnecting…")           // web tv:player.reconnecting
            reemitCurrent()                       // rebuild the AVPlayerItem in place
            startWatchdog()
            return
        }
        Task { await client.postTvStreamHealth(streamId: src.streamId, ok: false, code: code) }
        cancelTimers()
        let next = sourceIndex + 1
        if next < play.sources.count {
            sourceIndex = next; reloadedOnce = false; reportedOk = false
            showToast("Trying source \(next + 1)/\(play.sources.count)") // web tv:player.tryingSource
            loadState = streamURL.map { .playing($0) } ?? .offline
            startWatchdog()
        } else {
            loadState = .offline                  // overlay shows the offline panel
        }
    }

    /// AVPlayer produced a first frame / is playing: cancel the dead-channel
    /// watchdog and, once, schedule the 30 s "healthy" report for this source.
    func playbackStarted() {
        watchdogTask?.cancel(); watchdogTask = nil
        guard !reportedOk, healthTask == nil, let src = currentSource else { return }
        healthTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.healthOkAfterNs)
            guard let self, !Task.isCancelled else { return }
            self.reportedOk = true; self.healthTask = nil
            await self.client.postTvStreamHealth(streamId: src.streamId, ok: true)
        }
    }

    private func startWatchdog() {
        watchdogTask?.cancel()
        watchdogTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.deadChannelWatchdogNs)
            guard let self, !Task.isCancelled else { return }
            self.watchdogTask = nil
            self.playbackFailed(code: "watchdog_no_first_frame")
        }
    }
    private func reemitCurrent() { if let url = streamURL { loadState = .playing(url) } }
    private func showToast(_ msg: String) {
        toast = msg; toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.toastNs)
            if !Task.isCancelled { self?.toast = nil }
        }
    }
    private func cancelTimers() {
        healthTask?.cancel(); healthTask = nil
        watchdogTask?.cancel(); watchdogTask = nil
    }
    deinit { healthTask?.cancel(); watchdogTask?.cancel(); toastTask?.cancel() }
}
```

- **`LiveTvPlayerView` (AVPlayer host):** a `UIViewControllerRepresentable` whose controller owns an `AVPlayer` + `AVPlayerLayer` sized to fill. It rebuilds the `AVPlayerItem` whenever the passed `streamURL` (or `attempt`) changes — the tvOS analogue of the web `key={streamId:attempt}` remount. The coordinator observes the current item's `status` (`.failed` → `controller.playbackFailed(code:)`), `AVPlayerItemFailedToPlayToEndTime` (→ same), and `timeControlStatus`/`AVPlayerItem` first-`isPlaybackLikelyToKeepUp` (→ `controller.playbackStarted()`). No progress PUTs, no resume seek, no `/playback/info`. **Do not reuse `PlaybackController`/`PlayerViewController`.**

- **`LiveTvOverlay` (zap OSD, mini-guide, offline, remote):**
  - **OSD auto-hide (4 s, web `OSD_MS`):** shown on mount and every tune; `showOSD()` sets `osdVisible = true` and (re)schedules a 4 s hide `Task`, cancelling the prior one:

```swift
@State private var osdVisible = true
@State private var osdHideTask: Task<Void, Never>?
private func showOSD() {
    osdVisible = true
    osdHideTask?.cancel()
    osdHideTask = Task { @MainActor in
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        if !Task.isCancelled { osdVisible = false }
    }
}
```
  OSD content mirrors web `LiveTvOverlay.tsx:246-280`: number · `ChannelLogoView` · name · `QualityChip` · source indicator (`"Source \(i+1)/\(total)"` when `sourceIndex > 0`) · now title + red `NowProgressBar(fraction: tvNowProgressFraction(...))` · "Next · Title" — read from `controller.play.channel`/`nowNext` and the zap-context `TvChannelCard`.
  - **Zap (`zap(_ delta:)`, web lines 82-90):** index into the passed `channels` list, wrap, `Task { await controller.tune(to: channels[next].id) }`; remembers the previous id for **last-channel jump**.
  - **Mini-guide drawer (web lines 285-325):** a left `LazyVStack` of the zap-context channels (number · name · `ChannelNowNextView` · quality); focus moves up/down, **Select tunes in place** (drawer stays open); the current channel is accent-tinted.
  - **Offline panel (web lines 224-243):** shown when `controller.loadState == .offline`: "This channel is offline" + **Retry** (`controller.retry()`) and **Next channel** (`zap(1)`) `OrbixButton`s.
  - **Remote mapping (web keyboard → tvOS):** persistent, always-focusable on-screen control cluster (right edge, web lines 327-339) — **channel-up** (`zap(-1)`), **guide** (toggle mini-guide), **channel-down** (`zap(1)`), plus a **last-channel** button and a top-left **close**. In addition: a focusable transparent player surface handles `.onMoveCommand(.up/.down)` = zap prev/next (the swipe path) and `.onMoveCommand(.left/.right)` opens/closes the mini-guide; **Select** on it toggles the OSD (`showOSD()`); `.onExitCommand` (Menu) closes the mini-guide first, else calls `onClose()`. (Web's `l`=live-edge/`i`=show-OSD map to the OSD toggle; there is no custom catch-up in v1 per spec §7.10 — AVPlayer live defaults handle the window.) Document this mapping in the file's doc comment. The overlay hosts the player only when `!offline` and passes `controller.streamURL`/`attempt` to `LiveTvPlayerView`.
  - Presented from a page via `.fullScreenCover(item:)` over an identifiable `LivePlayContext { channels, initialId }`; `LiveTvController` is a `@State` created with `model.client`/`model.baseURL` and `.task { await controller.tune(to: context.initialId) }`.

- [ ] **Step 1: Read the web sources** — `apps/web/src/components/tv/ChannelLogo.tsx`, `ChannelNowNext.tsx`, `NowProgressBar.tsx`, `LiveTvPlayer.tsx` (source ordering, `advanceSource`, health OK-after-30s, error ladder, live config → the AVPlayer-appropriate reductions above), `LiveTvOverlay.tsx` (OSD/mini-guide/offline/keyboard). Re-read `clients/tvos/Sources/Orbix/Home/BoxArtCard.swift` (the `ImageLoader` `.task(id:)` art pattern), `Sources/Orbix/Design/{ProgressBars,Badges}.swift` (`NowProgressBar`/`QualityChip`), and `Sources/OrbixKit/AvatarHue.swift` (confirm `avatarHue`/`avatarInitials` == `channelHue`/`channelInitials`).

- [ ] **Step 2: Implement `ChannelLogoView.swift`** (with the `Color(tvHueDegrees:…)` helper) and `ChannelNowNextView.swift`. Add `#Preview`s (logo-present, logo-missing→monogram gradient, now/next present-and-absent).

- [ ] **Step 3: Implement `LiveTvController.swift`** (the complete failover/health logic above).

- [ ] **Step 4: Implement `LiveTvPlayerView.swift`** — the AVPlayer/AVPlayerLayer representable + coordinator observers wired to `controller.playbackFailed`/`playbackStarted`; rebuild the item on `streamURL`/`attempt` change.

- [ ] **Step 5: Implement `LiveTvOverlay.swift`** — the OSD (with `showOSD()` timing), mini-guide, offline panel, control cluster, and remote handlers; `#Preview` with sample `TvChannelCard`s (a `nil`-client/preview `AppModel` so it renders without a network).

- [ ] **Step 6: Build gate** — `xcodegen generate` + app `build` SUCCEEDED (these compile standalone; the first screen wires them in Task 4). No consumer yet, so no live smoke here — the overlay's UI is exercised in Task 4 (rails → tune → OSD/mini-guide/offline against the NAS catalog) and tokened **playback** in Task 8.

- [ ] **Step 7: Commit** — `git add clients/tvos/Sources/Orbix/Design/ChannelLogoView.swift clients/tvos/Sources/Orbix/TV && git commit -m "feat(tvos): live-TV player — ChannelLogoView, zap OSD/mini-guide overlay, failover controller"`

---

### Task 4: TV Home — rails screen (`TvHomeView`) + favorite toggle + Shell wiring

**Files:**
- Create: `clients/tvos/Sources/Orbix/TV/ChannelCard.swift`
- Create: `clients/tvos/Sources/Orbix/TV/ChannelRailView.swift`
- Create: `clients/tvos/Sources/Orbix/TV/TvHomeView.swift`
- Modify: `clients/tvos/Sources/Orbix/Shell/ShellView.swift` (replace the `.tv` placeholder with `TvHomeView`)

**Interfaces:**
- Consumes: `ChannelLogoView`/`ChannelNowNextView`/`LiveTvOverlay`/`LiveTvController` (Task 3), `NowProgressBar`/`QualityChip` (Design), `tvNowProgressFraction`/`tvRegionName` (OrbixKit), `tvHome()`/`setTvFavorite()`/`TvChannelCard`/`TvHome` (OrbixKit), `ImageLoader`, `AppModel` (`client`, `baseURL`), the `RailView`/`LibraryModel` screen idioms (loadState machine, `.focusSection()` rails).
- Produces:
  - `struct ChannelCard: View` — the 16:9 channel tile (web `ChannelCard.tsx`): `ChannelLogoView(gradient:true)` art, bottom scrim with number · name · `QualityChip`, now-playing title + red `NowProgressBar`, offline dot (dims art at 0.5 opacity like web, dot stays full), focus-promote scale (`.card`/`focusPromote` per the `BoxArtCard` precedent). Select = tune (`onPlay`); **favorite toggle via `.contextMenu`** (tvOS long-press Select) — "Add to Favorites" / "Remove from Favorites".
  - `struct ChannelRailView: View` — heading + horizontal `.focusSection()` strip of `ChannelCard`s (the `RailView` structure; no paddles — focus-driven), `onPlay(channel, railChannels)` hands the rail's list as the zap context.
  - `struct TvHomeView: View` + `@MainActor @Observable final class TvHomeModel` — owns its `NavigationStack`; loads `/tv/home` into a `loadState` (loading→skeleton rails / error→retry / empty→member empty state / loaded→rails); renders Recents, Favorites, per-country (heading = `tvRegionName(code) ?? code`), per-category (heading = capitalized id) rails, each non-empty; a channel select opens `LiveTvOverlay` via `.fullScreenCover`; favorite toggle is optimistic (flip the card's `favorite` locally, `setTvFavorite`, revert on throw — the wishlist idiom).

**Web→TV adaptations (explicit):**
- **Empty state (web `TvHomePage.tsx:29-50`, member branch):** when every rail is empty, a `ContentUnavailableView`("Live TV", `tv`, "Live channels aren't set up yet. Ask your server admin to add a TV source.") — **member copy only**; the admin CTA stays web (`tv:empty.memberBody`; the admin-only "Set up TV" button is not ported). Kids never reach here (the TV nav item is hidden and `/tv/*` 403s kids server-side).
- **Rails (web lines 96-125):** Recents → Favorites → countries (largest first, from the server's ordering) → categories; each rendered only when it has channels. Country heading uses `tvRegionName`; category heading capitalizes the id (English; i18n Phase 5).
- **Guide affordance (web lines 86-90):** a small "Guide" `OrbixButton(.ghost)` in the header that pushes the guide route onto the `NavigationStack` (the guide screen lands in Task 5/6; until then, wire the push target and leave the button — annotate as a Task-5 bridge, or gate it behind the guide route once it exists). Prefer: add the button in this task pointing at a `TvGuideRoute` registered in `TvHomeView`'s stack, and add the actual `TvGuideView` destination in Task 5.
- **Favorite toggle:** `TvHomeModel.toggleFavorite(_ card:)` flips the matching card's `favorite` across all rails optimistically, calls `client.setTvFavorite(channelId:on:)`, reverts on error (mirrors `TitleModel.toggleWishlist`). The context menu label reflects current membership.
- **Shell wiring:** in `ShellView.content`, replace the `.tv` `placeholder(...)` with `TvHomeView(model: model)`. Keep the `.onExitCommand { selection = .home }` Menu-walk that the shell already attaches to non-Home sections (spec §6 / the shell's existing per-section fallback). The TV nav item is already hidden for kids (`OrbixTopBar.isKids`).

- [ ] **Step 1: Read the web sources** — `apps/web/src/pages/TvHomePage.tsx`, `components/tv/ChannelCard.tsx`, `ChannelRail.tsx`. Re-read `clients/tvos/Sources/Orbix/Home/{RailView,BoxArtCard}.swift` (rail/focus-section + focus-promote), `Library/LibraryBrowseView.swift` (loadState model + `NavigationStack` idiom), `Title/TitlePage.swift`'s `toggleWishlist` (optimistic-revert shape), and `Shell/ShellView.swift` (`.tv` case + Menu-walk).

- [ ] **Step 2: Implement `ChannelCard.swift`** — the tile with the offline-dim, scrim, quality chip, now bar, focus-promote, `onPlay`, and `.contextMenu` favorite toggle. `.accessibilityIdentifier("channelCard_\(channel.id)")`.

- [ ] **Step 3: Implement `ChannelRailView.swift`** — heading + focus-sectioned `ChannelCard` strip; `.accessibilityIdentifier("channelRail_\(id)")`.

- [ ] **Step 4: Implement `TvHomeView.swift` + `TvHomeModel`** — the loadState machine, rails, `.fullScreenCover` live overlay, optimistic favorites, member empty state, skeleton rails (reuse `SkeletonView`), Guide button (Task-5 bridge). `.accessibilityIdentifier("tvHomeScroll")`.

- [ ] **Step 5: Wire the Shell** — replace `ShellView`'s `.tv` placeholder with `TvHomeView(model: model)`; keep the section Menu-walk. Remove the now-dead `placeholder("Live TV", …)` call if nothing else uses it (Account still does — keep the helper).

- [ ] **Step 6: Build gate** — `xcodegen generate` + app `build` SUCCEEDED.

- [ ] **Step 7: Authenticated smoke + screenshot (vs NAS)** — boot the sim, build+install, then:
  `set -a; source .superpowers/sdd/dev-device-token.env; set +a`
  `BUNDLE_ID=$(xcodebuild -project clients/tvos/Orbix.xcodeproj -scheme Orbix -showBuildSettings 2>/dev/null | awk -F' = ' '/PRODUCT_BUNDLE_IDENTIFIER/{print $2; exit}')`
  `xcrun simctl launch booted "$BUNDLE_ID" -orbixBaseURL "$ORBIX_TEST_BASE_URL" -orbixToken "$ORBIX_TEST_TOKEN"` (token never echoed).
  Select **TV** in the top bar: confirm the rails (Recents/Favorites/country/category) with logo/monogram tiles, number+name scrim, quality chip, offline dot + dimmed art, now-playing title + red progress. Select a channel → the `LiveTvOverlay` presents; confirm the **zap OSD** (auto-hides ~4 s), **channel up/down** cycles the rail context, the **mini-guide** opens and Select tunes in place, and — since the NAS lacks the Phase-0 tokened proxy — the **offline panel** appears after the source ladder is exhausted with graceful "Retry / Next channel" (this is the expected NAS behavior; **real playback is verified in Task 8**). Long-press a tile → favorite toggles (optimistic; persists if the NAS accepts). Capture `xcrun simctl io booted screenshot .superpowers/sdd/phase4-tv-home.png` and `.superpowers/sdd/phase4-live-osd.png`.

- [ ] **Step 8: Commit** — `git add clients/tvos/Sources/Orbix/TV/ChannelCard.swift clients/tvos/Sources/Orbix/TV/ChannelRailView.swift clients/tvos/Sources/Orbix/TV/TvHomeView.swift clients/tvos/Sources/Orbix/Shell/ShellView.swift && git commit -m "feat(tvos): TV Home rails + channel tiles + live tune; wire TV section"`

---

### Task 5: TV Guide — page scaffold, list/grid toggle (persisted), search + filter chips, LIST view

**Files:**
- Create: `clients/tvos/Sources/Orbix/TV/TvGuideView.swift`
- Modify: `clients/tvos/Sources/Orbix/TV/TvHomeView.swift` (register the `TvGuideRoute` destination the header Guide button pushes)

**Interfaces:**
- Consumes: `ChannelLogoView`/`ChannelNowNextView`/`LiveTvOverlay` (Task 3), `tvGuide(...)`/`TvGuideResponse`/`TvChannelCard` (OrbixKit), `tvRegionName` (OrbixKit), `AppModel`, `QualityChip`, the `LibraryModel`/`SearchModel` debounce + cancel-previous-`Task` idioms.
- Produces:
  - `struct TvGuideView: View` + `@MainActor @Observable final class TvGuideModel` — the guide screen: header (title + channel count + **list/grid toggle chips**), a search field, a horizontal **filter chip** row (All / Favorites / per-country / per-category), and the **LIST** view (a `LazyVStack`/`List` of virtualized rows). Offset paging: fetch the next 100 as the list nears its end (web `useTvGuide` infinite paging). The **GRID** toggle renders a placeholder ("Grid view — loading…") until Task 6 fills it, so the toggle + persistence ship here and the risky EPG lands isolated next.
  - `enum GuideView { case list, grid }` persisted in `UserDefaults` under the web's key `"orbix.tv.guideView"` (mirror of `GUIDE_VIEW_STORAGE_KEY`), **default `.list`** (web default; spec §7.8 keeps list as the fallback default).
  - `enum GuideFilter { case all, favorites, country(String), category(String) }` — facets derived **client-side from the unfiltered first page** (web lines 106-116): countries + categories from `base` (the default `tvGuide({})` query), sorted.

**Web→TV adaptations (explicit)** (web `apps/web/src/pages/TvGuidePage.tsx`):
- **Toggle + filter chips → focusable chip buttons** (the `SortChipStyle`/`Chip` adaptation from `LibraryBrowseView`): `Capsule`/rounded chips, selected chip accent-tinted, focused chip white+scaled. Country chip label = `tvRegionName(code) ?? code`; category chip label = capitalized id.
- **Search → on-page `TextField`** (the `LibraryBrowseView.filterField` pattern, **not** `.searchable` — avoids the `OrbixTopBar` collision), debounced ~300 ms in `TvGuideModel` (the `queryChanged` cancel-previous-`Task` idiom). Placeholder = web `tv:guidePage.searchPlaceholder` ("Search channels…").
- **List rows (web lines 225-272):** each row = number (`.monospacedDigit()`) · `ChannelLogoView` (flat) · name + `ChannelNowNextView(now,next)` · `QualityChip`; **Select tunes** (opens `LiveTvOverlay` with the full loaded `channels` as the zap context); a secondary **info** action → **channel page** (`TvChannelRoute`, registered/landed in Task 7 — until then push a route the stack registers; annotate as a Task-7 bridge, OR gate the info action behind the channel route once it exists). Virtualize with `LazyVStack` inside a `ScrollView` (row height ~ web's 72), loading the next page when the last row nears view (`onAppear` on the tail row).
- **Filter/search reset:** on filter or query change, reset scroll to top and refetch page 0 (web's scroll reset). Favorites filter with zero favorites → empty list (server returns `total:0`).
- **Header count:** "N channels" from `total` (web `tv:guidePage.channelCount`).
- Presented within the **TV section's** `NavigationStack`: the TV Home header "Guide" button pushes `TvGuideRoute`; `TvHomeView` registers `.navigationDestination(for: TvGuideRoute.self) { TvGuideView(model: model, path: $path) }` and passes the shared `path` so the guide's info action can push `TvChannelRoute` onto the same stack.

- [ ] **Step 1: Read the web source** — `apps/web/src/pages/TvGuidePage.tsx` (toggle persistence, facet derivation, debounce, infinite paging, list-row lockup, grid handoff). Re-read `clients/tvos/Sources/Orbix/Library/LibraryBrowseView.swift` (`filterField`, `SortChipStyle`, `LibraryModel` debounce/cancel-previous) and `Search/SearchView.swift` (grid/loadState idioms).

- [ ] **Step 2: Implement `TvGuideModel`** — offset paging (`offset`/`limit`, append pages), `filter`/`query` state, facets from the base page, debounce, cancel-previous `Task`, `UserDefaults` view persistence. Guard against clobbering (cancel-previous). Favorites-empty short-circuit.

- [ ] **Step 3: Implement `TvGuideView`** — header (title, count, list/grid chips), search field, filter chip row, LIST view (virtualized rows, tune, info→channel-route bridge, next-page-on-tail), grid placeholder, `.fullScreenCover` live overlay, empty/loading states. `.accessibilityIdentifier`s (`tvGuideView`, `tvGuideList`, `tvGuideToggle_list/grid`, `tvGuideRow_\(id)`).

- [ ] **Step 4: Register the route** in `TvHomeView` (`TvGuideRoute`) and wire the header Guide button push.

- [ ] **Step 5: Build gate** — `xcodegen generate` + app `build` SUCCEEDED.

- [ ] **Step 6: Authenticated smoke + screenshot (vs NAS)** — launch as in Task 4 Step 7; open **TV → Guide**: confirm the channel count, the list/grid toggle (flip to grid → placeholder; flip back → list persists across relaunch), search filtering, filter chips (All/Favorites/country/category, facets from the first page), virtualized rows with logo/now-next/red progress/quality chip, Select tunes, and info → channel page (once Task 7 lands; bridge until then). Capture `.superpowers/sdd/phase4-guide-list.png`.

- [ ] **Step 7: Commit** — `git add clients/tvos/Sources/Orbix/TV/TvGuideView.swift clients/tvos/Sources/Orbix/TV/TvHomeView.swift && git commit -m "feat(tvos): TV Guide list + filter chips + persisted list/grid toggle"`

---

### Task 6: TV Guide — the TiviMate-style time×channel EPG grid

**Files:**
- Create: `clients/tvos/Sources/Orbix/TV/TvGuideGridView.swift`
- Modify: `clients/tvos/Sources/Orbix/TV/TvGuideView.swift` (render `TvGuideGridView` for the grid toggle)

**Interfaces:**
- Consumes: the Task-2 math (`tvFloorToHour`/`tvShiftHours`/`tvPrimeTimeOnDay`/`tvComputeBlockRect`/`tvGenerateTimeTicks`/`tvNowLinePercent`), `tvGrid(...)`/`TvGridResponse`/`TvGridChannel`/`TvGridProgramme` (OrbixKit), `ChannelLogoView`, `LiveTvOverlay`, a locale `DateFormatter` (HH:MM ruler + window label), `AppModel`.
- Produces: `struct TvGuideGridView: View` + `@MainActor @Observable final class TvGuideGridModel` — the bounded 4-hour EPG over a `start` window, with Now/Prev/Next/Today/Tomorrow-prime controls, a sticky time ruler + sticky channel column, programme blocks positioned by the ported percentage math, an airing-block accent tint, a red per-row now-line, focusable blocks (focus = highlight, Select = tune), and a channel-limit note.

**Web→TV adaptations (explicit)** (web `apps/web/src/components/tv/TvGuideGrid.tsx`):
- **Window/nav:** `HOURS = 4`, `start` = `tvFloorToHour(Date())`; Now/Today → `tvFloorToHour(now)`; Prev/Next → `tvShiftHours(start, ∓4)`; Tomorrow → `tvPrimeTimeOnDay(1, 18)`. Window label = `weekday day month · HH:MM–HH:MM` via a locale `DateFormatter`. Load via `tvGrid(start: start.ISO, hours: 4, limit: 80, …filter)` where `filter` is the shared guide filter (country/category/favorites/q) passed from `TvGuideView`.
- **Layout (fixed pixel track, percentage blocks — no DOM measuring):** channel column width ~360pt, time track width = `HOURS * (a fixed per-hour width, e.g. 520pt)`, row height ~100pt, ruler height ~64pt (×1.5-ish for 10-ft). Ticks from `tvGenerateTimeTicks(windowStartMs, WINDOW_MS)`; each block's `left`/`width` from `tvComputeBlockRect(p.start, p.stop, windowStartMs, WINDOW_MS)` (skip `width <= 0`). **The tvOS focus engine drives horizontal + vertical scroll** — no manual sticky-scroll offset math; render the ruler and channel column as pinned headers (`ScrollView([.horizontal, .vertical])` with a sticky ruler row and a leading channel cell per row, or a `LazyVStack` of rows where each row is `channel-cell | ZStack(blocks)`). Given spec §13 (grid focus is the hardest surface), prefer the **simplest focusable structure**: a vertically-`LazyVStack` list of channel rows; within a row, an `HStack` of the sticky channel button + a `ZStack` time-track whose programme blocks are focusable `Button`s positioned with `.offset`/`.frame` from the percentage math (convert `left%`/`width%` to points against the fixed track width). Horizontal navigation within a row moves block→block; vertical moves row→row. Keep each row a `.focusSection()` so up/down hands off cleanly.
- **Airing block + now-line:** a block whose `[start,stop)` contains `now` is tinted `OrbixColor.accent.opacity(0.2)`; the now-line is a 2pt `OrbixColor.live` rule at `tvNowLinePercent(...)%` of the track, drawn **per row** (the web's per-row now-line rationale — a single overlay would fight the sticky channel column's stacking; per-row segments read as one continuous line and avoid focus/stacking conflicts).
- **Empty programmes:** a channel with no programmes in the window shows the "No guide data" text across its track (web `tv:guidePage.noEpg`).
- **Channel-limit note (web lines 279-283):** when `total > channels.count`, a footer "Showing N of M channels — narrow the filter to see more." (web `tv:grid.showingOf`).
- **Tune:** focusing + Select on a block **or** the channel cell tunes the channel (opens `LiveTvOverlay` with the grid's channels bridged to the zap-context `TvChannelCard` shape — `now/next = nil`, mirroring web `handleGridTune`).
- **Fallback stance (spec §13):** list stays the default view; if grid focus proves janky on-device, the list view already covers the use case. Build the grid, keep list default.

- [ ] **Step 1: Read the web source** — `apps/web/src/components/tv/TvGuideGrid.tsx` (window nav, layout constants, block/tick/now-line positioning, airing tint, sticky structure, channel-limit note, `handleGridTune`). Re-read Task-2's `TvGridLayout.swift` signatures.

- [ ] **Step 2: Implement `TvGuideGridModel`** — window `start` + nav actions, `tvGrid` load keyed by `(start, filter)`, `channels`/`total`, loadState. Reset on filter/window change.

- [ ] **Step 3: Implement `TvGuideGridView`** — the nav control row (Now/Prev/window-label/Next/Today/Tomorrow), the ruler, the `LazyVStack` of focusable rows (channel cell + positioned blocks + per-row now-line + airing tint), the empty-per-row text, and the channel-limit footer. `.accessibilityIdentifier`s (`tvGuideGrid`, `tvGridRow_\(id)`, `tvGridBlock_\(programmeId)`, `tvGridNav_now/prev/next/today/tomorrow`).

- [ ] **Step 4: Wire into `TvGuideView`** — render `TvGuideGridView(model:filter:onTune:)` for the grid toggle (replacing the Task-5 placeholder), passing the shared filter + tune handler.

- [ ] **Step 5: Build gate** — `xcodegen generate` + app `build` SUCCEEDED.

- [ ] **Step 6: Authenticated smoke + screenshot (vs NAS)** — launch as before; **TV → Guide → Grid**: confirm the 4-hour window, sticky ruler + channel column, programme blocks positioned correctly (spot-check an airing programme lands under the red now-line and is accent-tinted), Prev/Next/Now/Today/Tomorrow re-window, **focus moves block↔block and row↔row**, Select tunes, and the channel-limit note when the filter matches more than the cap. Verify focus feels navigable (spec §13 acceptance — if janky, note it for the Phase-4 gate; list remains default). Capture `.superpowers/sdd/phase4-guide-grid.png`.

- [ ] **Step 7: Commit** — `git add clients/tvos/Sources/Orbix/TV/TvGuideGridView.swift clients/tvos/Sources/Orbix/TV/TvGuideView.swift && git commit -m "feat(tvos): TV Guide EPG grid (TiviMate-style 4h window, ported layout math)"`

---

### Task 7: TV Channel page (`TvChannelView`)

**Files:**
- Create: `clients/tvos/Sources/Orbix/TV/TvChannelView.swift`
- Modify: `clients/tvos/Sources/Orbix/TV/TvGuideView.swift` + `clients/tvos/Sources/Orbix/TV/TvHomeView.swift` (register the `TvChannelRoute` destination; wire the guide list-row info action to push it)

**Interfaces:**
- Consumes: `tvChannel(id:)`/`tvProgrammes(id:day:)`/`setTvFavorite`/`TvChannelDetail`/`TvProgramme` (OrbixKit), `ChannelLogoView`/`LiveTvOverlay` (Task 3), `tvRegionName`/`tvDayString` (OrbixKit), a locale `DateFormatter` (schedule HH:MM), `OrbixButton`, `AppModel`.
- Produces: `struct TvChannelView: View` + `@MainActor @Observable final class TvChannelModel` — the channel detail page: hero (logo, number, name, quality/region/category badges, offline dot), favorite toggle, **Watch** button, and a Today/Tomorrow schedule with ON-NOW highlight.

**Web→TV adaptations (explicit)** (web `apps/web/src/pages/TvChannelPage.tsx`):
- **Hero (web lines 42-79):** `ChannelLogoView` (large, ~160×96) + "Channel N" + name + a badge row: `QualityChip` (quality), region (`tvRegionName(country)`), each category (capitalized), and an offline dot ("● Offline", `OrbixColor.textDim`) when `!healthy`. Badges as bordered chips (`OrbixColor.surface2` stroke), matching web.
- **Favorite toggle (web lines 68-78):** a heart button, accent when favorite; optimistic flip + `setTvFavorite(channelId:on:)`, revert on error (wishlist idiom). Also exposes the same toggle the Home tile's context menu does (spec §7.7).
- **Watch (web lines 81-85):** `OrbixButton(.primary)` with a play glyph → opens `LiveTvOverlay(channels: [thisChannelAsCard], initialId: c.id, model:)` (single-channel zap context, web `channels={[c]}`). Bridge the `TvChannelDetail` to a `TvChannelCard`-shaped context (now/next nil).
- **Schedule (web lines 87-156):** a Today/Tomorrow tab pair (`tvDayString(0)`/`tvDayString(1)` → the `?day=` param); each programme row = `HH:MM–HH:MM` (locale `DateFormatter`) · title (+ 2-line description); the **on-air** row (`start <= now < stop`, single `now` snapshot for the whole render) is highlighted (`OrbixColor.live` ring + surface tint) with an **"ON NOW"** badge (web `tv:channel.onNow`, red). Empty schedule → "No schedule available" (`tv:channel.noSchedule`).
- Reached via `TvChannelRoute(channelId:)` pushed from the guide list-row info action (and, optionally, from a grid channel-cell long-press) onto the shared TV `NavigationStack`; owns no stack of its own (it's a pushed destination).

- [ ] **Step 1: Read the web source** — `apps/web/src/pages/TvChannelPage.tsx` (hero badges, favorite, Watch, day tabs, on-air highlight, ON-NOW badge). Re-read `clients/tvos/Sources/Orbix/Title/TitlePage.swift` (pushed-destination + optimistic-toggle shape) and `Design/OrbixButton.swift`.

- [ ] **Step 2: Implement `TvChannelModel`** — loads `tvChannel(id:)` + `tvProgrammes(id:day:)` (re-fetch on day-tab change), optimistic favorite toggle, loadState.

- [ ] **Step 3: Implement `TvChannelView`** — hero, badges, favorite heart, Watch (`.fullScreenCover` overlay), Today/Tomorrow schedule with ON-NOW highlight, empty/loading. `.accessibilityIdentifier`s (`tvChannelView_\(id)`, `tvChannelWatchButton`, `tvChannelFavoriteButton`, `tvChannelScheduleTab_today/tomorrow`).

- [ ] **Step 4: Register the route + wire the guide info action** — add `.navigationDestination(for: TvChannelRoute.self) { TvChannelView(channelId: $0.channelId, model: model) }` where the shared TV `path` lives (register once on `TvHomeView`'s stack; `TvGuideView`/`TvGuideGridView` push onto the same `path`). Convert the Task-5 guide info bridge into a real `TvChannelRoute` push.

- [ ] **Step 5: Build gate** — `xcodegen generate` + app `build` SUCCEEDED (confirm no dangling Task-5/6 bridge routes: `grep -rn "TvChannelRoute\|TvGuideRoute" clients/tvos/Sources` resolves cleanly).

- [ ] **Step 6: Authenticated smoke + screenshot (vs NAS)** — launch as before; from the Guide list, trigger a row's **info** → the channel page: confirm the hero (logo/number/name/quality/region/category badges/offline dot), the favorite toggle (optimistic), **Watch** opens the live overlay (offline panel vs NAS — playback verified in Task 8), and the Today/Tomorrow schedule with the ON-NOW highlight on the airing programme. Capture `.superpowers/sdd/phase4-channel-page.png`.

- [ ] **Step 7: Commit** — `git add clients/tvos/Sources/Orbix/TV/TvChannelView.swift clients/tvos/Sources/Orbix/TV/TvGuideView.swift clients/tvos/Sources/Orbix/TV/TvHomeView.swift && git commit -m "feat(tvos): TV Channel page (hero, favorite, Watch, day schedule with ON NOW)"`

---

### Task 8: Phase 4 gate — full gates, catalog/EPG live record vs NAS, tokened live playback via a throwaway local stack, parity screenshots + deviations

**Files:** none (verification + record only). If a defect surfaces that needs a code touch, fix it in the owning task's files and re-run that task's gate before this one.

- [ ] **Step 1: Full gates** — `cd clients/tvos && xcodegen generate`; app `build` SUCCEEDED; `OrbixKitTests` `test` all pass (Task-1 TV DTO suite + Task-2 `TvGridLayoutTests` green; every pre-existing suite still green). No server change → no `pnpm` gates required (confirm `git status` shows no `apps/api/**` edits).

- [ ] **Step 2: Catalog/EPG visual record vs the NAS** — launch in the simulator against the NAS (`set -a; source .superpowers/sdd/dev-device-token.env; set +a`; launch with `-orbixBaseURL`/`-orbixToken` as in Task 4 Step 7; token never printed). Side-by-side compare with the web app: **TV Home** rails, **Guide list** (rows/filters/search/toggle persistence), **Guide grid** (window/ruler/blocks/now-line/focus), **Channel page** (hero/badges/schedule/ON-NOW). Confirm a **kids** profile hides the TV nav item and `/tv/*` 403s server-side (nothing over-renders). Screenshots already captured per task; add `.superpowers/sdd/phase4-tv-home.png`, `phase4-guide-list.png`, `phase4-guide-grid.png`, `phase4-channel-page.png` to the record.

- [ ] **Step 3: Tokened live-PLAYBACK verification via a throwaway local stack (from this branch).** The NAS lacks the Phase-0 query-token auth, so this is the only path that exercises the real tokened proxy code path. **Never** use the dev `orbix` DB / the compose `./data/postgres` volume (divergent-migration hazard). Recipe:
  - **Ports:** check `1060-1063` availability (`lsof -iTCP -sTCP:LISTEN -n -P | grep -E ':(1060|1061|1062|1063)'`). If the repo's `docker compose` stack is already up, those are taken → use free ports (e.g. api `1071`, postgres `15432`, redis `16379`); otherwise the compose defaults are fine. Record the chosen ports.
  - **Throwaway datastores:** bring up **fresh, ephemeral** containers (no bind-mount to `./data`): e.g. `docker run -d --name orbix-tv-smoke-pg -e POSTGRES_USER=orbix -e POSTGRES_PASSWORD=orbix -e POSTGRES_DB=orbix_tvsmoke -p <pgPort>:5432 pgvector/pgvector:pg16` and `docker run -d --name orbix-tv-smoke-redis -p <redisPort>:6379 redis:7-alpine`. Wait for `pg_isready`.
  - **API from the branch (host-side, most reliable):** apply migrations then run the dev server against the throwaway datastores:
    `DATABASE_URL='postgresql://orbix:orbix@127.0.0.1:<pgPort>/orbix_tvsmoke' pnpm --filter @orbix/db exec prisma migrate deploy`
    then `DATABASE_URL=… REDIS_URL='redis://127.0.0.1:<redisPort>' SESSION_SECRET='dev-session-secret-change-me-32chars' API_PORT=<apiPort> WEB_ORIGIN='http://localhost:<apiPort>' MOUNTS_DIR=/tmp/orbix-tvsmoke-mounts pnpm --filter @orbix/api dev` (run in background; it's a `tsx watch` host dev server — **reap it in teardown**).
  - **Seed via the admin API (curl, cookie jar):** `POST /api/setup` with a throwaway email/password → `POST /api/auth/login` (keep the session cookie in a jar) → `POST /api/tv/sources` `{kind:"iptv-org", name:"Smoke", countries:["<ONE country, e.g. GB>"]}` → `POST /api/tv/sources/:id/sync` → poll `GET /api/tv/sources` (or `/tv/sync/events`) until the sync completes and `GET /api/tv/guide` returns channels.
  - **Pair a device token:** `POST /api/pair/initiate` `{name:"tv-smoke", platform:"tvos"}` → note the `code` + `pollToken` → `POST /api/pair/approve` `{code}` **with the session cookie** → `GET /api/pair/poll?token=<pollToken>` returns `{status:"approved", deviceToken, deviceId}`. Select a profile for the device if required (the pairing/profile flow), so `/tv/*` catalog + play succeed.
  - **Point the simulator at the local stack** (the sim shares the host network): `xcrun simctl launch booted "$BUNDLE_ID" -orbixBaseURL http://127.0.0.1:<apiPort> -orbixToken <deviceToken>` (pass by reference; never echo). Open **TV → a channel** and verify **live playback plays end-to-end through the tokened proxy** (the Phase-0 `?token=` path, exercised for real): the stream starts, the OSD/now-next show, **channel up/down zaps** to another channel and plays, and a **dead source fails over** within a few seconds to the next source (spec §13 acceptance). Capture `.superpowers/sdd/phase4-live-playback.png`.
  - **Teardown (mandatory):** stop the API dev server (`pkill -f "tsx.*apps/api"` / `pkill -f "tsx.*watch"`), `docker rm -f orbix-tv-smoke-pg orbix-tv-smoke-redis`, and free the chosen ports. Confirm no stray `tsx`/`vite` remain and the compose stack (if any) is untouched.

- [ ] **Step 4: Parity + deviations** — confirm ChannelCard/logo/now-next/quality/offline, guide list rows, EPG grid blocks/now-line, and the channel schedule match the web on the same channels. Record any deviations (e.g. EPG grid focus feel, AVPlayer-vs-hls.js failover timing, the monogram HSL rounding) in `.superpowers/sdd/progress.md` for the Phase-6 audit rather than gold-plating. Note the known NAS constraint: catalog/EPG verified vs NAS, tokened playback verified vs the throwaway stack (full NAS playback lands when the NAS updates in Phase 6).

- [ ] **Step 5: Commit** — the record/screenshots are typically untracked artifacts; if `.superpowers/sdd/progress.md` is updated, `git add .superpowers/sdd/progress.md && git commit -m "docs(tvos): phase 4 gate — live TV visual record + local-stack playback verification"`. (No source changes → nothing else to commit.)

---

## Self-review notes

- **Spec coverage:** §7.7 TV Home — rails (Recents/Favorites/localized country/category), `ChannelCard` (logo/monogram, number+name scrim, quality chip, offline dot, now + red progress), select = tune, favorite via long-press context menu, member empty state (Task 4); §7.8 TV Guide — list/grid toggle persisted to `orbix.tv.guideView`, search, filter chips (facets client-side from the first page), virtualized LIST rows with info→channel, TiviMate 4-hour EPG GRID with sticky ruler/column, ported block/tick/now-line math, airing tint, red now-line, focusable blocks, channel-limit note (Tasks 5-6); §7.9 Channel page — hero/badges/offline dot, favorite, Watch, Today/Tomorrow schedule with ON-NOW (Task 7); §7.10 Live player — its **own** lightweight controller (zap, last-channel, mini-guide, zap OSD auto-hide 4 s, offline panel, multi-source failover ladder + per-source health, watch events) (Task 3); §3 — verified the tv-proxy tokened change already landed in Phase 0 (`6293760`), so Phase 4 is client-only; §10 — DTO decode tests (Task 1) + EPG/time math tests with web vectors (Task 2) + authenticated simulator record incl. tokened playback (Task 8); §13 — bounded 4-hour window, `LazyVStack` row virtualization, ported math, list kept as default (grid built, list-fallback stance), AVPlayer-appropriate failover ladder + dead-channel watchdog for "fail over in a few seconds".
- **Live player is NOT the VOD player:** `LiveTvController` + `LiveTvPlayerView` are new, with no `PlaybackController` progress chain, no resume seek, no `/playback/info`; the VOD stack is untouched.
- **Forward-dependency ordering (reason for the 8-task split):** the live overlay is a shared dependency of every catalog screen ("select = tune"), so it's built (Task 3) before the screens (Tasks 4-7) that present it; `ChannelLogoView` is a Design primitive reused by cards, OSD, mini-guide, and the channel hero, so it ships with the overlay. The risky EPG grid is isolated in its own task (6) after the guide scaffold (5), so the list view + toggle persistence ship green even if the grid needs iteration.
- **Green builds per commit:** Task-3 components/overlay compile with previews (no consumer yet); Tasks 4/5/7 register their own pushed routes and use annotated bridges only where a later task lands the destination (guide info→channel in Task 5, filled in Task 7); Task 6 replaces the Task-5 grid placeholder in one commit.
- **DTO decode-safety:** every optional wire field is `Optional` (now/next absent on favorites/grid → nil); `TvStreamRef.protocol` uses a backticked property so Codable maps the `"protocol"` key without custom keys; all fixtures are real handler shapes.
- **Verification honesty:** catalog/EPG UI is live-verifiable vs the NAS (bearer-ready on main); tokened live **playback** is only verifiable against the throwaway local stack from this branch (Task 8), never the dev `orbix` DB — the NAS playback path lands in Phase 6.
- **No placeholders in load-bearing code:** the EPG/time math port + its ported test vectors, the failover ladder state machine, the OSD 4 s auto-hide timing, the 30 s health report, and the HSL→sRGB monogram conversion are complete; view scaffolding follows the existing `LibraryBrowseView`/`RailView`/`TitlePage` idioms.
