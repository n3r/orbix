# Movie / TV Series Page Rework — Master Design

**Date:** 2026-06-30
**Status:** Approved (design forks decided via brainstorming Q&A)
**Branch:** `feat/movie-tv-page-rework`

## Goal

Rework the title detail page (`/title/:id`) from a generic, constrained layout into a
best-in-class, Netflix-style cinematic experience. Five user requirements:

1. Full-width page.
2. Cinematic hero image, sourced robustly (TMDB backdrop + logo art, with a
   video-frame grab as offline fallback).
3. Seasons / Episodes drill-down for TV series & anime.
4. "More Like This" / Similar section.
5. IMDb + Rotten Tomatoes ratings (plus TMDB score).

## Decisions (locked via Q&A)

- **TV scope:** Full TV support — Season/Episode data layer, TMDB TV enrichment,
  scanner episode-grouping, episode playback, drill-down UI.
- **Ratings:** OMDb (IMDb / Rotten Tomatoes / Metacritic) **and** TMDB score; show
  both. OMDb cached at scan time; runtime stays offline. TMDB score is the
  always-present baseline.
- **Hero sourcing:** Backdrop + logo/title-art (fanart.tv → TMDB images) + ffmpeg
  frame-grab fallback.
- **TV model:** Dedicated `Season` + `Episode` tables. Series is
  `MediaItem(kind="series")`. Movies unchanged.

## Architectural constraints (from CLAUDE.md / codebase)

- **`packages/core` stays pure**: no DB / network / ffmpeg / fs imports. All I/O is
  injected (the `fetchImpl`, `run`, `cacheImage`, `saveMetadata` adapter pattern).
  New work (OMDb fetch, frame extraction, TV enrichment) follows this — core defines
  pure functions taking adapters; `apps/api` supplies the real adapters
  (`apps/api/src/plugins/queue.ts` is the canonical wiring point).
- **Offline guarantee**: all metadata/images cached to `METADATA_DIR` at scan time.
  Browsing/playback never hit the network.
- **Kids filtering is server-enforced on every route.** Episodes inherit the series'
  `rating`; episode `MediaFile.mediaItemId` points at the series so the existing
  `apps/api/src/routes/stream.ts` rating lookup and `catalog-filter.ts` keep working
  unchanged.
- **`MediaFile.size` is `BigInt`** → `.toString()` before `JSON.stringify`.
- **Run `pnpm lint` per change** (not just typecheck+test; Turbo cache can hide
  lint-only failures).

## Grounding map (current code)

| Concern | Location |
| --- | --- |
| Detail page | `apps/web/src/pages/TitlePage.tsx` |
| Route | `apps/web/src/router.tsx` (`/title/:id`) |
| Item detail API | `apps/api/src/routes/catalog.ts` `GET /items/:id` |
| Image serving | `apps/api/src/routes/images.ts` `GET /api/images/*` |
| Image cache (jpg only) | `packages/core/src/metadata/images.ts` |
| Enrich (movie) | `packages/core/src/metadata/enrich.ts` `enrichItem` + `SaveMetadataInput` |
| TMDB client | `packages/core/src/metadata/tmdb.ts` (movie-only; `get<T>` uses `fetchImpl`) |
| Filename parser | `packages/core/src/scanner/parse.ts` (`@ctrl/video-filename-parser`; title/year only) |
| Scanner | `packages/core/src/scanner/scan.ts` `scanSource`; upsert in `queue.ts` `upsertItemAndFile` |
| Enrich wiring | `apps/api/src/plugins/queue.ts` (`saveMetadata`, `cacheImage`, `probe` adapters) |
| Stream (per-fileId) | `apps/api/src/routes/stream.ts` `/play/:fileId/decision` etc. |
| Player | `apps/web/src/components/Player.tsx` (props: `fileId`, `mediaItemId`, `title`) |
| Progress | `apps/api/src/routes/playstate.ts`; `PlaybackState @@unique([profileId, mediaItemId])` |
| Similarity | `packages/core/src/discovery/similarity.ts` `itemSimilarity`; embeddings in `apps/api/src/discovery/` |
| Settings | `apps/api/src/routes/settings.ts` (already has `omdbKey`, `fanartKey`) |
| Migrations | `packages/db/prisma/migrations/` (latest `20260629202900_discovery`; api runs `migrate deploy` on start) |

## Target page layout (full-width)

```
[ FULL-BLEED BACKDROP ~88vh ] cinematic gradient scrims (bottom + left)
  LOGO ART (fanart.tv PNG) — falls back to styled large type
  ★ IMDb 9.0  🍅 96%  ▲ TMDB 8.7 · 2021 · 9 eps · [16+] · Action
  short synopsis (clamped)
  ▶ Resume S1:E3 │ + My List │ ⓘ details
── Seasons & Episodes (series only): [Season N ▾] + episode list
   (still thumb · number · title · runtime · progress bar · ▶)
── Cast (avatar rail)
── More Like This (PosterCard rail)
── Details (director · genres · file/quality)
```

Full-bleed (drop the constrained container), dark theme, glassy rating chips,
accent primary button, hover-scale cards. Movies omit the Seasons section; the rest
is shared.

## Data model changes

`MediaItem` — add:
`logoPath String?`, `backdropSource String?` (`"tmdb" | "frame"`), `tagline String?`,
`status String?` (series, e.g. `Ended`/`Returning`), `tmdbScore Float?`,
`imdbRating Float?`, `imdbVotes Int?`, `rtRating Int?` (0–100), `metacritic Int?`.

