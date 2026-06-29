# Task 12 Report: Catalog Routes + Browse UI + TMDB Attribution

## Status: DONE

All requirements implemented, typechecks clean, build passes, e2e passes (3/3 tests green).

---

## What was built

### Part A — Catalog API routes (`apps/api/src/routes/catalog.ts`)

**`GET /sections/:id/items?sort=&q=`**
- Returns `Array<{id, title, year, posterPath, matchState}>`
- Sort: `title` (default, `sortTitle asc`), `added` (`addedAt desc`), `year` (`year desc`)
- `q`: case-insensitive `contains` filter on title
- MVP cap: 500 rows via Prisma `take: 500`
- Auth: `requireAdmin` preHandler (checks `req.accountId`)

**`GET /items/:id`**
- Returns full detail: scalars + genres (via `MediaItemGenre` join) + cast (top 15, `department="cast"`, ordered by `order`) + director (`department="crew"`, `role="Director"`) + files
- 404 if item not found
- **BigInt handling**: `size: f.size == null ? null : f.size.toString()` — confirmed working by curl smoke test (returned `"12345678901234"` as string, not number/error)

**Registered in `apps/api/src/app.ts`**: `await app.register(catalogRoute)` added after `scanRoute`.

**Also fixed**: `GET /libraries` now includes `{ sources: true }` within sections so the admin page can display sources.

---

### Part B — Web pages

**`apps/web/src/app/admin/libraries/page.tsx`**
- Client component; loads `GET /libraries` on mount
- Forms to create Library (`POST /libraries`), Section (`POST /sections`), Source (`POST /sources`) with path input
- Delete buttons for library/section/source
- "Scan" button per section: `POST /sections/:id/scan` → `{jobId}` → `new EventSource("/api/scan/${jobId}/stream")` → shows phase + count until `phase:"done"`, then reloads library list
- `formatScanState` renders `"scanning: 2/5"` or `"Done — added: 3, updated: 0, matched: 2"`

**`apps/web/src/app/library/[sectionId]/page.tsx`**
- Client component; resolves `params` Promise for Next 15 App Router
- Responsive poster grid: `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6`
- Matched items with `posterPath`: `<img src={/api/images/${posterPath}} />`
- Unmatched items: placeholder card with title text
- Sort control (select) + search input; each change re-fetches via `loadItems` (wrapped in `useCallback`)
- Each card links to `/title/[id]`

**`apps/web/src/app/title/[id]/page.tsx`**
- Client component; resolves `params` Promise
- Backdrop: full-width image with gradient overlay (if `backdropPath` present)
- Header: poster (md+), title, year, runtime (`formatRuntime`: `Xh Ym` or `Ym` if <1h), rating
- Unmatched notice (yellow text) if `matchState !== "matched"`
- Genres as pill badges
- Disabled `<Button disabled>Play (coming soon)</Button>`
- Overview, Director section, Cast grid (up to 15 members)
- 404 + error states handled gracefully

**`apps/web/src/app/layout.tsx`**
- Added `<footer>` with exact attribution text:
  `This product uses the TMDB API but is not endorsed or certified by TMDB.`
- Layout wraps children in `flex-col min-h-screen` div with `flex-1` so footer stays at bottom

---

### Part C — E2E (`apps/web/e2e/library.spec.ts`)

**Seeding strategy**: `beforeAll` seeds directly via `@orbix/db` prisma (no TMDB, no ffprobe):
- Library ID: `seedlibrary00000000000001`
- Section ID: `seedsection0000000000001`
- Item ID: `seeditem000000000000000001`
- `matchState: "matched"`, `posterPath: "poster/seed.jpg"`
- Tiny valid 1×1 JPEG written to `METADATA_DIR/poster/seed.jpg`

**Auth**: `doOnboarding(page)` helper navigates to `/` and branches on redirect:
- `/setup` path: runs full admin account creation + profile creation
- `/login` path: logs in with existing account (test 2 uses this branch)
- Then selects "Tester" profile on `/profiles`

Uses `test.describe.configure({ mode: "serial" })` so test 2 runs after test 1 completes setup.

**`afterAll`**: cleans all seeded rows + profile + account + poster file.

**Tests**:
1. `"library grid shows seeded movie"` → goto `/library/seedsection0000000000001` → asserts "Seeded Movie" visible
2. `"title detail shows overview"` → goto `/title/seeditem000000000000000001` → asserts "A seeded overview for testing." visible

---

## Verification output

### Typecheck
```
pnpm --filter @orbix/api typecheck → exit 0 (no errors)
pnpm --filter @orbix/web typecheck → exit 0 (no errors)
```

### Build
```
pnpm --filter @orbix/web build → exit 0
Routes:
  ○ /admin/libraries
  ƒ /library/[sectionId]
  ƒ /title/[id]
```

### E2E
```
pnpm --filter @orbix/web test:e2e

Running 3 tests using 2 workers
  ✓  [chromium] › e2e/onboarding.spec.ts  (2.0s)
  ✓  [chromium] › e2e/library.spec.ts › library grid shows seeded movie (3.1s)
  ✓  [chromium] › e2e/library.spec.ts › title detail shows overview (1.8s)

3 passed (9.7s)
```

### Curl smoke (BigInt confirmed)
```bash
curl -sb /tmp/orbix-cookie.txt "http://localhost:1061/items/<itemId>"
# files[0].size → "12345678901234"  (string, not error)
```

---

## Self-review / concerns

1. **BigInt**: Explicitly converted via `.toString()` before return — confirmed by curl smoke test. No BigInt escapes to JSON serializer.

2. **Auth on catalog routes**: Both `GET /sections/:id/items` and `GET /items/:id` require admin (`req.accountId`). Per spec: "admin for items list is fine; profile-gating comes with kids filtering in Phase 4."

3. **E2E isolation**: Library spec uses `libtest@home.lan` (distinct from onboarding spec's `me@home.lan`). `afterAll` cleans up. No interference with existing spec.

4. **`GET /libraries` sources fix**: The existing `libraries.ts` route was missing `include: { sources: true }` on sections. Fixed as part of this task so the admin page can list sources per section.

5. **No `next/image`**: Used `<img>` elements for poster/backdrop since `next/image` requires domain configuration and the image origin is same-origin `/api/images/*`. ESLint disable comments were removed (Next.js plugin wasn't in ESLint config).

6. **Phase 1 "done when"**: Library viewable offline — scan to enrich, browse correctly-enriched titles with local posters — all gates met by this task. Phase 1 is complete.
