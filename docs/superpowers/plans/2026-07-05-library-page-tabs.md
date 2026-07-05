# Library Page Categories/Browse Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `/library/:libraryId` from a single searchable grid into two tabs — **Categories** (auto-generated localized genre rails, biggest genre first, capped at 24 + "See all" grid) and **Browse** (flat poster grid sorted A→Z, then А→Я, then other scripts, digits last, by *displayed* title).

**Architecture:** Pure grouping/sorting logic lives in `packages/core` (`buildLibraryGenreRows`, `compareDisplayTitles`) per the core/api split. `apps/api` adds `GET /libraries/:id/rows` and extends `GET /libraries/:id/items` with `genre=` / `sort=alpha` / `sort=rating`. `apps/web` adds a `Tabs` primitive to `@orbix/ui`, generalizes `MediaRow` with a header `action` slot, and splits `LibraryPage` into Categories / Browse / GenreGrid views driven by URL search params.

**Tech Stack:** TypeScript, Fastify + Prisma (api), React + React Router v8 + TanStack Query + react-i18next (web), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-05-library-page-tabs-design.md`

## Global Constraints

- Run all commands with the repo-local pnpm (`pnpm`, pinned 10.22.0). Package-scoped runs: `pnpm --filter @orbix/core exec vitest run <file>`.
- `packages/core` must stay pure: no DB/network/ffmpeg/fs imports; functions take plain data.
- Kids filtering is server-enforced on every new/changed route via `kidsRatingWhere(profile)` from `apps/api/src/lib/catalog-filter.ts` — spread as `...(ratingFilter ?? {})` into the Prisma `where`.
- Never hardcode an absolute API origin in browser code — web calls relative `/api/...` via `apiJson`.
- i18n: every new key must be added to **all 6 locales** (`en, ru, de, es, fr, pt`) under `apps/web/src/locales/<lang>/catalog.json` — a bundle-parity test enforces key-set equality with `en`.
- Do not include `MediaFile.size` (BigInt) in any new payload.
- Run `pnpm lint` per task, not just typecheck+test (lint-only errors hide behind Turbo's cache).
- Commit after each green task. Branch: `lib-view` (already fast-forwarded to `origin/main` @ `c20c576`).
- Playwright e2e only against a throwaway DB (its global-setup wipes accounts/profiles) — task 9 writes the spec; running it is part of task 10's gate against the e2e harness DB, never the populated dev DB.

---

### Task 1: Core — script-bucketed display-title comparator

**Files:**
- Create: `packages/core/src/catalog/alpha-sort.ts`
- Create: `packages/core/src/catalog/alpha-sort.test.ts`
- Modify: `packages/core/src/index.ts` (add export)

**Interfaces:**
- Consumes: nothing (pure, leaf module).
- Produces: `titleScriptBucket(title: string): number` and `compareDisplayTitles(locale: string): (a: string, b: string) => number` — Task 4 (API `sort=alpha`) imports `compareDisplayTitles` from `@orbix/core`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/catalog/alpha-sort.test.ts
import { describe, it, expect } from "vitest";
import { titleScriptBucket, compareDisplayTitles } from "./alpha-sort";

describe("titleScriptBucket", () => {
  it("buckets by the first letter/digit: Latin 0, Cyrillic 1, other scripts 2, digits/symbols 3", () => {
    expect(titleScriptBucket("Alien")).toBe(0);
    expect(titleScriptBucket("Андрей Рублёв")).toBe(1);
    expect(titleScriptBucket("アキラ")).toBe(2);
    expect(titleScriptBucket("1917")).toBe(3);
    expect(titleScriptBucket("···")).toBe(3);
    expect(titleScriptBucket("")).toBe(3);
  });

  it("skips leading whitespace and punctuation", () => {
    expect(titleScriptBucket("«Брат»")).toBe(1);
    expect(titleScriptBucket("'Round Midnight")).toBe(0);
    expect(titleScriptBucket("  #Alive")).toBe(0);
  });
});

describe("compareDisplayTitles", () => {
  const byEn = compareDisplayTitles("en");

  it("orders Latin before Cyrillic before other scripts before digits", () => {
    const titles = ["1917", "Зеркало", "Alien", "アキラ"];
    expect([...titles].sort(byEn)).toEqual(["Alien", "Зеркало", "アキラ", "1917"]);
  });

  it("is case-insensitive and accent-aware within a bucket", () => {
    expect([...["batman", "Alien"]].sort(byEn)).toEqual(["Alien", "batman"]);
    expect([...["Zodiac", "Émilie"]].sort(byEn)).toEqual(["Émilie", "Zodiac"]);
  });

  it("sorts Cyrillic alphabetically within its bucket", () => {
    const ru = compareDisplayTitles("ru");
    expect([...["Сталкер", "Брат", "Ирония судьбы"]].sort(ru)).toEqual([
      "Брат", "Ирония судьбы", "Сталкер",
    ]);
  });

  it("compares numeric titles numerically", () => {
    expect([...["10 Things I Hate About You", "2 Fast 2 Furious"]].sort(byEn)).toEqual([
      "2 Fast 2 Furious", "10 Things I Hate About You",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/catalog/alpha-sort.test.ts`
Expected: FAIL — cannot resolve `./alpha-sort`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/catalog/alpha-sort.ts

/**
 * Script-bucketed alphabetical ordering for the library Browse tab.
 *
 * Titles sort by the script of their first letter/digit (leading whitespace
 * and punctuation skipped; no article stripping): Latin, then Cyrillic, then
 * any other letter script, then digits/symbols/empty last. Buckets are
 * implicit — a catalog with no Cyrillic titles simply has no Cyrillic block.
 */

const FIRST_ALNUM = /[\p{L}\p{N}]/u;

/** Bucket of a display title's first letter/digit; lower buckets sort first. */
export function titleScriptBucket(title: string): number {
  const first = title.match(FIRST_ALNUM)?.[0];
  if (first === undefined) return 3;
  if (/\p{Script=Latin}/u.test(first)) return 0;
  if (/\p{Script=Cyrillic}/u.test(first)) return 1;
  if (/\p{L}/u.test(first)) return 2;
  return 3; // digit
}

/**
 * Comparator factory over display titles: script bucket first, then a
 * case-insensitive, numeric-aware collation in the given locale (the active
 * profile's language — always one of the app's supported language codes).
 */
export function compareDisplayTitles(locale: string): (a: string, b: string) => number {
  const collator = new Intl.Collator([locale, "en"], { sensitivity: "base", numeric: true });
  return (a, b) => titleScriptBucket(a) - titleScriptBucket(b) || collator.compare(a, b);
}
```

- [ ] **Step 4: Export from the core index**

In `packages/core/src/index.ts`, after `export * from "./menu/resolve";` add:

```ts
export * from "./catalog/alpha-sort";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orbix/core exec vitest run src/catalog/alpha-sort.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Lint + typecheck the package**

