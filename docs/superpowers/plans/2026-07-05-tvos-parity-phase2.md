# tvOS Parity Rebuild — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the four tvOS consumption surfaces — Home (billboard + box-art rails), Library browse, Search, Wishlist — to web visual parity (TV-adapted: hover→focus), and add the OrbixKit endpoints + pure-logic ports they depend on. Exit gate: side-by-side vs web Home/Library/Search/Wishlist against the NAS.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-05-tvos-parity-rebuild-design.md` (§5 design system, §7 screens 2/3/5/6, §10 testing, §11 phasing). Builds on Phase 1's design system (`Sources/Orbix/Design/`), custom shell (`Sources/Orbix/Shell/`), and OrbixKit client/DTOs. New reusable art (`BoxArtCard`, `RailView`) lives in the app target; new pure logic that needs unit tests (billboard daily-pick, NEW-badge window, resume label) lives in **OrbixKit** (the only tested target). New endpoints + DTOs extend `OrbixClient`/`DTOs.swift`. Web components under `apps/web/src/**` are the visual source of truth; server wire shapes are verified against `apps/api/src/routes/**`.

**Tech Stack:** SwiftUI, tvOS 17, Swift 6, XcodeGen; XCTest (OrbixKitTests). One scoped server change (Fastify + vitest) for device-token wishlist profile resolution — see Task 1 and the ambiguity note at the end.

## Global Constraints

- **Web is the visual source of truth.** Read the named `apps/web/src/**` component/page before writing each surface; mirror layout, art treatment, badges, states. Where a web behavior is mouse/hover-specific (chevron paddles, `<select>` dropdown, `<Input>` focus ring), use the TV adaptation named in the task rather than inventing one.
- **DTOs mirror wire shapes verified against route handlers.** Every non-key field is `Optional` (decode-safe convention; a missing key and explicit `null` both decode to `nil`). Test fixtures in `DTOTests.swift` must be real wire shapes copied from the route handler, not invented.
- **Pure logic that needs tests goes in OrbixKit** (`Sources/OrbixKit/`), tested in `Tests/OrbixKitTests/`. TDD for all OrbixKit logic: write the failing test first, run it to confirm failure, then implement.
- **Repo gates (server tasks):** `pnpm typecheck && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api test` — run lint **separately** per CLAUDE.md (Turbo cache can hide lint-only errors).
- **Build/test gates (tvOS):** regenerate after file adds: `cd clients/tvos && xcodegen generate`; then
  `xcodebuild -project Orbix.xcodeproj -scheme Orbix -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' build CODE_SIGNING_ALLOWED=NO`
  and for kit changes `xcodebuild -project Orbix.xcodeproj -scheme OrbixKitTests -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' test CODE_SIGNING_ALLOWED=NO`.
  **Substitution note:** if that simulator name is unavailable, pick one from `xcrun simctl list devices available | grep "Apple TV"` and substitute it in `-destination`.
- **Swift 6 language mode:** new types crossing actor boundaries are `Sendable`; UI models are `@MainActor @Observable`. OrbixKit pure functions are free functions on `Sendable` inputs.
- **Token-only colors:** use `OrbixColor`/`OrbixRadius`/`OrbixSpacing`/`OrbixType`. No raw hex or ad-hoc `Color(red:…)` in view code.
- **No hardcoded server origins or tokens** in committed code (the existing launch-arg/env mechanism stays: `-orbixBaseURL`/`-orbixToken`, `ORBIX_BASE_URL`/`ORBIX_TOKEN`).
- **Authenticated simulator smokes** use the device-token env file at `.superpowers/sdd/dev-device-token.env` (keys `ORBIX_TEST_BASE_URL`, `ORBIX_TEST_TOKEN`). Load it into the shell (`set -a; source .superpowers/sdd/dev-device-token.env; set +a`) and pass `"$ORBIX_TEST_TOKEN"` by reference — **never print or echo the token**. (Simulator keychain does not persist; launch args are the only auth path there.)
- **Commit after every task** (small commits on branch `tv-ui`; verify with `git branch --show-current`). Each commit must leave build + kit tests green.

---

### Task 1: OrbixKit endpoints + DTOs (library items, wishlist CRUD, search mode, card fields) + wishlist device-profile server fix

**Files:**
- Modify: `clients/tvos/Sources/OrbixKit/DTOs.swift`
- Modify: `clients/tvos/Sources/OrbixKit/OrbixClient.swift`
- Modify: `clients/tvos/Sources/Orbix/Search/SearchView.swift` (one-line caller fix for the changed `search` return type — full restyle is Task 6)
- Modify: `apps/api/src/routes/wishlist.ts` (device-profile resolution — see ambiguity note)
- Test: `clients/tvos/Tests/OrbixKitTests/DTOTests.swift` (extend)
- Test: `apps/api/src/routes/wishlist.test.ts` (extend — device-token coverage)

**Interfaces:**
- Consumes: existing `perform`/`send`/`encodeBody` plumbing in `OrbixClient`; decode-safe DTO conventions; `activeProfileId(app, req)` from `apps/api/src/lib/catalog-filter.ts`.
- Produces (OrbixKit):
  - `MediaCard` gains `public var addedAt: String?` and `public var matchState: String?` (both decode-safe Optional; update memberwise `init`). Remove the "addedAt deliberately ignored" clause from the type doc comment.
  - `public struct WishlistIdsResponse: Codable, Sendable, Equatable { public var ids: [String] }`
  - `MenuItem` and `MenuResponse` change `Decodable` → `Codable` (file-wide convention consistency; no behavior change, Encodable is synthesized).
  - `func libraryItems(id: String, sort: String = "title", q: String? = nil) async throws -> [MediaCard]` — `GET /api/libraries/:id/items?sort=&q=`.
  - `func wishlist() async throws -> [MediaCard]` — `GET /api/wishlist`.
  - `func wishlistIds() async throws -> [String]` — `GET /api/wishlist/ids`.
  - `func addToWishlist(itemId: String) async throws` — `POST /api/wishlist/:itemId`.
  - `func removeFromWishlist(itemId: String) async throws` — `DELETE /api/wishlist/:itemId`.
  - `func search(query: String) async throws -> SearchResponse` — **return type changed** from `[MediaCard]` so callers can read `usedEmbeddings`.
- Produces (server): the four `wishlist.ts` handlers resolve the profile via `activeProfileId(app, req)` instead of `req.cookies["orbix_profile"]`, so device (bearer) clients work identically to `/home/rows` and `/playstate`. Cookie behavior unchanged.

**Verified wire shapes (copied from handlers):**
- `GET /libraries/:id/items` (`apps/api/src/routes/catalog.ts:7-62`) → **bare array**, each item `{ id, title, year, posterPath, matchState }` (title localized; `year`/`posterPath` nullable). Sorts: `title|added|year` (invalid → 400 `{error:"invalid_sort"}`). `q` filters base title, case-insensitive.
- `GET /wishlist` (`apps/api/src/routes/wishlist.ts:9-45`) → **bare array**, newest-first, each `{ id, title, year, posterPath, matchState }`; `[]` when empty.
- `GET /wishlist/ids` (`wishlist.ts:49-68`) → `{ ids: string[] }`.
- `POST`/`DELETE /wishlist/:itemId` (`wishlist.ts:72-112`) → `{ ok: true }` (idempotent; POST 404s unknown/kids-blocked).
- `GET /search?q=` (`apps/api/src/routes/discovery.ts:310-452`) → `{ items: [{id,title,year,posterPath,matchState}], usedEmbeddings: boolean }`.