`Season` (new):
`id`, `seriesId → MediaItem`, `seasonNumber Int`, `name String?`, `overview String?`,
`posterPath String?`, `airYear Int?`, `tmdbSeasonId Int?`,
`@@unique([seriesId, seasonNumber])`.

`Episode` (new):
`id`, `seasonId → Season`, `seriesId String` (denormalized), `episodeNumber Int`,
`title String?`, `overview String?`, `stillPath String?`, `runtimeSec Int?`,
`airDate DateTime?`, `tmdbEpisodeId Int?`, `@@unique([seasonId, episodeNumber])`.

`MediaFile` — add `episodeId String?`. Movie files: `mediaItemId` only. Episode
files: **both** `mediaItemId` (= series, preserves kids-rating lookup) **and**
`episodeId`.

`PlaybackState` — add `episodeId String @default("")`; change unique to
`@@unique([profileId, mediaItemId, episodeId])`. Movies use `""`; episodes use the
episode id. Keeps the existing Prisma `upsert` (no nullable-unique pitfalls).

## Hero media pipeline

- **Logo art**: new `logo` image kind preserving PNG/transparency (current
  `cacheImage` forces `.jpg`). Source order: fanart.tv (`hdmovielogo`/`hdtvlogo`,
  English) when `fanartKey` set → TMDB `/images` logos (en) → none (styled type).
- **Backdrop**: keep w1280.
- **ffmpeg fallback**: when no backdrop after enrichment, a pure core function grabs
  a frame (~20% into the longest file, scaled 1280w) via an injected `extractFrame`
  adapter (api supplies ffmpeg, mirroring the ffprobe `run` injection); cache as
  backdrop, set `backdropSource="frame"`.

## Ratings ingestion

- Core adapter `fetchOmdbRatings(imdbId, {fetchImpl, apiKey})` → parses
  `imdbRating`, `imdbVotes`, and `Ratings[]` for Rotten Tomatoes % + Metacritic.
- `tmdbScore` from `vote_average` (movie & tv).
- Wired into enrich after imdbId known; gated on `omdbKey`. Degrades gracefully.
  New fields added to `SaveMetadataInput`. Surface `omdbKey`/`fanartKey` in the
  Settings page if not already shown.

## TV enrichment + scanner

- **TMDB client**: add `searchTv`, `tv(id)` (incl. `external_ids` for imdb,
  `number_of_seasons`, `vote_average`), `tvSeason(id, n)` (episodes w/ `still_path`,
  `overview`, `air_date`, `runtime`), `tvContentRating(id)`.
- **`enrichSeries`** (sibling of `enrichItem`): series details + content rating +
  per-season episode fetch → cache stills → upsert Season/Episode via a new
  `saveSeriesMetadata` callback.
- **Parser**: extend `parseMediaPath` to use the lib's TV mode + `Season NN/` folder
  convention → `{ seriesTitle, seasonNumber, episodeNumber }`.
- **Scanner**: episode files → find/create `MediaItem(kind="series")` → `Season` →
  `Episode`, link `MediaFile.episodeId`. Non-episode files unchanged (movie).

## API surface

- `GET /items/:id` extended: `kind`, `logoPath`, `tagline`, rating fields; for series
  a lightweight `seasons:[{seasonNumber, name, episodeCount, posterPath}]`.
- `GET /items/:id/seasons/:n/episodes` — lazy per-season list
  (`id, episodeNumber, title, overview, stillPath, runtimeSec, airDate, fileId?, progress?`).
- `GET /items/:id/similar` — embeddings (pgvector) → `itemSimilarity` fallback,
  kids-filtered, returns `MediaCard[]`.
- Progress: `PUT/GET /items/:id/progress` accept optional `episodeId`. Hero "Resume"
  picks the in-progress or next-unwatched episode.

## Delivery phases (one master spec; each phase shippable & reviewed)

1. **Cinematic redesign + Similar** — full-width hero/layout + `/items/:id/similar`.
   Uses existing data; rating/logo/season slots degrade gracefully. Immediate
   visual win.
2. **Hero media pipeline** — `logoPath` + fanart/TMDB logos (PNG) + ffmpeg backdrop
   fallback.
3. **Ratings ingestion** — OMDb + TMDB score → rating badges light up.
4. **Full TV support** — Season/Episode schema + parser + scanner grouping + TMDB TV
   enrichment + episodes API + drill-down UI + episode playback/progress. (Largest;
   sub-phased data → enrich → UI in its plan.)

## Testing strategy

- **core**: pure unit tests with fake adapters — OMDb parsing, frame-fallback
  decision, TV parse (SxxExx / `Season NN/` / anime), `enrichSeries` season/episode
  assembly, similarity ranking. No network/DB/ffmpeg.
- **api**: route tests for `/items/:id` (extended shape), `/items/:id/similar`,
  `/items/:id/seasons/:n/episodes`, per-episode progress, kids filtering on episodes.
- **web**: component/unit tests for hero (logo vs. type fallback), rating badges,
  season selector + episode list, similar rail; existing Playwright e2e stays green
  (run only against throwaway DB).
- Gates per change: `pnpm typecheck && pnpm lint && pnpm test`; `pnpm build` before
  merge.

## Out of scope

- Home-page `Hero.tsx` carousel (separate component; may share sub-components later).
- Trailer-on-hover playback, downloads, ratings write-back / user reviews.
- Re-scraping existing libraries is required to populate series/logos/ratings (the
  daily refresh job + a manual rescan will backfill).