Run: `pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/catalog/alpha-sort.ts packages/core/src/catalog/alpha-sort.test.ts packages/core/src/index.ts
git commit -m "feat(core): script-bucketed display-title comparator for library browse"
```

---

### Task 2: Core — genre-row grouping

**Files:**
- Create: `packages/core/src/catalog/library-rows.ts`
- Create: `packages/core/src/catalog/library-rows.test.ts`
- Modify: `packages/core/src/index.ts` (add export)

**Interfaces:**
- Consumes: nothing (pure, leaf module).
- Produces (imported by Tasks 3 & 4 from `@orbix/core`):
  - `LIBRARY_ROW_CAP = 24`
  - `interface RatedTitle { id: string; sortTitle: string; imdbRating: number | null; tmdbScore: number | null }`
  - `compareByRating(a: RatedTitle, b: RatedTitle): number`
  - `interface LibraryRowItem extends RatedTitle { genres: { id: number; name: string }[] }`
  - `interface LibraryGenreRow { genreId: number; name: string; total: number; itemIds: string[] }`
  - `buildLibraryGenreRows(items: LibraryRowItem[], cap?: number): LibraryGenreRow[]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/catalog/library-rows.test.ts
import { describe, it, expect } from "vitest";
import { buildLibraryGenreRows, compareByRating, LIBRARY_ROW_CAP } from "./library-rows";

const COMEDY = { id: 35, name: "Comedy" };
const HORROR = { id: 27, name: "Horror" };
const DRAMA = { id: 18, name: "Drama" };

/** Minimal item; ratings default to unrated. */
const item = (
  id: string,
  genres: { id: number; name: string }[],
  ratings: { imdbRating?: number | null; tmdbScore?: number | null } = {},
) => ({
  id,
  sortTitle: id,
  imdbRating: ratings.imdbRating ?? null,
  tmdbScore: ratings.tmdbScore ?? null,
  genres,
});

describe("buildLibraryGenreRows", () => {
  it("groups by genre and orders rows by item count desc, base name asc on ties", () => {
    const rows = buildLibraryGenreRows([
      item("a", [COMEDY, DRAMA]),
      item("b", [COMEDY]),
      item("c", [HORROR]),
    ]);
    // Comedy(2) first; Drama(1) vs Horror(1) tie → Drama before Horror by name
    expect(rows.map((r) => [r.name, r.total])).toEqual([
      ["Comedy", 2], ["Drama", 1], ["Horror", 1],
    ]);
  });

  it("ranks items within a row by imdbRating ?? tmdbScore desc, unrated last, sortTitle tiebreak", () => {
    const rows = buildLibraryGenreRows([
      item("unrated", [COMEDY]),
      item("imdb-low", [COMEDY], { imdbRating: 6.1, tmdbScore: 9.9 }), // imdb wins the coalesce
      item("tmdb-high", [COMEDY], { tmdbScore: 8.2 }),
      item("imdb-high", [COMEDY], { imdbRating: 8.9 }),
    ]);
    expect(rows[0].itemIds).toEqual(["imdb-high", "tmdb-high", "imdb-low", "unrated"]);
  });

  it("caps itemIds at the row cap but reports the full total", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      item(`m${String(i).padStart(2, "0")}`, [COMEDY]),
    );
    const rows = buildLibraryGenreRows(many);
    expect(rows[0].itemIds).toHaveLength(LIBRARY_ROW_CAP);
    expect(rows[0].total).toBe(30);
  });

  it("excludes items with no genres and returns [] for an empty catalog", () => {
    expect(buildLibraryGenreRows([item("nogenre", [])])).toEqual([]);
    expect(buildLibraryGenreRows([])).toEqual([]);
  });
});

describe("compareByRating", () => {
  it("sorts rated desc before unrated, tie by sortTitle", () => {
    const list = [
      { id: "1", sortTitle: "b", imdbRating: null, tmdbScore: null },
      { id: "2", sortTitle: "a", imdbRating: null, tmdbScore: null },
      { id: "3", sortTitle: "c", imdbRating: 7, tmdbScore: null },
    ];
    expect([...list].sort(compareByRating).map((x) => x.id)).toEqual(["3", "2", "1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/catalog/library-rows.test.ts`
Expected: FAIL — cannot resolve `./library-rows`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/catalog/library-rows.ts

/**
 * Genre-grouped rails for the library "Categories" tab.
 *
 * Every genre present in the catalog gets a row, biggest genre first. Rows
 * are capped (the API's "See all" grid serves the remainder) and ranked
 * top-rated-first so each rail reads as a best-of. Pure: takes plain data,
 * the API supplies items and localizes genre names.
 */

export const LIBRARY_ROW_CAP = 24;

export interface RatedTitle {
  id: string;
  sortTitle: string;
  imdbRating: number | null;
  tmdbScore: number | null;
}

/** Rated desc (imdbRating ?? tmdbScore), unrated last, sortTitle then id ties. */
export function compareByRating(a: RatedTitle, b: RatedTitle): number {
  const ra = a.imdbRating ?? a.tmdbScore;
  const rb = b.imdbRating ?? b.tmdbScore;
  if (ra !== null && rb !== null && ra !== rb) return rb - ra;
  if (ra === null && rb !== null) return 1;
  if (ra !== null && rb === null) return -1;
  return a.sortTitle.localeCompare(b.sortTitle) || a.id.localeCompare(b.id);
}

export interface LibraryRowItem extends RatedTitle {
  genres: { id: number; name: string }[];
}

export interface LibraryGenreRow {
  genreId: number;
  /** Base (English) genre name; the API localizes headings per profile. */
  name: string;
  /** Full genre size — itemIds is capped, this is not. */
  total: number;
  itemIds: string[];
}

export function buildLibraryGenreRows(
  items: LibraryRowItem[],
  cap = LIBRARY_ROW_CAP,
): LibraryGenreRow[] {
  const byGenre = new Map<number, { name: string; members: LibraryRowItem[] }>();
  for (const it of items) {
    for (const genre of it.genres) {
      const bucket = byGenre.get(genre.id) ?? { name: genre.name, members: [] };
      bucket.members.push(it);
      byGenre.set(genre.id, bucket);
    }
  }

  return [...byGenre.entries()]
    .map(([genreId, { name, members }]) => ({
      genreId,
      name,
      total: members.length,
      itemIds: [...members].sort(compareByRating).slice(0, cap).map((m) => m.id),
    }))
    .sort(
      (a, b) =>
        b.total - a.total || a.name.localeCompare(b.name) || a.genreId - b.genreId,
    );
}
```

- [ ] **Step 4: Export from the core index**

In `packages/core/src/index.ts`, next to the Task 1 export add:

```ts
export * from "./catalog/library-rows";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orbix/core exec vitest run src/catalog/library-rows.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Full core suite + lint + typecheck**

