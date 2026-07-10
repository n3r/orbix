# Orbix tvOS Full-Parity Rebuild — Design

**Date:** 2026-07-05
**Status:** Approved (scope + approach + design approved in session)
**Goal:** Rebuild the native Apple TV app so it looks like the web app and has the same feature set — full consumption parity, translated to the tvOS focus model.

## 1. Scope (user-approved)

- **Consumption only.** Home, Library browse, Title pages, Search, Wishlist, Live TV (full, incl. EPG grid), Profiles, playback, account-lite (profile/language/menu/unlink). Admin surfaces (server settings, library management, fix-match, TV source admin, device registry, first-run setup) stay web-only.
- **Full Live TV** including the time×channel EPG grid and live playback with zap/failover.
- **i18n:** all six web languages (en, es, de, pt, ru, fr) via String Catalogs; UI language follows the active profile's language (fallback: system), matching web behavior. Server-side per-profile catalog localization already works for device clients.
- **Visual parity = same design, TV-adapted.** Same tokens, typography feel, layouts, art treatments, badges; hover interactions become focus interactions; safe areas and remote navigation respected. Not a pixel-for-pixel clone of mouse-driven affordances.
- **Kids parity:** TV entry hidden for kids profiles; all catalog filtering is server-enforced already (shared auth path) — the client must simply not render what the server hides and hide the TV nav entry.

## 2. Approach (user-approved)

**Rebuild the UI on the existing foundation.** Keep:

- `OrbixKit` (actor API client, decode-safe DTOs, Keychain `TokenStore`, `ServerDiscovery`, `ServerURL`, 2-tier `ImageLoader`) — extended, not rewritten.
- The player plumbing (`PlaybackController` progress-report serialization, `PlayerViewController` observer lifecycle/teardown, next-episode autoplay, resume seek) — production-proven on real hardware, including the subtitle black-screen fix (AUTOSELECT=NO + VTT cache, server commit 9cf0bc8).
- The XcodeGen 3-target layout (`Orbix` app / `OrbixKit` framework / `OrbixKitTests`), tvOS 17.0 target, Swift 6.

Rebuild/replace the entire view layer (all screens), add a design system, add the missing OrbixKit endpoints, and make one server change.

Rejected alternatives: clean-room rebuild (re-risks paid-for playback lessons, no upside), web-tech app / RN-tvOS (fights the platform: no WebView on tvOS, second-class focus + AVKit integration).

## 3. Server change (the only one)

> **Amendment (Phase 2 planning):** a second, equally scoped server change surfaced — `apps/api/src/routes/wishlist.ts` reads the `orbix_profile` cookie directly, so device-token clients get `400 no_profile` on every wishlist route. Fix (Phase 2 Task 1): resolve the profile via the shared `activeProfileId(app, req)` helper like `/home/rows` does. Cookie behavior unchanged; covered by a device-token vitest.

`/api/tv/proxy/:streamId/{index.m3u8,p,s}` (apps/api/src/routes/tv-play.ts) currently use `[requireAuth, requireTvAccess]` with **no `queryTokenAuth`** — AVPlayer carries no headers/cookies, so live streams 401 for native clients. Change, mirroring VOD `/api/play/*`:

1. Add `queryTokenAuth` preHandler to the three tv-proxy routes.
2. Propagate `?token=` into rewritten playlist child URIs (`tokenSuffix`-style) so media playlists and segments stay authenticated.
3. `/api/tv/channels/:id/play` responses for bearer-authenticated requests mint `src` URLs with `?token=` appended (same pattern as `POST /api/playback/info`, playback.ts:235-241).
4. `requireTvAccess` (kids 403) must keep working identically for query-token requests.

Vitest coverage in apps/api: token accepted on all three routes, token propagated into playlist rewrite output, kids-profile device token still 403s, cookie path unchanged. Run repo gates (`pnpm typecheck && pnpm lint && pnpm test`).

## 4. OrbixKit extensions

New/extended methods + DTOs (decode-safe style: every non-key field Optional). Existing methods stay.

