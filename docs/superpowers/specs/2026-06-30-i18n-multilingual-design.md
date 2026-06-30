# Orbix i18n — Multilingual Support Design

**Date:** 2026-06-30
**Status:** Approved (scope/persistence/library chosen by product owner)
**Goal:** Multilingual support starting with English + Spanish, then German, Portuguese, Russian, French.

## 1. Scope & Decisions

Locked-in decisions (chosen by the product owner during brainstorming):

- **Localized:** all UI chrome (~250–300 strings) **and** catalog metadata — movie/show **title**, **overview**, and **genre names**.
- **Language-neutral (out of scope, to bound the work):** person/cast names, TMDB keywords (internal discovery tokens), poster/backdrop art, maturity-certification *codes* (`G`, `PG`, `PG-13`, `R`, `NC-17`). The display word "Unrated" and rating tooltips are UI strings, so they *are* localized.
- **Persistence:** **per-profile**. Each `Profile` carries a `language`. UI and catalog metadata both follow the active profile.
- **Languages:** `en`, `es` first; then `de`, `pt`, `ru`, `fr`. ISO 639-1 internally, mapped to TMDB language tags via a small table:
  | internal | TMDB tag |
  |----------|----------|
  | en | en-US |
  | es | es-ES |
  | de | de-DE |
  | pt | pt-BR |
  | ru | ru-RU |
  | fr | fr-FR |
- **Frontend library:** `react-i18next` (+ `i18next`, `i18next-browser-languagedetector`), JSON resource bundles lazy-loaded per locale.
- **Default language:** `en`. It is the permanent fallback for both UI and metadata.

**Non-goals:** RTL layout (none of the six languages are RTL), localized poster/logo art, regional rating *systems* (we keep US certs), localizing person names or keywords, translating user-generated content (there is none).

## 2. Frontend (apps/web)

### Setup
- Add deps: `i18next`, `react-i18next`, `i18next-browser-languagedetector`.
- New `apps/web/src/lib/i18n.ts` initializes i18next (resources, fallback `en`, interpolation, plural support). The app is wrapped once near the root.

### Resource bundles
- Location: `apps/web/src/locales/<lng>/<namespace>.json`.
- Namespaces by domain: `common`, `auth`, `profiles`, `nav`, `settings`, `libraries`, `catalog`, `search`, `title`, `player`, `errors`.
- Bundles are baked into the Vite build (`dist/`) — **never CDN-fetched** — preserving the offline guarantee. The active locale's bundles are lazy-loaded as a chunk to keep the initial payload small; `en` may be eagerly bundled as the guaranteed fallback.
- **English is the source of truth.** Other locales are derived from it.

### Extraction
- Replace every hardcoded user-facing string in pages/components with `t('ns:key')`.
- Priority order (highest string volume first): `AdminSettingsPage`, `AdminLibrariesPage`, `FixMatchPage`, `LoginPage`, `SetupPage`, `ProfilesPage`, `Sidebar`/`TopBar`, catalog (`HomePage`/`LibraryPage`/`MediaRow`/`Hero`), `SearchPage`, `TitlePage`, `Player`/`PlayerOverlay`.
- `packages/ui` stays presentational — **no copy moves into it**; consumers pass already-translated strings.

### Error codes → messages
- The `errors` namespace maps the API's existing machine codes (`invalid_credentials`, `unauthenticated`, `unauthorized`, `invalid_profile`, `not_found`, `pin_required`, `setup_complete`, `no_sources`, `tmdb_not_configured`, `tmdbId_required`, `tmdbPosterPath_required`, validation messages, …) to localized text. A `tError(code)` helper resolves a code → message with a generic fallback.

### Formatting
- Counts and summaries ("3 results", "Rebuilt N titles") use i18next CLDR plural forms (correct Russian/Polish-style plural categories).
- Dates/numbers use `Intl.DateTimeFormat` / `Intl.NumberFormat` keyed to the active locale (minimal today; establish the pattern).
- `formatRuntime` becomes a localized pattern (unit labels translated).

### Active-language resolution
- After profile selection, the app reads `language` from the profile/session payload and calls `i18n.changeLanguage`.
- **Pre-login screens** (setup, login, profile picker — no active profile): detect via `localStorage` → `navigator.language` → `en`, plus a small language switcher. Selection persists to `localStorage`.
- `<html lang>` is updated on every language change (a11y/SEO).
- Profile switch already triggers a full reload (existing behavior), which re-initializes i18next cleanly.

## 3. Catalog Metadata (apps/api + packages/db + packages/core)

### Schema (`packages/db/prisma/schema.prisma`)
- `Profile.language String @default("en")`.
- New `MediaItemTranslation`:
  ```prisma
  model MediaItemTranslation {
    mediaItemId String
    mediaItem   MediaItem @relation(fields: [mediaItemId], references: [id], onDelete: Cascade)
    language    String
    title       String?
    overview    String?
    @@id([mediaItemId, language])
    @@index([mediaItemId])
  }
  ```