Run: `pnpm --filter @orbix/core test && pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/catalog/library-rows.ts packages/core/src/catalog/library-rows.test.ts packages/core/src/index.ts
git commit -m "feat(core): genre-row grouping for the library categories tab"
```

---

### Task 3: API — `GET /libraries/:id/rows`

**Files:**
- Modify: `apps/api/src/routes/catalog.ts` (add route after the existing `/libraries/:id/items` handler, i.e. after line 62)
- Create: `apps/api/src/routes/catalog.rows.test.ts`

**Interfaces:**
- Consumes: `buildLibraryGenreRows`, `localizeItem` from `@orbix/core`; `activeProfile`, `kidsRatingWhere` from `../lib/catalog-filter`; `requireAuth` from `../lib/auth` (all already imported in `catalog.ts` except `buildLibraryGenreRows`).
- Produces: `GET /api/libraries/:id/rows` →
  `{ rows: [{ key: "genre:<genreId>", genreId: number, title: string, total: number, items: [{ id, title, year, posterPath, backdropPath, matchState, addedAt }] }] }`
  — consumed by Task 7's `useLibraryRows`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/catalog.rows.test.ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const cookies = { orbix_session: "s1", orbix_profile: "p1" };

function authed(app: any, profile: unknown = { id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null }) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.profile = { findUnique: async () => profile };
  app.prisma.genreTranslation = { findMany: async () => [] };
}

const COMEDY = { id: 35, name: "Comedy" };
const DRAMA = { id: 18, name: "Drama" };

/** Library item as the route's findMany select shapes it. */
const dbItem = (
  id: string,
  genres: { id: number; name: string }[],
  extra: Partial<{ imdbRating: number; tmdbScore: number; translations: { title: string }[] }> = {},
) => ({
  id, title: `Title ${id}`, sortTitle: `title ${id}`, year: 2020,
  posterPath: `poster/${id}.jpg`, backdropPath: `backdrop/${id}.jpg`, matchState: "matched",
  addedAt: new Date("2026-01-01T00:00:00Z"),
  imdbRating: extra.imdbRating ?? null, tmdbScore: extra.tmdbScore ?? null,
  translations: extra.translations ?? [],
  genres: genres.map((genre) => ({ genre })),
});

