# TVDB-Primary TV Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TheTVDB (v4) as the primary metadata source for TV series (matching, series/season/episode text, artwork, cross-referenced ids, and localized text), with graceful fallback to the existing TMDB path when TVDB can't match; movies stay on TMDB.

**Architecture:** A new pure `TvdbClient` (mirrors `TmdbClient`: injected `fetchImpl`, normalized shapes, JWT auth) and a pure `enrichSeriesTvdb` (mirrors `enrichSeries`) live in `packages/core`. `apps/api/src/plugins/queue.ts` wires a real TVDB client and, for each series, tries TVDB first and falls back to TMDB's `enrichSeries` on no-match. Both providers persist through one generalized `saveSeries` adapter and one generalized `SaveSeriesInput`. Localization parity is preserved via TVDB per-language translation endpoints, both at scan time and in the `translate-metadata` backfill worker.

**Tech Stack:** TypeScript, Node 22, pnpm 10.22.0 + Turborepo, Vitest, Prisma + Postgres 16, Fastify, BullMQ, React (Vite SPA), react-i18next.

## Global Constraints

- **Core purity:** `packages/core` must not import DB, network, ffmpeg, or fs. All I/O is injected (`fetchImpl`, `cacheImageUrl`, `saveSeries`, `fetchRatings`, etc.). Core tests must not touch network/DB/fs.
- **Offline guarantee:** all metadata + images are cached to `METADATA_DIR` at scan time; runtime never hits the network.
- **Secrets never leave the API:** the settings GET returns only `*Configured` booleans, never keys/pins/tokens.
- **Localization parity is mandatory:** non-en profiles must still get localized series/season/episode text — no regression of the shipped i18n feature.
- **Additive migrations only:** new nullable columns/indexes; no drops, no backfill. Generate migrations against a **throwaway DB** (the shared dev DB has unmerged drift — see the dev-db-divergence memory), never the populated dev DB.
- **Run `pnpm lint` per change** (not just typecheck+test) — Turbo caches hide lint-only errors.
- **Gates before done:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all green.
- **Locale parity:** any new UI string key added to `en` must be added to all of `es/de/pt/ru/fr` (`apps/web/src/locales/parity.test.ts` enforces this).
- **Episode order:** aired/official only — use TVDB's `default` season-type endpoint. No DVD/absolute orderings.

### TVDB v4 API facts (verified against the v4 OpenAPI spec)

- **Base:** `https://api4.thetvdb.com/v4`. Auth: `POST /login` with JSON `{ apikey, pin? }` → `{ status, data: { token } }`. JWT is valid ~1 month; cache it on the client and re-login once on a `401`.
- **Language:** 3-letter ISO 639-2 codes. Localized text via `/series/{id}/translations/{lang}` and `/series/{id}/episodes/default/{lang}`.
- **Search:** `GET /search?query=<t>&type=series` → `{ data: [{ tvdb_id, name, year, image_url, remote_ids }] }`. `tvdb_id` and `year` are strings.
- **Extended series:** `GET /series/{id}/extended` → `{ data: { id, name, image, overview, year, status:{name}, genres:[{id,name}], remoteIds:[{id,type,sourceName}], seasons:[{number,image,type:{type}}], artworks:[{image,type,language,score}], contentRatings:[{name,country}] } }`. `image`/`image_url`/artwork `image` are absolute URLs (defensive helper handles relative just in case).
- **Episodes (aired order):** `GET /series/{id}/episodes/default?page=N` → `{ data: { episodes:[{ id, seasonNumber, number, name, overview, image, runtime, aired }] }, links: { next } }`. `links.next` is null on the last page. One paginated sweep returns **all** episodes for the series.
- **remoteIds source names:** IMDB → `"IMDB"` (ids start `tt`), TMDB → `"TheMovieDB.com"`. Match defensively by regex.
- **Artwork types (series):** `2` = poster, `3` = background/backdrop, `23` = clearlogo. (From `/artwork/types`; hardcoded with comment — a wrong id degrades gracefully to the TMDB logo fallback.)
- **Season type:** aired/official seasons have `type.type === "official"`.

---

## File Structure

- `packages/db/prisma/schema.prisma` — add `MediaItem.tvdbId`, `MediaItem.metadataSource`, `Season.tvdbSeasonId`, `Episode.tvdbEpisodeId` (+ `@@index([tvdbId])`). New migration.
- `packages/core/src/metadata/enrich.ts` — add `tvdbId?` to `EnrichResult`.
- `packages/core/src/metadata/enrich-series.ts` — generalize `SaveSeriesInput` (optional `tmdbId`, add `tvdbId`/`metadataSource`), `SaveSeriesSeason.tvdbSeasonId`, `SaveSeriesEpisode.tvdbEpisodeId`; `enrichSeries` sets `metadataSource:"tmdb"`.
- `packages/core/src/metadata/localize.ts` — add `tvdbLanguageTag`.
- `packages/core/src/metadata/tvdb.ts` (new) — `TvdbClient`, `TvdbError`, normalized shapes, `pickArtwork`, structural `TvdbLike`.
- `packages/core/src/metadata/enrich-series-tvdb.ts` (new) — `enrichSeriesTvdb`.
- `packages/core/src/index.ts` — export the two new modules.
- `apps/api/src/routes/settings.ts` — `tvdbApiKey`/`tvdbPin` in/out + `tvdbConfigured`.
- `apps/api/src/plugins/queue.ts` — `saveSeries` writes new ids/source; enrichment loop TVDB-first/TMDB-fallback; upgraded `resolveLogoTv`; `translate-metadata` provider branching.
- `apps/web/src/pages/AdminSettingsPage.tsx` + `apps/web/src/locales/*/settings.json` — TheTVDB settings section.

---

## Phase 1 — Plumbing (schema, shared shapes, persistence, settings)

### Task 1: Additive schema migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`MediaItem`, `Season`, `Episode`)
- Create: `packages/db/prisma/migrations/<timestamp>_tvdb_ids/migration.sql` (generated)

**Interfaces:**
- Produces: columns `MediaItem.tvdbId Int?`, `MediaItem.metadataSource String?`, `Season.tvdbSeasonId Int?`, `Episode.tvdbEpisodeId Int?`, index on `MediaItem.tvdbId`.

- [ ] **Step 1: Add columns to the schema**

In `MediaItem`, add after `tmdbId Int?`:
```prisma
  tvdbId         Int?
  metadataSource String? // "tvdb" | "tmdb"; null = legacy/unmatched
```
and add below the existing `@@index([tmdbId])`:
```prisma
  @@index([tvdbId])
```
In `Season`, add after `tmdbSeasonId Int?`:
```prisma
  tvdbSeasonId Int?
```
In `Episode`, add after `tmdbEpisodeId Int?`:
```prisma
  tvdbEpisodeId Int?
```

- [ ] **Step 2: Generate the migration against a throwaway DB**

Run (throwaway DB URL — never the dev DB):
```bash
DATABASE_URL="postgresql://orbix:orbix@localhost:1062/orbix_tvdb_plan?schema=public" \
  pnpm --filter @orbix/db exec prisma migrate dev --name tvdb_ids --create-only
```
Expected: a new `migrations/<ts>_tvdb_ids/migration.sql` containing `ALTER TABLE "MediaItem" ADD COLUMN "tvdbId" INTEGER`, `"metadataSource" TEXT`, the `Season`/`Episode` columns, and `CREATE INDEX "MediaItem_tvdbId_idx"`. Review the SQL: **only** `ADD COLUMN` / `CREATE INDEX`, no drops.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `pnpm --filter @orbix/db exec prisma generate`
Expected: success; generated client now has the new optional fields.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @orbix/db typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat(db): additive tvdbId/metadataSource columns for TVDB enrichment"
```

---

### Task 2: Generalize the shared persist shape

**Files:**
- Modify: `packages/core/src/metadata/enrich.ts` (`EnrichResult`)
- Modify: `packages/core/src/metadata/enrich-series.ts` (`SaveSeriesInput`, `SaveSeriesSeason`, `SaveSeriesEpisode`, `enrichSeries` call)
- Test: `packages/core/src/metadata/enrich-series.test.ts`

**Interfaces:**
- Produces: `SaveSeriesInput` with `tmdbId?: number`, `tvdbId?: number`, `metadataSource?: "tvdb" | "tmdb"`; `SaveSeriesSeason.tvdbSeasonId?: number`; `SaveSeriesEpisode.tvdbEpisodeId?: number`; `EnrichResult.tvdbId?: number`. `enrichSeries` sets `metadataSource: "tmdb"`.

- [ ] **Step 1: Update the failing test**

In `packages/core/src/metadata/enrich-series.test.ts`, find the assertion(s) on the object passed to the `saveSeries` fake for a matched series and add a field check. Add this to the existing "enriches a matched series" test's assertion block:
```ts
expect(saved.metadataSource).toBe("tmdb");
expect(saved.tmdbId).toBe(1399); // whatever tmdbId the test fixture uses
```
(Match the existing fixture's tmdbId value.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/enrich-series.test.ts`
Expected: FAIL — `saved.metadataSource` is `undefined`.

