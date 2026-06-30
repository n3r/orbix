# Full-page immersive video player

**Date:** 2026-06-30
**Status:** Approved (design decisions captured interactively)

## Problem

Clicking **Play** on a title currently expands a small inline `aspect-video` block
inside `TitlePage` (`apps/web/src/components/Player.tsx` rendered inline at
`apps/web/src/pages/TitlePage.tsx`). We want a full-page, immersive cinema
experience like Netflix / Plex, with proper playback and sound controls.

## Decisions

- **Look:** keep Vidstack's `DefaultVideoLayout`, themed dark, made full-page
  (not a bespoke control bar). Robust, gives scrubber/volume/captions/settings
  for free.
- **Navigation:** fullscreen **overlay** via `createPortal` to `document.body`
  (`position: fixed; inset: 0`). No URL change. Close via a top-left
  chevron-down affordance or `Esc`.
- **Controls:** skip −10s (default seek button) / +30s (forward-button slot
  override), Picture-in-Picture, settings menu (playback speed / quality /
  audio / subtitles), volume + mute. All come from the default layout except
  the +30 override.

## Architecture

Two components, clean split:

1. **`PlayerOverlay.tsx`** (new) — the cinema container.
   - Renders via `createPortal(…, document.body)` as `fixed inset-0 z-50 bg-black`.
   - Body scroll-lock while mounted (restored on unmount).
   - `Esc` → `onClose`, but if `document.fullscreenElement` is set, let the
     browser exit fullscreen first (don't also close).
   - Always-visible top-left chevron-down close button → `onClose`.
   - Renders `<Player>` filling the viewport.

2. **`Player.tsx`** (refactor existing) — the engine. Keeps ALL current logic:
   decision fetch, bundled hls.js wiring (`onProviderChange`), 10s periodic
   progress save, resume-seek on `canPlay`, subtitle `<Track>`s,
   save-on-pause / visibility-hidden / unmount. Changes:
   - Container `aspect-video` block → `h-full w-full bg-black` (fills overlay).
   - `MediaPlayer`: add `autoPlay`, `playsInline`, `keyTarget="document"`
     (global keyboard shortcuts), `style={{ '--media-brand': 'var(--accent)' }}`
     (tint sliders to Orbix accent).
   - `DefaultVideoLayout`: `colorScheme="dark"`, `seekStep={10}` (keyboard seek).
     The default **large** (desktop) layout renders no on-screen seek buttons, so
     the −10s / +30s pair is injected via the large layout's
     `slots.largeLayout.beforePlayButton` / `afterPlayButton` (flanking the play
     button), using `SeekButton` with `SeekBackward10Icon` / `SeekForward30Icon`.

## Dependencies

- Added **`media-icons@1.1.5`** to `apps/web` for the numbered seek icons
  (`SeekBackward10Icon` / `SeekForward30Icon` from `@vidstack/react/icons`).
  Note: the registry `latest` tag (0.10.0) is stale and incompatible with
  `@vidstack/react@1.15.6` (missing `accessibilityPaths` etc.); the matching
  build is published under the `next` tag (1.1.5).
- The docker `web` container bakes `node_modules` into its image (only
  `apps/web/src` is volume-mounted), so any web dependency change requires
  `docker compose up -d --build web` for `localhost:1060` to pick it up.

## Entry / exit flow (TitlePage)

- `Play` → `setPlaying(true)` (unchanged trigger) mounts `<PlayerOverlay>`
  (lazy-loaded) instead of the inline block.
- Close (chevron / `Esc`) → `setPlaying(false)`. `Player` unmount saves
  progress (existing behavior) so continue-watching keeps working.

## Reused unchanged (no backend changes)

`/play/:fileId/decision`, `/play/:fileId/direct` & `/master.m3u8`,
`/play/:fileId/subs[/:index]`, `GET`/`PUT /items/:id/progress`.

## Out of scope (YAGNI)

- **Sprite/storyboard scrubber thumbnails** — Orbix doesn't generate sprite
  sheets; that's meaningful ffmpeg backend work. Scrubber keeps its time
  tooltip. Deferred enhancement.
- Prev/next episode, shuffle, repeat — no series model in a movie library.
- Launching playback directly from rows / continue-watching — those still route
  through the title page.

## Testing

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (gates).
- Manual browser smoke: Play opens full-screen overlay; play/pause, volume,
  seek ±10/+30, settings, PiP, fullscreen present; `Esc` / chevron closes;
  progress resumes on re-open.