- [ ] **Step 1: Read the handlers + web callers** — `apps/api/src/routes/catalog.ts` (`/libraries/:id/items`), `apps/api/src/routes/wishlist.ts`, `apps/api/src/routes/discovery.ts` (`/search`), `apps/api/src/lib/catalog-filter.ts` (`activeProfileId`), `apps/api/src/plugins/session.ts` (confirm bearer never falls back to cookies), and `apps/web/src/lib/queries.ts` (`useLibraryItems`, `useWishlist`, `useWishlistIds`, `useToggleWishlist`, `useSearch`) for query-param construction and cache semantics.

- [ ] **Step 2: Write failing DTO decode tests** in `DTOTests.swift` (follow the file's fixture style — JSON string → decode → assert). Real fixtures:

```swift
// MARK: - Library items (Phase 2 Task 1) — GET /libraries/:id/items (bare array)

func testDecodeLibraryItemsBareArray() throws {
    // apps/api/src/routes/catalog.ts:44-60 select: {id,title,year,posterPath,matchState}
    // (title localized). Bare array, no envelope. year/posterPath nullable;
    // an unmatched item carries matchState:"unmatched" and a null poster.
    let json = """
    [{"id":"m1","title":"Arrival","year":2016,"posterPath":"/p1.jpg","matchState":"matched"},
     {"id":"m2","title":"Untitled Import","year":null,"posterPath":null,"matchState":"unmatched"}]
    """.data(using: .utf8)!
    let items = try JSONDecoder().decode([MediaCard].self, from: json)
    XCTAssertEqual(items.count, 2)
    XCTAssertEqual(items[0].id, "m1")
    XCTAssertEqual(items[0].matchState, "matched")
    XCTAssertEqual(items[1].matchState, "unmatched")
    XCTAssertNil(items[1].year)
    XCTAssertNil(items[1].posterPath)
    // Fields not on this wire shape decode to nil, not throw.
    XCTAssertNil(items[0].backdropPath)
    XCTAssertNil(items[0].addedAt)
    XCTAssertNil(items[0].progress)
}

// MARK: - Wishlist (Phase 2 Task 1)

func testDecodeWishlistItemsBareArray() throws {
    // apps/api/src/routes/wishlist.ts:38-44 — newest-first, {id,title,year,posterPath,matchState}.
    let json = """
    [{"id":"m2","title":"Beta","year":2020,"posterPath":"/p2.jpg","matchState":"matched"},
     {"id":"m1","title":"Alpha","year":2019,"posterPath":"/p1.jpg","matchState":"manual"}]
    """.data(using: .utf8)!
    let items = try JSONDecoder().decode([MediaCard].self, from: json)
    XCTAssertEqual(items.map(\.id), ["m2", "m1"])
    XCTAssertEqual(items.first?.matchState, "matched")
}

func testDecodeWishlistEmpty() throws {
    // wishlist.ts:18 returns [] when there are no entries.
    let items = try JSONDecoder().decode([MediaCard].self, from: Data("[]".utf8))
    XCTAssertTrue(items.isEmpty)
}

func testDecodeWishlistIdsResponse() throws {
    // wishlist.ts:67 → {ids:[...]}; :58 → {ids:[]} when empty.
    let json = """
    {"ids":["m2","m1"]}
    """.data(using: .utf8)!
    let response = try JSONDecoder().decode(WishlistIdsResponse.self, from: json)
    XCTAssertEqual(response.ids, ["m2", "m1"])
    let empty = try JSONDecoder().decode(WishlistIdsResponse.self, from: Data(#"{"ids":[]}"#.utf8))
    XCTAssertTrue(empty.ids.isEmpty)
}

// MARK: - MediaCard new fields (Phase 2 Task 1)

func testDecodeHomeCardAddedAtNowModeled() throws {
    // discovery.ts:285 sends addedAt on every home-row card; it is now modeled
    // (needed by the billboard/box-art NEW badge — Task 2/3). matchState is
    // absent on home cards and must decode to nil.
    let json = """
    {"id":"m1","title":"Arrival","year":2016,"posterPath":"/p1.jpg",
     "backdropPath":"/b1.jpg","addedAt":"2026-07-01T00:00:00.000Z",
     "progress":null,"resume":null}
    """.data(using: .utf8)!
    let card = try JSONDecoder().decode(MediaCard.self, from: json)
    XCTAssertEqual(card.addedAt, "2026-07-01T00:00:00.000Z")
    XCTAssertEqual(card.backdropPath, "/b1.jpg")
    XCTAssertNil(card.matchState)
}
```

- [ ] **Step 3: Write the failing server test** in `wishlist.test.ts` — device (bearer) path. Mirror the `stubDeviceAuth` shape from the Phase 0-1 plan Task 1 (`apps/api/src/routes/stream.token.test.ts` `stubAuth` + `hashDeviceToken`), giving the device a standard `activeProfileId`. The existing file's `authed`/`cookies` cookie tests stay untouched.

```ts
import { hashDeviceToken } from "@orbix/core"; // add to imports
const RAW = "orb_wishlist-device";
const HASH = hashDeviceToken(RAW);

function deviceAuthed(app: any) {
  app.prisma.deviceToken = {
    findUnique: async ({ where }: any) =>
      where.tokenHash === HASH || where.id === "dev1"
        ? { id: "dev1", accountId: "a1", activeProfileId: "p1", revokedAt: null }
        : null,
    update: async () => ({}),
  };
  app.prisma.profile = {
    findUnique: async () => ({ id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null, language: "en" }),
  };
}

describe("GET /wishlist (device bearer)", () => {
  it("resolves the device row's active profile (no cookie) and returns cards", async () => {
    const app = await buildApp(env);
    deviceAuthed(app as any);
    (app as any).prisma.wishlistEntry = { findMany: async () => [{ mediaItemId: "m1" }] };
    (app as any).prisma.mediaItem = { findMany: async () => [card("m1", "Alpha")] };
    const res = await app.inject({
      method: "GET", url: "/api/wishlist",
      headers: { authorization: `Bearer ${RAW}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((i: any) => i.id)).toEqual(["m1"]);
    await app.close();
  });
});
```

- [ ] **Step 4: Run to verify failure** — kit tests FAIL (symbols/fields undefined); server test FAILS with 400 `no_profile` (route still reads the cookie). Kit: the `xcodebuild … -scheme OrbixKitTests … test` gate. Server: `pnpm --filter @orbix/api exec vitest run src/routes/wishlist.test.ts`.

- [ ] **Step 5: Implement DTOs** in `DTOs.swift` — add `addedAt`/`matchState` to `MediaCard` (+ its `init`), add `WishlistIdsResponse`, flip `MenuItem`/`MenuResponse` to `Codable`.

- [ ] **Step 6: Implement client methods** in `OrbixClient.swift` (same actor, same `perform`/`send`):

```swift
// MARK: - Library browse