- [ ] **Step 3: Widen the types and set the source**

In `packages/core/src/metadata/enrich.ts`, change `EnrichResult`:
```ts
export interface EnrichResult {
  matched: boolean;
  tmdbId?: number;
  tvdbId?: number;
}
```
In `packages/core/src/metadata/enrich-series.ts`:
- In `SaveSeriesEpisode`, add `tvdbEpisodeId?: number;` next to `tmdbEpisodeId?`.
- In `SaveSeriesSeason`, add `tvdbSeasonId?: number;` next to `tmdbSeasonId?`.
- In `SaveSeriesInput`, change `tmdbId: number;` to `tmdbId?: number;` and add:
```ts
  tvdbId?: number;
  metadataSource?: "tvdb" | "tmdb";
```
- In the `enrichSeries` `deps.saveSeries({ ... })` call, add `metadataSource: "tmdb",` alongside `tmdbId,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/enrich-series.test.ts src/metadata/enrich.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the workspace (API consumes these types)**

Run: `pnpm --filter @orbix/core typecheck && pnpm --filter @orbix/api typecheck`
Expected: PASS (queue.ts still compiles: `input.tmdbId` is now `number | undefined`; `saveSeries` handles `?? null`, which is fine for `undefined`).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/metadata/enrich.ts packages/core/src/metadata/enrich-series.ts packages/core/src/metadata/enrich-series.test.ts
git commit -m "feat(core): generalize SaveSeriesInput for multi-provider (tvdbId/metadataSource)"
```

---

### Task 3: Persist the new ids/source in `saveSeries`

**Files:**
- Modify: `apps/api/src/plugins/queue.ts` (`saveSeries`, ~lines 565-675)

**Interfaces:**
- Consumes: `SaveSeriesInput` with `tvdbId?`/`metadataSource?`/`tvdbSeasonId?`/`tvdbEpisodeId?` (Task 2).
- Produces: series `MediaItem` rows get `tvdbId` + `metadataSource`; `Season`/`Episode` rows get `tvdbSeasonId`/`tvdbEpisodeId`.

- [ ] **Step 1: Write the new ids in the MediaItem update**

In `saveSeries`, in the `const data: Prisma.MediaItemUpdateInput = { ... }` block, replace the line `tmdbId: input.tmdbId,` with:
```ts
              tmdbId: input.tmdbId ?? null,
              tvdbId: input.tvdbId ?? null,
              metadataSource: input.metadataSource ?? "tmdb",
```

- [ ] **Step 2: Write the season/episode tvdb ids**

In the `seasonData` object, add `tvdbSeasonId: s.tvdbSeasonId ?? null,`. In the `epData` object, add `tvdbEpisodeId: e.tvdbEpisodeId ?? null,`.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @orbix/api typecheck`
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `pnpm --filter @orbix/api lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/plugins/queue.ts
git commit -m "feat(api): persist tvdbId/metadataSource in saveSeries"
```

---

### Task 4: TVDB settings (API)

**Files:**
- Modify: `apps/api/src/routes/settings.ts`

**Interfaces:**
- Produces: settings keys `tvdbApiKey`, `tvdbPin`; GET returns `tvdbConfigured: boolean`.

- [ ] **Step 1: Extend `SettingsBody`**

Add to the `SettingsBody` interface:
```ts
  tvdbApiKey?: string;
  tvdbPin?: string;
```

- [ ] **Step 2: Read + expose `tvdbConfigured` in GET**

In the GET handler's `Promise.all`, add reads:
```ts
      getSetting<string>("tvdbApiKey", { fallback: "", read: r }),
      getSetting<string>("tvdbPin", { fallback: "", read: r }),
```
Destructure them (e.g. `tvdbApiKey, tvdbPin`) and add to the returned object:
```ts
      tvdbConfigured: tvdbApiKey.length > 0,
```
(`tvdbPin` is read only to keep the tuple shape consistent; do not return it.)

- [ ] **Step 3: Persist in PUT**

In the PUT handler, add:
```ts
      if (typeof body.tvdbApiKey === "string") {
        tasks.push(setSetting("tvdbApiKey", body.tvdbApiKey, { write: w }));
      }
      if (typeof body.tvdbPin === "string") {
        tasks.push(setSetting("tvdbPin", body.tvdbPin, { write: w }));
      }
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint`
Expected: PASS.

- [ ] **Step 5: Manual smoke (throwaway DB, optional but recommended)**

With the API running against a throwaway DB and an admin session cookie in `$COOKIE`:
```bash
curl -s -X PUT localhost:1061/api/settings -H 'content-type: application/json' -b "$COOKIE" -d '{"tvdbApiKey":"test-key","tvdbPin":"1234"}'
curl -s localhost:1061/api/settings -b "$COOKIE" | python3 -m json.tool
```
Expected: PUT `{"ok":true}`; GET shows `"tvdbConfigured": true` and **no** `tvdbApiKey`/`tvdbPin`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/settings.ts
git commit -m "feat(api): TVDB apiKey/pin settings (tvdbConfigured, secrets withheld)"
```

---

## Phase 2 — TVDB client + series enrichment

### Task 5: `tvdbLanguageTag` helper

**Files:**
- Modify: `packages/core/src/metadata/localize.ts`
- Test: `packages/core/src/metadata/localize.test.ts`

**Interfaces:**
- Produces: `tvdbLanguageTag(code: string): string` — 2-letter → 3-letter ISO 639-2, default `"eng"`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/metadata/localize.test.ts`:
```ts
import { tvdbLanguageTag } from "./localize";