| Area | Methods | Endpoints |
|---|---|---|
| Wishlist | `wishlist()`, `wishlistIds()`, `addToWishlist(itemId:)`, `removeFromWishlist(itemId:)` | `GET /api/wishlist`, `GET /api/wishlist/ids`, `POST/DELETE /api/wishlist/:itemId` |
| Library browse | `libraries()`, `libraryItems(id:sort:q:)` | `GET /api/libraries`, `GET /api/libraries/:id/items?sort=&q=` |
| Profile menu | `menu()`, `menuConfig()`, `saveMenu(libraryIds:)` | `GET /api/me/menu`, `GET /api/me/menu/config`, `PUT /api/me/menu` |
| Continue watching | `continueWatching()` | `GET /api/continue-watching` |
| Profiles | `updateProfile(id:language:)` (PATCH) | `PATCH /api/profiles/:id` |
| Playback | extend `PlaybackInfoRequest` with `quality`, `audioMode`; extend `PlaybackInfo` to decode `quality`, `audioMode`, `qualities[]`, `audioModes[]` | `POST /api/playback/info` |
| Live TV | `tvHome()`, `tvGuide(country:category:favorites:q:offset:limit:)`, `tvGrid(start:hours:…)`, `tvChannel(id:)`, `tvProgrammes(id:day:)`, `tvChannelPlay(id:)`, `tvFavorites()`, `setTvFavorite(id:on:)`, `postTvEvent(channelId:)`, `postTvStreamHealth(streamId:ok:code:)` | `GET /api/tv/home`, `/api/tv/guide`, `/api/tv/grid`, `/api/tv/channels/:id`, `/api/tv/channels/:id/programmes`, `/api/tv/channels/:id/play`, `/api/tv/favorites`, `PUT/DELETE /api/tv/favorites/:id`, `POST /api/tv/events/:channelId`, `POST /api/tv/streams/:streamId/health` |

Type contracts: mirror `apps/web/src/lib/types.ts` (MediaCard, HomeCard/HomeRow, TitleDetail, EpisodeCard, TvChannelCard, TvGuide*/TvGrid*, TvPlayResponse, Profile, MenuItem/MenuConfig). Every DTO gets decode tests in `OrbixKitTests/DTOTests` style.

## 5. Design system (`Sources/Orbix/Design/`)

A folder in the app target (no fourth framework target — YAGNI).

**Tokens** (port `packages/ui/src/tokens.css` verbatim):

- Surfaces: `bg #0b0d12`, `surface #14171f`, `surface2 #1c212b`, `surface3 #232936`.
- Ink: `text #e8eaf0`, `textMuted #c2c8d4`, `textDim #9aa3b2`.
- Accent ("orbit"): `accent #6d7bff`, `accent2 #a06dff`, `accentStrong #4b57d6` (NEW badges); red reserved: `danger #ef4444`, `live #ef4444`; `success #34d399`, `warning #fbbf24`; `scrim rgba(0,0,0,0.62)`.
- Radii: web 8/12/16px → TV 12/18/24pt (×1.5 for 10-ft viewing distance).
- Typography: system SF (the web uses the system stack — parity is free). Weights: extrabold hero/billboard titles (tight tracking), bold/semibold headings, tracked-uppercase wordmark (`0.25em`), `.monospacedDigit()` for times/numbers.

**Components** (mirroring `@orbix/ui` + web components):

- `OrbixButton` — primary (white bg, black text), ghost (translucent white), danger. Focus treatment on all.
- `BoxArtCard` — 16:9, backdrop→poster fallback, bottom scrim with title + subtitle (resume label "S3 E4 · Title" or year), NEW badge top-left (accent-strong, 14-day window), 3pt accent progress bar. **Focus-promote:** scale ~1.04 + shadow on focus (web hover-promote translated).
- `PosterCard` — 2:3, focus-promote, title fallback plate.
- `RatingBadges` — IMDb (yellow chip), RT (tomato/splat + %), TMDB (accent), Metacritic, MPAA/cert plate.
- `ProgressBarView` (3pt accent), `NowProgressBar` (red, live TV).
- `SkeletonView` — pulse animation, rounded variants; every loading state uses skeletons, not spinners.
- `ScrimView` — the three billboard/hero legibility gradients (nav bar top, left vignette, bottom dissolve).
- `RailView` — heading + horizontal scrolling row, focus-sectioned.
- `ChannelLogoView` — cached logo centered on hue-hashed monogram gradient fallback (port `channelHue`/`channelInitials` from `apps/web/src/lib/tv.ts`).
- `Badge` / quality chips, offline dot.
- Focus ring: web accent `--focus` ring maps to focused scale + subtle accent-tinted border where a ring is appropriate (buttons, toggles, rows).

## 6. Shell & navigation (user chose custom web-style top bar)