/// `GET /api/libraries/:id/items?sort=&q=` (see apps/api/src/routes/catalog.ts) —
/// a library's items as poster cards. Bare array, no envelope. `sort` is one of
/// title|added|year (server 400s anything else); `q` filters the base title
/// case-insensitively and is omitted from the wire when nil/empty.
public func libraryItems(id: String, sort: String = "title", q: String? = nil) async throws -> [MediaCard] {
    var queryItems = [URLQueryItem(name: "sort", value: sort)]
    if let q, !q.isEmpty { queryItems.append(URLQueryItem(name: "q", value: q)) }
    let url = baseURL.appending(path: "api/libraries/\(id)/items").appending(queryItems: queryItems)
    return try await send(method: "GET", url: url)
}

// MARK: - Wishlist

/// `GET /api/wishlist` (see apps/api/src/routes/wishlist.ts) — the active
/// profile's saved titles as poster cards, newest-first. Bare array.
public func wishlist() async throws -> [MediaCard] {
    try await send(method: "GET", url: baseURL.appending(path: "api/wishlist"))
}

/// `GET /api/wishlist/ids` — membership ids for the title-page toggle (Phase 3).
public func wishlistIds() async throws -> [String] {
    let response: WishlistIdsResponse = try await send(method: "GET", url: baseURL.appending(path: "api/wishlist/ids"))
    return response.ids
}

/// `POST /api/wishlist/:itemId` — idempotent add (404s an unknown/kids-blocked id).
public func addToWishlist(itemId: String) async throws {
    _ = try await perform(method: "POST", url: baseURL.appending(path: "api/wishlist/\(itemId)"))
}

/// `DELETE /api/wishlist/:itemId` — idempotent remove.
public func removeFromWishlist(itemId: String) async throws {
    _ = try await perform(method: "DELETE", url: baseURL.appending(path: "api/wishlist/\(itemId)"))
}
```

  And change `search(query:)` to return the full envelope:
```swift
public func search(query: String) async throws -> SearchResponse {
    let url = baseURL.appending(path: "api/search").appending(queryItems: [URLQueryItem(name: "q", value: query)])
    return try await send(method: "GET", url: url)
}
```
  Then fix the lone caller in `SearchView.swift`'s `SearchModel.performSearch`: `let response = try await client.search(query: query); results = response.items` (surfacing `usedEmbeddings` is Task 6). Keep everything else in that method unchanged.

- [ ] **Step 7: Implement the server change** in `wishlist.ts` — add `activeProfileId` to the existing `../lib/catalog-filter` import; in each of the four handlers replace
  `const profileId = req.cookies["orbix_profile"]; if (!profileId) return reply.code(400).send({ error: "no_profile" });`
  with `const profileId = await activeProfileId(app, req); if (!profileId) return reply.code(400).send({ error: "no_profile" });`. No other logic changes.

- [ ] **Step 8: Run tests — PASS.** Kit: `OrbixKitTests` green. Server: `pnpm --filter @orbix/api exec vitest run src/routes/wishlist.test.ts` green (including all pre-existing cookie tests).

- [ ] **Step 9: Gates** — `cd clients/tvos && xcodegen generate` then the app `build` gate + `OrbixKitTests` `test` gate (both SUCCEEDED/passing). Server: `pnpm typecheck && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api test`.

- [ ] **Step 10: Commit** — `git add clients/tvos/Sources/OrbixKit clients/tvos/Sources/Orbix/Search/SearchView.swift clients/tvos/Tests/OrbixKitTests/DTOTests.swift apps/api/src/routes/wishlist.ts apps/api/src/routes/wishlist.test.ts && git commit -m "feat(orbixkit): library-items, wishlist CRUD, search mode surfacing; device-profile wishlist"`

---

### Task 2: OrbixKit pure logic — billboard daily pick + NEW-badge window + resume label (TDD)

**Files:**
- Create: `clients/tvos/Sources/OrbixKit/Billboard.swift`
- Test: `clients/tvos/Tests/OrbixKitTests/BillboardTests.swift`

**Interfaces:**
- Consumes: `HomeRow`, `MediaCard`, `MediaCard.Resume` (OrbixKit DTOs).
- Produces (all `public`, `Sendable` inputs — pure, no shared state):
  - `func pickBillboard(rows: [HomeRow], seed: Int = 0) -> MediaCard?`
  - `func dailySeed(now: Date = Date()) -> Int`
  - `func isNew(addedAt: String?, now: Date) -> Bool`
  - `func resumeLabel(_ resume: MediaCard.Resume?) -> String?`

**Ports (verified against source):** `apps/web/src/lib/billboard.ts` (`pickBillboard`, `dailySeed`) and `apps/web/src/lib/spotlight.ts` (`isNew`, `resumeLabel`). The continue-watching row key is `"continue"` (confirmed in `packages/core/src/discovery/rows.ts:179`), matching `billboard.ts`'s `r.key !== "continue"` — the port uses `"continue"` verbatim.

- [ ] **Step 1: Read the sources** — `apps/web/src/lib/billboard.ts` and `apps/web/src/lib/spotlight.ts`. Note: `isNew` uses `now - added <= 14d` with **no** lower bound (a future `addedAt` still reads as new) and returns false on unparseable dates; `resumeLabel` treats an empty-string `episodeTitle` as absent (JS falsy).

- [ ] **Step 2: Write the failing tests** (complete file):

```swift
import XCTest
@testable import OrbixKit

final class BillboardTests: XCTestCase {
    private func card(_ id: String, backdrop: String? = nil, addedAt: String? = nil) -> MediaCard {
        MediaCard(id: id, title: id, backdropPath: backdrop, addedAt: addedAt)
    }
    private func row(_ key: String, _ items: [MediaCard]) -> HomeRow {
        HomeRow(key: key, title: key, items: items)
    }

    // MARK: pickBillboard

    func testPicksBackdropCardOfFirstNonContinueRow() {
        let rows = [
            row("continue", [card("cw1", backdrop: "/cw.jpg")]),
            row("hiddenGems", [card("h1"), card("h2", backdrop: "/h2.jpg"), card("h3", backdrop: "/h3.jpg")]),
        ]
        // seed 0 → first backdrop-bearing candidate of the first non-continue row.
        XCTAssertEqual(pickBillboard(rows: rows, seed: 0)?.id, "h2")
        // seed rotates deterministically within that row's candidates ([h2,h3]).
        XCTAssertEqual(pickBillboard(rows: rows, seed: 1)?.id, "h3")
        XCTAssertEqual(pickBillboard(rows: rows, seed: 2)?.id, "h2")
        // abs(seed) so a negative seed never traps (matches web Math.abs(seed)).
        XCTAssertEqual(pickBillboard(rows: rows, seed: -1)?.id, "h3")
    }

    func testSkipsContinueRowEvenWhenItHasBackdrops() {
        let rows = [
            row("continue", [card("cw1", backdrop: "/cw.jpg")]),
            row("tonight", [card("t1", backdrop: "/t1.jpg")]),
        ]
        XCTAssertEqual(pickBillboard(rows: rows, seed: 0)?.id, "t1")
    }

    func testFallsBackToFirstBackdropInAnyRowWhenFirstDiscoveryRowHasNone() {
        // First non-continue row has NO backdrop cards → scan all rows for the
        // first backdrop-bearing card (continue row included, per web step 2).
        let rows = [
            row("continue", [card("cw1", backdrop: "/cw.jpg")]),
            row("hiddenGems", [card("h1"), card("h2")]),
        ]
        XCTAssertEqual(pickBillboard(rows: rows, seed: 0)?.id, "cw1")
    }

