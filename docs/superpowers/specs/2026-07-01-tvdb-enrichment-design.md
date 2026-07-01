# TVDB Enrichment (TV-Primary) — Design

**Date:** 2026-07-01
**Status:** Approved
**Branch:** `tvdb` (current)
**Goal:** Add TheTVDB (v4) as a metadata source of truth for **TV series** — matching, series/season/episode text, artwork, and cross-referenced ids — because TVDB has broader TV coverage than TMDB. TVDB becomes **primary for series**; TMDB stays the **fallback** for series it can't match, and remains the **only** source for movies.

## Background

Enrichment today is TMDB-only. During a scan, `apps/api/src/plugins/queue.ts` builds one `TmdbClient` and, per item, calls `enrichItem` (movies) or `enrichSeries` (series) from `packages/core/src/metadata/`. Both are pure functions over injected adapters (`client`, `cacheImage`, `saveMetadata`/`saveSeries`, `resolveLogo`, `fetchRatings`, `translateClients`). The i18n feature (PR #7 + `feat/i18n-series`) localizes series title/overview/season/episode text by running one language-configured `TmdbClient` per active profile language, both at scan time (`translateClients`) and via the `translate-metadata` backfill worker.

Two existing seams matter for TV coverage:
- **Series matching** relies on TMDB `searchTv(title, year)`. When TMDB lacks a series (or names it differently), the item stays `unmatched`.
- **TV hero logos** are limited: `resolveLogoTv` only uses TMDB's own logo art because fanart.tv's TV endpoint is keyed by a TheTVDB id we never had (`queue.ts:435`).

TVDB fixes coverage and unlocks the TheTVDB id (fanart TV logos, richer cross-refs).

## Scope

For **TV series** (`MediaItem.kind === "series"`):
1. **Match** against TVDB first (search by name; year disambiguation), TMDB fallback.
2. **Series/season/episode text** (aired/official order) from TVDB, with **localization parity** via TVDB per-language translation endpoints.
3. **Artwork** (poster, backdrop, season poster, episode still, hero logo) cached from TVDB absolute image URLs.
4. **Cross-referenced ids** from TVDB `remoteIds`: `imdbId` (preserves OMDb ratings) and `tmdbId` (retained as a cross-ref).
5. **Ratings**: TVDB `score` → `tmdbScore`-equivalent field is **not** written; we keep OMDb (imdb/RT/metacritic) via `imdbId`. TVDB's own site rating is out of scope for now (no column, avoids conflating providers).

**Non-goals:** movies (stay TMDB); alternate episode orderings (DVD/absolute — **aired/`default` order only**); TVDB people/character art; TVDB keyword taxonomy; migrating already-cached images. Genres map by **name** (TVDB genres have no TMDB id; `Genre.name` is `@unique`).

## Decisions (confirmed)

- **TVDB-first for series, TMDB fallback.** A series enriches from TVDB when TVDB can match it; otherwise it falls back to the existing TMDB `enrichSeries` path unchanged.
- **Re-match existing series is fine.** On rescan, TVDB-first applies to *all* non-manual series, including ones previously matched by TMDB. A series that flips TMDB→TVDB gets its `metadataSource` and ids rewritten. (`matchState === "manual"` items are still skipped, as today.)
- **Localization parity is mandatory** — no regression of the shipped i18n feature. Non-en profiles must still get localized series/season/episode text; TVDB supplies it via `/translations/{lang}` and the per-language episodes variant.
- **Aired order only.** We fetch TVDB's `default`-order episodes.

## 1. Data Model (`packages/db/prisma/schema.prisma`)

Additive, nullable columns only (no backfill, no drops). Base rows keep TMDB ids where already set; new series get TVDB ids.

```prisma
model MediaItem {
  // … existing …
  tmdbId         Int?
  tvdbId         Int?        // NEW — TheTVDB series id (series only)
  metadataSource String?     // NEW — "tvdb" | "tmdb"; null on legacy/unmatched
  // …
  @@index([tmdbId])
  @@index([tvdbId])          // NEW
}

model Season {
  // … existing …
  tmdbSeasonId Int?
  tvdbSeasonId Int?          // NEW
}

model Episode {
  // … existing …
  tmdbEpisodeId Int?
  tvdbEpisodeId Int?         // NEW
}
```

`metadataSource` is the switch read paths and backfill use to pick a provider client; `null` means "legacy/TMDB-era or unmatched" and is treated as TMDB for backfill (its `tmdbId` is present). New migration generated against a **throwaway DB** (shared dev DB has unmerged drift — see the dev-db-divergence memory).

## 2. Core (`packages/core`)

### `metadata/tvdb.ts` (new) — `TvdbClient`

Mirrors `TmdbClient`'s shape: a `TvdbError` class, normalized result interfaces, a pure image-URL helper, and a class taking `(apiKey, fetchImpl?, pin?, language?)`. TVDB v4 specifics:

- **Auth:** `POST {BASE}/login` with `{ apikey, pin? }` → JWT (valid ~1 month). The client logs in lazily on first request and caches the token in-memory; a `401` triggers one re-login+retry. `BASE = "https://api4.thetvdb.com/v4"`.
- **Language:** TVDB uses **3-letter ISO 639-2** codes. A `language?` field (already a 3-letter code) selects the translated endpoints; unset → base/English.
- **Images:** TVDB returns **absolute** URLs. `cacheImage` today expects a TMDB *path* it prefixes with a base. To avoid overloading it, TVDB paths flow through a sibling `cacheImageFromUrl` adapter (already used for fanart logos — `queue.ts:428`), injected as `cacheImageUrl`. The core module stays fetch-free; it only returns URLs and lets the adapter cache them.

Methods (normalized returns, English unless `language` set):
- `searchSeries(title, year?): Promise<TvdbSearchResult | null>` — `GET /search?query=&type=series` (+year filter/disambiguation client-side). Returns `{ tvdbId, title, year? }`.
- `series(id): Promise<TvdbSeries>` — `GET /series/{id}/extended?meta=translations` → normalized `{ tvdbId, title, year?, overview?, status?, posterUrl?, backdropUrl?, imdbId?, tmdbId?, contentRating?, genres: {name}[], seasons: TvdbSeasonRef[] }`. `imdbId`/`tmdbId` extracted from `remoteIds`; `contentRating` is the US `contentRatings` entry (else undefined). `seasons` filtered to `type.type === "official"` (aired order).
- `seriesLogoUrl(id, lang?): Promise<string | undefined>` — pick best `clearlogo`-type artwork from `/series/{id}/extended` (language-preferred, else neutral). Pure `pickArtwork` helper, unit-tested.
- `seasonEpisodes(id, opts): Promise<TvdbEpisode[]>` — `GET /series/{id}/episodes/default?page=N` (aired order), following pagination, mapped to `{ seasonNumber, episodeNumber, title?, overview?, stillUrl?, runtimeSec?, airDate?, tvdbEpisodeId }`. One paginated fetch yields **all** episodes for the series; we group by `seasonNumber` in core (cheaper than per-season requests).
- `seriesTranslated(id, lang): Promise<{ title?; overview?; seasons; episodes }>` — `GET /series/{id}/episodes/default/{lang}` returns translated episode titles/overviews in one call; `GET /series/{id}/translations/{lang}` gives series title/overview; season names come from the extended payload's translated season records. Used to build translation arrays.

### `metadata/enrich-series-tvdb.ts` (new) — `enrichSeriesTvdb`

A parallel to `enrichSeries`, structurally identical in signature so `queue.ts` wiring is symmetric. It:
1. Resolves `tvdbId` from `item.tvdbId ?? searchSeries(title, year)`. **Returns `{ matched: false }` when TVDB can't match** — this is the fallback signal.
2. Fetches `series(id)`, caches poster/backdrop via `cacheImageUrl`, resolves hero logo (fanart.tv by TheTVDB id first, then TVDB clearlogo), pulls episodes via `seasonEpisodes`, filters to `localSeasonNumbers` when provided.
3. Builds per-language translation arrays from `seriesTranslated` for each `translateClients` language (same non-fatal per-language try/catch as `enrichSeries`).
4. Calls the shared `saveSeries` adapter with `metadataSource: "tvdb"`, `tvdbId`, per-season `tvdbSeasonId`, per-episode `tvdbEpisodeId`, plus `imdbId`/`tmdbId` cross-refs and OMDb ratings (via injected `fetchRatings(imdbId)`).

### Shared persist shape (`metadata/enrich-series.ts`)

`SaveSeriesInput` is generalized so **both** providers write through one adapter:
- `tmdbId: number` → `tmdbId?: number` (now optional).
- Add `tvdbId?: number` and `metadataSource?: "tvdb" | "tmdb"`.
- `SaveSeriesSeason` gains `tvdbSeasonId?: number`; `SaveSeriesEpisode` gains `tvdbEpisodeId?: number`.
- `EnrichResult` already carries `{ matched, tmdbId? }`; add optional `tvdbId?`.

`enrichSeries` (TMDB path) keeps setting `tmdbId` + `metadataSource: "tmdb"`; it is otherwise untouched.

### `metadata/localize.ts`

Add `tvdbLanguageTag(code)` — 2-letter → 3-letter ISO 639-2 (`en→eng, es→spa, de→deu, pt→por, ru→rus, fr→fra`; default `eng`), parallel to `tmdbLanguageTag`. Localize read helpers (`localizeItem`/`localizeName`) are provider-agnostic and unchanged.

## 3. Persistence & Wiring (`apps/api/src/plugins/queue.ts`)

### Settings & clients
- Read `tvdbApiKey` + `tvdbPin` (below). When set, build a base `TvdbClient` and, per active language, a language-configured `TvdbClient` (`tvdbLanguageTag(lang)`) into a `tvdbTranslateClients` map — parallel to the TMDB `translateClients`.

### `saveSeries`
- `data.tmdbId = input.tmdbId` becomes conditional: only set columns for ids the provider supplied. Always set `metadataSource: input.metadataSource ?? "tmdb"`.
- Write `tvdbId` on the `MediaItem` update; write `tvdbSeasonId`/`tvdbEpisodeId` in the season/episode upsert `data` (already threaded — just add the fields).
- **`imdbId` must not be clobbered:** keep the existing `imdbId: input.imdbId ?? null` (TVDB supplies it from `remoteIds`).

### Enrichment loop (per series item)
- Select adds `tvdbId`, `metadataSource` to the `findUnique`.
- For `kind === "series"`, **try TVDB first** when a `TvdbClient` exists:
  - `result = await enrichSeriesTvdb(base, { client: tvdb, cacheImageUrl, saveSeries, resolveLogoTv, fetchRatings, localSeasonNumbers, translateClients: tvdbTranslateClients })`.
  - If `!result.matched`, **fall back** to the existing `enrichSeries(...)` TMDB path unchanged.
  - If no TVDB key configured, skip straight to TMDB (today's behavior).
- `resolveLogoTv` is upgraded: it now receives a `tvdbId`, so it tries **fanart.tv TV logo by TheTVDB id first** (`fetchFanartLogoUrl` already exists), then TVDB clearlogo, then TMDB logo — closing the logo gap noted in Background.

### `translate-metadata` backfill worker
- Query broadens from `{ tmdbId: { not: null } }` to `{ OR: [{ tmdbId: { not: null } }, { tvdbId: { not: null } }], matchState: { not: "unmatched" } }`, selecting `metadataSource`, `tvdbId`.
- Branch by provider: series with `metadataSource === "tvdb"` (or `tvdbId != null`) use a `translateSeriesTvdb(seriesId, tvdbId, lang)` that calls the language-configured `TvdbClient` and upserts `MediaItemTranslation` + `SeasonTranslation` + `EpisodeTranslation`, matched by `seasonNumber`/`episodeNumber` — mirroring the existing `translateSeries`. TMDB-source series and all movies keep the existing TMDB path. Genre translations unchanged (name-keyed genres from TVDB have no `tmdbId`, so they simply won't get TMDB genre-list translations — acceptable; genre localization for TVDB-only genres is a deferred minor).

## 4. Settings (`apps/api/src/routes/settings.ts`)

Follow the `omdbKey`/`fanartKey` precedent exactly:
- `SettingsBody` gains `tvdbApiKey?: string`, `tvdbPin?: string`.
- GET returns `tvdbConfigured: (tvdbApiKey.length > 0)` — **never** the key/pin.
- PUT persists both via `setSetting` when strings are provided.
- Web settings UI: add a "TheTVDB" section (API key + optional subscriber PIN) alongside TMDB/OMDb/fanart, gated on `tvdbConfigured`. (UI strings — keep bundle-parity test green by adding keys to every locale.)

## 5. Read Paths — unchanged

Browse/detail routes (`catalog.ts`, `series.ts`) key on natural keys (`seriesId_seasonNumber`, `seasonId_episodeNumber`) and coalesce text by profile language via `localizeItem`/`localizeName`. They never branch on provider, so **no read-path changes**. Poster/backdrop/still/logo columns already store metadata-relative cached paths regardless of origin. Kids/maturity filtering is unaffected (rating cert still stored on `MediaItem.rating`; TVDB content ratings map into it in `enrichSeriesTvdb` — US rating when available, else undefined → unrated, which the fail-safe already handles).

## 6. Testing

**Core (no network/DB/fs):**
- `TvdbClient`: lazy login + token reuse; 401 → single re-login+retry; `series()` normalizes `remoteIds`→`imdbId`/`tmdbId` and filters official seasons; `seasonEpisodes()` follows pagination and groups by season; `seriesTranslated()` builds title/overview/episode maps; `pickArtwork` logo preference (language → neutral → any). All with a fake `fetchImpl`.
- `enrichSeriesTvdb`: matched path produces a `SaveSeriesInput` with `metadataSource:"tvdb"`, `tvdbId`, season/episode tvdb ids, translation arrays; **no match → `{ matched:false }`** (the fallback contract); a failing per-language translate client is skipped and enrichment still succeeds.
- `tvdbLanguageTag` mapping + default.

**API:**
- `settings` PUT/GET round-trips `tvdbApiKey`/`tvdbPin`, GET exposes only `tvdbConfigured`.
- (Route read tests unchanged; add none unless a regression surfaces.)

**DB:** migration applies on a throwaway DB; client typechecks.

**Integration (manual smoke, throwaway DB):** scan a TV library with a TVDB key set → series match `metadataSource:"tvdb"`, seasons/episodes populated in aired order, poster/backdrop/logo cached, an `es` profile sees localized episode titles; a series TVDB can't match falls back to TMDB and still enriches.

## 7. Delivery Phases

1. **Plumbing** — schema migration (additive columns/indexes) + `SaveSeriesInput` generalization + `saveSeries` writing the new ids/`metadataSource` (TMDB path only, still green) + settings key. Ships behind "no TVDB key = today's behavior".
2. **TVDB series enrichment** — `TvdbClient`, `enrichSeriesTvdb`, queue TVDB-first/TMDB-fallback wiring, upgraded `resolveLogoTv`. Series now match via TVDB when a key is set.
3. **Localization parity** — `tvdbTranslateClients` at scan time + `translate-metadata` provider branching, so non-en profiles get TVDB-sourced localized text and the backfill covers TVDB-only series.

## 8. Tradeoffs / Risks

- **Provider churn on rescan** (accepted): existing TMDB series re-match to TVDB, rewriting ids/text/artwork. Acceptable per decision; `manual` items are protected.
- **TVDB genres lack ids** → TVDB-only genres won't receive TMDB genre-list translations. Deferred minor; base (en) genre name always shows.
- **Two provider clients + JWT lifecycle** add surface area; contained in `tvdb.ts` with the same fail-soft try/catch discipline as the TMDB path (a TVDB outage degrades to TMDB fallback, never breaks a scan).
- **Image cache dual-path** (`cacheImage` for TMDB paths, `cacheImageUrl` for TVDB absolute URLs) — both already exist; we inject the right one per provider rather than teaching `cacheImage` about absolute URLs.

## Key File Touchpoints
- `packages/db/prisma/schema.prisma` + new migration (additive columns/indexes).
- `packages/core/src/metadata/tvdb.ts` (new), `enrich-series-tvdb.ts` (new), `enrich-series.ts` (generalize `SaveSeriesInput`/`EnrichResult`), `localize.ts` (`tvdbLanguageTag`) — all with tests.
- `apps/api/src/plugins/queue.ts` (`saveSeries`, enrichment loop TVDB-first, `resolveLogoTv`, `translate-metadata` worker).
- `apps/api/src/routes/settings.ts` + web settings UI (+ locale strings).
