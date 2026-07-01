# Spotlight Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the homepage's auto-rotating `Hero` with a Netflix-style spotlight row — a large hover-promotable landscape hero plus a scrollable trailing poster strip, resume-first, with progress/NEW badges.

**Architecture:** The featured (first) home row is rendered by a new `SpotlightRow`. It shows one large hero for the *active* item (default = first item) and a horizontal strip of portrait posters for the rest; hovering or focusing a poster promotes it (200ms debounce) into the fixed-size hero slot. Rich hero metadata (backdrop/logo/overview/genres/seasons/rating) is lazily fetched per active item from the existing `GET /items/:id`; continue-watching `progress` + `resume` (S/E/title) and `addedAt` are added to the `/home/rows` payload. Everything below the spotlight stays as today's poster rails.

**Tech Stack:** TypeScript, React 19 + React Router v8, TanStack Query, Tailwind (`@tailwindcss/vite`), Fastify + Prisma, vitest, Playwright.

## Global Constraints

- Package manager: **pnpm 10.22.0** (repo-local). Node 22. Turborepo.
- Gates before declaring any task done: `pnpm typecheck`, `pnpm lint`, `pnpm test`. **Run `pnpm lint` per change** — lint-only errors pass typecheck+test and are hidden by Turbo's cache.
- `packages/core` is framework-agnostic: **no DB/network/fs/ffmpeg imports**; pure functions only.
- **`MediaFile.size` is a Prisma `BigInt`** → `.toString()` before `JSON.stringify` in any route touching it. (This plan does not add size fields, but do not regress the existing `.toString()` in `catalog.ts`.)
- The SPA calls **relative `/api/...`** only (via `apiJson`/`apiFetch`). Never hardcode an API origin.
- Tests use **semantic selectors** (`getByRole`/`getByText`/`getByLabel`/`getByAltText`) — the repo uses **no `data-testid`**.
- vitest import style everywhere: `import { describe, it, expect } from "vitest"`.
- E2E wipes the DB in `global-setup`: run only against a **throwaway DB** with `E2E_ALLOW_DB_RESET=1`. Reap host dev servers after manual smokes (`pkill -f "tsx.*watch src/server.ts"; pkill -f vite`).
- Every commit ends with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work happens on the current `homepage` branch (already a feature branch).