    func testFallsBackToFirstCardOfFirstNonEmptyRowWhenNoBackdropsAnywhere() {
        let rows = [row("continue", []), row("hiddenGems", [card("h1"), card("h2")])]
        XCTAssertEqual(pickBillboard(rows: rows, seed: 0)?.id, "h1")
    }

    func testReturnsNilWhenNothingToFeature() {
        XCTAssertNil(pickBillboard(rows: [], seed: 0))
        XCTAssertNil(pickBillboard(rows: [row("continue", [])], seed: 0))
    }

    // MARK: dailySeed

    func testDailySeedStableWithinDayAndDiffersAcrossDays() {
        let d1 = Date(timeIntervalSince1970: 1_760_000_000) // some instant
        let sameDayLater = d1.addingTimeInterval(60 * 60)   // +1h, same UTC day bucket
        let nextDay = d1.addingTimeInterval(24 * 60 * 60)   // +24h
        XCTAssertEqual(dailySeed(now: d1), dailySeed(now: sameDayLater))
        XCTAssertEqual(dailySeed(now: nextDay), dailySeed(now: d1) + 1)
    }

    // MARK: isNew

    func testIsNewWithinAndOutsideWindow() {
        let now = ISO8601DateFormatter().date(from: "2026-07-05T00:00:00Z")!
        XCTAssertTrue(isNew(addedAt: "2026-07-01T00:00:00.000Z", now: now))  // 4 days
        XCTAssertFalse(isNew(addedAt: "2026-06-01T00:00:00.000Z", now: now)) // >14 days
        XCTAssertFalse(isNew(addedAt: nil, now: now))
        XCTAssertFalse(isNew(addedAt: "not-a-date", now: now))
    }

    // MARK: resumeLabel

    func testResumeLabel() {
        XCTAssertNil(resumeLabel(nil))
        XCTAssertEqual(resumeLabel(MediaCard.Resume(seasonNumber: 1, episodeNumber: 2)), "S1 E2")
        XCTAssertEqual(
            resumeLabel(MediaCard.Resume(seasonNumber: 3, episodeNumber: 4, episodeTitle: "Old Friends")),
            "S3 E4 · Old Friends"
        )
        // Empty title behaves as absent (JS falsy parity).
        XCTAssertEqual(resumeLabel(MediaCard.Resume(seasonNumber: 1, episodeNumber: 2, episodeTitle: "")), "S1 E2")
    }
}
```

- [ ] **Step 3: Run to verify failure** — `xcodegen generate` then the `OrbixKitTests` `test` gate. Expected: FAIL (symbols undefined).

- [ ] **Step 4: Implement** `Billboard.swift` (complete file):

```swift
import Foundation

/// Deterministic billboard pick — 1:1 port of apps/web/src/lib/billboard.ts.
///   1. a backdrop-bearing card of the first non-"continue" row (the billboard
///      is a discovery surface, not a resume prompt); `seed` rotates which one,
///      so it changes day to day but is stable within a day,
///   2. else the first backdrop-bearing card in any row,
///   3. else the first card of the first non-empty row (tiny libraries),
///   4. else nil.
/// The continue-watching row key is "continue" (packages/core/src/discovery/rows.ts).
public func pickBillboard(rows: [HomeRow], seed: Int = 0) -> MediaCard? {
    if let discovery = rows.first(where: { $0.key != "continue" && !$0.items.isEmpty }) {
        let candidates = discovery.items.filter { $0.backdropPath != nil }
        if !candidates.isEmpty {
            return candidates[abs(seed) % candidates.count]
        }
    }
    for row in rows {
        if let hit = row.items.first(where: { $0.backdropPath != nil }) {
            return hit
        }
    }
    return rows.first(where: { !$0.items.isEmpty })?.items.first
}

/// Day index used to rotate the billboard pick once per day — port of
/// billboard.ts `dailySeed`: floor(now_ms / 86_400_000).
public func dailySeed(now: Date = Date()) -> Int {
    Int((now.timeIntervalSince1970 * 1000) / 86_400_000)
}

/// 14 days, in seconds — port of spotlight.ts NEW_WINDOW_MS.
private let newWindowSeconds: TimeInterval = 14 * 24 * 60 * 60

/// True when `addedAt` (ISO-8601) is within the last 14 days of `now` — port of
/// spotlight.ts `isNew`. No lower bound (a future addedAt still reads as new,
/// matching the web); an unparseable/absent date is never new.
public func isNew(addedAt: String?, now: Date) -> Bool {
    guard let addedAt, let added = parseISODate(addedAt) else { return false }
    return now.timeIntervalSince(added) <= newWindowSeconds
}

/// "S3 E4 · Old Friends" / "S1 E2"; nil for a movie (nil resume) — port of
/// spotlight.ts `resumeLabel`. An empty episodeTitle is treated as absent.
public func resumeLabel(_ resume: MediaCard.Resume?) -> String? {
    guard let resume else { return nil }
    let base = "S\(resume.seasonNumber) E\(resume.episodeNumber)"
    if let title = resume.episodeTitle, !title.isEmpty { return "\(base) · \(title)" }
    return base
}

