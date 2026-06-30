# Series Metadata Localization — Design

**Date:** 2026-06-30
**Status:** Approved
**Branch:** `feat/i18n-series` (off `main`, which already has the i18n base + TV/series rework)
**Goal:** Localize TV series metadata — series title/overview, season names, and episode titles/overviews — per the active profile's language, completing the i18n feature for series (movies are already localized).

## Background

PR #7 localized the UI and **movie** catalog metadata. Series were explicitly deferred: `enrichSeries` fetches from TMDB's tv endpoints in English only, and there are no translation tables for seasons/episodes. The series **title/overview** already coalesce on read (they live on `MediaItem`, which has `MediaItemTranslation`) but are never populated for series. There is also a latent bug: the `translate-metadata` backfill calls `client.movie(tmdbId)` for **every** matched item, which is wrong for series (their `tmdbId` is a tv id).

## Scope

Localize all three levels of series text:
1. **Series** title + overview → `MediaItemTranslation` (table exists; needs population).
2. **Season** name + overview → new `SeasonTranslation`.
3. **Episode** title + overview → new `EpisodeTranslation`.

**Non-goals:** episode still images / posters / logos (language-neutral), person names, keywords, rating cert codes. No UI-string changes (so the bundle parity test is unaffected).

## 1. Data Model (`packages/db/prisma/schema.prisma`)

Two additive tables, mirroring `MediaItemTranslation`. Base `Season`/`Episode` rows hold the default-language (en) values as the permanent fallback.

```prisma
model SeasonTranslation {
  seasonId String
  season   Season @relation(fields: [seasonId], references: [id], onDelete: Cascade)
  language String
  name     String?
  overview String?

  @@id([seasonId, language])
  @@index([seasonId])
}

model EpisodeTranslation {
  episodeId String
  episode   Episode @relation(fields: [episodeId], references: [id], onDelete: Cascade)
  language  String
  title     String?
  overview  String?

  @@id([episodeId, language])
  @@index([episodeId])
}
```
Add `translations SeasonTranslation[]` to `Season` and `translations EpisodeTranslation[]` to `Episode`. New migration generated against the throwaway DB (the shared dev DB drift rule still applies — see the i18n memory).

## 2. Core (`packages/core`)

### `metadata/tmdb.ts`
- Wrap `tv()` and `tvSeason()` request URLs in the existing `withLang()` helper. `tv()` already has `?append_to_response=external_ids`, so `withLang` appends `&language=<tag>`; `tvSeason()` gets `?language=<tag>`. A language-configured client then returns localized series name/overview, season names/overviews, and episode titles/overviews.
- `searchTv` / `tvContentRating` stay English (matching/cert are language-neutral).

### `metadata/localize.ts`
- Reuse `localizeItem` for episodes (`{title, overview}`).
- Add `localizeName<T extends { name: string | null; overview?: string | null }>(base, tr?)` — same non-empty-wins rule for season `name`/`overview`. (Seasons key on `name`, not `title`.)

### `metadata/enrich-series.ts`
- Extend `SaveSeriesInput`:
  - `translations?: MetadataTranslation[]` (series-level, reuse the movie type: `{ language, title, overview? }`).
  - On `SaveSeriesSeason`: `translations?: { language: string; name?: string; overview?: string }[]`.
  - On `SaveSeriesEpisode`: `translations?: { language: string; title?: string; overview?: string }[]`.
- Add dep `translateClients?: Map<string, Pick<TmdbTvLike, "tv" | "tvSeason">>`.
- After building the base `seasons`, for each `(language, client)`:
  - `const ltv = await client.tv(tmdbId)` → series translation `{ language, title: ltv.title, overview: ltv.overview }`; per-season name/overview from `ltv.seasons` matched by `seasonNumber`.
  - For each wanted season, `client.tvSeason(tmdbId, seasonNumber)` → per-episode title/overview matched by `episodeNumber`.
  - Attach these onto the corresponding base season/episode `translations` arrays and the top-level series `translations`.
  - Any per-language fetch failure is caught and skipped (never fails enrichment).

## 3. Persistence & Backfill (`apps/api/src/plugins/queue.ts`)

### `saveSeries`
Inside the existing transaction, after seasons/episodes are upserted (so their ids exist):
- Upsert the series `MediaItemTranslation` rows from `input.translations` (same as movies).
- For each saved season, upsert `SeasonTranslation` rows from its `translations`.
- For each saved episode, upsert `EpisodeTranslation` rows from its `translations`.
Season/episode rows are located by their natural keys (`seriesId_seasonNumber`, `seasonId_episodeNumber`) already used by the upserts.

### `translate-metadata` worker
Branch by `item.kind`:
- **movie** → existing `client.movie(tmdbId)` → `MediaItemTranslation`.
- **series** → `client.tv(tmdbId)` (series + season names) and `client.tvSeason(tmdbId, n)` per local season (episode text) → upsert `MediaItemTranslation` + `SeasonTranslation` + `EpisodeTranslation`, matching by `seasonNumber`/`episodeNumber`.
Genre translations unchanged. Per-item failures logged and skipped (existing behavior).

## 4. Read Paths

### `apps/api/src/routes/catalog.ts` `/items/:id`
- On the `seasons` select, add `translations: { where: { language: lang }, select: { name: true } }`.
- Coalesce each season's `name` via `localizeName` → requested language → base.

### `apps/api/src/routes/series.ts` `/items/:id/seasons/:n/episodes`
- Resolve `lang` from the active profile.
- On the `episodes` select, add `translations: { where: { language: lang }, select: { title: true, overview: true } }`.
- Coalesce each episode's `title`/`overview` via `localizeItem`. Kids gate, progress, and `fileId` logic unchanged.

## 5. Testing

- **Core:** `tv()`/`tvSeason()` append the language tag (and omit it when no language). `enrichSeries` with `translateClients` produces series/season/episode translation arrays; a failing per-language client is skipped and enrichment still succeeds. `localizeName` non-empty-wins + fallback.
- **API:** `/items/:id/seasons/:n/episodes` returns localized episode title/overview for an `es` profile and falls back when no translation row exists; kids gate still blocks. `/items/:id` returns localized season names. (Mock prisma per existing route-test pattern.)
- **DB:** migration applies; client typechecks.
- Bundle parity and movie-localization tests are unaffected.

## 6. Rollout

Single PR off `main`. Activation is automatic: when a profile selects a non-en language, `ensureMetadataLanguage` enqueues the (now kind-aware) backfill, and new scans populate translations for active languages via `enrichSeries`.

## Key File Touchpoints
- `packages/db/prisma/schema.prisma` + new migration.
- `packages/core/src/metadata/tmdb.ts`, `metadata/localize.ts`, `metadata/enrich-series.ts` (+ tests).
- `apps/api/src/plugins/queue.ts` (`saveSeries`, `translate-metadata` worker).
- `apps/api/src/routes/catalog.ts`, `apps/api/src/routes/series.ts` (+ a localize test).