- Custom-drawn floating top bar replicating web `TopNav`: left = wordmark + Home + TV (hidden for kids) + per-profile categories (`GET /api/me/menu`, max 6 + "More"); right = wishlist heart (accent when active), search, avatar → Account.
- Transparent gradient over billboard; solid `bg/95` + blur once content scrolls (web `useScrolled`).
- Focus model: the bar is a focus section above the content; each destination hosts its own `NavigationStack`; section switching driven by selection state (not stock `TabView`).
- Menu/back button walks: player → page → section root → (at Home root) system behavior.

## 7. Screens (parity map)

Each screen names its web source of truth.

1. **Onboarding** (existing flows, restyled): server select (LAN autoscan + manual entry) and pairing-code screen get the web auth look — centered `Card`, orbit-glow accent blur, wordmark. Profile picker = web ProfilesPage: "Who's watching?" tile grid (hue initials `Avatar`), add-profile (name + language). PIN profiles: show localized `pin_required` error (same as web).
2. **Home** (`HomePage.tsx`): billboard picked via the web's algorithm (deterministic daily seed over backdrop-bearing cards of the first non-continue row; port `src/lib/billboard.ts` + `spotlight.ts` NEW logic), logo-art upgrade via item detail, genre·year·seasons meta, 3-line overview, cert plate, NEW badge, **Play** (direct-play like `?play=1`) + **More info**. Rails ride up into the billboard's bottom dissolve. Rows via `GET /api/home/rows`; localized headings for `continue`/`hiddenGems`/`tonight` keys.
3. **Library** (`LibraryPage.tsx`): from a nav category → poster grid, sort select (title/added/year), text filter (on-screen keyboard).
4. **Title page** (`TitlePage.tsx`): hero (backdrop + scrims, logo art or big title, RatingBadges, year/seasons·episodes/runtime, ≤3 genres, 3-line overview, Play/Resume with "No media available" disabled state, wishlist toggle with optimistic update), series → season tabs (default first non-specials) + episode grid (stills, play affordance, per-episode progress, unowned greyed "Not in your library"), cast rail, "More Like This" rail, details (director, genres), unmatched-title notice (fix-match stays on web). Deep-link: billboard Play behaves like web `?play=1` (movie: first file; series: first owned episode).
5. **Search** (`SearchPage.tsx`): debounced (~350ms) NL search, semantic-vs-keyword mode badge (purple chip when `usedEmbeddings`), teaching landing state, result count, poster grid, prior results dimmed while re-searching.
6. **Wishlist** (`WishlistPage.tsx`): "My List" poster grid, newest first, empty state with hint.
7. **TV Home** (`TvHomePage.tsx`): rails — Recents, Favorites, per-country (localized region names), per-category. `ChannelCard`: 16:9, logo/monogram, number+name scrim, quality chip, offline dot (dims art), now-playing title + red progress. Focus+select = tune; favorite toggle via context action (long-press) exposed also on the channel page. Empty state: member "ask admin" text (admin CTA stays web).
8. **TV Guide** (`TvGuidePage.tsx`): list/grid view toggle (persisted, `UserDefaults` mirror of `orbix.tv.guideView`), search, filter chips (All/Favorites/country/category). **List:** virtualized rows (number, logo, name, now/next + red progress, quality chip); select = tune; info action → channel page. **Grid:** the TiviMate-style bounded 4-hour window EPG — Now/Prev/Next/Today/Tomorrow(prime-time) controls, sticky time ruler + sticky channel column, programme blocks positioned by window-relative fraction (port `tv-grid-layout.ts` math, unit-tested), airing block accent-tinted, red per-row now-line, focusable blocks (focus = highlight, select = tune), channel-limit note.
9. **TV Channel page** (`TvChannelPage.tsx`): hero (logo, number, name, quality/region/category badges, offline dot), favorite toggle, **Watch**, Today/Tomorrow schedule with ON NOW highlight.
10. **Live player** (`LiveTvOverlay`/`LiveTvPlayer`): AVPlayer on the (now tokened) proxy HLS. Zap OSD (number·logo·name·quality·source·now/next, auto-hide 4s), channel up/down (swipe/remote), last-channel jump, mini-guide overlay (up/down move, select tunes in place), offline panel (retry / next channel), multi-source failover ladder (fatal error → next source; report `POST /tv/streams/:id/health` fail per source, ok after 30s), watch events `POST /tv/events/:channelId`. Live-edge behavior via AVPlayer defaults; no custom catch-up logic in v1 (server proxy + AVPlayer handle live windows).
11. **Account-lite** (`AccountOverview` + `ProfileMenuEditor`): avatar/name/kind, language switcher (PATCHes profile → drives catalog re-localization), switch profile, per-profile menu editor (enable + reorder, ≥1 required), server info + unlink device (clear token → onboarding). No admin tabs.