/// The server sends addedAt via `Date.toISOString()` (always fractional ".000Z").
/// Try fractional first, then plain, so either shape parses.
private func parseISODate(_ string: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: string) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: string)
}
```

- [ ] **Step 5: Run tests — PASS.**

- [ ] **Step 6: Commit** — `git add clients/tvos/Sources/OrbixKit/Billboard.swift clients/tvos/Tests/OrbixKitTests/BillboardTests.swift && git commit -m "feat(orbixkit): billboard daily pick + NEW-window + resume label ports (tested)"`

---

### Task 3: BoxArtCard + RailView (reusable Home building blocks)

**Files:**
- Create: `clients/tvos/Sources/Orbix/Home/BoxArtCard.swift`
- Create: `clients/tvos/Sources/Orbix/Home/RailView.swift`

**Interfaces:**
- Consumes: `OrbixColor`/`OrbixRadius` (Tokens), `NewBadge` (Badges.swift), `ProgressBarView` (ProgressBars.swift), `BottomScrim`/`ScrimView` gradients, `ImageLoader` (OrbixKit), `isNew`/`resumeLabel` (Task 2), `MediaCard`/`HomeRow` (OrbixKit).
- Produces:
  - `struct BoxArtCard: View { let card: MediaCard; let baseURL: URL?; let imageLoader: ImageLoader; var onSelect: () -> Void }` — 16:9 focusable card (web `apps/web/src/components/BoxArtCard.tsx`).
  - `struct RailView: View { let row: HomeRow; let baseURL: URL?; let imageLoader: ImageLoader; var onSelect: (MediaCard) -> Void }` — heading + horizontal focus-sectioned rail of `BoxArtCard`s (web `apps/web/src/components/MediaRow.tsx`).

**Web→TV adaptations (explicit):**
- **Art:** backdrop first, poster cover-crop fallback, gradient plate when neither (web lines 22, 37-48). Web gates art on `matchState` (matched/manual/null show art). Home cards carry no `matchState` (→ nil → treated as matched), so this is inert on Home but correct if reused elsewhere.
- **Subtitle:** `resumeLabel(card.resume) ?? card.year.map(String.init)` (web line 24).
- **NEW badge:** top-leading, gated by `isNew(card.addedAt, now: Date())`, using the Phase-1 `NewBadge` (web lines 57-61).
- **Progress bar:** 4pt accent `ProgressBarView(fraction:)` pinned to the bottom edge when `card.progress` is present and `durationSec > 0` (web lines 63-67). **Do not** use `PosterCard.swift`'s legacy hardcoded red `ResumeProgressBar` — that is the Task-4-superseded component.
- **Focus-promote:** web `hover:scale-[1.04] + shadow` → a `Button` whose `ButtonStyle` reads `@Environment(\.isFocused)` and applies `.focusPromote(isFocused)` (Phase-1 modifier) + `RoundedRectangle(cornerRadius: OrbixRadius.md)` clip. (Do not use `.buttonStyle(.card)` here — the web promote is a specific 1.04 scale the `focusPromote` modifier already encodes.)
- **RailView heading (paddles adaptation):** web renders hover-only chevron paddles that page the strip; on tvOS there is **no paddle UI** — horizontal movement is focus-driven via `ScrollView(.horizontal)` + `.focusSection()` (the engine auto-scrolls to keep the focused card on-screen), exactly as the current `HomeView.railView` does. Heading uses `OrbixType.rowHeading` and `OrbixColor.text`. Heading text = `row.title` (server-provided). **Note:** web localizes `continue`/`hiddenGems`/`tonight` headings by key; tvOS i18n (String Catalogs) is Phase 5, so Phase 2 renders the server title and the key-based override lands with Phase 5 i18n.

- [ ] **Step 1: Read the web sources** — `apps/web/src/components/BoxArtCard.tsx` and `apps/web/src/components/MediaRow.tsx`. Cross-check the existing `clients/tvos/Sources/Orbix/Home/PosterCard.swift` for the `ImageLoader` `.task(id: url)` art-loading pattern to reuse (but 16:9 and the Task-4 `ProgressBarView`, not the legacy `ResumeProgressBar`).

- [ ] **Step 2: Implement `BoxArtCard.swift`.** Card body: a `ZStack(alignment:)` with (a) 16:9 art (`ImageLoader`-backed, backdrop→poster→gradient plate), (b) a bottom title/subtitle plate over a `LinearGradient` black `0.8→0` (web line 50), (c) `NewBadge` top-leading with `.padding(8)` when `isNew(card.addedAt, now: Date())`, (d) `ProgressBarView(fraction:)` bottom edge when progress present. Wrap in `Button(action: onSelect)` styled by a private `BoxArtCardStyle: ButtonStyle` that applies `.clipShape(RoundedRectangle(cornerRadius: OrbixRadius.md))` and `.focusPromote(isFocused)`. Fixed width ≈ 460pt (16:9 ≈ 460×259) so rails read like the web's landscape strip; expose the art URL builder mirroring `PosterCard.posterURL` (backdrop path preferred). Add `.accessibilityIdentifier("boxArtCard_\(card.id)")`.

- [ ] **Step 3: Implement `RailView.swift`** — mirror `HomeView.railView` structure (VStack heading + `ScrollView(.horizontal)` + `LazyHStack(spacing: OrbixSpacing.cardGap)` of `BoxArtCard`s, vertical headroom padding so focus-scale doesn't clip, `.focusSection()`), `.accessibilityIdentifier("homeRail_\(row.key)")`. `onSelect` forwards the tapped card.

- [ ] **Step 4: Build gate** — `xcodegen generate` + app `build`. Expected: BUILD SUCCEEDED. (Add a `#Preview` with sample cards for visual sanity.)

- [ ] **Step 5: Commit** — `git add clients/tvos/Sources/Orbix/Home/BoxArtCard.swift clients/tvos/Sources/Orbix/Home/RailView.swift && git commit -m "feat(tvos): 16:9 BoxArtCard + focus-driven RailView (web MediaRow parity)"`

---

### Task 4: Home rebuild — billboard + rails + isScrolled threading + preserved route pushes

**Files:**
- Modify: `clients/tvos/Sources/Orbix/Home/HomeView.swift`
- Create: `clients/tvos/Sources/Orbix/Home/HomeBillboardView.swift`
- Modify: `clients/tvos/Sources/Orbix/Shell/ShellView.swift` (thread `isScrolled` binding into `HomeView`; reset on section change)
- Modify: `clients/tvos/Sources/Orbix/Title/TitlePage.swift` (add `autoplay` param + one-shot movie autoplay; extend `TitleRoute`)
- Modify: `clients/tvos/Sources/Orbix/Shell/OrbixTopBar.swift` (small polish: apply `NavItemStyle` focus treatment to the "More" overflow menu — folded here as the Home task is what revisits shell/bar scroll behavior)

**Interfaces:**
- Consumes: `pickBillboard`/`dailySeed`/`isNew`/`resumeLabel` (Task 2), `BoxArtCard`/`RailView` (Task 3), `SkeletonView`/scrims/`OrbixButtonStyle` (Phase 1), `itemDetail(id:)`/`homeRows()` (OrbixKit), `TitleRoute`/`SeasonRoute` (existing).
- Produces:
  - `HomeView` takes `@Binding var isScrolled: Bool`; renders `HomeBillboardView` (when a featured card exists) above the rails inside one `ScrollView`, rails overlapping the billboard's bottom dissolve; sets `isScrolled` from scroll offset.
  - `struct HomeBillboardView: View { let card: MediaCard; let model: AppModel; let imageLoader: ImageLoader; var onPlay: () -> Void; var onMoreInfo: () -> Void }` — full-bleed backdrop + `TopBarScrim`/`LeftVignette`/`BottomScrim`, logo/overview/cert upgrade via `itemDetail`, meta row, NEW badge, Play + More info buttons.
  - `TitleRoute` gains `var autoplay: Bool = false`; `TitlePage` gains `var autoplay: Bool = false` and presents the player once for a movie with a playable file.

**Web→TV adaptations (explicit):**
- **Billboard (web `apps/web/src/components/billboard/HomeBillboard.tsx` + `HomePage.tsx`):** paint immediately from the row card (`card.backdropPath` + title), upgrade to `detail.logoPath` (logo art *is* the title; else `OrbixType.heroTitle` text), `detail.genres.first · year · seasons`, 3-line `detail.overview`, and a `detail.rating` cert plate pinned bottom-trailing. NEW chip when `isNew(card.addedAt, now: Date())`.
- **Buttons:** **Play** = `OrbixButtonStyle(.primary)` (white/black) → `onPlay` (direct play, web `?play=1`); **More info** = `OrbixButtonStyle(.ghost)` → `onMoreInfo` (title page). No hover states — focus states come from `OrbixButtonStyle`.
- **Play deep-link (web `?play=1`):** `onPlay` pushes `TitleRoute(itemId: card.id, autoplay: true)`; `onMoreInfo` pushes `TitleRoute(itemId: card.id)`. This **preserves the existing `NavigationPath` contract** (still `path.append(TitleRoute…)`; `SeasonRoute` unaffected). `TitlePage` presents the player once on load for a **movie** with `files.first` (web parity: movie → first file). **Series autoplay** (first owned episode) needs the episode fetch that the Phase-3 title/episode rebuild owns — in Phase 2 a series `autoplay` route simply shows the title page (documented decision).
- **Scrolled bar (web `useScrolled`):** `ShellView` owns `@State private var isScrolled`; passes `isScrolled` (Bool) to `OrbixTopBar` (unchanged) and `$isScrolled` (Binding) to `HomeView`. `HomeView` detects scroll offset via a `GeometryReader` + `PreferenceKey` in a named coordinate space (tvOS 17 — `onScrollGeometryChange` is 18+): `isScrolled = offset < -10`. On any section change away from `.home`, `ShellView` resets `isScrolled = false` (`.onChange(of: selection)`), so a non-Home section never leaves the bar solid.
- **Skeleton:** loading state uses `SkeletonView` (billboard block + three rail placeholders), mirroring `HomePage.tsx`'s `HomeSkeleton` — not a `ProgressView` spinner.

