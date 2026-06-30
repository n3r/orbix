# Phase 1 — Cinematic Title Page + Similar Rail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the constrained `/title/:id` page with a full-width, Netflix-style cinematic layout, and add a kids-filtered `GET /items/:id/similar` endpoint feeding a "More Like This" rail.

**Architecture:** Backend adds one read endpoint reusing the existing pgvector ranking (with `itemSimilarity` Jaccard fallback) and the `catalog-filter` kids gate. Frontend decomposes `TitlePage` into focused presentational components (`TitleHero`, `RatingBadges`, `SimilarRail`) wired with TanStack Query. New optional fields (`kind`, `logoPath`, ratings, `seasons`) are added to the detail type now so later phases light them up with zero UI churn.

**Tech Stack:** Fastify + Prisma (raw `$queryRaw` for pgvector), React 19 + React Router v8 + TanStack Query, Tailwind v4, Vitest + @testing-library/react.

## Global Constraints

- `packages/core` stays pure — no DB/network/fs/ffmpeg imports. (Phase 1 adds no core code.)
- Kids filtering is server-enforced: the similar endpoint MUST apply `kidsRatingWhere` / exclude the anchor and drop blocked titles.
- `MediaFile.size` is `BigInt` → `.toString()` before JSON (not returned by similar; relevant only if touching `/items/:id`).
- The SPA only calls relative `/api/...` via `apiJson`/`apiFetch` (`credentials: include`). Never hardcode an origin.
- Design tokens: `--bg #0b0d12`, `--surface #14171f`, `--surface-2 #1c212b`, `--text #e8eaf0`, `--text-dim #9aa3b2`, `--accent #6d7bff`, `--accent-2 #a06dff`, `--radius 12px`, `--radius-sm 8px`. Keep the existing accent (not Netflix red).
- Gates before declaring done: `pnpm typecheck && pnpm lint && pnpm test`.

---

## File Structure

- **Create** `apps/api/src/routes/similar.ts` — `GET /items/:id/similar` route plugin.
- **Create** `apps/api/src/routes/similar.test.ts` — route tests (kids filter, anchor exclusion, fallback).
- **Modify** `apps/api/src/app.ts` — register `similarRoute` under `/api`.
- **Modify** `apps/api/src/routes/catalog.ts:120-145` — add `kind` to `GET /items/:id` response.
- **Modify** `apps/web/src/lib/types.ts` — add `TitleDetail`, `EpisodeCard`, `SeasonSummary`, `Ratings` types.
- **Create** `apps/web/src/components/RatingBadges.tsx` — IMDb/RT/TMDB/MPAA chips (renders only present values).
- **Create** `apps/web/src/components/RatingBadges.test.tsx`
- **Create** `apps/web/src/components/TitleHero.tsx` — full-bleed hero (backdrop, logo/type, meta, synopsis, actions).
- **Create** `apps/web/src/components/SimilarRail.tsx` — fetches `/items/:id/similar` → `MediaRow`.
- **Modify** `apps/web/src/pages/TitlePage.tsx` — recompose into full-width layout using the above.

---

### Task 1: `GET /items/:id/similar` endpoint

**Files:**
- Create: `apps/api/src/routes/similar.ts`
- Create: `apps/api/src/routes/similar.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `requireAuth` (`../lib/auth`), `activeProfile`, `kidsRatingWhere`, `profileAllowsItem` (`../lib/catalog-filter`), `itemSimilarity` (`@orbix/core`), `embedText`, `EmbedderUnavailable` (`../discovery/embedder.js`), `Prisma` (`@orbix/db`).
- Produces: route `GET /items/:id/similar` → `{ items: MediaCard[] }` where `MediaCard = { id, title, year, posterPath, matchState }`. Returns `404 {error:"not_found"}` if the anchor is missing or blocked for the profile. Up to 12 items, anchor excluded.

- [ ] **Step 1: Write failing tests** in `apps/api/src/routes/similar.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", EMBEDDINGS_ENABLED: true,
};

function authed(app: any, profile: any) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.profile = { findUnique: async () => profile };
}