- New `GenreTranslation`:
  ```prisma
  model GenreTranslation {
    genreId  Int
    genre    Genre  @relation(fields: [genreId], references: [id], onDelete: Cascade)
    language String
    name     String
    @@id([genreId, language])
  }
  ```
- Base `MediaItem` (`title`/`overview`) and `Genre.name` keep the **default-language (English)** values as the permanent fallback. No data loss; translations are additive.

### Read path
- Catalog list/by-id/rows/search/title/continue-watching routes resolve the **request language** from the active profile cookie (`orbix_profile` → profile → `language`).
- Returned `title`/`overview`/genre `name` are **coalesced**: `requested-language translation → base (English) → raw`. Never blank.
- Kids-filtering, BigInt `.toString()`, and all existing route guards are unchanged. Localization is a presentation concern layered on the already-filtered result set.

### Write / population (preserving offline)
- The pure-core `TmdbClient` gains an optional `language` argument that appends `&language=<tag>` to requests (adapters still injected by `apps/api`; core stays network-free in tests).
- **Active content languages** = the distinct set of `Profile.language` values ∪ `{en}`.
- **On enrichment (scan):** after writing base English fields for an item, fetch + upsert `MediaItemTranslation` rows for each active non-English language.
- **On new-language activation:** when a profile first selects a language not previously active, enqueue a `translate-metadata` BullMQ job that backfills `MediaItemTranslation` for all matched items and populates `GenreTranslation` from TMDB's per-language genre list (`/genre/{movie,tv}/list?language=<tag>`). Progress is emitted over the existing in-process `EventEmitter` and streamed via SSE, mirroring scans; late subscribers read a done-cache. The job is idempotent and re-runnable.

### Alternatives considered
- **JSON `translations` blob on `MediaItem`** — rejected: not queryable, awkward partial updates, no genre sharing.
- **On-demand fetch at request time** — rejected: breaks the hard offline guarantee.
- The **normalized translation table** is queryable, cache-friendly, shares genre translations across the catalog, and degrades gracefully (missing rows → fallback).

## 4. Backend Text

- The API stays **locale-agnostic**: responses remain machine-readable codes + structured data; all human text is rendered client-side. This extends the existing error-code pattern.
- The few remaining human-readable backend strings (queue "no TMDB token" warning, rebuild summary, admin-visible scan log lines) become codes / structured payloads (`{ code, counts }`) that the client localizes.

## 5. Testing

- **Core:** `TmdbClient` appends `language` correctly for each tag; coalesce/fallback helper picks translation → base → raw.
- **API:** catalog route returns localized `title`/`overview`/genres for a profile's language; falls back when a translation row is missing; kids-filter still enforced under localization; BigInt serialization intact.
- **Web:** i18next init test; render test asserts a key resolves in `es`; **bundle-parity test** — every locale has exactly the key set of `en` (no missing/extra keys); a guard flags raw JSX string literals in already-migrated files.
- **E2E:** set a profile to Spanish → UI chrome and a known overview render in Spanish (throwaway DB only, per the e2e harness rules).

## 6. Rollout (matches the stated goal)

- **Phase 1 — Infrastructure + English + Spanish (ship working bilingual):**
  library + init, schema migration, translation tables, `translate-metadata` job, route read-path coalescing, error-code map, full `en` extraction, complete `es` UI bundle, `es` metadata population. All gates green; e2e proves es end-to-end.
- **Phase 2 — German, Portuguese, Russian, French:** add `de`, `pt`, `ru`, `fr` UI bundles + activate the four content languages; infra already done. Verify Russian plural categories specifically.

## 7. Translation Authoring

Non-English bundles (`es`, then `de/pt/ru/fr`) are produced as complete LLM translations from the English source as the initial set, refinable later. If professional translators are preferred, the JSON bundle structure is the hand-off artifact (no code change needed to swap in human translations).

## 8. Key File Touchpoints

- Frontend: `apps/web/src/lib/i18n.ts` (new), `apps/web/src/locales/**` (new), all `apps/web/src/pages/*` + `components/*`, `apps/web/src/lib/api.ts` (error-code helper area).
- DB: `packages/db/prisma/schema.prisma` + a new migration.
- Core: `packages/core/src/metadata/tmdb.ts` (language arg), `packages/core/src/metadata/enrich.ts`, a new coalesce helper, `packages/core/src/ratings/maturity.ts` (only the "Unrated" display label, via UI).
- API: catalog/search/title routes under `apps/api/src/routes/*`, `apps/api/src/plugins/queue.ts` (translate-metadata job + active-language wiring), profile create/update route (language field + activation trigger), `apps/api/src/lib/catalog-filter.ts` (unchanged logic, localized projection layered after).
- Config: optionally a `DEFAULT_LOCALE` env in `packages/config` (default `en`).
