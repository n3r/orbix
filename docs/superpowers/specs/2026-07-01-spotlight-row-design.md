# Spotlight Row — homepage featured area

**Date:** 2026-07-01
**Status:** Approved design (pre-implementation)
**Scope:** `apps/web` (frontend) + a minimal `apps/api` / `packages/core` change

## Summary

Rework the top of the homepage from the current auto-rotating single-item `Hero`
into a **spotlight row**: one large landscape hero on the left plus a
horizontally-scrollable strip of portrait posters on the right. Hovering (or
focusing) a poster promotes it into the hero. Below the hero: a metadata line, a
short description, and Play / add / More actions. This mirrors Netflix's
TV/tablet "spotlight" pattern, adapted to a pointer + keyboard on the web.

Everything below the spotlight row stays as today's poster rails
(`HomeRows` → `MediaRow` → `PosterCard`), unchanged.

### Decisions locked during brainstorming

| Question | Decision |
|---|---|
| Which item is the big hero (web) | **Hover promotes (debounced)**; keyboard focus also promotes |
| How many rows get the treatment | **Top row only** = spotlight; the rest stay rails |
| What feeds the featured row | **Resume-first**: Continue Watching when present, else the top discovery row |
| "NEW" badge | **Included** (plumb `MediaItem.addedAt`) |
| Auto-rotation | **None** (conflicts with hover-promote) |
| Play button | **Opens the title page** (`/title/:id`), same as today |

### Why this shape (research)

- Netflix's real **desktop-web** pattern is hover-*expand-in-place* rails + one
  top billboard. The large-hero "spotlight row" in the reference images is
  Netflix's **TV UI**, driven by a D-pad focus cursor (always exactly one
  focused item, changed deliberately). A mouse has no persistent focus, so we
  pick the hero via debounced hover and native keyboard focus.
- Layout-shift guidance is unanimous: a hero that *resizes* on hover jitters.
  The hero is therefore a **fixed-size container** whose *content* swaps
  (cross-fade); the row never reflows. `prefers-reduced-motion` → instant swap.

## Layout

```
┌───────────────────────────────────┐  ┌────┐┌────┐┌────┐┌───
│                                   │  │    ││    ││    ││      ← trailing posters:
│         HERO  (active item)       │  │▓▓▓▓││    ││    ││        every other item in
│    backdrop + logo art overlay    │  │▓▓▓▓││    ││    ││        the row (scroll →)
│                          [badges] │  │    ││    ││    ││
└───────────────────────────────────┘  └────┘└────┘└────┘└───
 BRIDGERTON                                hover / focus a poster
 S3 E4 · Old Friends   ▓▓▓▓▓▓░░ 20m left   (debounced ~200ms) →
 [▶ Play]  [ⓘ More Info]                    cross-fades into the hero
```

- **Hero slot**: fixed size, ≈16:9 landscape. Backdrop image + logo art overlay,
  with a text-title fallback when no logo. Legibility gradients (reuse the
  existing `Hero` gradient treatment). Badge stack overlaid on the artwork.
- **Below the hero** (on the page background, not overlaid): title (only if no
  logo art), metadata line, 2–3-line description, action buttons.
- **Trailing posters**: portrait (2:3), reusing `PosterCard` visuals. Each shows
  a progress bar overlay (Continue-Watching items) and a corner "NEW" badge when
  applicable. Horizontally scrollable so **no item in the row is dropped**.
- Default active item = the first item in the row.
- The featured row is **removed from the rails below** so it is not rendered
  twice. (Today's `Hero` duplicates the first row as both billboard and rail;
  this design fixes that.)

### Content selection (resume-first)

- If Continue Watching has items → it is the featured row. Hero shows the
  resume context: `S{n} E{m} · {episodeTitle}` (movies: no episode line),
  a progress bar, and "{X}m left". Reference image #1.
- Else → the top discovery row (e.g. Hidden gems / Tonight / first available
  row) is featured. Hero shows `Genre · Year · N Seasons · Cert` + description.
  Reference image #2.
- Fixes the latent bug at `apps/web/src/pages/HomePage.tsx:16`: it looks for row
  key `"continue_watching"`, but the real key is `"continue"` (see
  `packages/core/src/discovery/rows.ts`). Select the featured row by the correct
  key.

## Interaction