const anchor = {
  id: "a", title: "Anchor", year: 2020, rating: "PG-13", posterPath: null, matchState: "matched",
  genres: [{ genre: { name: "Action" } }], keywords: [], credits: [],
};
const other = {
  id: "b", title: "Other", year: 2021, rating: "PG-13", posterPath: "poster/b.jpg", matchState: "matched",
  genres: [{ genre: { name: "Action" } }], keywords: [], credits: [],
};

describe("GET /items/:id/similar", () => {
  it("returns 404 when the anchor item does not exist", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", kind: "standard", maturityCap: null });
    (app as any).prisma.mediaItem = { findUnique: async () => null };
    const res = await app.inject({ method: "GET", url: "/api/items/missing/similar", cookies: { orbix_session: "s1", orbix_profile: "p1" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("excludes the anchor and ranks the rest (keyword/Jaccard fallback path)", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", kind: "standard", maturityCap: null });
    (app as any).prisma.mediaItem = {
      findUnique: async () => anchor,
      findMany: async () => [anchor, other],
    };
    // Force the embeddings path to degrade by making $queryRaw throw EmbedderUnavailable-like:
    (app as any).prisma.$queryRaw = async () => { throw new Error("no embeddings"); };
    const res = await app.inject({ method: "GET", url: "/api/items/a/similar", cookies: { orbix_session: "s1", orbix_profile: "p1" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(["b"]);
    await app.close();
  });

  it("returns 404 for a kids profile when the anchor exceeds the cap", async () => {
    const app = await buildApp(env);
    authed(app, { id: "p1", kind: "kids", maturityCap: 1 }); // cap below PG-13
    (app as any).prisma.mediaItem = { findUnique: async () => anchor };
    const res = await app.inject({ method: "GET", url: "/api/items/a/similar", cookies: { orbix_session: "s1", orbix_profile: "p1" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/similar.test.ts`
Expected: FAIL (route not registered → 404 for the success case too, or 500).

- [ ] **Step 3: Implement** `apps/api/src/routes/similar.ts`

```typescript
import type { FastifyInstance } from "fastify";
import { itemSimilarity } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { activeProfile, kidsRatingWhere, profileAllowsItem } from "../lib/catalog-filter";
import { embedText, EmbedderUnavailable } from "../discovery/embedder.js";
import { Prisma } from "@orbix/db";

const LIMIT = 12;

interface Card {
  id: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  matchState: string;
}

const itemSelect = {
  id: true, title: true, year: true, posterPath: true, matchState: true, rating: true,
  overview: true,
  genres: { select: { genre: { select: { name: true } } } },
  keywords: { select: { keyword: { select: { name: true } } } },
  credits: {
    select: { role: true, department: true, order: true, person: { select: { name: true } } },
    orderBy: { order: "asc" as const },
  },
};

function toFeatures(item: any) {
  return {
    genres: item.genres.map((g: any) => g.genre.name),
    keywords: item.keywords.map((k: any) => k.keyword.name),
    cast: item.credits.filter((c: any) => c.department === "cast").slice(0, 10).map((c: any) => c.person.name),
    director: item.credits.find((c: any) => c.department === "crew" && c.role === "Director")?.person.name,
  };
}

function toCard(item: any): Card {
  return { id: item.id, title: item.title, year: item.year, posterPath: item.posterPath, matchState: item.matchState };
}

export default async function similarRoute(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/items/:id/similar",
    { preHandler: requireAuth(app) },
    async (req, reply) => {
      const { id } = req.params;
      const [anchor, profile] = await Promise.all([
        app.prisma.mediaItem.findUnique({ where: { id }, select: itemSelect }),
        activeProfile(app, req),
      ]);
      if (!anchor) return reply.code(404).send({ error: "not_found" });
      if (!profileAllowsItem(profile, { rating: anchor.rating })) {
        return reply.code(404).send({ error: "not_found" });
      }

      const ratingFilter = kidsRatingWhere(profile);

      // Try embeddings first: nearest neighbours of the anchor, kids-filtered.
      try {
        const vecRow = await app.prisma.$queryRaw<{ id: string }[]>`
          SELECT mi.id
          FROM "MediaItem" mi
          JOIN "Embedding" e ON e."mediaItemId" = mi.id
          WHERE mi.id <> ${id}
          ORDER BY e.vector <=> (SELECT vector FROM "Embedding" WHERE "mediaItemId" = ${id})
          LIMIT ${LIMIT * 3}
        `;
        if (vecRow.length > 0) {
          const ids = vecRow.map((r) => r.id);
          const rows = await app.prisma.mediaItem.findMany({
            where: { id: { in: ids }, ...(ratingFilter ?? {}) },
            select: { id: true, title: true, year: true, posterPath: true, matchState: true },
          });
          const order = new Map(ids.map((x, i) => [x, i]));
          const items = rows
            .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
            .slice(0, LIMIT)
            .map(toCard);
          if (items.length > 0) return reply.send({ items });
        }
      } catch (err) {
        if (!(err instanceof EmbedderUnavailable) && !(err instanceof Error)) throw err;
        // fall through to Jaccard
      }

      // Fallback: weighted Jaccard over loaded catalog (cap 1000).
      const candidates = await app.prisma.mediaItem.findMany({
        where: { id: { not: id }, matchState: { in: ["matched", "manual"] }, ...(ratingFilter ?? {}) },
        take: 1000,
        select: itemSelect,
      });
      const anchorF = toFeatures(anchor);
      const items = candidates
        .map((c) => ({ c, score: itemSimilarity(anchorF, toFeatures(c)) }))
        .sort((a, b) => b.score - a.score || (b.c.year ?? 0) - (a.c.year ?? 0))
        .slice(0, LIMIT)
        .map(({ c }) => toCard(c));

      return reply.send({ items });
    },
  );
}
```

Note: `embedText` is imported to match the embeddings module surface used elsewhere; if eslint flags it as unused, remove the `embedText` import (only `EmbedderUnavailable` is needed). Keep imports minimal — prefer importing only `EmbedderUnavailable`.

- [ ] **Step 4: Register the route** in `apps/api/src/app.ts`

After `import discoveryRoute from "./routes/discovery";` add:
```typescript
import similarRoute from "./routes/similar";
```
After `await app.register(discoveryRoute, { prefix: "/api" });` add:
```typescript
await app.register(similarRoute, { prefix: "/api" });
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/similar.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/similar.ts apps/api/src/routes/similar.test.ts apps/api/src/app.ts
git commit -m "feat(api): GET /items/:id/similar (embeddings + Jaccard fallback, kids-filtered)"
```

---

### Task 2: Add `kind` to the detail response + forward-compatible web types

**Files:**
- Modify: `apps/api/src/routes/catalog.ts` (`GET /items/:id` select + return)
- Modify: `apps/web/src/lib/types.ts`

**Interfaces:**
- Produces: `/items/:id` JSON gains `kind: string`. `types.ts` exports `Ratings`, `SeasonSummary`, `EpisodeCard`, `TitleDetail`.

- [ ] **Step 1: Add `kind` to the Prisma select** in `apps/api/src/routes/catalog.ts` — inside the `select` object of `GET /items/:id` (after `id: true,`), add `kind: true,`. In the returned object (after `id: item.id,`) add `kind: item.kind,`.

- [ ] **Step 2: Add web types** to `apps/web/src/lib/types.ts` (append):

```typescript
/** Ratings shown on the title hero. All optional — render only what's present. */
export interface Ratings {
  imdbRating?: number | null;
  imdbVotes?: number | null;
  rtRating?: number | null;
  metacritic?: number | null;
  tmdbScore?: number | null;
}

/** Lightweight season summary for the season selector (series only). */
export interface SeasonSummary {
  seasonNumber: number;
  name: string | null;
  episodeCount: number;
  posterPath: string | null;
}

/** One episode in a season's episode list. */
export interface EpisodeCard {
  id: string;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  stillPath: string | null;
  runtimeSec: number | null;
  airDate: string | null;
  fileId: string | null;
  progress: { positionSec: number; durationSec: number; finished: boolean } | null;
}

export interface TitleFile {
  id: string;
  path: string;
  container: string | null;
  videoCodec: string | null;
  audioCodecs: string[];
  width: number | null;
  height: number | null;
  durationSec: number | null;
  size: string | null;
}

/** Full title detail (movie or series) returned by GET /items/:id. */
export interface TitleDetail extends Ratings {
  id: string;
  kind: string; // "movie" | "series"
  title: string;
  year: number | null;
  overview: string | null;
  tagline?: string | null;
  runtimeSec: number | null;
  rating: string | null; // MPAA cert
  posterPath: string | null;
  backdropPath: string | null;
  logoPath?: string | null;
  status?: string | null;
  matchState: string;
  genres: string[];
  cast: { name: string; character: string }[];
  director: { name: string } | null;
  files: TitleFile[];
  seasons?: SeasonSummary[];
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/catalog.ts apps/web/src/lib/types.ts
git commit -m "feat: expose item kind; add forward-compatible TitleDetail web types"
```

---

### Task 3: `RatingBadges` component

**Files:**
- Create: `apps/web/src/components/RatingBadges.tsx`
- Create: `apps/web/src/components/RatingBadges.test.tsx`

**Interfaces:**
- Consumes: `Ratings` from `@/lib/types`, plus `mpaa?: string | null`.
- Produces: `default function RatingBadges(props: Ratings & { mpaa?: string | null; className?: string })`. Renders an IMDb chip (gold `IMDb` label + value, when `imdbRating` present), an RT chip (🍅 + `rtRating%`), a TMDB chip (`TMDB` + value), and an MPAA cert chip. Renders nothing when all are absent.

- [ ] **Step 1: Write failing tests** `apps/web/src/components/RatingBadges.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RatingBadges from "./RatingBadges";

describe("RatingBadges", () => {
  it("renders IMDb, RT, and TMDB when present", () => {
    render(<RatingBadges imdbRating={9} rtRating={96} tmdbScore={8.7} />);
    expect(screen.getByText(/IMDb/)).toBeInTheDocument();
    expect(screen.getByText("9.0")).toBeInTheDocument();
    expect(screen.getByText("96%")).toBeInTheDocument();
    expect(screen.getByText(/TMDB/)).toBeInTheDocument();
  });

  it("renders nothing when no ratings and no mpaa", () => {
    const { container } = render(<RatingBadges />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the MPAA cert chip when provided", () => {
    render(<RatingBadges mpaa="PG-13" />);
    expect(screen.getByText("PG-13")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm --filter @orbix/web exec vitest run src/components/RatingBadges.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement** `apps/web/src/components/RatingBadges.tsx`

```tsx
import { cn } from "@orbix/ui";
import type { Ratings } from "@/lib/types";

function fmt1(n: number): string {
  return n.toFixed(1);
}

export default function RatingBadges({
  imdbRating, rtRating, tmdbScore, metacritic, mpaa, className,
}: Ratings & { mpaa?: string | null; className?: string }) {
  const hasAny =
    imdbRating != null || rtRating != null || tmdbScore != null || metacritic != null || (mpaa && mpaa.length > 0);
  if (!hasAny) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-sm", className)}>
      {imdbRating != null && (
        <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[#f5c518] px-1.5 py-0.5 font-semibold text-black">
          <span className="text-[11px] font-bold tracking-tight">IMDb</span>
          <span>{fmt1(imdbRating)}</span>
        </span>
      )}
      {rtRating != null && (
        <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[var(--text)]">
          <span aria-hidden>{rtRating >= 60 ? "🍅" : "🤢"}</span>
          <span>{rtRating}%</span>
        </span>
      )}
      {tmdbScore != null && (
        <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[var(--text)]">
          <span className="text-[11px] font-semibold text-[var(--accent)]">TMDB</span>
          <span>{fmt1(tmdbScore)}</span>
        </span>
      )}
      {metacritic != null && (
        <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[var(--text)]">
          <span className="text-[11px] font-semibold">MC</span>
          <span>{metacritic}</span>
        </span>
      )}
      {mpaa && (
        <span className="rounded-[var(--radius-sm)] border border-[var(--text-dim)]/40 px-1.5 py-0.5 text-xs text-[var(--text-dim)]">
          {mpaa}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass** — same vitest command → PASS (3).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/RatingBadges.tsx apps/web/src/components/RatingBadges.test.tsx
git commit -m "feat(web): RatingBadges (IMDb/RT/TMDB/MC/MPAA, render-only-present)"
```

---

### Task 4: `SimilarRail` component

**Files:**
- Create: `apps/web/src/components/SimilarRail.tsx`

**Interfaces:**
- Consumes: `apiJson` (`@/lib/api`), `MediaRow` (`@/components/MediaRow`), `MediaCard` (`@/lib/types`), `useQuery`.
- Produces: `default function SimilarRail({ itemId }: { itemId: string })`. Fetches `/items/:id/similar`; renders `<MediaRow title="More Like This" items={...} />`; renders nothing while loading/empty (MediaRow already returns null on empty).

- [ ] **Step 1: Implement** `apps/web/src/components/SimilarRail.tsx`

```tsx
import { useQuery } from "@tanstack/react-query";
import { apiJson } from "@/lib/api";
import MediaRow from "@/components/MediaRow";
import type { MediaCard } from "@/lib/types";

export default function SimilarRail({ itemId }: { itemId: string }) {
  const { data } = useQuery({
    queryKey: ["similar", itemId],
    queryFn: () => apiJson<{ items: MediaCard[] }>(`/items/${itemId}/similar`),
    retry: false,
  });
  if (!data || data.items.length === 0) return null;
  return <MediaRow title="More Like This" items={data.items} />;
}
```

- [ ] **Step 2: Typecheck** — `pnpm --filter @orbix/web typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/SimilarRail.tsx
git commit -m "feat(web): SimilarRail (More Like This rail via /items/:id/similar)"
```

---

### Task 5: `TitleHero` component

**Files:**
- Create: `apps/web/src/components/TitleHero.tsx`
- Create: `apps/web/src/components/TitleHero.test.tsx`

**Interfaces:**
- Consumes: `TitleDetail` (`@/lib/types`), `RatingBadges`, `Button` (`@orbix/ui`).
- Produces: `default function TitleHero({ item, onPlay, canPlay, playLabel }: { item: TitleDetail; onPlay: () => void; canPlay: boolean; playLabel: string })`. Renders a full-bleed backdrop (or gradient when absent), logo art `<img>` when `logoPath` present else an `<h1>` title, a meta row (`RatingBadges` + year + runtime/episode-count + genres), clamped synopsis, and the primary action button.

- [ ] **Step 1: Write failing tests** `apps/web/src/components/TitleHero.test.tsx`

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TitleHero from "./TitleHero";
import type { TitleDetail } from "@/lib/types";

const base: TitleDetail = {
  id: "x", kind: "movie", title: "Blade Runner", year: 1982, overview: "A blade runner must pursue replicants.",
  runtimeSec: 6900, rating: "R", posterPath: null, backdropPath: "backdrop/x.jpg", matchState: "matched",
  genres: ["Sci-Fi", "Thriller"], cast: [], director: null, files: [],
};

describe("TitleHero", () => {
  it("renders the title as text when there is no logo", () => {
    render(<TitleHero item={base} onPlay={() => {}} canPlay playLabel="Play" />);
    expect(screen.getByRole("heading", { name: "Blade Runner" })).toBeInTheDocument();
  });

  it("renders the logo image instead of the title heading when logoPath is set", () => {
    render(<TitleHero item={{ ...base, logoPath: "logo/x.png" }} onPlay={() => {}} canPlay playLabel="Play" />);
    expect(screen.getByAltText("Blade Runner")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Blade Runner" })).toBeNull();
  });

  it("fires onPlay when the play button is clicked", () => {
    const onPlay = vi.fn();
    render(<TitleHero item={base} onPlay={onPlay} canPlay playLabel="Play" />);
    screen.getByRole("button", { name: "Play" }).click();
    expect(onPlay).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm --filter @orbix/web exec vitest run src/components/TitleHero.test.tsx` → FAIL.

- [ ] **Step 3: Implement** `apps/web/src/components/TitleHero.tsx`

```tsx
import { Button } from "@orbix/ui";
import RatingBadges from "@/components/RatingBadges";
import type { TitleDetail } from "@/lib/types";

function formatRuntime(seconds: number | null): string | null {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

export default function TitleHero({
  item, onPlay, canPlay, playLabel,
}: {
  item: TitleDetail;
  onPlay: () => void;
  canPlay: boolean;
  playLabel: string;
}) {
  const runtime = formatRuntime(item.runtimeSec);
  const episodeCount = item.seasons?.reduce((n, s) => n + s.episodeCount, 0);
  const seasonCount = item.seasons?.length;

  return (
    <section className="relative w-full min-h-[60vh] md:min-h-[78vh] flex items-end overflow-hidden">
      {/* Backdrop */}
      {item.backdropPath ? (
        <img
          src={`/api/images/${item.backdropPath}`}
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-[var(--surface-2)] to-[var(--bg)]" />
      )}
      {/* Cinematic scrims */}
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg)] via-[var(--bg)]/55 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--bg)]/85 via-[var(--bg)]/25 to-transparent" />

      {/* Content */}
      <div className="relative z-10 w-full px-6 md:px-12 lg:px-16 pb-10 md:pb-16 max-w-5xl flex flex-col gap-4">
        {item.logoPath ? (
          <img
            src={`/api/images/${item.logoPath}`}
            alt={item.title}
            className="max-h-28 md:max-h-44 max-w-[70%] object-contain object-left drop-shadow-2xl"
          />
        ) : (
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight text-[var(--text)] drop-shadow-2xl">
            {item.title}
          </h1>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[var(--text-dim)]">
          <RatingBadges
            imdbRating={item.imdbRating}
            rtRating={item.rtRating}
            tmdbScore={item.tmdbScore}
            metacritic={item.metacritic}
            mpaa={item.rating}
          />
          {item.year != null && <span>{item.year}</span>}
          {item.kind === "series" && seasonCount ? (
            <span>{seasonCount} season{seasonCount > 1 ? "s" : ""}{episodeCount ? ` · ${episodeCount} episodes` : ""}</span>
          ) : (
            runtime && <span>{runtime}</span>
          )}
          {item.genres.slice(0, 3).map((g) => (
            <span key={g} className="text-[var(--text-dim)]">· {g}</span>
          ))}
        </div>

        {item.overview && (
          <p className="max-w-2xl text-[var(--text)]/90 leading-relaxed line-clamp-3 drop-shadow">
            {item.overview}
          </p>
        )}

        <div className="mt-2 flex items-center gap-3">
          <Button onClick={onPlay} disabled={!canPlay}>
            {canPlay ? `▶ ${playLabel}` : "No media"}
          </Button>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run, verify pass** — same vitest command → PASS (3).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/TitleHero.tsx apps/web/src/components/TitleHero.test.tsx
git commit -m "feat(web): full-bleed cinematic TitleHero (logo/type, ratings, scrims)"
```

---

### Task 6: Recompose `TitlePage` into the full-width layout

**Files:**
- Modify: `apps/web/src/pages/TitlePage.tsx`

**Interfaces:**
- Consumes: `TitleDetail` (`@/lib/types`), `TitleHero`, `SimilarRail`, the lazy `Player`, `useMyProfile`, `apiJson`, `ApiError`.
- Produces: the rendered page. Behaviour preserved: loading/404/error states, kids-hidden admin "Fix match" link, lazy Player mounted on Play with `files[0]`.

- [ ] **Step 1: Rewrite** `apps/web/src/pages/TitlePage.tsx`

```tsx
import { useState, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { apiJson, ApiError } from "@/lib/api";
import { useMyProfile } from "@/lib/queries";
import type { TitleDetail } from "@/lib/types";
import TitleHero from "@/components/TitleHero";
import SimilarRail from "@/components/SimilarRail";

const Player = lazy(() => import("@/components/Player"));

export default function TitlePage() {
  const { id } = useParams();
  const [playing, setPlaying] = useState(false);

  const itemQuery = useQuery({
    queryKey: ["item", id],
    enabled: !!id,
    queryFn: () => apiJson<TitleDetail>(`/items/${id}`),
    retry: false,
  });
  const profileQuery = useMyProfile();
  const isKidsProfile = profileQuery.data?.kind === "kids";

  const notFound = itemQuery.error instanceof ApiError && itemQuery.error.status === 404;

  if (itemQuery.isLoading) {
    return <main className="p-8"><p className="text-[var(--text-dim)]">Loading…</p></main>;
  }
  if (notFound) {
    return <main className="p-8"><h1 className="text-2xl font-bold text-[var(--text)]">Title not found</h1></main>;
  }
  const item = itemQuery.data;
  if (!item) {
    return <main className="p-8"><p className="text-sm text-red-400">Failed to load title</p></main>;
  }

  const firstFileId = item.files?.[0]?.id ?? null;

  return (
    <main className="flex w-full flex-col">
      <TitleHero
        item={item}
        canPlay={!!firstFileId}
        playLabel="Play"
        onPlay={() => setPlaying(true)}
      />

      <div className="w-full px-6 md:px-12 lg:px-16 py-8 flex flex-col gap-10">
        {/* Player */}
        {playing && firstFileId && (
          <Suspense fallback={<p className="text-sm text-[var(--text-dim)] py-2">Loading player…</p>}>
            <Player fileId={firstFileId} mediaItemId={item.id} title={item.title} />
          </Suspense>
        )}

        {/* Unmatched + admin fix */}
        {item.matchState !== "matched" && item.matchState !== "manual" && (
          <p className="text-sm text-yellow-400">Metadata not matched yet — scan with a TMDB token to enrich.</p>
        )}
        {!isKidsProfile && (
          <Link
            to={`/title/${id}/fix`}
            className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)] underline underline-offset-2 w-fit"
          >
            Fix match / poster (admin)
          </Link>
        )}

        {/* Cast */}
        {item.cast.length > 0 && (
          <section>
            <h2 className="mb-3 text-xl font-semibold text-[var(--text)]">Cast</h2>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {item.cast.map((c, i) => (
                <div key={i} className="w-32 shrink-0 rounded-[var(--radius)] bg-[var(--surface)] p-3">
                  <p className="text-sm font-medium text-[var(--text)] line-clamp-1">{c.name}</p>
                  {c.character && <p className="text-xs text-[var(--text-dim)] line-clamp-1">{c.character}</p>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* More Like This (full-bleed rail) */}
      {id && <SimilarRail itemId={id} />}

      {/* Details */}
      <div className="w-full px-6 md:px-12 lg:px-16 py-8 flex flex-col gap-4">
        {item.director && (
          <p className="text-sm text-[var(--text-dim)]">
            <span className="text-[var(--text)]">Director:</span> {item.director.name}
          </p>
        )}
        {item.genres.length > 0 && (
          <p className="text-sm text-[var(--text-dim)]">
            <span className="text-[var(--text)]">Genres:</span> {item.genres.join(", ")}
          </p>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Typecheck + lint + test**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/TitlePage.tsx
git commit -m "feat(web): recompose TitlePage into full-width cinematic layout"
```

---

### Task 7: Full gate sweep

- [ ] **Step 1: Run all gates**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS across core, api, config, web.

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: PASS (db generate + web vite build).

- [ ] **Step 3: Commit any fixes**, then Phase 1 is complete.

---

## Self-Review

- **Spec coverage:** Full-width ✅ (TitlePage/TitleHero full-bleed). Hero ✅ (logo/type + backdrop, scrims; logo/ffmpeg sourcing is Phase 2). Similar ✅ (Task 1+4). Ratings display ✅ (RatingBadges; data is Phase 3). Seasons/Episodes UI: not in Phase 1 (hero already shows season/episode counts via optional `seasons`; drill-down is Phase 4) — intentional per phasing.
- **Placeholder scan:** none.
- **Type consistency:** `TitleDetail` (web) used by TitleHero/TitlePage; `Card`/`MediaCard` shape `{id,title,year,posterPath,matchState}` consistent between similar endpoint and `MediaRow`/`PosterCard`.
- **Note:** `embedText` import in `similar.ts` is optional — keep only `EmbedderUnavailable` to avoid an unused-import lint error.