- [ ] **Step 1: Read the web sources** — `apps/web/src/pages/HomePage.tsx` (skeleton, billboard+rows composition, `-mt` overlap, `pickBillboard(rows, dailySeed())`) and `apps/web/src/components/billboard/HomeBillboard.tsx` (backdrop/logo/meta/overview/cert/buttons + three scrims). Re-read the current `HomeView.swift` for the `NavigationStack`/`path`/`navigationDestination` contract to preserve verbatim.

- [ ] **Step 2: Implement `HomeBillboardView.swift`** — full-bleed `ZStack`: backdrop art (`ImageLoader`, `card.backdropPath` first, upgrade to `detail?.backdropPath`), then `TopBarScrim` (top), `LeftVignette` (full-width), `BottomScrim` (bottom dissolve into `OrbixColor.bg`), then a bottom-leading copy block (logo-or-heroTitle, NEW+meta row, 3-line overview, Play/More-info buttons) and a bottom-trailing cert plate. Load detail via `.task(id: card.id) { detail = try? await client.itemDetail(id: card.id) }`.

- [ ] **Step 3: Rebuild `HomeView.swift`** — add `@Binding var isScrolled: Bool`. In the `.loaded(rows)` branch: compute `let featured = pickBillboard(rows: rows, seed: dailySeed())`; render a single `ScrollView` containing `HomeBillboardView` (if `featured != nil`) then a `LazyVStack` of `RailView`s pulled up (`.padding(.top, -80)`) into the dissolve. Replace the old `PosterCard` rails and the `ProgressView` loading state with `RailView` and a `SkeletonView`-based skeleton. Keep `NavigationStack(path:)`, both `navigationDestination` registrations, and `select(_:)` (now `path.append(TitleRoute(itemId: card.id))`). Add `onPlay`/`onMoreInfo` closures on the billboard that append the two `TitleRoute` variants. Add the offset `PreferenceKey` + `GeometryReader` and set `isScrolled`.

- [ ] **Step 4: Thread the binding in `ShellView.swift`** — add `@State private var isScrolled = false`; change `case .home: HomeView(model: model)` to `HomeView(model: model, isScrolled: $isScrolled)`; keep `OrbixTopBar(..., isScrolled: isScrolled)`; add `.onChange(of: selection) { _, new in if new != .home { isScrolled = false } }`. Remove the now-stale "isScrolled is plumbed but inert" clause from the doc comment.

- [ ] **Step 5: Add movie autoplay** in `TitlePage.swift` — extend `struct TitleRoute { let itemId: String; var autoplay: Bool = false }`; add `var autoplay: Bool = false` to `TitlePage`; add `@State private var didAutoplay = false`; in the `.loaded` movie branch attach `.onAppear { autoplayIfNeeded(detail, client) }` where `autoplayIfNeeded` guards `autoplay && !didAutoplay && detail.kind == "movie"`, resolves `detail.files?.first?.id`, sets `didAutoplay = true`, and calls the existing `presentPlayer(fileId:title:client:)`. Update `HomeView`'s (and, for consistency, any other section's in later tasks) `navigationDestination(for: TitleRoute.self)` to pass `autoplay: route.autoplay`.

- [ ] **Step 6: Polish the "More" overflow menu** in `OrbixTopBar.swift` — the `moreMenu` currently uses a raw `.foregroundStyle(OrbixColor.textDim)` with no focus treatment. Wrap its label so it participates in the same focus emphasis as the other bar items (apply the shared `NavItemStyle`-equivalent white-on-focus + scale, e.g. host the `Menu` in a styled container or reuse `NavItemStyle(isSelected:false, selectedColor:.text, normalColor:.textDim)` on the label). Keep `accessibilityIdentifier("nav_more")`.

- [ ] **Step 7: Build gate** — `xcodegen generate` + app `build`. Expected: BUILD SUCCEEDED.

- [ ] **Step 8: Authenticated smoke + screenshot** — boot the sim, build+install, then:
  `set -a; source .superpowers/sdd/dev-device-token.env; set +a`
  Resolve the bundle id without hardcoding: `BUNDLE_ID=$(xcodebuild -project clients/tvos/Orbix.xcodeproj -scheme Orbix -showBuildSettings 2>/dev/null | awk -F' = ' '/PRODUCT_BUNDLE_IDENTIFIER/{print $2; exit}')`. Launch with args (token passed by reference, never echoed):
  `xcrun simctl launch booted "$BUNDLE_ID" -orbixBaseURL "$ORBIX_TEST_BASE_URL" -orbixToken "$ORBIX_TEST_TOKEN"`.
  Confirm: billboard renders full-bleed under the transparent bar; bar turns solid when Home scrolls; rails overlap the dissolve; a box-art card focus-promotes; Play from the billboard starts the player for a movie; More info opens the title page. Capture `xcrun simctl io booted screenshot .superpowers/sdd/phase2-home.png`.

- [ ] **Step 9: Commit** — `git add clients/tvos/Sources/Orbix/Home clients/tvos/Sources/Orbix/Shell/ShellView.swift clients/tvos/Sources/Orbix/Shell/OrbixTopBar.swift clients/tvos/Sources/Orbix/Title/TitlePage.swift && git commit -m "feat(tvos): web-parity Home billboard + rails, scrolled bar, direct-play"`

---

### Task 5: Library browse section

**Files:**
- Create: `clients/tvos/Sources/Orbix/Library/LibraryBrowseView.swift`
- Modify: `clients/tvos/Sources/Orbix/Shell/ShellView.swift` (replace the `.category` placeholder)

**Interfaces:**
- Consumes: `libraryItems(id:sort:q:)` (Task 1), `PosterCard` (existing 2:3 card), `SkeletonView`, `TitleRoute`/`SeasonRoute`, `model.menuItems` (for the library name), `ImageLoader`.
- Produces:
  - `struct LibraryBrowseView: View { let libraryId: String; let libraryName: String; let model: AppModel }` — own `NavigationStack`; poster grid + sort control + text filter.
  - `@MainActor @Observable final class LibraryModel` — loads `libraryItems`, debounced on `q`, re-loads on `sort` change; single `loadState` (loading/error/empty/loaded) mirroring `HomeModel`/`SearchModel`.