| Input | Behavior |
|---|---|
| **Hover (desktop)** | Debounced ~200ms → promote hovered poster to hero. Leaving the row keeps the last promoted item (no snap-back). |
| **Keyboard focus** | Tab to a poster promotes it (the pointer-less equivalent of the TV focus cursor). Roving `tabindex` across the poster strip. |
| **Click / Enter** | Navigate to `/title/:id`. |
| **Hero buttons** | `▶ Play` → `/title/:id`; `ⓘ More Info` → `/title/:id`. (Matches today's Hero. No add-to-list button — the app has no My List feature; deferred.) |
| **Touch** | No hover. First item is the hero; tapping a poster navigates to its title (posters are not a promote-preview on touch → avoids the mobile double-tap trap). |
| **Reduced motion** | `prefers-reduced-motion` → instant content swap, no cross-fade. |
| **Auto-rotation** | None. |

Debounce prevents the hero from thrashing while the mouse sweeps across the
strip. The fixed hero slot means promotion never changes the row's height.

## Data & backend changes (minimal)

Rich hero metadata (backdrop, logo, overview, genres, rating cert, runtime,
seasons) is **already** available from `GET /items/:id` (`TitleDetail`). The
current `Hero` already fetches it per candidate. We keep that, but fetch
**lazily on promote** (React Query cache dedupes; prefetch the first 1–2 items
for an instant initial paint). So the rows payload does **not** need to carry
all hero fields.

Two additions are required:

1. **Continue-Watching progress + resume context** on `/home/rows` items:
   - Extend `continueWatching()` (`packages/core/src/playback/resume.ts`) to
     retain `episodeId` (already stored on `PlaybackState` as
     `(profileId, mediaItemId, episodeId)`).
   - In `GET /home/rows` (`apps/api/src/routes/discovery.ts`, hydration step
     ~L220–240), continue items gain:
     - `progress: { positionSec: number; durationSec: number } | null`
     - `resume: { seasonNumber: number; episodeNumber: number; episodeTitle: string | null } | null`
       (join `episodeId` → `Episode` → `Season`; `null` for movies or when the
       episode can't be resolved — degrade to title + time-left only).
   - Kids-filtering already runs on this route — unchanged.

2. **`addedAt` for the "NEW" badge**:
   - Include `addedAt` (ISO string) on `/home/rows` items (for trailing-poster
     badges) and on `TitleDetail` from `/items/:id` (for the hero badge).
   - "New" = added within **14 days**, computed client-side via a single shared
     helper `isNew(addedAt)` so the threshold lives in one place.

No new endpoints. `MediaCard` / `TitleDetail` types in
`apps/web/src/lib/types.ts` are widened to match.

## Frontend components

New, under `apps/web/src/components/spotlight/`:

- **`SpotlightRow`** — orchestrator. Owns active-item state, debounced-promote
  logic, lazy `/items/:id` fetch for the active item, cross-fade, keyboard roving
  focus. Replaces `Hero` in `HomePage`. Props: `{ items: MediaCard[] }` (the
  featured row's items, already carrying `progress`/`resume`/`addedAt`).
- **`SpotlightHero`** — presentational big card: backdrop + logo (title fallback)
  + `BadgeStack` + metadata line + description + action buttons. Props: the
  active item's `TitleDetail` (+ its `progress`/`resume` from the row item).
- **`SpotlightPoster`** — one trailing thumbnail: reuses `PosterCard` visuals +
  progress-bar overlay + "NEW" corner badge + hover/focus affordance.
- **`BadgeStack`** — generic, extensible. v1 renders: progress "{X}m left"
  (Continue Watching) and "NEW". Maturity cert (e.g. TV-MA) lives in the
  metadata line, not the badge stack.

`HomePage` renders `<SpotlightRow items={featured.items} />` followed by
`<HomeRows rows={remainingRows} />` (featured row excluded). The old `Hero`
component is removed (or kept only if still used elsewhere — verify no other
consumers).

## Responsive

- **≥ md (768px):** side-by-side spotlight as drawn.
- **< md:** collapse to a single full-width backdrop hero (active = first item)
  with metadata/description below, then the remaining items as a standard
  horizontal poster rail beneath it. No promote-on-hover (touch context).

## Non-goals (v1)

- Video-preview autoplay on hover.
- Award / "New Season" badges (no data source).
- Quality (HD/4K) badges (data is per-`MediaFile`; deferred).
- Redesigning the rails below the spotlight.
- Immediate playback from the Play button (opens the title page instead).
- An add-to-list / "My List" button (no such feature exists in the app yet).

## Testing

- **Core (`packages/core`):** `continueWatching()` returns `episodeId`;
  resume-label derivation (season/episode/title) from a `PlaybackState` + episode
  fixtures. Pure, no DB/network.
- **API (`apps/api`):** `/home/rows` includes `progress`/`resume`/`addedAt` on
  continue items; movies get `resume: null`; kids-filtering still applies.
- **Component (`apps/web`):** promote-on-hover is debounced; keyboard focus
  promotes; `prefers-reduced-motion` swaps instantly; touch = navigate (no
  promote); "NEW" shows only within threshold; progress bar width matches
  `positionSec/durationSec`.
- **E2E (Playwright, throwaway DB):** spotlight row renders; hovering a trailing
  poster swaps the hero; a Continue-Watching item shows the progress bar and
  resume label. Run against a throwaway DB per the repo's e2e harness rules.

## Rollout / risk notes

- Data delivery is additive (new optional fields); existing consumers unaffected.
- `BigInt` serialization: unrelated to the new fields, but if any `MediaFile`
  data is touched, `.toString()` before `JSON.stringify` (repo gotcha).
- Verify no other consumer imports `Hero` before removing it.
- Smoke migrations/e2e on a throwaway DB, never the populated dev DB (repo rule).
