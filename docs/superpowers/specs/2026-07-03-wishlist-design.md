# Wishlist ("Watch Later") — Design

**Date:** 2026-07-03 · **Branch:** `features/wishlist`

## Goal

Per-profile wishlist: a profile saves titles it wants to watch later, adds/removes them
from the title page, and browses them via the heart icon in the top nav — currently a
disabled `Placeholder` (`apps/web/src/components/shell/TopNav.tsx:85`). This is the
feature every prior spec deferred as "My List" (spotlight-row spec §out-of-scope,
floating-nav spec §deferred, MVP data model's `ListEntry` sketch).

## Decisions

- **Name:** user-facing **"Wishlist"** (en). Other locales use the idiomatic
  "my list" family (es "Mi lista", de "Meine Liste", pt "Minha lista",
  ru "Мой список", fr "Ma liste") — natural equivalents, not literal calques.
  Internal identifiers: `WishlistEntry`, `/api/wishlist`, `/wishlist`. The existing
  `nav:myList` key is renamed to `nav:wishlist` (it has no other consumers).
- **Scope:** per profile, like `PlaybackState` — each profile keeps its own list.
- **Alternatives considered:**
  - *Membership signal for the title page:* (a) an `inWishlist` flag on
    `GET /items/:id`, (b) a dedicated `GET /wishlist/ids`, (c) client derives it from
    the full list response. **Chosen: (b)** — keeps the catalog route untouched and
    profile-cache-neutral, and a flat id array is the natural target for optimistic
    toggles. (c) forces the title page to fetch full cards it doesn't render.
  - *Storage:* dedicated `WishlistEntry` table vs. a generic "named list" table.
    **Chosen: dedicated table** (YAGNI — one list per profile is the product).

## Data model (`packages/db/prisma/schema.prisma`)

```prisma
model WishlistEntry {
  id          String   @id @default(cuid())
  profileId   String
  mediaItemId String
  addedAt     DateTime @default(now())

  @@unique([profileId, mediaItemId])
  @@index([profileId, addedAt])
}
```

Follows repo convention for per-profile tables (bare String ids, no `@relation` —
same as `PlaybackState`/`PlayEvent`). Stale entries after item deletion are inert:
the list route inner-joins against `MediaItem`, so they simply don't render.
Migration: `packages/db/prisma/migrations/20260703<hhmmss>_wishlist/` (hand-written,
matching existing migration SQL style).

## API (`apps/api/src/routes/wishlist.ts`, registered under `/api` in `app.ts`)

All handlers: `preHandler: requireAuth(app)`; read `profileId` from the
`orbix_profile` cookie, `400 { error: "no_profile" }` when absent (repo convention,
`playstate.ts`). **Kids filtering is server-enforced on every route** (hard
requirement): `kidsRatingWhere(profile)` on list-style reads, `profileAllowsItem`
on writes.

- `GET /wishlist` → `MediaCard[]` (same shape and localized-title coalescing as
  `GET /libraries/:id/items`, `catalog.ts:38-60`), newest-first by `addedAt`.
  Two queries: entries for the profile, then
  `mediaItem.findMany({ where: { id: { in }, ...ratingFilter } })` with the card
  select + `translations`; re-order to entry order. No `files` selected → no BigInt
  serialization concern.
- `GET /wishlist/ids` → `{ ids: string[] }`, also kids-filtered (fail-safe: a
  blocked title's id must not leak into UI state).
- `POST /wishlist/:itemId` → verify the item exists **and**
  `profileAllowsItem(profile, { rating })`, else `404 { error: "not_found" }`
  (mirrors `GET /items/:id` non-leak behavior). Then upsert on
  `profileId_mediaItemId` → `{ ok: true }`. Idempotent.
- `DELETE /wishlist/:itemId` → `deleteMany({ profileId, mediaItemId })` →
  `{ ok: true }`. Idempotent; no existence check needed.

## Web (`apps/web`)

- **Route:** `{ path: "/wishlist", element: <WishlistPage /> }` under
  `RequireProfile` in `router.tsx`.
- **TopNav:** replace the heart `Placeholder` with a `Link to="/wishlist"`
  (aria-label `nav:wishlist`), active-state styling like the adjacent Home link.
  The right cluster is visible at all breakpoints, so mobile is covered —
  **no BottomNav change.**
- **WishlistPage:** `LibraryPage` pattern — heading, responsive `PosterCard` grid,
  loading state, and an empty state (title + hint pointing at the title-page button).
- **TitleHero:** an add/remove secondary button next to Play (the placement the
  movie-tv-page-rework spec sketched: `▶ Play │ + Wishlist`). `TitleHero` stays
  presentational: new props `wishlistLabel`, `inWishlist` (`boolean | undefined` —
  render the button only when defined, so the hero renders unchanged while ids
  load), `onToggleWishlist`. `TitlePage` wires them.
- **`lib/queries.ts`:** `useWishlist()` (`["wishlist","items"]`),
  `useWishlistIds()` (`["wishlist","ids"]`), `useToggleWishlist()` — mutation with
  optimistic update of the ids array (rollback on error) and invalidation of both
  keys on settle.
- **i18n (all 6 locales; `parity.test.ts` enforces):**
  - `nav.json`: `myList` → `wishlist` (value: "Wishlist" / idiomatic equivalents).
  - `title.json`: `addToWishlist`, `inWishlist` (button labels).
  - new `wishlist.json` namespace: `heading`, `empty`, `emptyHint` (+ add to
    `NAMESPACES` in `lib/i18n/index.ts`).

## Error handling

- Unauthenticated → 401 (`requireAuth`); no profile cookie → 400 `no_profile`;
  unknown or kids-blocked item on add → 404 `not_found`.
- Web mutation failure → optimistic ids rollback; button returns to prior state.

## Testing

- **API** `apps/api/src/routes/wishlist.test.ts` (structure of `menu.test.ts`:
  `buildApp` + stubbed `app.prisma.*` + `app.inject`): 401 without session; 400
  without profile cookie; add upserts on the compound unique; add of kids-blocked
  title → 404 and no upsert; list applies `kidsRatingWhere` and returns newest-first
  cards; ids route filtered the same way; delete is idempotent.
- **Web:** `WishlistPage.test.tsx` (grid links to `/title/:id`, empty state);
  extend `TitleHero.test.tsx` for the toggle (renders per `inWishlist`, fires
  `onToggleWishlist`, hidden when undefined).
- Locale parity is covered by the existing `parity.test.ts`.

## Out of scope

- Add-to-wishlist buttons on cards, home rows, or the billboard (stays deferred, per
  the spotlight-row spec).
- Episode-level entries, multiple named lists, sorting/filter controls on the page.
- A BottomNav tab (heart is reachable on mobile via the top-right cluster).