**Web→TV adaptations (explicit)** (web `apps/web/src/pages/LibraryPage.tsx`):
- **Grid:** 2:3 `PosterCard`s in a `LazyVGrid(.adaptive(minimum: 220))` (reuse `SearchView`'s grid lockup), one `.focusSection()`. Skeleton grid while loading (web `Array.from({length:21})`).
- **Sort `<select>` → segmented control:** a horizontal row of three focusable chip buttons (title/added/year) in their own focus section, selected chip tinted with `OrbixColor.accent`; changing selection re-loads. (No native `<select>` on tvOS.)
- **Text filter `<Input>` → `.searchable`:** use SwiftUI `.searchable(text:)` (system keyboard) bound to `q`; debounce via the model (~350ms, reuse `SearchModel`'s debounce idiom) before calling `libraryItems`. Empty `q` loads the full (sorted) list.
- **Empty/error:** `ContentUnavailableView` empty state (web line 45-47); error surfaced with a Retry (kids-filtering is server-side — nothing client-side to add).
- **Heading:** `libraryName` (from `model.menuItems.first{ $0.libraryId == libraryId }?.name`), `OrbixType.rowHeading`/hero weight.

- [ ] **Step 1: Read** `apps/web/src/pages/LibraryPage.tsx` and `apps/web/src/lib/queries.ts` `useLibraryItems` (query-string build: always `sort`, `q` only when non-empty — matches `libraryItems`). Re-read `catalog.ts:7-62` to confirm the sort allowlist (`title|added|year`) and the bare-array response.

- [ ] **Step 2: Implement `LibraryModel`** — `func load(client:libraryId:sort:q:) async` with an in-flight guard; a `queryChanged`/`sortChanged` debounce+fetch `Task` (cancel-previous idiom from `SearchModel`); `loadState(for:)` computed like `HomeModel`.

- [ ] **Step 3: Implement `LibraryBrowseView`** — `NavigationStack(path:)` with `TitleRoute`/`SeasonRoute` destinations (identical registrations to `HomeView`, passing `autoplay: route.autoplay`); heading; sort chips focus section; `.searchable` filter; grid/skeleton/empty/error. `select(card)` pushes `TitleRoute(itemId: card.id)`.

- [ ] **Step 4: Wire into `ShellView`** — replace the `.category(let libraryId)` placeholder with `LibraryBrowseView(libraryId: libraryId, libraryName: categoryName(for: libraryId), model: model).id(libraryId)`. The `.id(libraryId)` forces a fresh view/model when switching between categories (same enum case, different associated value).

- [ ] **Step 5: Build gate** — `xcodegen generate` + app `build`. BUILD SUCCEEDED.

- [ ] **Step 6: Authenticated smoke + screenshot** — launch as in Task 4 Step 8; select a category from the bar; confirm the poster grid loads, sort chips reorder, the on-screen keyboard filters, focus moves grid↔controls↔bar. Capture `.superpowers/sdd/phase2-library.png`.

- [ ] **Step 7: Commit** — `git add clients/tvos/Sources/Orbix/Library clients/tvos/Sources/Orbix/Shell/ShellView.swift && git commit -m "feat(tvos): library browse section (grid, sort, filter)"`

---

### Task 6: Search restyle to web parity

**Files:**
- Modify: `clients/tvos/Sources/Orbix/Search/SearchView.swift`

**Interfaces:**
- Consumes: `search(query:) -> SearchResponse` (Task 1), `PosterCard`, `SkeletonView`, `QualityChip` (reused for the mode badge) or a small inline chip, `OrbixColor`.
- Produces: `SearchModel` gains `private(set) var usedEmbeddings: Bool` and keeps prior results visible (dimmed) while a re-search is in flight; `SearchView` gains the teaching landing state, result count, and semantic/keyword mode badge.

**Web→TV adaptations (explicit)** (web `apps/web/src/pages/SearchPage.tsx`):
- **Mode badge:** a rounded chip after the result count — purple (`bg-purple-900/50 text-purple-300` → `OrbixColor.accent2` tint) reading “Semantic” when `usedEmbeddings`, neutral (`OrbixColor.surface`/`textDim`) reading “Keyword” otherwise (web lines 87-93).
- **Teaching landing state:** before any query, a centered heading + hint (web lines 69-74). Keep the existing `.searchable` affordance (tvOS-idiomatic; no hand-rolled field).
- **Result count:** “N results” line above the grid (web line 84).
- **Dimmed re-search:** keep the previous results grid visible at `opacity(0.5)` while `isSearching` and prior results exist (web `placeholderData: keepPreviousData` + `opacity-50`, lines 79-82). `SearchModel` already retains `results` until replaced — do **not** clear them at the top of `queryChanged` when there are prior results; only clear on an emptied field.
- **First-search skeleton:** when a query is submitted and there are no prior results yet, show `SearchSkeletonGrid` (web line 77), not a spinner.
- **Copy:** literal English strings for Phase 2 (String Catalog keys land in Phase 5 i18n) — note this deviation.

- [ ] **Step 1: Read** `apps/web/src/pages/SearchPage.tsx` and `apps/web/src/lib/queries.ts` `useSearch` (`placeholderData: keepPreviousData`). Re-read the current `SearchView.swift`/`SearchModel` to preserve the debounce, cancel-previous, and `loadState(for:)` machinery.

- [ ] **Step 2: Extend `SearchModel`** — store `usedEmbeddings` from the `SearchResponse`; in `queryChanged`, when a non-empty query changes and prior results exist, set `isSearching = true` **without** clearing `results` (so the grid dims instead of flashing empty); in `performSearch`, `let response = try await client.search(query: query); results = response.items; usedEmbeddings = response.usedEmbeddings`. Add a `hasSearched` flag (or reuse `searchedQuery.isEmpty`) so the landing state is distinguishable from an empty result set.

- [ ] **Step 3: Restyle `SearchView`** — landing state; results header (count + mode badge); dim the grid (`.opacity(isSearching && !results.isEmpty ? 0.5 : 1)`); first-search skeleton grid; keep no-results and error states. Reuse the existing grid lockup + `.focusSection()`.

- [ ] **Step 4: Build gate** — `xcodegen generate` + app `build`. BUILD SUCCEEDED.

- [ ] **Step 5: Authenticated smoke + screenshot** — launch as in Task 4; open Search; confirm landing state, a query returns a grid with count + mode badge, re-searching dims prior results rather than flashing empty. Capture `.superpowers/sdd/phase2-search.png`.

- [ ] **Step 6: Commit** — `git add clients/tvos/Sources/Orbix/Search/SearchView.swift && git commit -m "feat(tvos): search parity (mode badge, landing state, dimmed re-search)"`

---

### Task 7: Wishlist section

**Files:**
- Create: `clients/tvos/Sources/Orbix/Wishlist/WishlistView.swift`
- Modify: `clients/tvos/Sources/Orbix/Shell/ShellView.swift` (replace the `.wishlist` placeholder)

**Interfaces:**
- Consumes: `wishlist()` (Task 1), `PosterCard`, `SkeletonView`, `TitleRoute`/`SeasonRoute`, `ImageLoader`.
- Produces:
  - `struct WishlistView: View { let model: AppModel }` — own `NavigationStack`; "My List" 2:3 poster grid, newest-first, empty state.
  - `@MainActor @Observable final class WishlistModel` — loads `wishlist`; single `loadState` (loading/error/empty/loaded), reloads on appear.

**Web→TV adaptations (explicit)** (web `apps/web/src/pages/WishlistPage.tsx`):
- **Grid:** same 2:3 `PosterCard` grid/skeleton as Library (server returns newest-first, so no client sort). Heading “My List” (web `wishlist:heading`).
- **Empty state:** message + hint (web lines 21-26) via `ContentUnavailableView` with a description line.
- **Scope:** only the grid + reload land here. The **wishlist toggle** on the title page is Phase 3 (the client `addToWishlist`/`removeFromWishlist`/`wishlistIds` methods already exist from Task 1, ready for Phase 3). `WishlistModel` reloads `.onAppear` so a Phase-3 toggle is reflected when returning to the list.

- [ ] **Step 1: Read** `apps/web/src/pages/WishlistPage.tsx` and `useWishlist`. Re-read `wishlist.ts` to confirm newest-first ordering and the bare-array shape.

- [ ] **Step 2: Implement `WishlistModel`** — mirror `HomeModel`'s single-`loadState` shape; `load(client:) async` with in-flight guard; reload on view appear.

- [ ] **Step 3: Implement `WishlistView`** — `NavigationStack(path:)` with `TitleRoute`/`SeasonRoute` destinations (passing `autoplay: route.autoplay`); heading; grid/skeleton/empty/error; `select(card)` pushes `TitleRoute(itemId: card.id)`.

- [ ] **Step 4: Wire into `ShellView`** — replace the `.wishlist` placeholder with `WishlistView(model: model)`.

- [ ] **Step 5: Build gate** — `xcodegen generate` + app `build`. BUILD SUCCEEDED.

- [ ] **Step 6: Authenticated smoke + screenshot** — launch as in Task 4; open My List; confirm the grid loads newest-first (or the empty state if the profile has none). Capture `.superpowers/sdd/phase2-wishlist.png`.

- [ ] **Step 7: Commit** — `git add clients/tvos/Sources/Orbix/Wishlist clients/tvos/Sources/Orbix/Shell/ShellView.swift && git commit -m "feat(tvos): wishlist section (My List grid + empty state)"`

---

### Task 8: Phase 2 gate — build, tests, authenticated visual record vs web

**Files:** none created (verification only)

- [ ] **Step 1: Full gates** — `cd clients/tvos && xcodegen generate`; app `build` SUCCEEDED; `OrbixKitTests` `test` all pass (DTO + Billboard suites green, existing suites still green). Server: `pnpm typecheck && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api test` green (wishlist device test included).

- [ ] **Step 2: Per-screen visual record vs web** — launch in the simulator against the NAS (`set -a; source .superpowers/sdd/dev-device-token.env; set +a`; launch with `-orbixBaseURL`/`-orbixToken` as in Task 4 Step 8; token never printed). Capture and side-by-side compare with the web app: Home (billboard + rails + scrolled bar), Library browse (grid/sort/filter), Search (mode badge/landing/dimmed re-search), Wishlist (My List/empty). Screenshots: `.superpowers/sdd/phase2-{home,library,search,wishlist}.png`.

- [ ] **Step 3: Parity + kids checks** — verify billboard Play starts playback for a movie; box-art NEW badge + resume subtitle match web on the same titles; a kids profile still hides TV and shows only server-filtered catalog in Library/Search/Wishlist (server-enforced — confirm nothing over-renders). Note any deviations for the Phase 3 backlog rather than gold-plating.

- [ ] **Step 4: Update this plan's checkboxes; commit any fixes** — `git commit -m "chore(tvos): phase 2 gate — parity record vs web"` (if fixes were needed).

---

## Self-review notes

- **Spec coverage:** §7.2 Home (billboard via `pickBillboard(rows, dailySeed())` + `isNew`, rails, scrolled bar, direct-play), §7.3 Library, §7.5 Search, §7.6 Wishlist; §4 OrbixKit wishlist + libraryItems + search-mode surfacing; §5 BoxArtCard/RailView + reuse of Phase-1 badges/progress/scrims/skeleton; §10 DTO decode tests + billboard/spotlight unit tests + authenticated simulator record. Live TV / Title-page full parity / Account / i18n are out of Phase 2 (Phases 3-5).
- **Phase-1 leftovers folded:** MenuItem/MenuResponse `Codable` consistency → Task 1; "More" overflow menu focus treatment → Task 4 Step 6 (the shell/bar-touching task, not a separate task); PosterCard's legacy hardcoded `ResumeProgressBar` explicitly avoided by the Task-3 `ProgressBarView`. Nav-label raw font sizes left as-is (not trivially foldable; belongs with Phase-5 i18n/type pass).
- **Ordering/green-builds:** Task 1's `search` return-type change includes the one-line `SearchView` caller fix so every commit builds; Task 4's `TitleRoute.autoplay` is defaulted so pre-existing destinations compile; `.id(libraryId)` prevents category view reuse.
- **No placeholders:** the billboard/spotlight ports and their tests, and every DTO fixture, are complete real code/wire shapes copied from the named sources.

---

## Summary of key decisions and spec ambiguities (controller to resolve)

1. **[BLOCKER — server change needed] Wishlist is device-incompatible today.** `apps/api/src/routes/wishlist.ts` reads `req.cookies["orbix_profile"]` directly, but `session.ts` sets `req.deviceId` for bearer requests and **never falls back to cookies** — so every tvOS wishlist call returns `400 no_profile`. Spec §3 calls the tv-proxy fix "the only server change," yet §4 lists the wishlist client methods as if they work. I folded a minimal, well-scoped fix into Task 1 (switch the four handlers to `activeProfileId(app, req)`, mirroring `/home/rows`, + a device-token vitest). **Confirm** including this server change in Phase 2, or defer wishlist until a cookie-bridge exists.
2. **Billboard Play deep-link touches TitlePage (Phase-3 file).** I added `TitleRoute.autoplay` + a one-shot **movie** autoplay in `TitlePage` (Phase 2), since the task requires "Play starts playback." **Series** first-owned-episode autoplay needs the Phase-3 episode fetch and is deferred (series `autoplay` shows the page). Confirm this boundary.
3. **`MediaCard` gains `addedAt` + `matchState`.** Required by the billboard/box-art NEW badge (`addedAt`) and poster-card art gating (`matchState`); the old DTO comment said `addedAt` was intentionally ignored. Decode-safe, additive.
4. **i18n deferred to Phase 5.** Rail headings, sort labels, mode-badge/landing copy render literal English in Phase 2 (String Catalogs are Phase 5). Web localizes `continue`/`hiddenGems`/`tonight` headings by key — that override lands with i18n. Confirm acceptable for the Phase 2 parity gate.
5. **TV-adaptation choices (per instruction, made explicit, not left to the implementer):** MediaRow hover chevron paddles → focus-driven horizontal scroll (no paddles); Library `<select>` → focusable segmented chips; Library `<Input>` filter → `.searchable` system keyboard; Search keeps `.searchable` rather than a hand-rolled field; box-art focus-promote via `focusPromote` (not `.buttonStyle(.card)`).
6. **Continue-row key confirmed `"continue"`** (`packages/core/src/discovery/rows.ts:179`), matching `billboard.ts`; the illustrative `"continue-watching"` in an existing DTO fixture is not the real key — the billboard test uses `"continue"`.
7. **`search(query:)` return type changed** from `[MediaCard]` to `SearchResponse` (to surface `usedEmbeddings`); the single caller is updated in Task 1 to keep builds green, with the full restyle in Task 6.
