# Library Page Tabs: Categories + Browse — Design

**Date:** 2026-07-05
**Status:** Approved
**Branch:** `lib-view` (fast-forwarded onto `origin/main` @ `c20c576`, which includes the homepage smart-rows engine from PR #44)

## Goal

Rework the library viewing page (`/library/:libraryId`) from a single searchable
poster grid into two tabs:

- **Categories** — auto-generated genre rows, one rail per genre present in the
  library, in the visual style of the homepage rails.
- **Browse** — a flat poster grid of the whole library, sorted alphabetically
  across scripts (A→Z, then А→Я, then any other scripts), driven by the titles
  as displayed in the profile's language.

Decisions made with the user:

| Question | Decision |
| --- | --- |
| Browse layout | Flat sorted poster grid (no letter headers / jump bar) |
| Which genre rows | All genres in the library, ordered by item count descending |
| Row depth | Rails capped at 24 items + a "See all" grid per genre |
| Rail ordering | Top-rated first (`imdbRating ?? tmdbScore`, unrated last) |
| Grouping location | Server: new dedicated API endpoint; pure logic in `@orbix/core` |

## Non-goals

- No letter jump bar or section headers in Browse (flat grid was chosen).
- No changes to the homepage rows, nav menus (`ProfileMenuEntry`), or the admin
  libraries page.
- No new DB schema or migrations — `Genre`, `MediaItemGenre`, `GenreTranslation`,
  `MediaItem.sortTitle`, and the rating floats already exist.
- No pagination/virtualization in Browse; the grid renders all items with lazy
  images (cap raised to 2000, in line with the home-rows catalog cap).

## API

### New: `GET /api/libraries/:id/rows` (Categories tab)

- Auth identical to `GET /libraries/:id/items`; kids profiles are
  server-filtered via `kidsRatingWhere(profile)` (`apps/api/src/lib/catalog-filter.ts`).
- Single Prisma query: the library's items with card fields
  (`id,title,posterPath,year,kind,sortTitle`), rating floats
  (`imdbRating,tmdbScore`), genre links (`genres.genreId` + genre
  `tmdbId`/`name`), and title translations for the profile language.
- Grouping is a pure function in `packages/core/src/catalog/library-rows.ts`:

  ```
  buildLibraryGenreRows(items: LibraryRowItem[]): LibraryGenreRow[]
  //  → [{ genreId, total, itemIds }] where
  //    rows ordered by total desc, tie → base genre name asc;
  //    itemIds = top 24 by (imdbRating ?? tmdbScore) desc, unrated last,
  //              tie → sortTitle asc.
  ```

- The route hydrates ids → cards (`localizeItem` for titles) and localizes row
  headings via `GenreTranslation` for the profile language, falling back to the
  base English `Genre.name` (same pattern as the home `genre:*` rows in
  `apps/api/src/routes/discovery.ts`).
- Response: `{ rows: [{ key: "genre:<genreId>", genreId, title, total, items: MediaCard[] }] }`.
- Items with no genres appear only in Browse. Empty library → `rows: []`.

### Extended: `GET /api/libraries/:id/items` (Browse + See-all)

- New query param `genre=<genreId>` — filters to items linked to that genre
  (used by the "See all" grid). Combinable with `q`.
- New `sort=rating` — `(imdbRating ?? tmdbScore)` desc, unrated last, tie
  `sortTitle` asc. Computed in-memory after the fetch (coalesced sort isn't a
  single Prisma `orderBy`). Used by the "See all" grid so it continues the
  rail's order.
- New `sort=alpha` — the Browse order. The server resolves each item's
  *displayed* title (translation for the profile language, else base title) and
  sorts with a pure comparator from
  `packages/core/src/catalog/alpha-sort.ts`:
  1. Script bucket of the first letter or digit (leading whitespace/punctuation
     skipped; no article stripping): Latin, then Cyrillic, then any other
     letter script, then digits/symbols last. Buckets are implicit — a library
     with no Cyrillic titles simply has no Cyrillic block.
  2. Within a bucket: case-insensitive `localeCompare` (locale from the profile
     language).

  The DB fetch stays ordered by `sortTitle` so the 2000-item cap truncates
  deterministically before the in-memory sort.
- Existing sorts (`title`, `added`, `year`) remain for API compatibility; the
  web UI no longer offers them.
- Item cap raised 500 → 2000 so Browse covers the whole library.
- `q` search behavior unchanged (base-title contains; localized search stays
  deferred as noted in `catalog.ts`).

## Web UI

### `Tabs` primitive — `packages/ui`

New accessible component (none exists): `role=tablist/tab/tabpanel`, arrow-key
navigation, `focusRing` + semantic tokens, controlled `value`/`onChange`.
Exported from `@orbix/ui`.

### `LibraryPage.tsx` rework

- Tab state lives in the URL: default = Categories, `?tab=browse` = Browse.
  Deep links and back button work; switching libraries resets to Categories.
- **Categories tab**
  - `useLibraryRows(libraryId)` → `GET /api/libraries/:id/rows` (TanStack
    Query, keyed per library).
  - Rails reuse the homepage rail look: `MediaRow`-style strip of landscape
    `BoxArtCard`s. The row header adds a "See all (N)" link. `MediaRow` is
    generalized (optional header-action slot) rather than forked.
  - "See all" → `?genre=<genreId>`: in-page grid view with localized genre
    heading + count, `PosterCard` grid sorted by `sort=rating`, and a back
    control returning to the rails.
- **Browse tab**
  - Flat `PosterCard` grid (same grid classes as today), `sort=alpha`.
  - Keeps the search input (`q`); the title/added/year sort dropdown is
    removed.
- Loading: skeleton rails (Categories) / skeleton grid (Browse). Empty states
  reuse `catalog:browse.empty`; an empty Categories tab (no enriched genres)
  shows an explanatory empty state pointing at Browse.
- i18n: new `catalog` namespace keys (`tabs.categories`, `tabs.browse`,
  `rows.seeAll`, genre-grid strings) in all 6 locales (en/ru/de/es/fr/pt); the
  bundle-parity test enforces key equality.

## Error handling

- Kids profiles: both endpoints filter server-side; a capped profile never
  receives disallowed items in any row, grid, count, or total.
- Missing genre translation → English `Genre.name`.
- Unrated items sort after rated ones in rails and `sort=rating`.
- Unknown `genre` id or a genre emptied by the kids filter → empty item list
  (UI shows the standard empty state).
- `MediaFile.size` BigInt: card payloads don't include file sizes; keep it that
  way in the new rows route.

## Testing

- `packages/core`: vitest for `buildLibraryGenreRows` (count ordering,
  name tiebreak, 24-cap, rating coalesce/nulls-last, no-genre exclusion) and
  the alpha comparator (Latin < Cyrillic bucketing, other scripts, digits last,
  case-insensitivity, locale tiebreaks).
- `apps/api`: route test for `/libraries/:id/rows` following the existing
  `discovery.test.ts` pattern (localized headings, kids filtering).
- `apps/web`: update any tests/e2e specs assuming the old single-grid layout.
  E2e only against a throwaway DB.
- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, then the
  repo `/verify` runtime smoke of both tabs in en and ru.