describe("tvdbLanguageTag", () => {
  it("maps known 2-letter codes to 3-letter ISO 639-2", () => {
    expect(tvdbLanguageTag("en")).toBe("eng");
    expect(tvdbLanguageTag("es")).toBe("spa");
    expect(tvdbLanguageTag("de")).toBe("deu");
    expect(tvdbLanguageTag("pt")).toBe("por");
    expect(tvdbLanguageTag("ru")).toBe("rus");
    expect(tvdbLanguageTag("fr")).toBe("fra");
  });
  it("defaults unknown codes to eng", () => {
    expect(tvdbLanguageTag("zz")).toBe("eng");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/localize.test.ts`
Expected: FAIL — `tvdbLanguageTag` is not exported.

- [ ] **Step 3: Implement**

Add to `packages/core/src/metadata/localize.ts` (below `tmdbLanguageTag`):
```ts
const TVDB_LANGUAGE_TAGS: Record<string, string> = {
  en: "eng",
  es: "spa",
  de: "deu",
  pt: "por",
  ru: "rus",
  fr: "fra",
};

/** Map an internal ISO-639-1 code to a TVDB 3-letter ISO-639-2 code (default eng). */
export function tvdbLanguageTag(code: string): string {
  return TVDB_LANGUAGE_TAGS[code] ?? "eng";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/localize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/metadata/localize.ts packages/core/src/metadata/localize.test.ts
git commit -m "feat(core): tvdbLanguageTag (ISO 639-1 to 639-2)"
```

---

### Task 6: `TvdbClient` — auth + `searchSeries`

**Files:**
- Create: `packages/core/src/metadata/tvdb.ts`
- Test: `packages/core/src/metadata/tvdb.test.ts`

**Interfaces:**
- Produces: `class TvdbClient` with constructor `(apiKey: string, fetchImpl?: typeof fetch, pin?: string, language?: string)`, `class TvdbError extends Error`, `interface TvdbSearchResult { tvdbId: number; title: string; year?: number }`, and `searchSeries(title: string, year?: number): Promise<TvdbSearchResult | null>`. Lazy JWT login cached in-memory; `401` → single re-login + retry.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/metadata/tvdb.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { TvdbClient, TvdbError } from "./tvdb";

/** Build a fake fetch that returns queued JSON responses by URL substring. */
function fakeFetch(routes: { match: string; status?: number; body: unknown }[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no fake route for ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("TvdbClient auth + searchSeries", () => {
  it("logs in lazily and searches series", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "jwt-1" } } },
      {
        match: "/search",
        body: {
          status: "success",
          data: [{ tvdb_id: "121361", name: "Game of Thrones", year: "2011", image_url: "https://x/p.jpg" }],
        },
      },
    ]);
    const client = new TvdbClient("api-key", fetchImpl, "pin-1");
    const res = await client.searchSeries("Game of Thrones", 2011);
    expect(res).toEqual({ tvdbId: 121361, title: "Game of Thrones", year: 2011 });

    // login called once with apikey + pin; search carried the Bearer token
    const loginCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("/login"),
    );
    expect(JSON.parse((loginCall![1] as RequestInit).body as string)).toEqual({ apikey: "api-key", pin: "pin-1" });
    const searchCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("/search"),
    );
    expect((searchCall![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-1" });
  });

  it("returns null when there are no results", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "jwt-1" } } },
      { match: "/search", body: { status: "success", data: [] } },
    ]);
    const client = new TvdbClient("k", fetchImpl);
    expect(await client.searchSeries("Nope")).toBeNull();
  });

  it("re-logs in once on a 401 and retries", async () => {
    let searchHits = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login")) {
        return new Response(JSON.stringify({ status: "success", data: { token: "jwt-fresh" } }), { status: 200 });
      }
      searchHits++;
      if (searchHits === 1) return new Response("unauthorized", { status: 401 });
      return new Response(
        JSON.stringify({ status: "success", data: [{ tvdb_id: "9", name: "X", year: "2000" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new TvdbClient("k", fetchImpl);
    const res = await client.searchSeries("X");
    expect(res?.tvdbId).toBe(9);
    expect(searchHits).toBe(2); // retried once
  });

  it("throws TvdbError on a non-401 error", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "t" } } },
      { match: "/search", status: 500, body: {} },
    ]);
    const client = new TvdbClient("k", fetchImpl);
    await expect(client.searchSeries("X")).rejects.toBeInstanceOf(TvdbError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/tvdb.test.ts`
Expected: FAIL — module `./tvdb` does not exist.

- [ ] **Step 3: Implement the client skeleton + auth + searchSeries**

Create `packages/core/src/metadata/tvdb.ts`:
```ts
const BASE = "https://api4.thetvdb.com/v4";
const ARTWORKS_BASE = "https://artworks.thetvdb.com";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class TvdbError extends Error {
  constructor(status: number) {
    super(`TVDB request failed with status ${status}`);
    this.name = "TvdbError";
  }
}

// ---------------------------------------------------------------------------
// Normalised shapes
// ---------------------------------------------------------------------------

export interface TvdbSearchResult {
  tvdbId: number;
  title: string;
  year?: number;
}

// ---------------------------------------------------------------------------
// Raw shapes (only what we read)
// ---------------------------------------------------------------------------

interface RawLogin {
  data?: { token?: string };
}
interface RawSearchItem {
  tvdb_id?: string;
  name?: string;
  year?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Normalise a TVDB image field to an absolute URL (v4 usually already is). */
export function absUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  if (u.startsWith("http")) return u;
  return `${ARTWORKS_BASE}${u.startsWith("/") ? "" : "/"}${u}`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TvdbClient {
  private readonly apiKey: string;
  private readonly pin?: string;
  private readonly fetchImpl: typeof fetch;
  /** 3-letter ISO 639-2 language for localized endpoints; undefined = English. */
  readonly language?: string;
  private token?: string;

  constructor(apiKey: string, fetchImpl?: typeof fetch, pin?: string, language?: string) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.pin = pin;
    this.language = language;
  }

  private async login(): Promise<string> {
    const res = await this.fetchImpl(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(this.pin ? { apikey: this.apiKey, pin: this.pin } : { apikey: this.apiKey }),
    });
    if (!res.ok) throw new TvdbError(res.status);
    const raw = (await res.json()) as RawLogin;
    const token = raw.data?.token;
    if (!token) throw new TvdbError(res.status);
    this.token = token;
    return token;
  }

  /** GET a path (already including BASE) with the Bearer token; one re-login on 401. */
  private async get<T>(path: string): Promise<T> {
    if (!this.token) await this.login();
    let res = await this.fetchImpl(path, {
      headers: { Authorization: `Bearer ${this.token}`, accept: "application/json" },
    });
    if (res.status === 401) {
      await this.login();
      res = await this.fetchImpl(path, {
        headers: { Authorization: `Bearer ${this.token}`, accept: "application/json" },
      });
    }
    if (!res.ok) throw new TvdbError(res.status);
    return res.json() as Promise<T>;
  }

  async searchSeries(title: string, year?: number): Promise<TvdbSearchResult | null> {
    const url = `${BASE}/search?query=${encodeURIComponent(title)}&type=series`;
    const data = await this.get<{ data?: RawSearchItem[] }>(url);
    const items = data.data ?? [];
    // Prefer an exact-year match when a year is known; else the first result.
    const pick =
      (year != null && items.find((i) => Number(i.year) === year)) || items[0];
    if (!pick || pick.tvdb_id == null) return null;
    return {
      tvdbId: Number(pick.tvdb_id),
      title: pick.name ?? title,
      ...(pick.year ? { year: Number(pick.year) } : {}),
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/tvdb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/metadata/tvdb.ts packages/core/src/metadata/tvdb.test.ts
git commit -m "feat(core): TvdbClient auth (JWT) + searchSeries"
```

---

### Task 7: `TvdbClient.series()` — extended record + artwork/logo

**Files:**
- Modify: `packages/core/src/metadata/tvdb.ts`
- Test: `packages/core/src/metadata/tvdb.test.ts`

**Interfaces:**
- Produces: `interface TvdbSeasonRef { seasonNumber: number; posterUrl?: string }`; `interface TvdbSeries { tvdbId; title; year?; overview?; status?; posterUrl?; backdropUrl?; logoUrl?; imdbId?; tmdbId?; contentRating?; genres: { name: string }[]; seasons: TvdbSeasonRef[] }`; `series(id: number): Promise<TvdbSeries>`; and pure `pickArtwork(artworks, type, lang?): string | undefined`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/metadata/tvdb.test.ts`:
```ts
import { pickArtwork } from "./tvdb";

describe("pickArtwork", () => {
  const art = [
    { image: "https://a/logo-eng.png", type: 23, language: "eng", score: 10 },
    { image: "https://a/logo-neutral.png", type: 23, language: null, score: 99 },
    { image: "https://a/bg.jpg", type: 3, language: null, score: 5 },
  ];
  it("prefers the requested language, then highest score", () => {
    expect(pickArtwork(art, 23, "eng")).toBe("https://a/logo-eng.png");
  });
  it("falls back to any of the type by score when language missing", () => {
    expect(pickArtwork(art, 23, "spa")).toBe("https://a/logo-neutral.png");
  });
  it("returns undefined when the type is absent", () => {
    expect(pickArtwork(art, 2, "eng")).toBeUndefined();
  });
});

describe("TvdbClient.series", () => {
  it("normalises the extended record", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "t" } } },
      {
        match: "/series/121361/extended",
        body: {
          status: "success",
          data: {
            id: 121361,
            name: "Game of Thrones",
            image: "https://a/poster.jpg",
            overview: "Nine noble families…",
            year: "2011",
            status: { name: "Ended" },
            genres: [{ id: 1, name: "Drama" }, { id: 2, name: "Fantasy" }],
            remoteIds: [
              { id: "tt0944947", type: 2, sourceName: "IMDB" },
              { id: "1399", type: 12, sourceName: "TheMovieDB.com" },
            ],
            seasons: [
              { id: 500, number: 0, image: "https://a/s0.jpg", type: { type: "official" } },
              { id: 501, number: 1, image: "https://a/s1.jpg", type: { type: "official" } },
              { id: 599, number: 1, image: "https://a/s1-dvd.jpg", type: { type: "dvd" } },
            ],
            artworks: [
              { image: "https://a/bg.jpg", type: 3, language: null, score: 8 },
              { image: "https://a/logo.png", type: 23, language: "eng", score: 8 },
            ],
            contentRatings: [
              { name: "TV-MA", country: "usa" },
              { name: "18", country: "gbr" },
            ],
          },
        },
      },
    ]);
    const client = new TvdbClient("k", fetchImpl);
    const s = await client.series(121361);
    expect(s).toMatchObject({
      tvdbId: 121361,
      title: "Game of Thrones",
      year: 2011,
      status: "Ended",
      posterUrl: "https://a/poster.jpg",
      backdropUrl: "https://a/bg.jpg",
      logoUrl: "https://a/logo.png",
      imdbId: "tt0944947",
      tmdbId: 1399,
      contentRating: "TV-MA",
      genres: [{ name: "Drama" }, { name: "Fantasy" }],
    });
    // official seasons only, de-duped by number
    expect(s.seasons).toEqual([
      { seasonNumber: 0, posterUrl: "https://a/s0.jpg", tvdbSeasonId: 500 },
      { seasonNumber: 1, posterUrl: "https://a/s1.jpg", tvdbSeasonId: 501 },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/tvdb.test.ts`
Expected: FAIL — `pickArtwork` / `series` not defined.

- [ ] **Step 3: Implement `pickArtwork`, raw types, and `series()`**

In `packages/core/src/metadata/tvdb.ts`, add the normalized interfaces near the top shapes:
```ts
export interface TvdbSeasonRef {
  seasonNumber: number;
  posterUrl?: string;
  tvdbSeasonId?: number;
}

export interface TvdbSeries {
  tvdbId: number;
  title: string;
  year?: number;
  overview?: string;
  status?: string;
  posterUrl?: string;
  backdropUrl?: string;
  logoUrl?: string;
  imdbId?: string;
  tmdbId?: number;
  contentRating?: string;
  genres: { name: string }[];
  seasons: TvdbSeasonRef[];
}
```
Add raw shapes:
```ts
interface RawArtwork {
  image?: string;
  type?: number;
  language?: string | null;
  score?: number;
}
interface RawRemoteId {
  id?: string;
  sourceName?: string;
}
interface RawSeason {
  id?: number;
  number?: number;
  image?: string | null;
  type?: { type?: string };
}
interface RawSeriesExtended {
  id: number;
  name?: string;
  image?: string | null;
  overview?: string;
  year?: string;
  status?: { name?: string } | null;
  genres?: { name?: string }[];
  remoteIds?: RawRemoteId[];
  seasons?: RawSeason[];
  artworks?: RawArtwork[];
  contentRatings?: { name?: string; country?: string }[];
}
```
Add artwork type constants + the pure picker (near `absUrl`):
```ts
// Series artwork type ids (from /artwork/types). A wrong id simply yields no
// match and callers fall back to the TMDB logo, so this is safe to hardcode.
const ARTWORK_BACKDROP = 3;
const ARTWORK_CLEARLOGO = 23;

/**
 * Best artwork image URL of a given type: exact language match (by score desc)
 * → language-neutral (by score) → any of the type (by score). Pure.
 */
export function pickArtwork(
  artworks: { image?: string; type?: number; language?: string | null; score?: number }[],
  type: number,
  lang?: string,
): string | undefined {
  const pool = artworks.filter((a) => a.type === type && a.image);
  if (pool.length === 0) return undefined;
  const byScore = (a: { score?: number }, b: { score?: number }) => (b.score ?? 0) - (a.score ?? 0);
  if (lang) {
    const inLang = pool.filter((a) => a.language === lang).sort(byScore);
    if (inLang[0]?.image) return inLang[0].image;
  }
  const neutral = pool.filter((a) => a.language == null).sort(byScore);
  if (neutral[0]?.image) return neutral[0].image;
  return [...pool].sort(byScore)[0]?.image;
}
```
Add the `series()` method to the class:
```ts
  async series(id: number): Promise<TvdbSeries> {
    const raw = (await this.get<{ data: RawSeriesExtended }>(`${BASE}/series/${id}/extended`)).data;

    const remote = raw.remoteIds ?? [];
    const imdb = remote.find((r) => /imdb/i.test(r.sourceName ?? "") || /^tt\d+$/.test(r.id ?? ""));
    const tmdb = remote.find((r) => /moviedb|tmdb/i.test(r.sourceName ?? ""));
    const artworks = raw.artworks ?? [];
    const us = (raw.contentRatings ?? []).find((c) => (c.country ?? "").toLowerCase() === "usa");

    // Official (aired) seasons only, de-duped by number, first-wins.
    const seasons: TvdbSeasonRef[] = [];
    const seen = new Set<number>();
    for (const s of raw.seasons ?? []) {
      if (s.type?.type !== "official" || s.number == null || seen.has(s.number)) continue;
      seen.add(s.number);
      seasons.push({
        seasonNumber: s.number,
        ...(absUrl(s.image) ? { posterUrl: absUrl(s.image) } : {}),
        ...(s.id != null ? { tvdbSeasonId: s.id } : {}),
      });
    }
    seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);

    return {
      tvdbId: raw.id,
      title: raw.name ?? "",
      ...(raw.year ? { year: Number(raw.year) } : {}),
      ...(raw.overview != null ? { overview: raw.overview } : {}),
      ...(raw.status?.name ? { status: raw.status.name } : {}),
      ...(absUrl(raw.image) ? { posterUrl: absUrl(raw.image) } : {}),
      ...(pickArtwork(artworks, ARTWORK_BACKDROP) ? { backdropUrl: pickArtwork(artworks, ARTWORK_BACKDROP) } : {}),
      ...(pickArtwork(artworks, ARTWORK_CLEARLOGO, "eng") ? { logoUrl: pickArtwork(artworks, ARTWORK_CLEARLOGO, "eng") } : {}),
      ...(imdb?.id ? { imdbId: imdb.id } : {}),
      ...(tmdb?.id && Number.isFinite(Number(tmdb.id)) ? { tmdbId: Number(tmdb.id) } : {}),
      ...(us?.name ? { contentRating: us.name } : {}),
      genres: (raw.genres ?? []).filter((g) => g.name).map((g) => ({ name: g.name as string })),
      seasons,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/tvdb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/metadata/tvdb.ts packages/core/src/metadata/tvdb.test.ts
git commit -m "feat(core): TvdbClient.series (extended record + artwork/logo picker)"
```

---

### Task 8: `TvdbClient.seasonEpisodes()` — paginated aired order

**Files:**
- Modify: `packages/core/src/metadata/tvdb.ts`
- Test: `packages/core/src/metadata/tvdb.test.ts`

**Interfaces:**
- Produces: `interface TvdbEpisode { seasonNumber: number; episodeNumber: number; title?: string; overview?: string; stillUrl?: string; runtimeSec?: number; airDate?: string; tvdbEpisodeId: number }`; `seasonEpisodes(id: number): Promise<TvdbEpisode[]>` (follows `links.next` for all pages, aired/`default` order).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/metadata/tvdb.test.ts`:
```ts
describe("TvdbClient.seasonEpisodes", () => {
  it("follows pagination and normalises episodes", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login")) {
        return new Response(JSON.stringify({ status: "success", data: { token: "t" } }), { status: 200 });
      }
      if (url.includes("/episodes/default")) {
        const page = new URL(url).searchParams.get("page") ?? "0";
        if (page === "0") {
          return new Response(
            JSON.stringify({
              data: {
                episodes: [
                  { id: 1, seasonNumber: 1, number: 1, name: "Winter Is Coming", overview: "o1", image: "https://a/e1.jpg", runtime: 62, aired: "2011-04-17" },
                ],
              },
              links: { next: `${"https://api4.thetvdb.com/v4"}/series/9/episodes/default?page=1` },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            data: { episodes: [{ id: 2, seasonNumber: 1, number: 2, name: "The Kingsroad", aired: "2011-04-24" }] },
            links: { next: null },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const client = new TvdbClient("k", fetchImpl);
    const eps = await client.seasonEpisodes(9);
    expect(eps).toEqual([
      { seasonNumber: 1, episodeNumber: 1, title: "Winter Is Coming", overview: "o1", stillUrl: "https://a/e1.jpg", runtimeSec: 3720, airDate: "2011-04-17", tvdbEpisodeId: 1 },
      { seasonNumber: 1, episodeNumber: 2, title: "The Kingsroad", airDate: "2011-04-24", tvdbEpisodeId: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/tvdb.test.ts`
Expected: FAIL — `seasonEpisodes` not defined.

- [ ] **Step 3: Implement**

Add the interface near the other shapes:
```ts
export interface TvdbEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  overview?: string;
  stillUrl?: string;
  runtimeSec?: number;
  airDate?: string;
  tvdbEpisodeId: number;
}
```
Add a raw shape:
```ts
interface RawEpisode {
  id: number;
  seasonNumber?: number;
  number?: number;
  name?: string | null;
  overview?: string | null;
  image?: string | null;
  runtime?: number | null;
  aired?: string | null;
}
```
Add a private mapper + the paginated method to the class:
```ts
  private mapEpisode(e: RawEpisode): TvdbEpisode {
    return {
      seasonNumber: e.seasonNumber ?? 0,
      episodeNumber: e.number ?? 0,
      ...(e.name ? { title: e.name } : {}),
      ...(e.overview ? { overview: e.overview } : {}),
      ...(absUrl(e.image) ? { stillUrl: absUrl(e.image) } : {}),
      ...(e.runtime != null ? { runtimeSec: e.runtime * 60 } : {}),
      ...(e.aired ? { airDate: e.aired } : {}),
      tvdbEpisodeId: e.id,
    };
  }

  /** All episodes in aired (default) order, following pagination. */
  async seasonEpisodes(id: number): Promise<TvdbEpisode[]> {
    const lang = this.language ? `/${this.language}` : "";
    const out: TvdbEpisode[] = [];
    let page = 0;
    // Bounded to avoid a runaway loop on a misbehaving API.
    for (let guard = 0; guard < 100; guard++) {
      const raw = await this.get<{ data?: { episodes?: RawEpisode[] }; links?: { next?: string | null } }>(
        `${BASE}/series/${id}/episodes/default${lang}?page=${page}`,
      );
      for (const e of raw.data?.episodes ?? []) out.push(this.mapEpisode(e));
      if (!raw.links?.next) break;
      page++;
    }
    return out;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/tvdb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/metadata/tvdb.ts packages/core/src/metadata/tvdb.test.ts
git commit -m "feat(core): TvdbClient.seasonEpisodes (paginated aired order)"
```

---

### Task 9: `TvdbClient.seriesTranslated()` — localized text

**Files:**
- Modify: `packages/core/src/metadata/tvdb.ts`
- Test: `packages/core/src/metadata/tvdb.test.ts`

**Interfaces:**
- Produces: `interface TvdbTranslation { title?: string; overview?: string; episodes: Map<string, { title?: string; overview?: string }> }` (episode key = `` `${seasonNumber}:${episodeNumber}` ``); `seriesTranslated(id: number): Promise<TvdbTranslation>` — uses the client's own `language` (falls back to `"eng"`), one series-translation call + a paginated localized-episodes sweep.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/metadata/tvdb.test.ts`:
```ts
describe("TvdbClient.seriesTranslated", () => {
  it("returns localized series + episode text keyed by season:episode", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "t" } } },
      { match: "/series/9/translations/spa", body: { status: "success", data: { name: "Juego de Tronos", overview: "Nueve familias…", language: "spa" } } },
      {
        match: "/series/9/episodes/default/spa",
        body: {
          data: { episodes: [{ id: 1, seasonNumber: 1, number: 1, name: "Se acerca el invierno", overview: "o-es" }] },
          links: { next: null },
        },
      },
    ]);
    const client = new TvdbClient("k", fetchImpl, undefined, "spa");
    const tr = await client.seriesTranslated(9);
    expect(tr.title).toBe("Juego de Tronos");
    expect(tr.overview).toBe("Nueve familias…");
    expect(tr.episodes.get("1:1")).toEqual({ title: "Se acerca el invierno", overview: "o-es" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/tvdb.test.ts`
Expected: FAIL — `seriesTranslated` not defined.

- [ ] **Step 3: Implement**

Add the interface near the other shapes:
```ts
export interface TvdbTranslation {
  title?: string;
  overview?: string;
  /** key `${seasonNumber}:${episodeNumber}` → localized title/overview */
  episodes: Map<string, { title?: string; overview?: string }>;
}
```
Add a raw shape + the method:
```ts
interface RawTranslation {
  name?: string | null;
  overview?: string | null;
}
```
```ts
  /**
   * Localized series title/overview + per-episode title/overview, in the
   * client's configured language (default eng). One translations call plus a
   * paginated localized-episodes sweep.
   */
  async seriesTranslated(id: number): Promise<TvdbTranslation> {
    const lang = this.language ?? "eng";
    const series = (await this.get<{ data?: RawTranslation }>(`${BASE}/series/${id}/translations/${lang}`)).data;
    const episodes = new Map<string, { title?: string; overview?: string }>();
    let page = 0;
    for (let guard = 0; guard < 100; guard++) {
      const raw = await this.get<{ data?: { episodes?: RawEpisode[] }; links?: { next?: string | null } }>(
        `${BASE}/series/${id}/episodes/default/${lang}?page=${page}`,
      );
      for (const e of raw.data?.episodes ?? []) {
        const key = `${e.seasonNumber ?? 0}:${e.number ?? 0}`;
        episodes.set(key, {
          ...(e.name ? { title: e.name } : {}),
          ...(e.overview ? { overview: e.overview } : {}),
        });
      }
      if (!raw.links?.next) break;
      page++;
    }
    return {
      ...(series?.name ? { title: series.name } : {}),
      ...(series?.overview ? { overview: series.overview } : {}),
      episodes,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/tvdb.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint the new module**

Run: `pnpm --filter @orbix/core lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/metadata/tvdb.ts packages/core/src/metadata/tvdb.test.ts
git commit -m "feat(core): TvdbClient.seriesTranslated (localized series+episode text)"
```

---

### Task 10: `enrichSeriesTvdb`

**Files:**
- Create: `packages/core/src/metadata/enrich-series-tvdb.ts`
- Test: `packages/core/src/metadata/enrich-series-tvdb.test.ts`
- Modify: `packages/core/src/index.ts` (export both new modules)

**Interfaces:**
- Consumes: `TvdbSeries`, `TvdbEpisode`, `TvdbTranslation` (Tasks 7-9); `SaveSeriesInput`, `EnrichResult` (Task 2); `ImageKind`, `ExternalRatings`.
- Produces: `TvdbLike` structural interface `{ searchSeries; series; seasonEpisodes }`; `TvdbTranslateClient = { seriesTranslated(id: number): Promise<TvdbTranslation> }`; `enrichSeriesTvdb(item, deps): Promise<EnrichResult>`. Returns `{ matched: false }` when TVDB can't match (the fallback signal); on match, calls `saveSeries` with `metadataSource: "tvdb"`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/metadata/enrich-series-tvdb.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { enrichSeriesTvdb } from "./enrich-series-tvdb";
import type { TvdbSeries, TvdbEpisode, TvdbTranslation } from "./tvdb";
import type { SaveSeriesInput } from "./enrich-series";

const series: TvdbSeries = {
  tvdbId: 9,
  title: "Game of Thrones",
  year: 2011,
  overview: "Nine…",
  status: "Ended",
  posterUrl: "https://a/p.jpg",
  backdropUrl: "https://a/b.jpg",
  logoUrl: "https://a/l.png",
  imdbId: "tt0944947",
  tmdbId: 1399,
  contentRating: "TV-MA",
  genres: [{ name: "Drama" }],
  seasons: [{ seasonNumber: 1, posterUrl: "https://a/s1.jpg", tvdbSeasonId: 501 }],
};
const episodes: TvdbEpisode[] = [
  { seasonNumber: 1, episodeNumber: 1, title: "Winter Is Coming", overview: "o1", stillUrl: "https://a/e1.jpg", runtimeSec: 3720, airDate: "2011-04-17", tvdbEpisodeId: 101 },
];

function makeDeps(overrides: Partial<Parameters<typeof enrichSeriesTvdb>[1]> = {}) {
  const saved: SaveSeriesInput[] = [];
  const client = {
    searchSeries: vi.fn(async () => ({ tvdbId: 9, title: "Game of Thrones", year: 2011 })),
    series: vi.fn(async () => series),
    seasonEpisodes: vi.fn(async () => episodes),
  };
  const deps = {
    client,
    cacheImageUrl: vi.fn(async (url: string) => `cached/${url.split("/").pop()}`),
    saveSeries: vi.fn(async (i: SaveSeriesInput) => { saved.push(i); }),
    fetchRatings: vi.fn(async () => ({ imdbRating: 9.2, imdbVotes: 100, rtRating: 90, metacritic: 80 })),
    ...overrides,
  };
  return { deps, saved, client };
}

describe("enrichSeriesTvdb", () => {
  it("returns matched:false when TVDB has no match (fallback signal)", async () => {
    const { deps, client } = makeDeps();
    client.searchSeries.mockResolvedValueOnce(null);
    const res = await enrichSeriesTvdb({ id: "it1", title: "Nope" }, deps);
    expect(res).toEqual({ matched: false });
    expect(deps.saveSeries).not.toHaveBeenCalled();
  });

  it("enriches a matched series with tvdb source, ids, images and ratings", async () => {
    const { deps, saved } = makeDeps();
    const res = await enrichSeriesTvdb({ id: "it1", title: "Game of Thrones", year: 2011 }, deps);
    expect(res).toEqual({ matched: true, tvdbId: 9 });
    const s = saved[0]!;
    expect(s).toMatchObject({
      itemId: "it1",
      metadataSource: "tvdb",
      tvdbId: 9,
      tmdbId: 1399,
      imdbId: "tt0944947",
      title: "Game of Thrones",
      rating: "TV-MA",
      imdbRating: 9.2,
    });
    expect(s.tmdbId).toBe(1399);
    expect(s.posterPath).toBe("cached/p.jpg");
    expect(s.backdropPath).toBe("cached/b.jpg");
    expect(s.logoPath).toBe("cached/l.png");
    expect(s.seasons[0]).toMatchObject({ seasonNumber: 1, posterPath: "cached/s1.jpg", tvdbSeasonId: 501 });
    expect(s.seasons[0]!.episodes[0]).toMatchObject({
      episodeNumber: 1,
      title: "Winter Is Coming",
      stillPath: "cached/e1.jpg",
      runtimeSec: 3720,
      airDate: "2011-04-17",
      tvdbEpisodeId: 101,
    });
  });

  it("restricts to localSeasonNumbers when provided", async () => {
    const { deps, saved } = makeDeps();
    deps.seasonEpisodes = vi.fn(async () => [
      ...episodes,
      { seasonNumber: 2, episodeNumber: 1, title: "S2E1", tvdbEpisodeId: 201 },
    ]);
    await enrichSeriesTvdb({ id: "it1", title: "GoT", year: 2011 }, { ...deps, localSeasonNumbers: [1] });
    const s = saved[0]!;
    expect(s.seasons.map((x) => x.seasonNumber)).toEqual([1]);
  });

  it("attaches per-language translations and survives a failing translate client", async () => {
    const { deps, saved } = makeDeps();
    const goodTr: TvdbTranslation = {
      title: "Juego de Tronos",
      overview: "Nueve…",
      episodes: new Map([["1:1", { title: "Se acerca el invierno", overview: "o-es" }]]),
    };
    const translateClients = new Map([
      ["es", { seriesTranslated: vi.fn(async () => goodTr) }],
      ["de", { seriesTranslated: vi.fn(async () => { throw new Error("boom"); }) }],
    ]);
    await enrichSeriesTvdb({ id: "it1", title: "GoT", year: 2011 }, { ...deps, translateClients });
    const s = saved[0]!;
    expect(s.translations).toEqual([{ language: "es", title: "Juego de Tronos", overview: "Nueve…" }]);
    expect(s.seasons[0]!.episodes[0]!.translations).toEqual([
      { language: "es", title: "Se acerca el invierno", overview: "o-es" },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/enrich-series-tvdb.test.ts`
Expected: FAIL — module `./enrich-series-tvdb` does not exist.

- [ ] **Step 3: Implement `enrichSeriesTvdb`**

Create `packages/core/src/metadata/enrich-series-tvdb.ts`:
```ts
import type { TvdbSeries, TvdbEpisode, TvdbSearchResult, TvdbTranslation } from "./tvdb";
import type { ImageKind } from "./images";
import type { ExternalRatings } from "./omdb";
import type { EnrichResult, MetadataTranslation } from "./enrich";
import type { SaveSeriesInput, SaveSeriesSeason, SaveSeriesEpisode } from "./enrich-series";

/** Structural surface of TvdbClient needed to enrich a series. */
export interface TvdbLike {
  searchSeries(title: string, year?: number): Promise<TvdbSearchResult | null>;
  series(id: number): Promise<TvdbSeries>;
  seasonEpisodes(id: number): Promise<TvdbEpisode[]>;
}

/** Per-language client used to fetch localized series/episode text. */
export interface TvdbTranslateClient {
  seriesTranslated(id: number): Promise<TvdbTranslation>;
}

/**
 * Enrich a TV series from TVDB. Returns { matched: false } when TVDB cannot
 * match the title — the caller then falls back to the TMDB path. On a match,
 * persists via the shared saveSeries adapter with metadataSource "tvdb".
 */
export async function enrichSeriesTvdb(
  item: { id: string; title: string; year?: number; tvdbId?: number },
  deps: {
    client: TvdbLike;
    cacheImageUrl: (url: string, kind: ImageKind) => Promise<string>;
    saveSeries: (input: SaveSeriesInput) => Promise<void>;
    /** Resolve + cache a hero logo (TVDB clearlogo → TMDB fallback); metadata-relative path. */
    resolveLogo?: (input: { tvdbId: number; tmdbId?: number; logoUrl?: string }) => Promise<string | undefined>;
    fetchRatings?: (imdbId: string) => Promise<ExternalRatings | undefined>;
    localSeasonNumbers?: number[];
    translateClients?: Map<string, TvdbTranslateClient>;
  },
): Promise<EnrichResult> {
  const tvdbId = item.tvdbId ?? (await deps.client.searchSeries(item.title, item.year))?.tvdbId;
  if (!tvdbId) return { matched: false };

  const series = await deps.client.series(tvdbId);

  const posterPath = series.posterUrl ? await deps.cacheImageUrl(series.posterUrl, "poster") : undefined;
  const backdropPath = series.backdropUrl ? await deps.cacheImageUrl(series.backdropUrl, "backdrop") : undefined;

  // Hero logo: prefer a caller-provided resolver (TVDB clearlogo → TMDB), else
  // cache the TVDB clearlogo directly. Never fail enrichment on the logo.
  let logoPath: string | undefined;
  try {
    if (deps.resolveLogo) {
      logoPath = await deps.resolveLogo({ tvdbId, tmdbId: series.tmdbId, logoUrl: series.logoUrl });
    } else if (series.logoUrl) {
      logoPath = await deps.cacheImageUrl(series.logoUrl, "logo");
    }
  } catch {
    logoPath = undefined;
  }

  let extraRatings: ExternalRatings | undefined;
  if (deps.fetchRatings && series.imdbId) {
    try {
      extraRatings = await deps.fetchRatings(series.imdbId);
    } catch {
      extraRatings = undefined;
    }
  }

  // Episodes (aired order), grouped by season; restricted to local seasons if known.
  const allEpisodes = await deps.client.seasonEpisodes(tvdbId);
  const local = deps.localSeasonNumbers ? new Set(deps.localSeasonNumbers) : null;
  const metaBySeason = new Map(series.seasons.map((s) => [s.seasonNumber, s]));

  const bySeason = new Map<number, TvdbEpisode[]>();
  for (const e of allEpisodes) {
    if (local && !local.has(e.seasonNumber)) continue;
    let arr = bySeason.get(e.seasonNumber);
    if (!arr) {
      arr = [];
      bySeason.set(e.seasonNumber, arr);
    }
    arr.push(e);
  }

  const seasons: SaveSeriesSeason[] = [];
  for (const seasonNumber of [...bySeason.keys()].sort((a, b) => a - b)) {
    const eps = bySeason.get(seasonNumber)!;
    const meta = metaBySeason.get(seasonNumber);
    const savedEpisodes: SaveSeriesEpisode[] = [];
    for (const e of eps) {
      const stillPath = e.stillUrl ? await deps.cacheImageUrl(e.stillUrl, "still") : undefined;
      savedEpisodes.push({
        episodeNumber: e.episodeNumber,
        ...(e.title != null ? { title: e.title } : {}),
        ...(e.overview != null ? { overview: e.overview } : {}),
        ...(stillPath ? { stillPath } : {}),
        ...(e.runtimeSec != null ? { runtimeSec: e.runtimeSec } : {}),
        ...(e.airDate != null ? { airDate: e.airDate } : {}),
        tvdbEpisodeId: e.tvdbEpisodeId,
      });
    }
    seasons.push({
      seasonNumber,
      ...(meta?.posterUrl ? { posterPath: await deps.cacheImageUrl(meta.posterUrl, "poster") } : {}),
      ...(meta?.tvdbSeasonId != null ? { tvdbSeasonId: meta.tvdbSeasonId } : {}),
      episodes: savedEpisodes,
    });
  }

  // Localized series/episode text per active language. A per-language failure
  // must NOT fail enrichment — skip that language.
  const seriesTranslations: MetadataTranslation[] = [];
  if (deps.translateClients) {
    for (const [language, client] of deps.translateClients) {
      try {
        const tr = await client.seriesTranslated(tvdbId);
        if (tr.title) {
          seriesTranslations.push({
            language,
            title: tr.title,
            ...(tr.overview != null ? { overview: tr.overview } : {}),
          });
        }
        for (const season of seasons) {
          for (const ep of season.episodes) {
            const le = tr.episodes.get(`${season.seasonNumber}:${ep.episodeNumber}`);
            if (!le || (le.title == null && le.overview == null)) continue;
            (ep.translations ??= []).push({
              language,
              ...(le.title != null ? { title: le.title } : {}),
              ...(le.overview != null ? { overview: le.overview } : {}),
            });
          }
        }
      } catch {
        // localized fetch failed for this language — fall back to base.
      }
    }
  }

  await deps.saveSeries({
    itemId: item.id,
    metadataSource: "tvdb",
    tvdbId,
    ...(series.tmdbId != null ? { tmdbId: series.tmdbId } : {}),
    title: series.title,
    ...(series.year != null ? { year: series.year } : {}),
    ...(series.overview != null ? { overview: series.overview } : {}),
    ...(series.status != null ? { status: series.status } : {}),
    ...(posterPath ? { posterPath } : {}),
    ...(backdropPath ? { backdropPath } : {}),
    ...(logoPath ? { logoPath } : {}),
    ...(series.imdbId != null ? { imdbId: series.imdbId } : {}),
    ...(extraRatings?.imdbRating != null ? { imdbRating: extraRatings.imdbRating } : {}),
    ...(extraRatings?.imdbVotes != null ? { imdbVotes: extraRatings.imdbVotes } : {}),
    ...(extraRatings?.rtRating != null ? { rtRating: extraRatings.rtRating } : {}),
    ...(extraRatings?.metacritic != null ? { metacritic: extraRatings.metacritic } : {}),
    ...(series.contentRating != null ? { rating: series.contentRating } : {}),
    genres: series.genres.map((g) => ({ tmdbId: 0, name: g.name })),
    seasons,
    translations: seriesTranslations,
  });

  return { matched: true, tvdbId };
}
```
Note on `genres`: `SaveSeriesInput.genres` items are `{ tmdbId: number; name: string }` and `saveSeries` upserts genres by **name** (`where: { name: g.name }`), so `tmdbId: 0` is a harmless placeholder for TVDB genres that have no TMDB id.

Then add exports to `packages/core/src/index.ts` (after `export * from "./metadata/enrich-series";`):
```ts
export * from "./metadata/tvdb";
export * from "./metadata/enrich-series-tvdb";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orbix/core exec vitest run src/metadata/enrich-series-tvdb.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Full core gate**

Run: `pnpm --filter @orbix/core typecheck && pnpm --filter @orbix/core lint && pnpm --filter @orbix/core test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/metadata/enrich-series-tvdb.ts packages/core/src/metadata/enrich-series-tvdb.test.ts packages/core/src/index.ts
git commit -m "feat(core): enrichSeriesTvdb (TVDB-first series enrichment)"
```

---

### Task 11: Wire TVDB-first into the scan (queue.ts)

**Files:**
- Modify: `apps/api/src/plugins/queue.ts` (imports; enrichment setup ~382-447; the series branch ~712-725; `resolveLogoTv`)

**Interfaces:**
- Consumes: `TvdbClient`, `enrichSeriesTvdb`, `cacheImageFromUrl`, `tvdbLanguageTag` (core); `SaveSeriesInput` (Task 2).
- Produces: series enrich TVDB-first, TMDB fallback on `!matched`; `resolveLogoTv` upgraded to TVDB clearlogo → TMDB.

- [ ] **Step 1: Add imports**

In the `from "@orbix/core"` import block in `apps/api/src/plugins/queue.ts`, add:
```ts
  TvdbClient,
  enrichSeriesTvdb,
  tvdbLanguageTag,
  type EnrichResult,
```

- [ ] **Step 2: Build the TVDB clients + a URL cacher in the enrichment setup**

Immediately after the `boundCacheImage` definition (~line 418; `activeLanguages` and `imageIo` are already in scope by here), add:
```ts
        // TVDB is optional; when configured, series enrich TVDB-first.
        const tvdbApiKey = await getSetting<string>("tvdbApiKey", {
          fallback: "",
          read: (k) => prisma.setting.findUnique({ where: { key: k } }),
        });
        const tvdbPin = await getSetting<string>("tvdbPin", {
          fallback: "",
          read: (k) => prisma.setting.findUnique({ where: { key: k } }),
        });
        const tvdb = tvdbApiKey ? new TvdbClient(tvdbApiKey, fetch, tvdbPin || undefined) : null;
        const tvdbTranslateClients = new Map<string, TvdbClient>();
        if (tvdbApiKey) {
          for (const lang of activeLanguages) {
            tvdbTranslateClients.set(lang, new TvdbClient(tvdbApiKey, fetch, tvdbPin || undefined, tvdbLanguageTag(lang)));
          }
        }

        const boundCacheImageUrl = (url: string, kind: ImageKind): Promise<string> =>
          cacheImageFromUrl(url, kind, imageIo);
```

- [ ] **Step 3: Upgrade `resolveLogoTv` to prefer TVDB clearlogo**

Replace the existing `resolveLogoTv` (~437-443) with:
```ts
        // TV logo: prefer the TVDB clearlogo art (absolute URL) when present,
        // else TMDB's own logo art keyed by the cross-referenced tmdbId.
        const resolveLogoTv = async (id: {
          tvdbId?: number;
          tmdbId?: number;
          logoUrl?: string;
        }): Promise<string | undefined> => {
          if (id.logoUrl) return cacheImageFromUrl(id.logoUrl, "logo", imageIo);
          if (id.tmdbId != null) {
            const tmdbLogo = await client.tvLogoPath(id.tmdbId);
            if (tmdbLogo) return boundCacheImage(tmdbLogo, "logo");
          }
          return undefined;
        };
```
Note: the TMDB series branch calls `resolveLogoTv` via `enrichSeries`'s `resolveLogo` dep, which passes `{ tmdbId, imdbId }`. The new signature accepts `tmdbId` (optional `tvdbId`/`logoUrl`), so that call still works — it just takes the `id.tmdbId != null` branch. Confirm the `enrichSeries(...)` call still passes `resolveLogo: resolveLogoTv`.

- [ ] **Step 4: Make the series branch TVDB-first with TMDB fallback**

Replace the series branch inside the per-item loop (the `if (item.kind === "series") { ... }` block, ~712-725) with:
```ts
            if (item.kind === "series") {
              const localSeasons = await prisma.season.findMany({
                where: { seriesId: item.id },
                select: { seasonNumber: true },
              });
              const localSeasonNumbers = localSeasons.map((s) => s.seasonNumber);

              // TVDB first (when configured); fall back to TMDB on no match.
              if (tvdb) {
                result = await enrichSeriesTvdb(
                  { id: item.id, title: item.title, year: item.year ?? undefined, tvdbId: item.tvdbId ?? undefined },
                  {
                    client: tvdb,
                    cacheImageUrl: boundCacheImageUrl,
                    saveSeries,
                    resolveLogo: resolveLogoTv,
                    fetchRatings,
                    localSeasonNumbers,
                    translateClients: tvdbTranslateClients,
                  },
                );
              } else {
                result = { matched: false };
              }

              if (!result.matched) {
                result = await enrichSeries(base, {
                  client,
                  cacheImage: boundCacheImage,
                  saveSeries,
                  resolveLogo: resolveLogoTv,
                  fetchRatings,
                  localSeasonNumbers,
                  translateClients,
                });
              }
            } else {
```
Also change the `let result;` declaration (just above this block, ~711) to `let result: EnrichResult;`, and update the item `select` (~697) to include the new columns:
```ts
            select: { id: true, kind: true, title: true, year: true, tmdbId: true, tvdbId: true, matchState: true },
```

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint`
Expected: PASS. (`result` is declared `let result: EnrichResult;` in Step 4, so all branches — TVDB, TMDB series, movie, and the `{ matched: false }` no-key case — unify cleanly.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/plugins/queue.ts
git commit -m "feat(api): TVDB-first series enrichment with TMDB fallback + TVDB logo"
```

---

## Phase 3 — Localization backfill parity

### Task 12: Provider-aware `translate-metadata` worker

**Files:**
- Modify: `apps/api/src/plugins/queue.ts` (`translateProcessor` ~839-956)

**Interfaces:**
- Consumes: `TvdbClient`, `tvdbLanguageTag` (already imported in Task 11).
- Produces: the backfill covers TVDB-sourced series (localized series + episode text) in addition to TMDB items; query broadened to include `tvdbId`-only series.

- [ ] **Step 1: Build a language-configured TVDB client in the worker**

Near the top of `translateProcessor`, after the TMDB `client` is built (~854), add:
```ts
      const tvdbApiKey = await getSetting<string>("tvdbApiKey", {
        fallback: "",
        read: (k) => prisma.setting.findUnique({ where: { key: k } }),
      });
      const tvdbPin = await getSetting<string>("tvdbPin", {
        fallback: "",
        read: (k) => prisma.setting.findUnique({ where: { key: k } }),
      });
      const tvdbClient = tvdbApiKey
        ? new TvdbClient(tvdbApiKey, fetch, tvdbPin || undefined, tvdbLanguageTag(language))
        : null;
```

- [ ] **Step 2: Add a TVDB series backfill function**

Next to the existing `translateSeries` function, add:
```ts
      async function translateSeriesTvdb(seriesId: string, tvdbId: number): Promise<void> {
        if (!tvdbClient) return;
        const tr = await tvdbClient.seriesTranslated(tvdbId);
        if (tr.title) {
          await prisma.mediaItemTranslation.upsert({
            where: { mediaItemId_language: { mediaItemId: seriesId, language } },
            create: { mediaItemId: seriesId, language, title: tr.title, overview: tr.overview ?? null },
            update: { title: tr.title, overview: tr.overview ?? null },
          });
        }
        const localEpisodes = await prisma.episode.findMany({
          where: { seriesId },
          select: { id: true, seasonId: true, episodeNumber: true, season: { select: { seasonNumber: true } } },
        });
        for (const le of localEpisodes) {
          const t = tr.episodes.get(`${le.season.seasonNumber}:${le.episodeNumber}`);
          if (!t || (t.title == null && t.overview == null)) continue;
          await prisma.episodeTranslation.upsert({
            where: { episodeId_language: { episodeId: le.id, language } },
            create: { episodeId: le.id, language, title: t.title ?? null, overview: t.overview ?? null },
            update: { title: t.title ?? null, overview: t.overview ?? null },
          });
        }
      }
```

- [ ] **Step 3: Broaden the item query + branch by provider**

Replace the items query (~930):
```ts
      const items = await prisma.mediaItem.findMany({
        where: {
          matchState: { not: "unmatched" },
          OR: [{ tmdbId: { not: null } }, { tvdbId: { not: null } }],
        },
        select: { id: true, kind: true, tmdbId: true, tvdbId: true, metadataSource: true },
      });
```
Replace the per-item branch body (~936-947) with:
```ts
        try {
          if (item.kind === "series" && (item.metadataSource === "tvdb" || (item.tvdbId != null && item.tmdbId == null))) {
            await translateSeriesTvdb(item.id, item.tvdbId!);
          } else if (item.kind === "series" && item.tmdbId != null) {
            await translateSeries(item.id, item.tmdbId);
          } else if (item.tmdbId != null) {
            const m = await client.movie(item.tmdbId);
            await prisma.mediaItemTranslation.upsert({
              where: { mediaItemId_language: { mediaItemId: item.id, language } },
              create: { mediaItemId: item.id, language, title: m.title, overview: m.overview ?? null },
              update: { title: m.title, overview: m.overview ?? null },
            });
          }
        } catch (err) {
          app.log.warn({ err, itemId: item.id, language }, "item translation failed — continuing");
        }
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/plugins/queue.ts
git commit -m "feat(api): provider-aware metadata translation backfill (TVDB series)"
```

---

## Phase 4 — Settings UI

### Task 13: TheTVDB settings section (web)

**Files:**
- Modify: `apps/web/src/pages/AdminSettingsPage.tsx`
- Modify: `apps/web/src/locales/{en,es,de,pt,ru,fr}/settings.json`

**Interfaces:**
- Consumes: `GET /api/settings` `tvdbConfigured`; `PUT /api/settings` `tvdbApiKey`/`tvdbPin` (Task 4).

- [ ] **Step 1: Add locale keys (en)**

In `apps/web/src/locales/en/settings.json`, under `providers`, add a `tvdb` block (sibling of `fanart`):
```json
    "tvdb": {
      "label": "TheTVDB API Key",
      "pinLabel": "TheTVDB Subscriber PIN",
      "placeholderPinConfigured": "Leave blank to keep existing PIN",
      "placeholderPinEmpty": "Optional subscriber PIN"
    }
```

- [ ] **Step 2: Add the same keys to es/de/pt/ru/fr**

Add the parallel `providers.tvdb` block to each other locale's `settings.json` (translate the values; keys must match en exactly or `parity.test.ts` fails):

`es`:
```json
    "tvdb": {
      "label": "Clave de API de TheTVDB",
      "pinLabel": "PIN de suscriptor de TheTVDB",
      "placeholderPinConfigured": "Deja en blanco para conservar el PIN actual",
      "placeholderPinEmpty": "PIN de suscriptor (opcional)"
    }
```
`de`:
```json
    "tvdb": {
      "label": "TheTVDB-API-Schlüssel",
      "pinLabel": "TheTVDB-Abonnenten-PIN",
      "placeholderPinConfigured": "Leer lassen, um die vorhandene PIN zu behalten",
      "placeholderPinEmpty": "Optionale Abonnenten-PIN"
    }
```
`pt`:
```json
    "tvdb": {
      "label": "Chave da API do TheTVDB",
      "pinLabel": "PIN de assinante do TheTVDB",
      "placeholderPinConfigured": "Deixe em branco para manter o PIN atual",
      "placeholderPinEmpty": "PIN de assinante (opcional)"
    }
```
`ru`:
```json
    "tvdb": {
      "label": "Ключ API TheTVDB",
      "pinLabel": "PIN подписчика TheTVDB",
      "placeholderPinConfigured": "Оставьте пустым, чтобы сохранить текущий PIN",
      "placeholderPinEmpty": "PIN подписчика (необязательно)"
    }
```
`fr`:
```json
    "tvdb": {
      "label": "Clé API TheTVDB",
      "pinLabel": "Code PIN d'abonné TheTVDB",
      "placeholderPinConfigured": "Laisser vide pour conserver le code PIN actuel",
      "placeholderPinEmpty": "Code PIN d'abonné (facultatif)"
    }
```

- [ ] **Step 3: Wire state + payload in the page**

In `apps/web/src/pages/AdminSettingsPage.tsx`:
- In the settings-shape interface (the one with `omdbConfigured: boolean;`), add `tvdbConfigured: boolean;`.
- Add state: `const [tvdbConfigured, setTvdbConfigured] = useState(false);`, `const [tvdbApiKey, setTvdbApiKey] = useState("");`, `const [tvdbPin, setTvdbPin] = useState("");`.
- In the load effect (next to `setFanartConfigured(data.fanartConfigured);`), add `setTvdbConfigured(data.tvdbConfigured);`.
- In the submit handler (next to `if (fanartKey) body.fanartKey = fanartKey;`), add `if (tvdbApiKey) body.tvdbApiKey = tvdbApiKey;` and `if (tvdbPin) body.tvdbPin = tvdbPin;`.

- [ ] **Step 4: Add the TheTVDB JSX block**

Immediately after the Fanart.tv `<div>…</div>` block (before the closing `</div>` of the providers group), add:
```tsx
            {/* TheTVDB */}
            <div>
              <label className="block mb-1 text-sm font-medium text-[var(--text)]">
                {t("settings:providers.tvdb.label")}{" "}
                <span className="text-[var(--text-dim)] font-normal">{t("settings:providers.optional")}</span>
              </label>
              <p className="mb-2 text-xs text-[var(--text-dim)]">
                {t("settings:providers.statusLabel")}{" "}
                <span className={tvdbConfigured ? "text-green-400" : "text-[var(--text-dim)]"}>
                  {tvdbConfigured ? t("settings:providers.status.configured") : t("settings:providers.status.notSet")}
                </span>
              </p>
              <Input
                type="password"
                value={tvdbApiKey}
                onChange={(e) => setTvdbApiKey(e.target.value)}
                placeholder={tvdbConfigured ? t("settings:providers.placeholderKeyConfigured") : t("settings:providers.placeholderKeyEmpty")}
                autoComplete="off"
              />
              <label className="block mt-3 mb-1 text-sm font-medium text-[var(--text)]">
                {t("settings:providers.tvdb.pinLabel")}{" "}
                <span className="text-[var(--text-dim)] font-normal">{t("settings:providers.optional")}</span>
              </label>
              <Input
                type="password"
                value={tvdbPin}
                onChange={(e) => setTvdbPin(e.target.value)}
                placeholder={tvdbConfigured ? t("settings:providers.tvdb.placeholderPinConfigured") : t("settings:providers.tvdb.placeholderPinEmpty")}
                autoComplete="off"
              />
            </div>
```

- [ ] **Step 5: Run the locale parity test + web checks**

Run: `pnpm --filter @orbix/web exec vitest run src/locales/parity.test.ts`
Expected: PASS (all locales have the new `providers.tvdb.*` keys).
Then: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/AdminSettingsPage.tsx apps/web/src/locales
git commit -m "feat(web): TheTVDB API key + subscriber PIN settings section"
```

---

## Final Verification

- [ ] **Full gates**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all PASS.

- [ ] **Integration smoke (throwaway DB, real TVDB key)**

Bring up `docker compose up -d`, set a TVDB API key in Settings, add a TV library, scan. Verify:
- Series `MediaItem.metadataSource === "tvdb"`, `tvdbId` set, seasons/episodes populated in aired order, poster/backdrop/logo cached under `METADATA_DIR`.
- A series TVDB can't match still enriches via TMDB (`metadataSource === "tmdb"`).
- Switch a profile to `es`, trigger the translate backfill (or rescan), confirm episode titles localize and fall back to base when a translation is missing.
- Kids profile still filters TVDB-matched series by rating.

Then reap host dev servers: `pkill -f "tsx.*watch src/server.ts"; pkill -f vite`.

- [ ] **Update the SDD ledger**

Append a short entry to `.superpowers/sdd/progress.md` noting: TVDB-primary TV enrichment shipped; deferred minors — fanart-TV logos (`/v3/tv/{tvdbId}`), TVDB season-name localization, TVDB genre-list translations, alternate (DVD/absolute) episode orderings.

---

## Deferred (intentional non-goals for this plan)

- **fanart.tv TV logos** (`/v3/tv/{tvdbId}` with `hdtvlogo`/`clearlogo`) — TVDB's own clearlogo covers the hero-logo need; fanart-TV is a later polish. (Design §3/§8 mentioned fanart-first; refined to TVDB-clearlogo-first here to avoid a new fanart-TV core helper.)
- **TVDB season-name localization** — TVDB season names are usually generic ("Season N", language-neutral); series + episode text localization is preserved.
- **TVDB genre-list translations** — TVDB genres are name-keyed (no TMDB id), so they don't get TMDB genre-list translations; base (en) genre name always shows.
- **Alternate episode orderings** (DVD/absolute).
- **Migrating already-cached TMDB images** for series that flip to TVDB — rescan re-caches from TVDB.
```