## File map

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/playback/resume.ts` | modify | `continueWatching` returns `episodeId` |
| `packages/core/src/playback/resume.test.ts` | modify | assert `episodeId` passthrough |
| `apps/api/src/routes/discovery.ts` | modify | `/home/rows` items gain `addedAt` + `progress` + `resume` |
| `apps/api/src/routes/discovery.test.ts` | modify | assert the new fields |
| `apps/web/src/lib/types.ts` | modify | new `HomeCard`; `HomeRow.items: HomeCard[]` |
| `apps/web/src/lib/queries.ts` | modify | `useItemDetail(id)` |
| `apps/web/src/lib/spotlight.ts` | create | pure helpers: `isNew`, `progressPct`, `timeLeftLabel`, `resumeLabel` |
| `apps/web/src/lib/spotlight.test.ts` | create | unit tests for the helpers |
| `apps/web/src/components/spotlight/BadgeStack.tsx` | create | NEW + time-left badge chips |
| `apps/web/src/components/spotlight/SpotlightPoster.tsx` | create | trailing poster + progress bar + badge |
| `apps/web/src/components/spotlight/SpotlightPoster.test.tsx` | create | poster render test |
| `apps/web/src/components/spotlight/SpotlightHero.tsx` | create | big hero: backdrop/logo/badges/meta/desc/actions |
| `apps/web/src/components/spotlight/SpotlightHero.test.tsx` | create | hero render test |
| `apps/web/src/components/spotlight/SpotlightRow.tsx` | create | orchestrator: active state, debounced promote, layout |
| `apps/web/src/components/spotlight/SpotlightRow.test.tsx` | create | default hero + promote-on-hover test |
| `apps/web/src/pages/HomePage.tsx` | modify | use `SpotlightRow`; exclude featured row from rails; fix key |
| `apps/web/src/pages/HomePage.test.tsx` | create | spotlight + rails render, no duplicate row |
| `apps/web/src/components/Hero.tsx` | delete (conditional) | only after grep confirms no other consumer |
| `apps/web/e2e/spotlight.spec.ts` | create | seed 2 in-progress movies → hover promotes hero |

---

### Task 1: Core — `continueWatching` carries `episodeId`

**Files:**
- Modify: `packages/core/src/playback/resume.ts`
- Test: `packages/core/src/playback/resume.test.ts`

**Interfaces:**
- Produces: `interface PlaybackStateLike { mediaItemId: string; positionSec: number; durationSec: number; finished: boolean; updatedAt: Date; episodeId: string }` and `continueWatching(states: PlaybackStateLike[]): { mediaItemId: string; positionSec: number; durationSec: number; episodeId: string }[]`

- [ ] **Step 1: Write the failing test** — append to `packages/core/src/playback/resume.test.ts` inside the existing `describe("continueWatching", …)` block (add `episodeId` to every state object in the shared `states` fixture first, e.g. `episodeId: ""`).

```typescript
  it("passes episodeId through for each returned item", () => {
    const withEp = [
      {
        mediaItemId: "series-1",
        positionSec: 600,
        durationSec: 1200,
        finished: false,
        updatedAt: new Date("2026-06-30T10:00:00Z"),
        episodeId: "ep-42",
      },
      {
        mediaItemId: "movie-1",
        positionSec: 300,
        durationSec: 6000,
        finished: false,
        updatedAt: new Date("2026-06-29T10:00:00Z"),
        episodeId: "",
      },
    ];
    const result = continueWatching(withEp);
    expect(result.map((r) => r.episodeId)).toEqual(["ep-42", ""]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/core test src/playback/resume.test.ts`
Expected: FAIL — existing fixture objects error on the new `episodeId` field / new test property missing on return type, or the assertion fails because `episodeId` is `undefined`.

- [ ] **Step 3: Write minimal implementation** — edit `packages/core/src/playback/resume.ts`:

```typescript
export interface PlaybackStateLike {
  mediaItemId: string;
  positionSec: number;
  durationSec: number;
  finished: boolean;
  updatedAt: Date;
  episodeId: string;
}
```

and change the `continueWatching` return + mapping:

```typescript
export function continueWatching(
  states: PlaybackStateLike[]
): { mediaItemId: string; positionSec: number; durationSec: number; episodeId: string }[] {
  return states
    .filter((s) => s.positionSec > 0 && !s.finished)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map(({ mediaItemId, positionSec, durationSec, episodeId }) => ({
      mediaItemId,
      positionSec,
      durationSec,
      episodeId,
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/core test src/playback/resume.test.ts`
Expected: PASS (all `continueWatching` + `isFinished` tests green).

- [ ] **Step 5: Typecheck + lint the package**

Run: `pnpm --filter @orbix/core typecheck && pnpm --filter @orbix/core lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/playback/resume.ts packages/core/src/playback/resume.test.ts
git commit -m "feat(core): carry episodeId through continueWatching" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: API — enrich `/home/rows` with `addedAt`, `progress`, `resume`

**Files:**
- Modify: `apps/api/src/routes/discovery.ts` (route `GET /home/rows`, lines ~84–240)
- Test: `apps/api/src/routes/discovery.test.ts`

**Interfaces:**
- Consumes: `continueWatching` from Task 1 (now returns `episodeId`).
- Produces: each `/home/rows` item is now
  ```ts
  {
    id: string; title: string; year: number | null; posterPath: string | null;
    addedAt: string;                                             // ISO 8601
    progress: { positionSec: number; durationSec: number } | null;
    resume: { seasonNumber: number; episodeNumber: number; episodeTitle: string | null } | null;
  }
  ```

- [ ] **Step 1: Write the failing test** — append two tests to `apps/api/src/routes/discovery.test.ts`. Reuse the file's existing `env` const. Add this block:

```typescript
describe("GET /home/rows — continue-watching enrichment", () => {
  function authed(app: any, profile: unknown = { id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null }) {
    app.prisma.session = {
      findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
    };
    app.prisma.profile = { findUnique: async () => profile };
  }

  const cookies = { orbix_session: "s1", orbix_profile: "p1" };

  const seriesItem = {
    id: "series-1", title: "The Series", year: 2011, posterPath: "poster/s.jpg",
    addedAt: new Date("2026-06-30T00:00:00Z"),
    translations: [], genres: [], keywords: [], credits: [],
  };
  const movieItem = {
    id: "movie-1", title: "The Movie", year: 2020, posterPath: "poster/m.jpg",
    addedAt: new Date("2020-01-01T00:00:00Z"),
    translations: [], genres: [], keywords: [], credits: [],
  };

  it("adds progress + resume (S/E/title) to a series continue item and addedAt to all items", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.mediaItem = { findMany: async () => [seriesItem] };
    (app as any).prisma.playbackState = {
      findMany: async () => [
        { mediaItemId: "series-1", episodeId: "ep-1", positionSec: 600, durationSec: 1200, finished: false, updatedAt: new Date() },
      ],
    };
    (app as any).prisma.playEvent = { findMany: async () => [] };
    (app as any).prisma.episode = {
      findMany: async () => [{ id: "ep-1", episodeNumber: 4, title: "Old Friends", season: { seasonNumber: 3 } }],
    };

    const res = await app.inject({ method: "GET", url: "/api/home/rows", cookies });
    expect(res.statusCode).toBe(200);
    const cont = res.json().rows.find((r: any) => r.key === "continue");
    expect(cont.items[0]).toMatchObject({
      id: "series-1",
      addedAt: "2026-06-30T00:00:00.000Z",
      progress: { positionSec: 600, durationSec: 1200 },
      resume: { seasonNumber: 3, episodeNumber: 4, episodeTitle: "Old Friends" },
    });
    await app.close();
  });

  it("gives a movie continue item progress but resume=null (empty episodeId)", async () => {
    const app = await buildApp(env);
    authed(app as any);
    (app as any).prisma.mediaItem = { findMany: async () => [movieItem] };
    (app as any).prisma.playbackState = {
      findMany: async () => [
        { mediaItemId: "movie-1", episodeId: "", positionSec: 300, durationSec: 6000, finished: false, updatedAt: new Date() },
      ],
    };
    (app as any).prisma.playEvent = { findMany: async () => [] };
    (app as any).prisma.episode = { findMany: async () => [] };

    const res = await app.inject({ method: "GET", url: "/api/home/rows", cookies });
    expect(res.statusCode).toBe(200);
    const cont = res.json().rows.find((r: any) => r.key === "continue");
    expect(cont.items[0]).toMatchObject({
      id: "movie-1",
      progress: { positionSec: 300, durationSec: 6000 },
      resume: null,
    });
    await app.close();
  });
});
```

Add `import { describe, it, expect } from "vitest";` and `import { buildApp } from "../app";` if the file's existing header does not already cover them (it does — reuse).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/api test src/routes/discovery.test.ts`
Expected: FAIL — `addedAt`/`progress`/`resume` are `undefined` on the returned items (route doesn't select/emit them yet). The route may also throw if `app.prisma.episode` is read but the route doesn't call it — that's fine, it means the assertion still fails.

- [ ] **Step 3a: Select the new columns** — in `apps/api/src/routes/discovery.ts`, add `addedAt: true` to `itemSelect` (after `posterPath: true`, ~line 89):

```typescript
      const itemSelect = {
        id: true,
        title: true,
        year: true,
        posterPath: true,
        addedAt: true,
        translations: { where: { language: lang }, select: { title: true } },
```

and add `episodeId: true` to the `playbackState.findMany` select (~line 123):

```typescript
        app.prisma.playbackState.findMany({
          where: { profileId },
          select: {
            mediaItemId: true,
            episodeId: true,
            positionSec: true,
            durationSec: true,
            finished: true,
            updatedAt: true,
          },
        }),
```

- [ ] **Step 3b: Resolve progress + resume** — immediately after `const cwList = continueWatching(allStates);` (~line 197) insert:

```typescript
      // Map mediaItemId → its newest in-progress state (progress + resume source).
      const cwByItem = new Map<
        string,
        { positionSec: number; durationSec: number; episodeId: string }
      >();
      for (const c of cwList) {
        if (!cwByItem.has(c.mediaItemId)) {
          cwByItem.set(c.mediaItemId, {
            positionSec: c.positionSec,
            durationSec: c.durationSec,
            episodeId: c.episodeId,
          });
        }
      }
      // Resolve S/E/title for series continue items (episodeId "" = movie → skip).
      const episodeIds = [
        ...new Set([...cwByItem.values()].map((c) => c.episodeId).filter((id) => id !== "")),
      ];
      const episodes = episodeIds.length
        ? await app.prisma.episode.findMany({
            where: { id: { in: episodeIds } },
            select: {
              id: true,
              episodeNumber: true,
              title: true,
              season: { select: { seasonNumber: true } },
            },
          })
        : [];
      const epById = new Map(episodes.map((e) => [e.id, e]));
```

- [ ] **Step 3c: Emit the fields in hydration** — replace the item mapper in the hydration step (~lines 226–235) with:

```typescript
          const items = row.itemIds
            .map((id) => {
              const item = itemById.get(id);
              if (!item) return null;
              const cw = cwByItem.get(item.id);
              const ep = cw && cw.episodeId ? epById.get(cw.episodeId) : undefined;
              return {
                id: item.id,
                title: locTitle(item),
                year: item.year,
                posterPath: item.posterPath,
                addedAt: item.addedAt.toISOString(),
                progress: cw
                  ? { positionSec: cw.positionSec, durationSec: cw.durationSec }
                  : null,
                resume: ep
                  ? {
                      seasonNumber: ep.season.seasonNumber,
                      episodeNumber: ep.episodeNumber,
                      episodeTitle: ep.title,
                    }
                  : null,
              };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/api test src/routes/discovery.test.ts`
Expected: PASS (new tests + existing `/search` tests green).

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint`
Expected: no errors. (`@orbix/api` depends on `@orbix/core`; Task 1 must be committed/built first — Turbo handles the build.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/discovery.ts apps/api/src/routes/discovery.test.ts
git commit -m "feat(api): add addedAt/progress/resume to /home/rows items" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Web — types, query hook, and pure spotlight helpers

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/queries.ts`
- Create: `apps/web/src/lib/spotlight.ts`
- Test: `apps/web/src/lib/spotlight.test.ts`

**Interfaces:**
- Consumes: the `/home/rows` shape from Task 2; `TitleDetail` (existing).
- Produces:
  - `interface HomeCard extends MediaCard { addedAt?: string; progress?: { positionSec: number; durationSec: number } | null; resume?: { seasonNumber: number; episodeNumber: number; episodeTitle: string | null } | null }` and `HomeRow.items: HomeCard[]`.
  - `useItemDetail(id: string | undefined)` → TanStack Query for `TitleDetail`, key `["item", id]`.
  - `isNew(addedAt: string | undefined, now: Date): boolean`
  - `progressPct(positionSec: number, durationSec: number): number`
  - `timeLeftLabel(positionSec: number, durationSec: number): string`
  - `resumeLabel(resume: { seasonNumber: number; episodeNumber: number; episodeTitle: string | null } | null | undefined): string | null`

- [ ] **Step 1: Write the failing test** — create `apps/web/src/lib/spotlight.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isNew, progressPct, timeLeftLabel, resumeLabel } from "./spotlight";

describe("isNew", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  it("is true within 14 days", () => {
    expect(isNew("2026-06-20T00:00:00Z", now)).toBe(true);
  });
  it("is false at 15 days", () => {
    expect(isNew("2026-06-16T00:00:00Z", now)).toBe(false);
  });
  it("is false when addedAt is undefined", () => {
    expect(isNew(undefined, now)).toBe(false);
  });
});

describe("progressPct", () => {
  it("returns a 0..100 percentage", () => {
    expect(progressPct(600, 1200)).toBe(50);
  });
  it("returns 0 for a zero/invalid duration", () => {
    expect(progressPct(600, 0)).toBe(0);
  });
  it("clamps to 100", () => {
    expect(progressPct(9999, 1200)).toBe(100);
  });
});

describe("timeLeftLabel", () => {
  it("formats minutes", () => {
    expect(timeLeftLabel(600, 1200)).toBe("10m left");
  });
  it("formats hours + minutes", () => {
    expect(timeLeftLabel(600, 4500)).toBe("1h 5m left");
  });
  it("returns empty string for invalid duration", () => {
    expect(timeLeftLabel(10, 0)).toBe("");
  });
});

describe("resumeLabel", () => {
  it("formats season, episode and title", () => {
    expect(resumeLabel({ seasonNumber: 3, episodeNumber: 4, episodeTitle: "Old Friends" }))
      .toBe("S3 E4 · Old Friends");
  });
  it("omits the title when absent", () => {
    expect(resumeLabel({ seasonNumber: 1, episodeNumber: 2, episodeTitle: null }))
      .toBe("S1 E2");
  });
  it("returns null for a movie (null resume)", () => {
    expect(resumeLabel(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/web test src/lib/spotlight.test.ts`
Expected: FAIL — `./spotlight` module does not exist.

- [ ] **Step 3a: Create the helpers** — `apps/web/src/lib/spotlight.ts`:

```typescript
const NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** True when `addedAt` (ISO) is within the last 14 days of `now`. */
export function isNew(addedAt: string | undefined, now: Date): boolean {
  if (!addedAt) return false;
  const added = new Date(addedAt).getTime();
  if (Number.isNaN(added)) return false;
  return now.getTime() - added <= NEW_WINDOW_MS;
}

/** Playback progress as an integer 0..100. 0 when duration is not positive. */
export function progressPct(positionSec: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return Math.min(100, Math.round((positionSec / durationSec) * 100));
}

/** "10m left" / "1h 5m left"; "" when duration is not positive. */
export function timeLeftLabel(positionSec: number, durationSec: number): string {
  if (durationSec <= 0) return "";
  const leftMin = Math.max(0, Math.round((durationSec - positionSec) / 60));
  const h = Math.floor(leftMin / 60);
  const m = leftMin % 60;
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

/** "S3 E4 · Old Friends" / "S1 E2"; null for a movie (null/undefined resume). */
export function resumeLabel(
  resume: { seasonNumber: number; episodeNumber: number; episodeTitle: string | null } | null | undefined,
): string | null {
  if (!resume) return null;
  const base = `S${resume.seasonNumber} E${resume.episodeNumber}`;
  return resume.episodeTitle ? `${base} · ${resume.episodeTitle}` : base;
}
```

- [ ] **Step 3b: Widen the types** — in `apps/web/src/lib/types.ts`, add after the `MediaCard` interface:

```typescript
/** Home-row card: MediaCard plus continue-watching + recency fields. */
export interface HomeCard extends MediaCard {
  addedAt?: string;
  progress?: { positionSec: number; durationSec: number } | null;
  resume?: { seasonNumber: number; episodeNumber: number; episodeTitle: string | null } | null;
}
```

and change `HomeRow.items` to use it:

```typescript
export interface HomeRow {
  key: string;
  title: string;
  items: HomeCard[];
}
```

- [ ] **Step 3c: Add the query hook** — in `apps/web/src/lib/queries.ts`, add the `TitleDetail` import to the existing type import and add the hook:

```typescript
import type { AuthMe, HomeRow, MediaCard, MenuConfig, MenuItem, Profile, TitleDetail } from "./types";
```

```typescript
/** Full title detail; shared cache key ["item", id] (used by the spotlight hero). */
export function useItemDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["item", id],
    enabled: !!id,
    queryFn: () => apiJson<TitleDetail>(`/items/${id}`),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/web test src/lib/spotlight.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/lib/spotlight.ts apps/web/src/lib/spotlight.test.ts
git commit -m "feat(web): HomeCard type, useItemDetail hook, spotlight helpers" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Web — `BadgeStack` + `SpotlightPoster`

**Files:**
- Create: `apps/web/src/components/spotlight/BadgeStack.tsx`
- Create: `apps/web/src/components/spotlight/SpotlightPoster.tsx`
- Test: `apps/web/src/components/spotlight/SpotlightPoster.test.tsx`

**Interfaces:**
- Consumes: `HomeCard` (Task 3), `isNew`/`progressPct`/`timeLeftLabel` (Task 3), `cn` from `@orbix/ui`.
- Produces:
  - `BadgeStack(props: { isNew?: boolean; timeLeft?: string | null; className?: string })`
  - `SpotlightPoster(props: { item: HomeCard; active: boolean; onPromote: () => void })`

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/spotlight/SpotlightPoster.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { MemoryRouter } from "react-router";
import { render, screen } from "@testing-library/react";
import SpotlightPoster from "./SpotlightPoster";
import type { HomeCard } from "@/lib/types";

function renderPoster(item: HomeCard) {
  return render(
    <MemoryRouter>
      <SpotlightPoster item={item} active={false} onPromote={() => {}} />
    </MemoryRouter>,
  );
}

describe("SpotlightPoster", () => {
  it("links to the title page", () => {
    renderPoster({ id: "x1", title: "My Show", year: 2020, posterPath: "poster/x.jpg" });
    expect(screen.getByRole("link", { name: /My Show/ })).toHaveAttribute("href", "/title/x1");
  });

  it("renders a progress bar when the item has progress", () => {
    const { container } = renderPoster({
      id: "x2", title: "In Progress", year: 2020, posterPath: "poster/x.jpg",
      progress: { positionSec: 600, durationSec: 1200 },
    });
    const bar = container.querySelector("[data-progress]") as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar!.style.width).toBe("50%");
  });
});
```

Note: the `[data-progress]` attribute is a rendering hook for the width assertion, not a test-id selector for user-facing queries — it carries the computed width.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/web test src/components/spotlight/SpotlightPoster.test.tsx`
Expected: FAIL — modules do not exist.

- [ ] **Step 3a: Create `BadgeStack.tsx`:**

```tsx
import { cn } from "@orbix/ui";

/** Small overlaid chips: "NEW" and/or a time-left label. Renders nothing when empty. */
export default function BadgeStack({
  isNew,
  timeLeft,
  className,
}: {
  isNew?: boolean;
  timeLeft?: string | null;
  className?: string;
}) {
  if (!isNew && !timeLeft) return null;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {isNew && (
        <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-xs font-semibold text-white">
          NEW
        </span>
      )}
      {timeLeft && (
        <span className="rounded bg-black/60 px-1.5 py-0.5 text-xs text-[var(--text)]">
          {timeLeft}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 3b: Create `SpotlightPoster.tsx`:**

```tsx
import { Link } from "react-router";
import { cn } from "@orbix/ui";
import type { HomeCard } from "@/lib/types";
import { isNew, progressPct } from "@/lib/spotlight";

/**
 * One trailing poster in the spotlight strip. Hovering or focusing promotes it
 * (via `onPromote`); clicking navigates to the title. Shows a continue-watching
 * progress bar and a "NEW" badge when applicable.
 */
export default function SpotlightPoster({
  item,
  active,
  onPromote,
}: {
  item: HomeCard;
  active: boolean;
  onPromote: () => void;
}) {
  const showImg =
    item.posterPath &&
    (item.matchState == null || item.matchState === "matched" || item.matchState === "manual");
  const pct = item.progress ? progressPct(item.progress.positionSec, item.progress.durationSec) : 0;

  return (
    <Link
      to={`/title/${item.id}`}
      onMouseEnter={onPromote}
      onFocus={onPromote}
      className={cn(
        "group relative w-28 shrink-0 overflow-hidden rounded-[var(--radius)] outline-none md:w-32",
        active && "ring-2 ring-[var(--accent)]",
      )}
    >
      <div className="aspect-[2/3] bg-[var(--surface)]">
        {showImg ? (
          <img
            src={`/api/images/${item.posterPath}`}
            alt={item.title}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-end p-2 text-left text-xs leading-tight text-[var(--text-dim)] line-clamp-3">
            {item.title}
          </div>
        )}
      </div>
      {isNew(item.addedAt, new Date()) && (
        <span className="absolute left-1 top-1 rounded bg-[var(--accent)] px-1 py-0.5 text-[10px] font-semibold text-white">
          NEW
        </span>
      )}
      {pct > 0 && (
        <span
          data-progress
          className="absolute bottom-0 left-0 h-1 bg-[var(--accent)]"
          style={{ width: `${pct}%` }}
        />
      )}
    </Link>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/web test src/components/spotlight/SpotlightPoster.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/spotlight/BadgeStack.tsx apps/web/src/components/spotlight/SpotlightPoster.tsx apps/web/src/components/spotlight/SpotlightPoster.test.tsx
git commit -m "feat(web): BadgeStack and SpotlightPoster components" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Web — `SpotlightHero`

**Files:**
- Create: `apps/web/src/components/spotlight/SpotlightHero.tsx`
- Test: `apps/web/src/components/spotlight/SpotlightHero.test.tsx`

**Interfaces:**
- Consumes: `HomeCard`, `TitleDetail` (types); `resumeLabel`/`timeLeftLabel`/`progressPct`/`isNew` (Task 3); `BadgeStack` (Task 4); `Button`, `cn` from `@orbix/ui`.
- Produces: `SpotlightHero(props: { card: HomeCard; detail: TitleDetail | undefined })`.

Behaviour:
- No `detail` yet → skeleton block (keeps the fixed slot height).
- `detail.logoPath` present → show logo `<img>`; else `<h2>` with the title.
- Continue item (`card.resume` OR `card.progress`) → resume line + progress bar + time-left. Otherwise a discovery metadata line: `genre · year · N Seasons · rating`.
- Actions: `▶ Play` and `ⓘ More Info`, both `Link`s to `/title/:id`.
- Reduced motion handled by CSS: fade classes carry `motion-reduce:transition-none`.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/spotlight/SpotlightHero.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { MemoryRouter } from "react-router";
import { render, screen } from "@testing-library/react";
import SpotlightHero from "./SpotlightHero";
import type { HomeCard, TitleDetail } from "@/lib/types";

const detail: TitleDetail = {
  id: "s1", kind: "series", title: "The Series", year: 2011,
  overview: "Twisted tales run wild in this anthology.", tagline: null,
  runtimeSec: null, rating: "TV-MA", posterPath: "poster/s.jpg",
  backdropPath: "backdrop/s.jpg", logoPath: null, status: null, matchState: "matched",
  genres: ["Drama"], cast: [], director: null, files: [],
  seasons: [{ seasonNumber: 1, name: null, episodeCount: 8, posterPath: null }],
};

function renderHero(card: HomeCard, d: TitleDetail | undefined = detail) {
  return render(
    <MemoryRouter>
      <SpotlightHero card={card} detail={d} />
    </MemoryRouter>,
  );
}

describe("SpotlightHero", () => {
  it("renders the title heading and Play link when there is no logo", () => {
    renderHero({ id: "s1", title: "The Series", year: 2011, posterPath: "poster/s.jpg" });
    expect(screen.getByRole("heading", { name: "The Series" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /play/i })).toHaveAttribute("href", "/title/s1");
  });

  it("shows the discovery metadata line and description", () => {
    renderHero({ id: "s1", title: "The Series", year: 2011, posterPath: "poster/s.jpg" });
    expect(screen.getByText(/Drama/)).toBeTruthy();
    expect(screen.getByText(/TV-MA/)).toBeTruthy();
    expect(screen.getByText(/Twisted tales/)).toBeTruthy();
  });

  it("shows the resume line + time-left for a continue item", () => {
    renderHero({
      id: "s1", title: "The Series", year: 2011, posterPath: "poster/s.jpg",
      progress: { positionSec: 600, durationSec: 1200 },
      resume: { seasonNumber: 3, episodeNumber: 4, episodeTitle: "Old Friends" },
    });
    expect(screen.getByText("S3 E4 · Old Friends")).toBeTruthy();
    expect(screen.getByText("10m left")).toBeTruthy();
  });

  it("renders a skeleton (no heading) while detail is loading", () => {
    renderHero({ id: "s1", title: "The Series", year: 2011, posterPath: "poster/s.jpg" }, undefined);
    expect(screen.queryByRole("heading", { name: "The Series" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/web test src/components/spotlight/SpotlightHero.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `SpotlightHero.tsx`:**

```tsx
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, cn } from "@orbix/ui";
import type { HomeCard, TitleDetail } from "@/lib/types";
import BadgeStack from "./BadgeStack";
import { isNew, progressPct, resumeLabel, timeLeftLabel } from "@/lib/spotlight";

/** The large hero for the active spotlight item. Fixed-size slot; content swaps. */
export default function SpotlightHero({
  card,
  detail,
}: {
  card: HomeCard;
  detail: TitleDetail | undefined;
}) {
  const { t } = useTranslation();

  const resume = resumeLabel(card.resume);
  const pct = card.progress ? progressPct(card.progress.positionSec, card.progress.durationSec) : 0;
  const timeLeft = card.progress
    ? timeLeftLabel(card.progress.positionSec, card.progress.durationSec)
    : null;

  const metaLine = card.resume
    ? null
    : [
        detail?.genres?.[0],
        card.year ?? detail?.year ?? null,
        detail?.seasons && detail.seasons.length > 0 ? `${detail.seasons.length} Seasons` : null,
        detail?.rating,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <section className="relative aspect-video w-full overflow-hidden rounded-[var(--radius)] bg-[var(--surface)]">
      {detail?.backdropPath && (
        <img
          key={detail.id}
          src={`/api/images/${detail.backdropPath}`}
          alt=""
          className="absolute inset-0 h-full w-full animate-[fadein_300ms_ease] object-cover motion-reduce:animate-none"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg)] via-[var(--bg)]/30 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--bg)]/80 via-transparent to-transparent" />

      <BadgeStack
        isNew={isNew(card.addedAt, new Date())}
        className="absolute right-3 top-3"
      />

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-4 md:p-6">
        {detail ? (
          <>
            {detail.logoPath ? (
              <img
                src={`/api/images/${detail.logoPath}`}
                alt={card.title}
                className="max-h-20 w-auto max-w-[60%] object-contain md:max-h-28"
              />
            ) : (
              <h2 className="text-2xl font-bold text-[var(--text)] md:text-4xl">{card.title}</h2>
            )}

            {resume ? (
              <div className="flex max-w-xl flex-col gap-1">
                <span className="text-sm text-[var(--text-dim)]">{resume}</span>
                <div className="flex items-center gap-3">
                  <span className="h-1 w-40 overflow-hidden rounded bg-[var(--surface-2)]">
                    <span className="block h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                  </span>
                  {timeLeft && <span className="text-xs text-[var(--text-dim)]">{timeLeft}</span>}
                </div>
              </div>
            ) : (
              <>
                {metaLine && (
                  <div className="text-sm text-[var(--text-dim)]">{metaLine}</div>
                )}
                {detail.overview && (
                  <p className="line-clamp-2 max-w-xl text-sm text-[var(--text-dim)] md:line-clamp-3">
                    {detail.overview}
                  </p>
                )}
              </>
            )}

            <div className="mt-1 flex items-center gap-3">
              <Link to={`/title/${card.id}`}>
                <Button>▶ {t("catalog:hero.play")}</Button>
              </Link>
              <Link to={`/title/${card.id}`}>
                <Button variant="ghost">{t("catalog:hero.moreInfo")}</Button>
              </Link>
            </div>
          </>
        ) : (
          <div className={cn("h-24 w-2/3 animate-pulse rounded bg-[var(--surface-2)]")} />
        )}
      </div>
    </section>
  );
}
```

Add a keyframe for `fadein` to the global stylesheet if not present — in `apps/web/src/index.css` (or the app's Tailwind entry CSS) append:

```css
@keyframes fadein { from { opacity: 0 } to { opacity: 1 } }
```

(If a `fadein`/`fade-in` utility already exists, reuse it and skip this.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/web test src/components/spotlight/SpotlightHero.test.tsx`
Expected: PASS. (If `t("catalog:hero.play")` renders a key instead of "Play", the regex `/play/i` still matches the key `hero.play` — assertion holds. The test-setup initializes i18n so English strings render.)

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/spotlight/SpotlightHero.tsx apps/web/src/components/spotlight/SpotlightHero.test.tsx apps/web/src/index.css
git commit -m "feat(web): SpotlightHero component" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Web — `SpotlightRow` orchestrator

**Files:**
- Create: `apps/web/src/components/spotlight/SpotlightRow.tsx`
- Test: `apps/web/src/components/spotlight/SpotlightRow.test.tsx`

**Interfaces:**
- Consumes: `HomeCard` (type); `useItemDetail` (Task 3); `SpotlightHero` (Task 5); `SpotlightPoster` (Task 4).
- Produces: `SpotlightRow(props: { items: HomeCard[]; debounceMs?: number })` (default `debounceMs = 200`).

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/spotlight/SpotlightRow.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import SpotlightRow from "./SpotlightRow";
import type { HomeCard, TitleDetail } from "@/lib/types";

const cardA: HomeCard = { id: "a", title: "Movie A", year: 2020, posterPath: "poster/a.jpg" };
const cardB: HomeCard = { id: "b", title: "Movie B", year: 2021, posterPath: "poster/b.jpg" };

const detail = (id: string, title: string): TitleDetail => ({
  id, kind: "movie", title, year: 2020, overview: `${title} overview`, tagline: null,
  runtimeSec: null, rating: "PG-13", posterPath: `poster/${id}.jpg`,
  backdropPath: `backdrop/${id}.jpg`, logoPath: null, status: null, matchState: "matched",
  genres: ["Action"], cast: [], director: null, files: [],
});

function setup() {
  const client = makeClient();
  client.setQueryData(["item", "a"], detail("a", "Movie A"));
  client.setQueryData(["item", "b"], detail("b", "Movie B"));
  return renderWithProviders(<SpotlightRow items={[cardA, cardB]} debounceMs={0} />, { client });
}

describe("SpotlightRow", () => {
  it("shows the first item as the hero by default", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Movie A" })).toBeTruthy();
  });

  it("promotes a poster to the hero on hover", async () => {
    setup();
    // Two links to Movie B exist (hero none yet + poster). Hover the poster.
    const posterB = screen.getAllByRole("link", { name: /Movie B/ })[0];
    fireEvent.mouseEnter(posterB);
    expect(await screen.findByRole("heading", { name: "Movie B" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/web test src/components/spotlight/SpotlightRow.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `SpotlightRow.tsx`:**

```tsx
import { useEffect, useRef, useState } from "react";
import type { HomeCard } from "@/lib/types";
import { useItemDetail } from "@/lib/queries";
import SpotlightHero from "./SpotlightHero";
import SpotlightPoster from "./SpotlightPoster";

/**
 * Featured home row: a large hover-promotable hero on the left and a
 * horizontally-scrollable poster strip on the right (stacked on mobile).
 * Hovering/focusing a poster promotes it to the hero after `debounceMs`.
 */
export default function SpotlightRow({
  items,
  debounceMs = 200,
}: {
  items: HomeCard[];
  debounceMs?: number;
}) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const promote = (id: string) => {
    clear();
    timer.current = setTimeout(() => setActiveId(id), debounceMs);
  };
  useEffect(() => clear, []);

  const active = items.find((i) => i.id === activeId) ?? items[0];
  const detail = useItemDetail(active?.id);
  if (!active) return null;

  return (
    <section className="w-full px-6 py-4 md:px-8 lg:px-10">
      <div className="flex flex-col gap-4 md:flex-row md:items-stretch">
        <div className="md:w-[62%] lg:w-[66%]">
          <SpotlightHero card={active} detail={detail.data} />
        </div>
        <div className="flex gap-3 overflow-x-auto pb-2 md:flex-1" onMouseLeave={clear}>
          {items.map((item) => (
            <SpotlightPoster
              key={item.id}
              item={item}
              active={item.id === active.id}
              onPromote={() => promote(item.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/web test src/components/spotlight/SpotlightRow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/spotlight/SpotlightRow.tsx apps/web/src/components/spotlight/SpotlightRow.test.tsx
git commit -m "feat(web): SpotlightRow orchestrator with debounced hover-promote" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Web — wire `SpotlightRow` into `HomePage`, drop the old `Hero`

**Files:**
- Modify: `apps/web/src/pages/HomePage.tsx`
- Test: `apps/web/src/pages/HomePage.test.tsx` (create)
- Delete (conditional): `apps/web/src/components/Hero.tsx`

**Interfaces:**
- Consumes: `useHomeRows` (existing), `SpotlightRow` (Task 6).
- Produces: a homepage that renders the featured row as `SpotlightRow` and the remaining rows as `HomeRows`, with no duplicated row.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/pages/HomePage.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import HomePage from "./HomePage";
import type { HomeRow, TitleDetail } from "@/lib/types";

const rows: HomeRow[] = [
  { key: "continue", title: "Continue Watching", items: [
    { id: "a", title: "Resume A", year: 2020, posterPath: "poster/a.jpg",
      progress: { positionSec: 600, durationSec: 1200 }, resume: null },
  ] },
  { key: "hiddenGems", title: "Hidden gems", items: [
    { id: "b", title: "Gem B", year: 2019, posterPath: "poster/b.jpg" },
  ] },
];

const detailA: TitleDetail = {
  id: "a", kind: "movie", title: "Resume A", year: 2020, overview: "o", tagline: null,
  runtimeSec: null, rating: "PG", posterPath: "poster/a.jpg", backdropPath: "backdrop/a.jpg",
  logoPath: null, status: null, matchState: "matched", genres: ["Action"], cast: [],
  director: null, files: [],
};

function setup() {
  const client = makeClient();
  client.setQueryData(["home-rows"], { rows });
  client.setQueryData(["item", "a"], detailA);
  return renderWithProviders(<HomePage />, { client });
}

describe("HomePage", () => {
  it("renders the featured (first) row as the spotlight hero", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Resume A" })).toBeTruthy();
  });

  it("renders remaining rows as rails and does not duplicate the featured row heading", () => {
    setup();
    expect(screen.getByRole("heading", { name: /Hidden gems/ })).toBeTruthy();
    // "Continue Watching" is now the spotlight, not a rail heading below.
    expect(screen.queryByRole("heading", { name: "Continue Watching" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/web test src/pages/HomePage.test.tsx`
Expected: FAIL — HomePage still renders the old `Hero` (no "Resume A" heading) / still lists the continue row as a rail.

- [ ] **Step 3: Rewrite `HomePage.tsx`:**

```tsx
import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import { useHomeRows } from "@/lib/queries";
import HomeRows from "@/components/HomeRows";
import SpotlightRow from "@/components/spotlight/SpotlightRow";

export default function HomePage() {
  const { t } = useTranslation();
  const { data, isLoading } = useHomeRows();
  const rows = data?.rows ?? [];

  // Featured row = Continue Watching when present, else the first row.
  const featured = rows.find((r) => r.key === "continue") ?? rows[0];
  const rest = rows.filter((r) => r !== featured);
  const hasFeatured = !!featured && featured.items.length > 0;

  if (isLoading)
    return <div className="p-8 text-[var(--text-dim)]">{t("common:status.loading")}</div>;

  return (
    // Pull the spotlight up under the fixed transparent TopNav (cancels
    // AppShell's pt-14) so the gradient bar overlays the backdrop art.
    <div className={cn("flex flex-col gap-6 pb-4", hasFeatured && "-mt-14")}>
      {hasFeatured && <SpotlightRow items={featured.items} />}
      <HomeRows rows={rest} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/web test src/pages/HomePage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Delete the old `Hero` if unused**

Run: `grep -rn "components/Hero\"\|from \"@/components/Hero\"\|Hero, { type HeroItem }" apps/web/src`
Expected: only matches were in `HomePage.tsx` (now removed). If so:

```bash
git rm apps/web/src/components/Hero.tsx
# also remove apps/web/src/components/Hero.test.tsx if it exists
```

If any other file imports `Hero`, leave the file and note it in the commit body.

- [ ] **Step 6: Full gates**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green across packages.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/HomePage.tsx apps/web/src/pages/HomePage.test.tsx apps/web/src/components/Hero.tsx
git commit -m "feat(web): render homepage featured row as the spotlight row" \
  -m "Replaces the auto-rotating Hero; excludes the featured row from the rails." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: E2E — hover promotes the hero (Playwright)

**Files:**
- Create: `apps/web/e2e/spotlight.spec.ts`

**Interfaces:**
- Consumes: the whole feature end-to-end against a real DB.

Uses two in-progress **movies** (episodeId `""`) so the continue row has two items — the hero defaults to the first and hovering the second promotes it. (Series resume-label formatting is already covered by the Task 2 API test.)

- [ ] **Step 1: Write the spec** — create `apps/web/e2e/spotlight.spec.ts`. Model it on `apps/web/e2e/playback.spec.ts` (seed helpers + onboarding):

```typescript
/**
 * E2E: homepage spotlight row.
 *   - Seeds two in-progress movies (Continue Watching).
 *   - Hero defaults to the first; hovering the second poster promotes it.
 */
import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const LIBRARY_ID = "spotlib00000000000000001";
const ITEM_A = "spotitem0000000000000001";
const ITEM_B = "spotitem0000000000000002";
const PROFILE_NAME = "Spotter";
const ADMIN_EMAIL = "spotlight@home.lan";
const ADMIN_PASSWORD = "longenough";

async function seedDb() {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  const { hashPassword } = await import("@orbix/core");

  await prisma.playbackState.deleteMany({ where: { mediaItemId: { in: [ITEM_A, ITEM_B] } } });
  await prisma.mediaItem.deleteMany({ where: { id: { in: [ITEM_A, ITEM_B] } } });
  await prisma.library.deleteMany({ where: { id: LIBRARY_ID } });
  await prisma.account.deleteMany();

  await prisma.account.create({
    data: { email: ADMIN_EMAIL, passwordHash: await hashPassword(ADMIN_PASSWORD), isAdmin: true },
  });

  await prisma.library.create({
    data: {
      id: LIBRARY_ID,
      name: "Spotlight Library",
      items: {
        create: [
          { id: ITEM_A, title: "Alpha Movie", sortTitle: "alpha movie", year: 2020,
            overview: "Alpha overview.", backdropPath: "backdrop/a.jpg", matchState: "matched" },
          { id: ITEM_B, title: "Bravo Movie", sortTitle: "bravo movie", year: 2021,
            overview: "Bravo overview.", backdropPath: "backdrop/b.jpg", matchState: "matched" },
        ],
      },
    },
  });

  await prisma.$disconnect();
}

async function cleanDb() {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  await prisma.playbackState.deleteMany({ where: { mediaItemId: { in: [ITEM_A, ITEM_B] } } });
  await prisma.mediaItem.deleteMany({ where: { id: { in: [ITEM_A, ITEM_B] } } });
  await prisma.library.deleteMany({ where: { id: LIBRARY_ID } });
  await prisma.profile.deleteMany({ where: { name: PROFILE_NAME } });
  await prisma.account.deleteMany({ where: { email: ADMIN_EMAIL } });
  await prisma.$disconnect();
}

async function onboardAndGetProfileId(page: Page): Promise<string> {
  await page.goto("http://localhost:1060/");
  await page.waitForURL(/\/(setup|login|profiles)/, { timeout: 15_000 });
  if (page.url().includes("/setup")) {
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /create/i }).click();
  } else if (page.url().includes("/login")) {
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
  }
  await expect(page).toHaveURL(/\/profiles/, { timeout: 15_000 });
  const exists = await page.getByText(PROFILE_NAME).isVisible().catch(() => false);
  if (!exists) {
    await page.getByRole("button", { name: /add profile/i }).click();
    await page.getByLabel("Name").fill(PROFILE_NAME);
    await page.getByRole("button", { name: /save/i }).click();
  }
  await page.getByText(PROFILE_NAME).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  // Read the created profile id so we can seed playback states for it.
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  const profile = await prisma.profile.findFirstOrThrow({ where: { name: PROFILE_NAME } });
  await prisma.$disconnect();
  return profile.id;
}

async function seedProgress(profileId: string) {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  await prisma.playbackState.createMany({
    data: [
      { profileId, mediaItemId: ITEM_A, episodeId: "", positionSec: 600, durationSec: 1200, finished: false },
      { profileId, mediaItemId: ITEM_B, episodeId: "", positionSec: 300, durationSec: 1200, finished: false },
    ],
  });
  await prisma.$disconnect();
}

test.describe("homepage spotlight row", () => {
  test.beforeAll(seedDb);
  test.afterAll(cleanDb);

  test("hero defaults to the first item and hovering a poster promotes it", async ({ page }) => {
    const profileId = await onboardAndGetProfileId(page);
    await seedProgress(profileId);

    await page.goto("http://localhost:1060/");
    // Alpha is newest-updated? createMany order is not guaranteed; assert either
    // hero shows one of the two, then hover the other and assert it takes over.
    const heroAlpha = page.getByRole("heading", { name: "Alpha Movie" });
    const heroBravo = page.getByRole("heading", { name: "Bravo Movie" });
    await expect(heroAlpha.or(heroBravo)).toBeVisible({ timeout: 15_000 });

    // Hover the Bravo poster (there is a poster link for each item).
    await page.getByRole("link", { name: /Bravo Movie/ }).first().hover();
    await expect(page.getByRole("heading", { name: "Bravo Movie" })).toBeVisible({ timeout: 15_000 });
  });
});
```

- [ ] **Step 2: Run the spec against a throwaway DB**

Run:
```bash
E2E_ALLOW_DB_RESET=1 \
DATABASE_URL="postgresql://orbix:orbix@localhost:1062/orbix" \
REDIS_URL="redis://localhost:1063" \
pnpm --filter @orbix/web test:e2e e2e/spotlight.spec.ts
```
Expected: PASS. Prerequisites: postgres (1062) + redis (1063) up (`docker compose up -d postgres redis`); the config's `webServer` auto-starts api+web. Point `DATABASE_URL` at a throwaway DB — global-setup wipes accounts/profiles.

- [ ] **Step 3: Reap dev servers** (avoid EMFILE / stale reuse):

```bash
pkill -f "tsx.*watch src/server.ts"; pkill -f vite || true
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/spotlight.spec.ts
git commit -m "test(web/e2e): spotlight row hover promotes the hero" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Manual smoke (after Task 7, before Task 8)

1. `docker compose up -d postgres redis`, then run api + web dev servers.
2. Open `http://localhost:1060`, select a profile with in-progress titles.
3. Verify: the top shows a large hero (first continue item) + a poster strip; the resume line + progress bar + "Xm left" appear; a "Continue Watching" rail is **not** duplicated below.
4. Hover across posters → hero cross-fades after a beat, no row height jitter.
5. Tab with the keyboard → focusing a poster promotes it.
6. Narrow the window < 768px → hero stacks above a horizontal poster rail.
7. Reap dev servers: `pkill -f "tsx.*watch src/server.ts"; pkill -f vite`.

## Self-Review

- **Spec coverage:** Layout (Tasks 5–7), debounced hover-promote + keyboard focus (Task 6, SpotlightPoster onFocus), fixed-size hero slot / no jitter (aspect-video hero, transform-free promote), reduced-motion (CSS `motion-reduce:` + `@keyframes` gated), resume-first content + key-bug fix (Task 7), backend progress/resume/addedAt (Task 2, Task 1), NEW badge (Tasks 3–5), responsive (Task 6 layout), no-duplicate-row (Task 7 test), testing across all four layers (Tasks 1–8). All spec sections map to tasks.
- **Placeholder scan:** No TBD/TODO; every code step shows full code; every test shows real assertions.
- **Type consistency:** `HomeCard` (Task 3) is consumed identically in Tasks 4–7; `progress`/`resume` shapes match the API output (Task 2) and the helpers (`resumeLabel`, Task 3); `useItemDetail` key `["item", id]` matches the cache seeded in Tasks 6–7 and the pre-existing HomePage usage; `continueWatching` return (Task 1) matches the `cwByItem` reader (Task 2).
- **Known deviation from spec (intentional, simpler):** `/items/:id` is **not** modified — the hero's NEW badge/progress/resume come from the `HomeCard` the row already provides. Noted here so a reviewer expecting a `catalog.ts` change knows it was deliberately avoided.