## 8. Player upgrades (VOD)

Keep the AVKit stack (observers, serialized progress chain, teardown, resume, next-episode autoplay) untouched at its core. Add via transport-bar menu (`transportBarCustomMenuItems`):

- **Quality selector** — options from `qualities[]`; choosing re-POSTs `/playback/info` with `quality`, preserving current position, stopping the previous session (web Player behavior).
- **Audio leveling** — `standard`/`leveled` `audioMode` toggle, same re-negotiation.

Audio/subtitle track selection stays native (in-manifest HLS renditions, `subtitleDelivery: "hls"`).

## 9. i18n

- String Catalog(s) with en/es/de/pt/ru/fr; keys organized to mirror the web namespaces (common, nav, catalog, search, title, wishlist, player, tv, profiles, account, errors).
- UI language: active profile's `language` overrides; system language fallback; applied at profile select and on language change (mirrors `useSyncProfileLanguage`).
- Region names via `Locale.localizedString(forRegionCode:)` (UK→GB fix like web); times via locale-aware `DateFormatter`; numbers monospaced-digit.
- Error-code → localized message mapping (port `tError.ts` approach).

## 10. Testing & verification

- **Unit:** DTO decode tests for every new endpoint (existing `DTOTests` style); EPG window/geometry math tests (port of `tv-grid-layout` cases); billboard daily-seed pick tests; existing suites stay green.
- **Server:** vitest for tv-proxy query-token auth + playlist token propagation + kids 403; full repo gates.
- **Per-phase gates:** `xcodegen generate` + `xcodebuild build` + `xcodebuild test` (simulator, `CODE_SIGNING_ALLOWED=NO`).
- **Live verification per phase:** run in tvOS simulator against the NAS (`http://192.168.1.95:8080`, paired device token), screenshot each screen and compare side-by-side with the web app; verify kids profile hides TV + filters catalog.
- **Final milestone:** sideload to the physical Apple TV 4K (team `UG27UAHLA4`, `-allowProvisioningUpdates -allowProvisioningDeviceRegistration`, `devicectl device install/launch`), verify VOD + live playback on hardware.

## 11. Phasing

| Phase | Contents | Exit gate |
|---|---|---|
| 0 | Server tv-proxy token fix + tests | repo gates green |
| 1 | Design tokens/components, custom top-bar shell, restyled onboarding + profiles | build+test green, simulator screenshots vs web auth/profiles |
| 2 | Home (billboard + rails), Library browse, Search, Wishlist (+ OrbixKit endpoints) | side-by-side vs web Home/Library/Search/Wishlist |
| 3 | Title page full parity, player quality/audio menu | side-by-side vs web title page; playback smoke vs NAS |
| 4 | Live TV: TV home, guide list+grid, channel page, live player w/ zap+failover | live channel plays in simulator vs NAS; EPG grid parity |
| 5 | Account-lite, i18n (6 languages), kids polish, edge/empty/error states | language switch smoke; kids profile smoke |
| 6 | Full-parity audit (every screen vs web), real-device deploy | user acceptance on the Apple TV 4K |

## 12. Non-goals / deferred

- Admin surfaces on TV (settings, libraries, scan, fix-match, TV-source/EPG admin, device registry) — web-only by product decision.
- Profile creation/editing beyond add-profile parity on the picker; PIN entry UI (web parity = localized error only).
- Custom live-TV catch-up/timeshift beyond AVPlayer defaults.
- iPhone/iPad targets.

## 13. Risks

- **EPG grid on tvOS** is the hardest UI: 2D sticky grid + focus engine. Mitigation: bounded 4-hour window (like web), `LazyVStack` row virtualization, ported layout math with tests, list view as the fallback default if grid focus proves janky (web defaults to list too).
- **Live HLS variability** (upstream channel quality): the failover ladder + health reporting mirror the web's tuned behavior; AVPlayer's live handling differs from hls.js — acceptance is "zap works, dead channels fail over in a few seconds."
- **Simulator ≠ device** for HEVC/keychain: keychain doesn't persist in simulator (known), HEVC hardware decode needs the real device — both covered by the Phase 6 hardware pass.