describe("GET /libraries/:id/rows", () => {
  it("groups a library into count-ordered genre rows with hydrated cards", async () => {
    const app = await buildApp(env);
    authed(app as any);
    let captured: any = {};
    (app as any).prisma.mediaItem = {
      findMany: async (args: any) => {
        captured = args;
        return [
          dbItem("a", [COMEDY, DRAMA], { imdbRating: 6 }),
          dbItem("b", [COMEDY], { imdbRating: 9 }),
          dbItem("c", []),
        ];
      },
    };

    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/rows", cookies });
    expect(res.statusCode).toBe(200);
    expect(captured.where.libraryId).toBe("lib1");
    const { rows } = res.json();
    expect(rows.map((r: any) => [r.key, r.title, r.total])).toEqual([
      ["genre:35", "Comedy", 2],
      ["genre:18", "Drama", 1],
    ]);
    // Top-rated first inside the rail; cards carry box-art fields.
    expect(rows[0].items.map((i: any) => i.id)).toEqual(["b", "a"]);
    expect(rows[0].items[0]).toMatchObject({
      title: "Title b", posterPath: "poster/b.jpg", backdropPath: "backdrop/b.jpg",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    await app.close();
  });

  it("localizes item titles and genre headings for a non-en profile", async () => {
    const app = await buildApp(env);
    authed(app as any, { id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null, language: "ru" });
    (app as any).prisma.mediaItem = {
      findMany: async () => [dbItem("a", [COMEDY], { translations: [{ title: "Тайтл А" }] })],
    };
    (app as any).prisma.genreTranslation = {
      findMany: async () => [{ genreId: 35, name: "Комедии" }],
    };

    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/rows", cookies });
    const { rows } = res.json();
    expect(rows[0].title).toBe("Комедии");
    expect(rows[0].items[0].title).toBe("Тайтл А");
    await app.close();
  });

  it("applies the kids maturity filter to the item query", async () => {
    const app = await buildApp(env);
    authed(app as any, { id: "p1", name: "K", avatar: null, kind: "kids", maturityCap: 2 });
    let captured: any = {};
    (app as any).prisma.mediaItem = {
      findMany: async (args: any) => { captured = args; return []; },
    };

    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/rows", cookies });
    expect(res.statusCode).toBe(200);
    expect(captured.where.rating).toEqual({ in: ["G", "PG", "PG-13"] });
    expect(res.json()).toEqual({ rows: [] });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/catalog.rows.test.ts`
Expected: FAIL — 404s (route not registered).

- [ ] **Step 3: Implement the route**

In `apps/api/src/routes/catalog.ts`, extend the core import (line 2) to:

```ts
import { localizeItem, localizeGenres, localizeName, buildLibraryGenreRows } from "@orbix/core";
```

Then insert after the closing of the `/libraries/:id/items` handler (after line 62):

```ts
  // GET /libraries/:id/rows — genre-grouped rails for the Categories tab.
  // Every genre in the library gets a row (count desc); each rail is the
  // genre's top-rated slice, with `total` sizing the "See all" grid.
  app.get<{ Params: { id: string } }>(
    "/libraries/:id/rows",
    { preHandler: requireAuth(app) },
    async (req) => {
      const profile = await activeProfile(app, req);
      const ratingFilter = kidsRatingWhere(profile);
      const lang = profile?.language ?? "en";

      const items = await app.prisma.mediaItem.findMany({
        where: { libraryId: req.params.id, ...(ratingFilter ?? {}) },
        select: {
          id: true, title: true, sortTitle: true, year: true,
          posterPath: true, backdropPath: true, matchState: true, addedAt: true,
          imdbRating: true, tmdbScore: true,
          translations: { where: { language: lang }, select: { title: true } },
          genres: { select: { genre: { select: { id: true, name: true } } } },
        },
        orderBy: [{ sortTitle: "asc" }, { id: "asc" }],
        take: 2000,
      });

      const rows = buildLibraryGenreRows(
        items.map((it) => ({
          id: it.id, sortTitle: it.sortTitle,
          imdbRating: it.imdbRating, tmdbScore: it.tmdbScore,
          genres: it.genres.map((g) => g.genre),
        })),
      );

      // Genre headings are data-bearing (like home's genre:* rows), so the
      // server owns their localization; base Genre.name is the en fallback.
      let headingByGenreId = new Map<number, string>();
      if (lang !== "en" && rows.length > 0) {
        const trs = await app.prisma.genreTranslation.findMany({
          where: { language: lang, genreId: { in: rows.map((r) => r.genreId) } },
          select: { genreId: true, name: true },
        });
        headingByGenreId = new Map(
          trs.filter((t) => t.name.trim()).map((t) => [t.genreId, t.name]),
        );
      }

      const cardById = new Map(
        items.map((it) => [
          it.id,
          {
            id: it.id,
            title: localizeItem({ title: it.title }, it.translations[0]).title,
            year: it.year,
            posterPath: it.posterPath,
            backdropPath: it.backdropPath,
            matchState: it.matchState,
            addedAt: it.addedAt.toISOString(),
          },
        ]),
      );

      return {
        rows: rows.map((row) => ({
          key: `genre:${row.genreId}`,
          genreId: row.genreId,
          title: headingByGenreId.get(row.genreId) ?? row.name,
          total: row.total,
          items: row.itemIds.map((id) => cardById.get(id)!),
        })),
      };
    },
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/catalog.rows.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint + typecheck + api suite**

Run: `pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api test`
Expected: all green (existing `catalog.test.ts` untouched by this route).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/catalog.ts apps/api/src/routes/catalog.rows.test.ts
git commit -m "feat(api): genre-grouped /libraries/:id/rows endpoint"
```

---

### Task 4: API — extend `GET /libraries/:id/items` (genre filter, alpha + rating sorts, 2000 cap)

**Files:**
- Modify: `apps/api/src/routes/catalog.ts:6-62` (the items handler)
- Create: `apps/api/src/routes/catalog.items-sort.test.ts`

**Interfaces:**
- Consumes: `compareDisplayTitles`, `compareByRating` from `@orbix/core` (Tasks 1–2).
- Produces: `GET /api/libraries/:id/items?sort=title|added|year|alpha|rating&q=&genre=<genreId>` → `MediaCard[]` (shape unchanged: `{ id, title, year, posterPath, matchState }`). `sort=alpha` orders by localized display title with script buckets; `sort=rating` matches the rail order; `genre` filters via the `MediaItemGenre` join. Consumed by Task 7's `useLibraryItems`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/catalog.items-sort.test.ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const cookies = { orbix_session: "s1", orbix_profile: "p1" };

function authed(app: any, profile: unknown = null) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.profile = { findUnique: async () => profile };
}

const dbItem = (
  id: string, title: string,
  extra: Partial<{ imdbRating: number; tmdbScore: number; translations: { title: string }[] }> = {},
) => ({
  id, title, sortTitle: title.toLowerCase(), year: 2020, posterPath: null, matchState: "matched",
  imdbRating: extra.imdbRating ?? null, tmdbScore: extra.tmdbScore ?? null,
  translations: extra.translations ?? [],
});

describe("GET /libraries/:id/items — new sorts and genre filter", () => {
  it("sort=alpha orders by displayed title: Latin, Cyrillic, digits last", async () => {
    const app = await buildApp(env);
    // ru profile: localized titles drive the order
    authed(app as any, { id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null, language: "ru" });
    (app as any).prisma.mediaItem = {
      findMany: async () => [
        dbItem("m1", "1917"),
        dbItem("m2", "Brother", { translations: [{ title: "Брат" }] }),
        dbItem("m3", "Alien"),
      ],
    };
    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/items?sort=alpha", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((i: any) => i.title)).toEqual(["Alien", "Брат", "1917"]);
    await app.close();
  });

  it("sort=rating orders imdb??tmdb desc with unrated last", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.mediaItem = {
      findMany: async () => [
        dbItem("m1", "Unrated"),
        dbItem("m2", "Good", { tmdbScore: 7.5 }),
        dbItem("m3", "Great", { imdbRating: 9 }),
      ],
    };
    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/items?sort=rating", cookies });
    expect(res.json().map((i: any) => i.id)).toEqual(["m3", "m2", "m1"]);
    await app.close();
  });

  it("genre=<id> filters via the genre join; response shape keeps MediaCard fields only", async () => {
    const app = await buildApp(env);
    authed(app as any);
    let captured: any = {};
    (app as any).prisma.mediaItem = {
      findMany: async (args: any) => { captured = args; return [dbItem("m1", "Heat", { imdbRating: 8 })]; },
    };
    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/items?sort=rating&genre=35", cookies });
    expect(res.statusCode).toBe(200);
    expect(captured.where.genres).toEqual({ some: { genreId: 35 } });
    expect(captured.take).toBe(2000);
    expect(res.json()[0]).toEqual({ id: "m1", title: "Heat", year: 2020, posterPath: null, matchState: "matched" });
    await app.close();
  });

  it("rejects a non-integer genre", async () => {
    const app = await buildApp(env);
    authed(app as any);
    const res = await app.inject({ method: "GET", url: "/api/libraries/lib1/items?genre=abc", cookies });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_genre" });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/catalog.items-sort.test.ts`
Expected: FAIL — `sort=alpha` returns 400 `invalid_sort`, `genre=abc` returns 200.

- [ ] **Step 3: Rework the items handler**

Extend the core import in `apps/api/src/routes/catalog.ts` to include the comparators:

```ts
import {
  localizeItem, localizeGenres, localizeName,
  buildLibraryGenreRows, compareDisplayTitles, compareByRating,
} from "@orbix/core";
```

Replace the `/libraries/:id/items` handler body (current lines 8–62) with:

```ts
  // GET /libraries/:id/items?sort=&q=&genre=
  app.get<{
    Params: { id: string };
    Querystring: { sort?: string; q?: string; genre?: string };
  }>(
    "/libraries/:id/items",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const { id } = req.params;
      const sort = req.query.sort ?? "title";
      const q = req.query.q?.trim();

      const allowedSorts = ["title", "added", "year", "alpha", "rating"];
      if (!allowedSorts.includes(sort)) {
        return reply.code(400).send({ error: "invalid_sort" });
      }
      let genreId: number | undefined;
      if (req.query.genre !== undefined) {
        genreId = Number(req.query.genre);
        if (!Number.isInteger(genreId)) {
          return reply.code(400).send({ error: "invalid_genre" });
        }
      }

      // alpha/rating sort in-memory below; the DB keeps a deterministic
      // sortTitle order so the item cap truncates stably.
      const orderBy =
        sort === "added"
          ? [{ addedAt: "desc" as const }]
          : sort === "year"
          ? [{ year: "desc" as const }]
          : [{ sortTitle: "asc" as const }];

      const profile = await activeProfile(app, req);
      const ratingFilter = kidsRatingWhere(profile);
      const lang = profile?.language ?? "en";

      // NOTE: the `q` filter matches the base (en) title only; localized-title
      // search is a deliberate Phase-2 follow-up, not required here.
      const items = await app.prisma.mediaItem.findMany({
        where: {
          libraryId: id,
          ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
          ...(genreId !== undefined ? { genres: { some: { genreId } } } : {}),
          ...(ratingFilter ?? {}),
        },
        select: {
          id: true,
          title: true,
          sortTitle: true,
          year: true,
          posterPath: true,
          matchState: true,
          imdbRating: true,
          tmdbScore: true,
          translations: { where: { language: lang }, select: { title: true } },
        },
        orderBy,
        take: 2000,
      });

      // Coalesce title → requested-language translation, else base; the
      // sort fields stay behind — the response is plain MediaCards.
      const enriched = items.map(({ translations, sortTitle, imdbRating, tmdbScore, ...rest }) => ({
        sortTitle,
        imdbRating,
        tmdbScore,
        card: { ...rest, title: localizeItem({ title: rest.title }, translations[0]).title },
      }));

      if (sort === "alpha") {
        // Browse order: script-bucketed A→Z/А→Я over the *displayed* title.
        const cmp = compareDisplayTitles(lang);
        enriched.sort((a, b) => cmp(a.card.title, b.card.title) || a.sortTitle.localeCompare(b.sortTitle));
      } else if (sort === "rating") {
        enriched.sort((a, b) => compareByRating({ id: a.card.id, ...a }, { id: b.card.id, ...b }));
      }

      return enriched.map((e) => e.card);
    },
  );
```

- [ ] **Step 4: Run the new + existing catalog tests**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/catalog.items-sort.test.ts src/routes/catalog.test.ts src/routes/catalog.localize.test.ts`
Expected: all PASS (the existing tests' mocked rows lack `sortTitle`/`imdbRating`/`tmdbScore` fields — destructuring them off yields `undefined`, which the default `title` sort never touches; if a pre-existing assertion compares full response objects and now fails on an extra/missing key, align the mock rows with the new select instead of changing the route).

- [ ] **Step 5: Lint + typecheck + full api suite**

Run: `pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/catalog.ts apps/api/src/routes/catalog.items-sort.test.ts
git commit -m "feat(api): genre filter + alpha/rating sorts on library items"
```

---

### Task 5: UI — `Tabs` primitive in `@orbix/ui`

**Files:**
- Create: `packages/ui/src/components/Tabs.tsx`
- Modify: `packages/ui/src/index.ts` (add export)

**Interfaces:**
- Consumes: `cn` from `../cn`, `focusRing` from `../styles`.
- Produces: `Tabs({ tabs: { value: string; label: string }[], value: string, onValueChange: (next: string) => void, className?, "aria-label"? })` — a controlled, panel-less tab strip. Task 8's `LibraryPage` consumes it; its behavior is covered by `LibraryPage.test.tsx` (the `@orbix/ui` package has no test runner — `pnpm test` covers core/api/config/web only).

- [ ] **Step 1: Write the component**

```tsx
// packages/ui/src/components/Tabs.tsx
import { useRef, type KeyboardEvent } from "react";
import { cn } from "../cn";
import { focusRing } from "../styles";

export interface TabItem {
  value: string;
  label: string;
}

type Props = {
  tabs: TabItem[];
  value: string;
  onValueChange: (next: string) => void;
  className?: string;
  "aria-label"?: string;
};

/**
 * Controlled tab strip (role="tablist") with roving focus and Left/Right
 * arrow activation. Panels live with the caller: render the active panel
 * with `role="tabpanel"` and `aria-labelledby={`tab-${value}`}`.
 */
export function Tabs({ tabs, value, onValueChange, className, ...aria }: Props) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const next = (idx + dir + tabs.length) % tabs.length;
    onValueChange(tabs[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      {...aria}
      className={cn(
        "flex w-fit gap-1 rounded-[var(--radius)] bg-[var(--surface)] p-1",
        className,
      )}
    >
      {tabs.map((tab, idx) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${tab.value}`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(tab.value)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={cn(
              "rounded-[var(--radius-sm)] px-4 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-[var(--surface-3)] text-[var(--text)]"
                : "text-[var(--text-dim)] hover:text-[var(--text)]",
              focusRing,
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Export it**

In `packages/ui/src/index.ts`, after the `Toggle` export add:

```ts
export * from "./components/Tabs";
```

- [ ] **Step 3: Lint + typecheck**

Run: `pnpm --filter @orbix/ui lint && pnpm --filter @orbix/ui typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/Tabs.tsx packages/ui/src/index.ts
git commit -m "feat(ui): accessible Tabs primitive"
```

---

### Task 6: Web — `MediaRow` header action slot

**Files:**
- Modify: `apps/web/src/components/MediaRow.tsx:9-14` (props) and `:70-72` (heading)
- Modify: `apps/web/src/components/MediaRow.test.tsx` (add one test)

**Interfaces:**
- Consumes: existing `MediaRow` internals (unchanged otherwise).
- Produces: optional `action?: ReactNode` prop rendered right-aligned next to the heading. Task 8's Categories tab passes a "See all" `Link`. All existing call sites (`HomeRows.tsx`) pass no `action` and are unaffected.

- [ ] **Step 1: Add the failing test**

Append to the `describe("MediaRow", ...)` block in `apps/web/src/components/MediaRow.test.tsx`:

```tsx
  it("renders an optional right-aligned header action", () => {
    renderWithProviders(
      <MediaRow title="Drama" items={items} action={<a href="/library/l1?genre=18">See all (9)</a>} />,
    );
    expect(screen.getByRole("link", { name: "See all (9)" }).getAttribute("href")).toBe(
      "/library/l1?genre=18",
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/web exec vitest run src/components/MediaRow.test.tsx`
Expected: the new test FAILS (unknown `action` prop is ignored, link not found); existing tests pass.

- [ ] **Step 3: Implement the slot**

In `apps/web/src/components/MediaRow.tsx` — extend the props (lines 9–14):

```tsx
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
```

```tsx
interface MediaRowProps {
  title: string;
  /** Stable home-row key from the API, used to localize the heading. */
  rowKey?: string;
  items: HomeCard[];
  /** Optional right-aligned header control (e.g. a "See all" link). */
  action?: ReactNode;
}
```

Update the destructuring on line 34:

```tsx
export default function MediaRow({ title, rowKey, items, action }: MediaRowProps) {
```

Replace the `<h2>` (lines 70–72) with:

```tsx
      <div className="mb-2 flex items-baseline justify-between gap-4 px-[4vw]">
        <h2 className="text-base font-semibold text-[var(--text)] md:text-xl">{heading}</h2>
        {action}
      </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/web exec vitest run src/components/MediaRow.test.tsx`
Expected: PASS (all tests, including the pre-existing heading assertions).

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm --filter @orbix/web lint && pnpm --filter @orbix/web typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/MediaRow.tsx apps/web/src/components/MediaRow.test.tsx
git commit -m "feat(web): optional header action slot on MediaRow"
```

---

### Task 7: Web — data layer + i18n keys

**Files:**
- Modify: `apps/web/src/lib/types.ts` (add `LibraryRow`)
- Modify: `apps/web/src/lib/queries.ts:29-39` (`useLibraryItems` genre param; add `useLibraryRows`)
- Modify: `apps/web/src/locales/{en,ru,de,es,fr,pt}/catalog.json` (add `library.*`, drop `browse.sort.*`)

**Interfaces:**
- Consumes: Task 3's `/rows` response, Task 4's items params.
- Produces (consumed by Task 8):
  - `interface LibraryRow { key: string; genreId: number; title: string; total: number; items: HomeCard[] }` in `types.ts`
  - `useLibraryRows(libraryId: string | undefined)` → query of `{ rows: LibraryRow[] }`, key `["library-rows", libraryId]`
  - `useLibraryItems(libraryId: string | undefined, sort: string, q: string, genreId?: number)` → `MediaCard[]`, key `["library-items", libraryId, sort, q, genreId ?? null]`
  - i18n keys: `catalog:library.tabs.categories`, `catalog:library.tabs.browse`, `catalog:library.seeAll` (uses `{{total}}` — deliberately NOT `count`, avoiding i18next plural-suffix resolution), `catalog:library.back`, `catalog:library.emptyCategories`

- [ ] **Step 1: Add the `LibraryRow` type**

In `apps/web/src/lib/types.ts`, after the `HomeRow` interface (line 113) add:

```ts
/** One genre rail on the library Categories tab. */
export interface LibraryRow {
  key: string;
  genreId: number;
  title: string;
  total: number;
  items: HomeCard[];
}
```

- [ ] **Step 2: Update the hooks**

In `apps/web/src/lib/queries.ts`, add `LibraryRow` to the type import list, then replace `useLibraryItems` (lines 29–39) with:

```ts
export function useLibraryItems(
  libraryId: string | undefined,
  sort: string,
  q: string,
  genreId?: number,
) {
  return useQuery({
    queryKey: ["library-items", libraryId, sort, q, genreId ?? null],
    enabled: !!libraryId,
    queryFn: () => {
      const qs = new URLSearchParams({ sort });
      if (q) qs.set("q", q);
      if (genreId != null) qs.set("genre", String(genreId));
      return apiJson<MediaCard[]>(`/libraries/${libraryId}/items?${qs}`);
    },
  });
}

/** Genre rails for the library Categories tab. */
export function useLibraryRows(libraryId: string | undefined) {
  return useQuery({
    queryKey: ["library-rows", libraryId],
    enabled: !!libraryId,
    queryFn: () => apiJson<{ rows: LibraryRow[] }>(`/libraries/${libraryId}/rows`),
  });
}
```

- [ ] **Step 3: Update all 6 locale files**

In each `apps/web/src/locales/<lang>/catalog.json`: **delete the `browse.sort` object** (the UI dropdown is gone; `browse.title`, `browse.searchPlaceholder`, `browse.empty` stay) and **add a `library` block** after `browse`:

`en`:
```json
  "library": {
    "tabs": { "categories": "Categories", "browse": "Browse" },
    "seeAll": "See all ({{total}})",
    "back": "Back to categories",
    "emptyCategories": "No categories yet — titles appear here once they have genre info. See the Browse tab for everything."
  }
```

`ru`:
```json
  "library": {
    "tabs": { "categories": "Категории", "browse": "Обзор" },
    "seeAll": "Показать все ({{total}})",
    "back": "Назад к категориям",
    "emptyCategories": "Категорий пока нет — тайтлы появятся здесь, когда у них будет информация о жанрах. Всё содержимое — во вкладке «Обзор»."
  }
```

`de`:
```json
  "library": {
    "tabs": { "categories": "Kategorien", "browse": "Durchsuchen" },
    "seeAll": "Alle anzeigen ({{total}})",
    "back": "Zurück zu den Kategorien",
    "emptyCategories": "Noch keine Kategorien — Titel erscheinen hier, sobald sie Genre-Informationen haben. Im Tab „Durchsuchen“ sehen Sie alles."
  }
```

`es`:
```json
  "library": {
    "tabs": { "categories": "Categorías", "browse": "Explorar" },
    "seeAll": "Ver todo ({{total}})",
    "back": "Volver a categorías",
    "emptyCategories": "Aún no hay categorías: los títulos aparecerán aquí cuando tengan información de género. En la pestaña Explorar está todo."
  }
```

`fr`:
```json
  "library": {
    "tabs": { "categories": "Catégories", "browse": "Parcourir" },
    "seeAll": "Tout afficher ({{total}})",
    "back": "Retour aux catégories",
    "emptyCategories": "Pas encore de catégories — les titres apparaissent ici dès qu'ils ont des informations de genre. L'onglet Parcourir montre tout."
  }
```

`pt`:
```json
  "library": {
    "tabs": { "categories": "Categorias", "browse": "Explorar" },
    "seeAll": "Ver tudo ({{total}})",
    "back": "Voltar às categorias",
    "emptyCategories": "Ainda sem categorias — os títulos aparecem aqui quando tiverem informação de gênero. Veja a aba Explorar para ver tudo."
  }
```

- [ ] **Step 4: Verify parity + typecheck**

Run: `pnpm --filter @orbix/web test && pnpm --filter @orbix/web typecheck`
Expected: bundle-parity i18n test green; typecheck green. (`LibraryPage.tsx` still compiles — its 3-arg `useLibraryItems` call stays valid — but its sort dropdown now references deleted `browse.sort.*` keys; that UI is replaced in Task 8, and missing-key rendering isn't asserted by any test.)

Note: if `pnpm --filter @orbix/web test` fails here on `browse.sort` key-parity only when a *subset* of locales was edited, re-check that the `sort` block was removed from **all six** files.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/locales
git commit -m "feat(web): library rows/items data hooks + tab i18n keys"
```

---

### Task 8: Web — LibraryPage rework (Categories / Browse / GenreGrid)

**Files:**
- Create: `apps/web/src/components/library/CategoriesTab.tsx`
- Create: `apps/web/src/components/library/BrowseTab.tsx`
- Create: `apps/web/src/components/library/GenreGridView.tsx`
- Rewrite: `apps/web/src/pages/LibraryPage.tsx`
- Create: `apps/web/src/pages/LibraryPage.test.tsx`

**Interfaces:**
- Consumes: `Tabs` from `@orbix/ui` (Task 5), `MediaRow` `action` prop (Task 6), `useLibraryRows` / `useLibraryItems` / `useMenu` (Task 7), `PosterCard`, `Skeleton`, `Input`, i18n keys (Task 7).
- Produces: the final `/library/:libraryId` UX. URL contract: no params = Categories; `?tab=browse` = Browse; `?genre=<id>` = genre grid (Categories drill-in). Task 9's e2e asserts against this contract.

- [ ] **Step 1: Write the failing page test**

```tsx
// apps/web/src/pages/LibraryPage.test.tsx
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import LibraryPage from "./LibraryPage";
import type { LibraryRow, MediaCard } from "@/lib/types";

const rows: LibraryRow[] = [
  {
    key: "genre:35", genreId: 35, title: "Comedy", total: 30,
    items: [{ id: "c1", title: "Funny One", year: 2020, posterPath: "poster/c1.jpg", backdropPath: null }],
  },
  {
    key: "genre:18", genreId: 18, title: "Drama", total: 2,
    items: [{ id: "d1", title: "Sad One", year: 2019, posterPath: "poster/d1.jpg", backdropPath: null }],
  },
];

const alphaItems: MediaCard[] = [
  { id: "a1", title: "Alien", year: 1979, posterPath: "poster/a1.jpg" },
  { id: "b1", title: "Брат", year: 1997, posterPath: "poster/b1.jpg" },
];

const comedyItems: MediaCard[] = [
  { id: "c1", title: "Funny One", year: 2020, posterPath: "poster/c1.jpg" },
];

function setup(route: string) {
  const client = makeClient();
  client.setQueryData(["menu"], { items: [{ libraryId: "lib1", name: "Movies" }] });
  client.setQueryData(["library-rows", "lib1"], { rows });
  client.setQueryData(["library-items", "lib1", "alpha", "", null], alphaItems);
  client.setQueryData(["library-items", "lib1", "rating", "", 35], comedyItems);
  return renderWithProviders(
    <Routes>
      <Route path="/library/:libraryId" element={<LibraryPage />} />
    </Routes>,
    { route, client },
  );
}

describe("LibraryPage", () => {
  it("defaults to the Categories tab: library-name heading + genre rails with See-all links", () => {
    setup("/library/lib1");
    expect(screen.getByRole("heading", { name: "Movies", level: 1 })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Categories", selected: true })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Comedy" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Drama" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "See all (30)" }).getAttribute("href")).toBe(
      "/library/lib1?genre=35",
    );
  });

  it("?tab=browse renders the flat alphabetical grid with search, no rails", () => {
    setup("/library/lib1?tab=browse");
    expect(screen.getByRole("tab", { name: "Browse", selected: true })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search titles…")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Alien/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Брат/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Comedy" })).toBeNull();
  });

  it("?genre=35 renders the See-all grid with genre heading and a back link", () => {
    setup("/library/lib1?genre=35");
    expect(screen.getByRole("heading", { name: "Comedy", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Back to categories/ }).getAttribute("href")).toBe(
      "/library/lib1",
    );
    expect(screen.getByRole("link", { name: /Funny One/ })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/web exec vitest run src/pages/LibraryPage.test.tsx`
Expected: FAIL (no tabs/rails in the old page).

- [ ] **Step 3: Create the three tab components**

```tsx
// apps/web/src/components/library/CategoriesTab.tsx
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { cn, focusRing, Skeleton } from "@orbix/ui";
import MediaRow from "@/components/MediaRow";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import { useLibraryRows } from "@/lib/queries";

/** Genre rails (all genres, biggest first) with a See-all drill-in per row. */
export default function CategoriesTab({ libraryId }: { libraryId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useLibraryRows(libraryId);
  const rows = data?.rows ?? [];

  if (isLoading) {
    return (
      <div className="flex flex-col gap-8">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="px-[4vw]">
            <Skeleton className="mb-3 h-6 w-40" rounded="sm" />
            <div className="flex gap-2 overflow-hidden">
              {Array.from({ length: 6 }).map((_, j) => (
                <Skeleton key={j} className="aspect-video w-[44vw] shrink-0 sm:w-[30vw] md:w-[23.5vw] lg:w-[19vw] xl:w-[15.5vw]" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="px-[4vw] text-sm text-red-400">
        {errorMessage(error instanceof ApiError ? error.code : undefined, t)}
      </p>
    );
  }

  if (rows.length === 0) {
    return <p className="px-[4vw] text-[var(--text-dim)]">{t("catalog:library.emptyCategories")}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {rows.map((row) => (
        <MediaRow
          key={row.key}
          title={row.title}
          items={row.items}
          action={
            <Link
              to={`/library/${libraryId}?genre=${row.genreId}`}
              className={cn(
                "shrink-0 text-sm text-[var(--text-dim)] transition-colors hover:text-[var(--text)]",
                focusRing,
              )}
            >
              {t("catalog:library.seeAll", { total: row.total })}
            </Link>
          }
        />
      ))}
    </div>
  );
}
```

```tsx
// apps/web/src/components/library/BrowseTab.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input, Skeleton } from "@orbix/ui";
import PosterCard from "@/components/PosterCard";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import { useLibraryItems } from "@/lib/queries";

/** Flat A→Z/А→Я poster grid over the whole library, with title search. */
export default function BrowseTab({ libraryId }: { libraryId: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const { data: items = [], isLoading, error } = useLibraryItems(libraryId, "alpha", q);

  return (
    <div className="px-6 md:px-8 lg:px-10">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("catalog:browse.searchPlaceholder")}
        className="mb-6 max-w-xs"
      />

      {error && (
        <p className="mb-4 text-sm text-red-400">
          {errorMessage(error instanceof ApiError ? error.code : undefined, t)}
        </p>
      )}
      {!isLoading && items.length === 0 && (
        <p className="text-[var(--text-dim)]">{t("catalog:browse.empty")}</p>
      )}

      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 md:gap-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
        {isLoading
          ? Array.from({ length: 21 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="aspect-[2/3] w-full" />
                <Skeleton className="h-4 w-3/4" rounded="sm" />
              </div>
            ))
          : items.map((item) => <PosterCard key={item.id} item={item} />)}
      </div>
    </div>
  );
}
```

```tsx
// apps/web/src/components/library/GenreGridView.tsx
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { cn, focusRing, Skeleton } from "@orbix/ui";
import PosterCard from "@/components/PosterCard";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/i18n/tError";
import { useLibraryItems, useLibraryRows } from "@/lib/queries";

/** "See all" drill-in for one genre: full grid, rail order (top-rated first). */
export default function GenreGridView({ libraryId, genreId }: { libraryId: string; genreId: number }) {
  const { t } = useTranslation();
  // Row metadata (localized heading) comes from the rows query — already
  // cached when arriving via a rail, fetched fresh on a deep link.
  const { data: rowsData } = useLibraryRows(libraryId);
  const row = rowsData?.rows.find((r) => r.genreId === genreId);
  const { data: items = [], isLoading, error } = useLibraryItems(libraryId, "rating", "", genreId);

  return (
    <main className="px-6 py-8 md:px-8 lg:px-10">
      <Link
        to={`/library/${libraryId}`}
        className={cn(
          "mb-4 inline-block text-sm text-[var(--text-dim)] transition-colors hover:text-[var(--text)]",
          focusRing,
        )}
      >
        ← {t("catalog:library.back")}
      </Link>
      <h1 className="mb-6 text-3xl font-bold text-[var(--text)]">{row?.title ?? ""}</h1>

      {error && (
        <p className="mb-4 text-sm text-red-400">
          {errorMessage(error instanceof ApiError ? error.code : undefined, t)}
        </p>
      )}
      {!isLoading && items.length === 0 && (
        <p className="text-[var(--text-dim)]">{t("catalog:browse.empty")}</p>
      )}

      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 md:gap-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
        {isLoading
          ? Array.from({ length: 14 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="aspect-[2/3] w-full" />
                <Skeleton className="h-4 w-3/4" rounded="sm" />
              </div>
            ))
          : items.map((item) => <PosterCard key={item.id} item={item} />)}
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Rewrite the page**

```tsx
// apps/web/src/pages/LibraryPage.tsx
import { useParams, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Tabs } from "@orbix/ui";
import BrowseTab from "@/components/library/BrowseTab";
import CategoriesTab from "@/components/library/CategoriesTab";
import GenreGridView from "@/components/library/GenreGridView";
import { useMenu } from "@/lib/queries";

/**
 * Library viewing page: Categories (auto genre rails) / Browse (flat A→Z
 * grid). URL contract: default = Categories, `?tab=browse` = Browse,
 * `?genre=<id>` = one genre's See-all grid.
 */
export default function LibraryPage() {
  const { t } = useTranslation();
  const { libraryId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: menu } = useMenu();

  if (!libraryId) return null;

  const genreParam = searchParams.get("genre");
  const genreId = genreParam && /^\d+$/.test(genreParam) ? Number(genreParam) : null;
  if (genreId != null) {
    return <GenreGridView libraryId={libraryId} genreId={genreId} />;
  }

  const tab = searchParams.get("tab") === "browse" ? "browse" : "categories";
  const libraryName = menu?.items.find((m) => m.libraryId === libraryId)?.name;

  return (
    <main className="py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 px-6 md:px-8 lg:px-10">
        <h1 className="text-3xl font-bold text-[var(--text)]">
          {libraryName ?? t("catalog:browse.title")}
        </h1>
        <Tabs
          aria-label={t("catalog:browse.title")}
          tabs={[
            { value: "categories", label: t("catalog:library.tabs.categories") },
            { value: "browse", label: t("catalog:library.tabs.browse") },
          ]}
          value={tab}
          onValueChange={(next) =>
            setSearchParams(next === "browse" ? { tab: "browse" } : {})
          }
        />
      </div>

      {tab === "categories" ? (
        <CategoriesTab libraryId={libraryId} />
      ) : (
        <BrowseTab libraryId={libraryId} />
      )}
    </main>
  );
}
```

- [ ] **Step 5: Run the page test**

Run: `pnpm --filter @orbix/web exec vitest run src/pages/LibraryPage.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Full web suite + lint + typecheck + build**

Run: `pnpm --filter @orbix/web test && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/LibraryPage.tsx apps/web/src/pages/LibraryPage.test.tsx apps/web/src/components/library
git commit -m "feat(web): library page Categories/Browse tabs with genre see-all grid"
```

---

### Task 9: E2E — update `library.spec.ts` for the tabbed layout

**Files:**
- Modify: `apps/web/e2e/library.spec.ts` (seed a genre; retarget the grid test to Browse; add a Categories rail test)

**Interfaces:**
- Consumes: Task 8's URL contract (`?tab=browse`, default Categories) and Task 3's rows payload; the seeded genre must clear the rail (any non-empty genre gets a row — no minimum).
- Produces: e2e coverage of both tabs. Runs only against the throwaway e2e DB in Task 10.

- [ ] **Step 1: Seed a genre**

In `seedDb()` (after the `prisma.library.create` call, before the poster write) add:

```ts
  // Genre rail seed: the Categories tab only rows items that carry a genre.
  const genre = await prisma.genre.upsert({
    where: { name: "Drama" },
    update: {},
    create: { tmdbId: 18, name: "Drama" },
  });
  await prisma.mediaItemGenre.create({
    data: { mediaItemId: ITEM_ID, genreId: genre.id },
  });
```

In `cleanDb()` add after the `mediaItem.deleteMany` + `library.deleteMany` lines (join rows cascade with the item):

```ts
  await prisma.genre.deleteMany({ where: { name: "Drama" } });
```

- [ ] **Step 2: Update the grid test + add the Categories test**

Replace the `"library grid shows seeded movie"` test with:

```ts
  test("categories tab shows a genre rail with the seeded movie", async ({ page }) => {
    await doOnboarding(page);
    await page.goto(`http://localhost:1060/library/${LIBRARY_ID}`);
    await expect(page.getByRole("heading", { name: "Drama" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: /Seeded Movie/ })).toBeVisible();
    // See-all drill-in renders the genre grid
    await page.getByRole("link", { name: /See all/ }).click();
    await expect(page.getByRole("heading", { name: "Drama", level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: /Seeded Movie/ })).toBeVisible();
  });

  test("browse tab shows the seeded movie in the flat grid", async ({ page }) => {
    await doOnboarding(page);
    await page.goto(`http://localhost:1060/library/${LIBRARY_ID}?tab=browse`);
    await expect(page.getByRole("link", { name: /Seeded Movie/ })).toBeVisible({ timeout: 15_000 });
  });
```

(The `"title detail shows overview"` test stays unchanged.)

- [ ] **Step 3: Typecheck + lint the spec**

Run: `pnpm --filter @orbix/web lint && pnpm --filter @orbix/web typecheck`
Expected: clean. (Execution happens in Task 10 against the throwaway DB.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/library.spec.ts
git commit -m "test(e2e): cover library categories + browse tabs"
```

---

### Task 10: Gates + runtime verification

**Files:** none new — verification only.

**Interfaces:**
- Consumes: everything above.
- Produces: green gates + a live smoke of both tabs (en + ru), per the repo verify recipe.

- [ ] **Step 1: Full monorepo gates**

Run from the repo root:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all four green. Fix anything red before proceeding (lint runs per package; don't rely on Turbo cache from earlier scoped runs).

- [ ] **Step 2: E2E against the throwaway DB**

Follow the repo's e2e harness workflow (`pnpm --filter @orbix/web test:e2e` with postgres+redis up, throwaway `DATABASE_URL` — **never** the populated dev DB; the global-setup wipes accounts/profiles). Run at minimum `library.spec.ts`.
Expected: library spec green (2 tab tests + title detail).

- [ ] **Step 3: Runtime verify (repo skill)**

Invoke the repo's committed verify recipe (`.claude/skills/verify/SKILL.md`) to smoke the real flow against a dev stack: log in, open a library →
1. Categories tab default: genre rails render, biggest genre first, localized headings under a ru-language profile ("Комедии" etc.).
2. "See all" opens the genre grid, top-rated first, back link returns.
3. Browse tab: flat grid ordered Latin → Cyrillic → digits by displayed title; search still filters.
4. Kids profile: rails/grids exclude disallowed titles.

Expected: all four observed live. Reap host dev servers afterwards (`pkill -f "tsx.*watch src/server.ts"; pkill -f vite`).

- [ ] **Step 4: Final commit (if verification produced fixes)**

```bash
git status   # commit any fixes with their own focused messages
```

Then invoke `superpowers:finishing-a-development-branch` to decide merge/PR.
