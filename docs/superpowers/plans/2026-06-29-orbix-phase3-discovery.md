# Orbix Phase 3 — Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a large library findable — auto-generated smart home rows ("Because you watched X", "Hidden gems", "Pick something for tonight") AND natural-language mood search ("something light and funny under 2 hours") — all working fully offline.

**Architecture:** Two independently-valuable layers. (1) **Smart rows**: pure content-based similarity from data Orbix already has (genres/keywords/cast/director overlap) + per-profile watch history — zero ML, robust, ships first. (2) **NL mood search**: a regex constraint parser (runtime/decade/genre/rating) narrows candidates, then local sentence embeddings (`@huggingface/transformers` + `bge-small-en-v1.5`, int8) rank the residual free-text by cosine over `pgvector` (brute-force). Embeddings are generated at scan/enrich time and at a backfill; the model is baked into the api image so nothing hits the internet at query time. The constraint parser is a swappable interface so a local LLM can replace the regex later.

**Tech Stack:** `@huggingface/transformers` (onnxruntime-node) + `bge-small-en-v1.5` int8 (384-dim) for embeddings; `pgvector` brute-force cosine (`<=>`); pure-TS regex constraint parser; Prisma; Fastify; Next 15; Vitest. All similarity/parser/constraint logic is pure DI-tested core; embedding generation runs only in the api.

## Global Constraints

- **Language:** TypeScript, `"strict": true`. Recommendation/similarity/constraint logic lives in `packages/core` (framework-agnostic, dependency-injected, unit-tested with NO model load / NO DB). Embedding generation (the only place the model loads) runs in the api.
- **Offline is mandatory:** NL search and smart rows must work with the network down. The embedding model files are baked into the api image (or mounted on a `models` volume); set transformers.js `env.allowRemoteModels = false` + `env.localModelPath`. No query-time internet.
- **Vector storage:** add an `Embedding` table with a `pgvector` `vector(384)` column (the `vector` extension is already enabled from Phase 1). At thousands of items use **brute-force** cosine (`ORDER BY vector <=> $1 LIMIT k`), NO ANN index.
- **Degrade gracefully:** if embeddings are absent (model not yet downloaded / backfill not run), NL search falls back to constraint-filter + title/overview substring ranking, and smart rows work regardless (they need no embeddings). The app must never hard-fail because the model is missing.
- **Ports/services unchanged** (web 1060, api 1061, postgres 1062, redis 1063). Dockerized postgres+redis running for integration. Embedding generation is heavy → runs as a BullMQ job (reuse the Phase 1 queue) or inline during enrich, not on a request.
- **New env:** `MODELS_DIR` (default `./data/models`, gitignored; baked/mounted), `EMBEDDINGS_ENABLED` (default `true`; allows disabling the model entirely on weak hardware).
- **Per-profile:** smart rows use the active `orbix_profile` cookie's history (`PlayEvent`/`PlaybackState`). No cross-profile leakage.
- **Commits:** conventional-commit; bodies end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. TDD: failing test first for all core logic.

---

## File Structure

```
packages/db/prisma/schema.prisma     # + Embedding (vector 384), PlayEvent (history)
packages/config/src/env.ts           # + MODELS_DIR, EMBEDDINGS_ENABLED
packages/core/src/discovery/
  similarity.ts                      # itemSimilarity(a,b) from genre/keyword/cast/director overlap
  rows.ts                            # buildSmartRows(history, candidates, sims) -> labeled rows
  constraints.ts                     # parseConstraints(query) -> {runtimeMaxSec?, decade?, genres[], ratingMax?, residualText}
  rank.ts                            # rankByVector(queryVec, candidates) + cosine helper (pure)
apps/api/src/discovery/
  embedder.ts                        # loadEmbedder() (transformers.js, offline) + embedText(text)->number[]
  embed-worker.ts                    # BullMQ: embed an item's text -> Embedding row (+ backfill all)
apps/api/src/routes/
  discovery.ts                       # GET /home/rows ; GET /search?q= ; POST /embeddings/backfill (admin)
apps/web/src/
  app/page.tsx                       # home: render smart rows (replaces the placeholder welcome)
  app/search/page.tsx                # NL mood search box + results
  components/MediaRow.tsx            # a horizontal poster row (reused by home + search)
```

---

### Task 1: History + Embedding schema + env

**Files:** `packages/db/prisma/schema.prisma` (+ migration), `packages/config/src/env.ts`, `.env.example`

**Interfaces:**
- Produces: `PlayEvent { id, profileId, mediaItemId, at }` (a row appended whenever playback starts — wire a tiny append into the existing `PUT /items/:id/progress` when positionSec crosses a small threshold, so history exists). `Embedding { mediaItemId @id, vector Unsupported("vector(384)"), text, model, updatedAt }`. `env.MODELS_DIR` (default `./data/models`), `env.EMBEDDINGS_ENABLED` (default `true`, coerced bool).

- [ ] **Step 1: schema** — add `PlayEvent` (`@@index([profileId, at])`) and `Embedding`. Because Prisma lacks native `vector`, declare the column via `Unsupported("vector(384)")` and create the table through the migration; raw SQL (`<=>`) is used for queries. Migrate `--name discovery`; `prisma generate`.
- [ ] **Step 2: env** — `MODELS_DIR: z.string().default("./data/models")`, `EMBEDDINGS_ENABLED: z.coerce.boolean().default(true)`. `.env.example` comments. Phase 0 env test still passes (defaulted).
- [ ] **Step 3: history wiring** — in `PUT /items/:id/progress`, after upsert, if this is the first progress for `(profile,item)` in the last N hours (or positionSec small), `prisma.playEvent.create(...)`. Keep it cheap; don't block the response on failure.
- [ ] **Step 4: verify + commit** — migration applied (`\d "Embedding"`, `\d "PlayEvent"`), api typecheck 0. Commit `feat(db): PlayEvent history + Embedding(vector 384) + discovery env`.

---

### Task 2: Content similarity (`packages/core/src/discovery/similarity.ts`) — TDD, pure

**Interfaces:**
- Produces: `itemSimilarity(a, b): number` where each item is `{ genres:string[], keywords:string[], cast:string[], director?:string }`. Weighted Jaccard-ish: `0.4*genreOverlap + 0.3*keywordOverlap + 0.2*castOverlap + 0.1*(sameDirector?1:0)`, each overlap = `|∩| / |∪|` (0 if both empty). Range 0..1.

- [ ] **Step 1: failing tests** — identical items → 1.0; disjoint → 0; shared director only → 0.1; partial genre+keyword overlap → expected weighted value (compute by hand). **Step 2: fail → 3: implement → 4: pass. Step 5: commit** `feat(core): content-based item similarity`.

---

### Task 3: Smart-row builder (`packages/core/src/discovery/rows.ts`) — TDD, pure

**Interfaces:**
- Produces: `buildSmartRows(input): SmartRow[]` where `SmartRow = { key, title, itemIds: string[] }`. `input = { continueWatching:{mediaItemId}[], history:{mediaItemId}[], catalog:{id,...features,rating,playedByProfile:boolean}[], simOf:(a,b)=>number }`. Rows produced (skip a row if it would be empty):
  - `continue` "Continue Watching" — from continueWatching ids.
  - `becauseYouWatched` "Because you watched <title>" — pick the most recent history item, top-N most similar unplayed catalog items.
  - `hiddenGems` "Hidden gems" — high-affinity-to-history but never played (or, with no history, just unplayed items — keep deterministic ordering).
  - `tonight` "Pick something for tonight" — a small affinity-weighted selection of unplayed items (deterministic given the input; no RNG — order by a score, take K).
- Pure & deterministic (no Date.now/Math.random; the API supplies ordering inputs).

- [ ] **Step 1: failing tests** — given a small fixture (history of 1 item, a catalog with similar/dissimilar/played items + a `simOf` stub), assert each row contains the right ids in the right order, played items excluded from recommendation rows, empty rows omitted. **Step 2: fail → 3: implement → 4: pass. Step 5: commit** `feat(core): smart home-row builder`.

---

### Task 4: Home rows route + home UI + MediaRow

**Files:** `apps/api/src/routes/discovery.ts` (the `/home/rows` part), `apps/web/src/app/page.tsx`, `apps/web/src/components/MediaRow.tsx`; register route.

**Interfaces:**
- Produces (active profile required): `GET /home/rows` → `[{ key, title, items:[{id,title,year,posterPath}] }]`. The api loads the profile's continueWatching + history + the section's catalog (with genres/keywords/cast/director features via the joins), calls `buildSmartRows` with `itemSimilarity`, and hydrates ids → item cards. Cap items per row (e.g. 20). Web: home page renders the rows as horizontal `MediaRow`s (poster cards linking to `/title/:id`); the first row is Continue Watching. Replaces the "Welcome to Orbix" placeholder.

- [ ] **Step 1** route (assemble inputs, call core, hydrate). **Step 2** `MediaRow.tsx` + home page rendering rows. **Step 3** typecheck + build; smoke: seed history → `GET /home/rows` returns a "Because you watched" row; home renders rows. **Step 4** commit `feat(web): smart home rows (continue/because-you-watched/hidden-gems/tonight)`.

---

### Task 5: NL constraint parser (`packages/core/src/discovery/constraints.ts`) — TDD, pure

**Interfaces:**
- Produces: `parseConstraints(query): { runtimeMaxSec?, runtimeMinSec?, decadeStart?, decadeEnd?, genres:string[], ratingMax?, residualText:string }`. Regex extraction:
  - "under/less than 2 hours|90 minutes|90 min" → runtimeMaxSec; "over/at least X" → runtimeMinSec.
  - "from/in the 90s|1990s|2000s" → decade range; "before 2000"/"after 2010" → bounds.
  - genre words (a known list: funny→Comedy, scary→Horror, light, tense, etc. mapped to TMDB genres where possible) → genres[].
  - "for kids|family|G|PG" → ratingMax.
  - residualText = the query with matched constraint phrases stripped (for embedding).

- [ ] **Step 1: failing tests** — "something light and funny under 2 hours" → `runtimeMaxSec:7200, genres includes Comedy, residualText ~ "light"`; "tense thriller from the 90s" → decade 1990-1999, genres includes Thriller; "movie under 90 minutes" → 5400. **Step 2: fail → 3: implement → 4: pass. Step 5: commit** `feat(core): NL search constraint parser`.

---

### Task 6: Vector rank helper (`packages/core/src/discovery/rank.ts`) — TDD, pure

**Interfaces:**
- Produces: `cosine(a:number[], b:number[]): number`; `rankByVector(queryVec, candidates:{id,vector}[], k): {id,score}[]` (sorted desc, top k). Pure — the DB does the real brute-force in prod, but this is the unit-tested reference + used for in-memory ranking of a constraint-filtered candidate set when small.

- [ ] **Step 1: failing tests** — cosine of identical unit vectors → 1; orthogonal → 0; rankByVector orders by similarity, respects k. **Step 2: fail → 3: implement → 4: pass. Step 5: commit** `feat(core): cosine + vector ranking helper`.

---

### Task 7: Embedder (`apps/api/src/discovery/embedder.ts`) + embedding worker

**Files:** `apps/api/src/discovery/embedder.ts`, `apps/api/src/discovery/embed-worker.ts`; `apps/api/package.json` (+ `@huggingface/transformers`); wire embed-on-enrich + a backfill into the queue.

**Interfaces:**
- Produces: `loadEmbedder(opts:{modelsDir, allowRemote:false})` → caches a pipeline; `embedText(text):Promise<number[]>` (384-dim, bge query/passage prefix as appropriate). `embedItemText(item)` builds `title + overview + genres + keywords`. A BullMQ `embed` job upserts `Embedding` (raw SQL to write the `vector` column). A `backfillEmbeddings()` enqueues all matched items lacking an embedding. **Offline:** `env.allowRemoteModels=false`, `env.localModelPath=MODELS_DIR`; if `EMBEDDINGS_ENABLED=false` or the model isn't present, `embedText` throws a typed `EmbedderUnavailable` and callers degrade.

- [ ] **Step 1** add the dep; `pnpm install` (note: onnxruntime-node native binary — ensure it builds; add to `pnpm.onlyBuiltDependencies` if needed). **Step 2** implement `embedder.ts` with the offline env flags; a focused api test that EITHER (if the model is present/downloadable in this env) embeds a string and asserts a 384-length numeric vector, OR (if not) asserts `embedText` throws `EmbedderUnavailable` cleanly — the test must pass either way and NEVER require network. **Step 3** the embed worker + backfill (write the vector via `prisma.$executeRaw` with the `vector` literal). **Step 4** integration smoke (best-effort): if the model loads, backfill a couple of matched items and confirm `Embedding` rows exist; if the model can't load offline in this env, report that truthfully and confirm the degrade path. **Step 5** commit `feat(api): offline sentence-embedder + embedding backfill worker`.

**Honesty:** the model download/native-binary may not work in every env. The MUST-pass is: the code is correct + offline-flagged + degrades cleanly (typed unavailable), proven by the unit test; the live embedding is best-effort and reported truthfully.

---

### Task 8: Search route (`/search`) + search UI

**Files:** `apps/api/src/routes/discovery.ts` (the `/search` part), `apps/web/src/app/search/page.tsx`; reuse `MediaRow`/cards.

**Interfaces:**
- Produces (active profile optional, auth required): `GET /search?q=` → `{ items:[{id,title,year,posterPath,matchState}], usedEmbeddings:boolean }`. Pipeline: `parseConstraints(q)` → SQL filter the catalog by runtime/decade/genre/rating → if embeddings available AND residualText non-empty: `embedText(residualText)` then `ORDER BY embedding.vector <=> $queryvec LIMIT k` over the filtered candidate ids (raw SQL join); ELSE rank by title/overview ILIKE %residual% + recency (the degrade path). Always returns sensible results offline. Web: `/search` page with a query box + results grid; link from the header/home.

- [ ] **Step 1** route with BOTH paths (embeddings + degrade), `usedEmbeddings` flag. **Step 2** search page UI. **Step 3** typecheck + build; smoke: `GET /search?q=comedy under 2 hours` returns constraint-filtered results (with or without embeddings); the degrade path returns results when embeddings off. **Step 4** e2e (`discovery.spec.ts`): seed items with genres/runtime, onboard+select profile, search "comedy under 2 hours", assert matching titles appear and a too-long/non-comedy item is excluded (constraint path — deterministic, no model needed). **Step 5** commit `feat(web): natural-language mood search (constraints + vector/degrade)`.

---

## Self-Review

**Spec coverage (Phase 3 "Done when": home shows relevant personalized rows AND "something funny under 2 hours" returns a sensible, correctly-filtered shortlist — offline):**
- Smart rows (continue/because/gems/tonight) → Tasks 2,3,4 (no ML, always work). NL search: constraint parse → Task 5; vector rank → Tasks 6,7,8; offline embedder baked + degrade → Task 7,8. History for personalization → Task 1. Vector storage (pgvector brute-force) → Tasks 1,7,8. ✅
- The offline guarantee is enforced by `allowRemoteModels=false` + baked model + a degrade path that never hard-fails.

**Placeholder scan:** core tasks (2,3,5,6) are full TDD; api/UI tasks (1,4,7,8) give interfaces + key code + smokes/e2e following the established patterns. The embedder's live behavior is explicitly best-effort with a typed-unavailable degrade (no fake). No `TBD`.

**Type consistency:** `itemSimilarity` feeds `buildSmartRows` (via `simOf`) and the `/home/rows` route; `parseConstraints` output feeds the `/search` SQL filter + the residualText into `embedText`; `embedText` 384-dim matches `Embedding.vector(384)` and `cosine`/`rankByVector`; `usedEmbeddings` reflects the degrade branch. Consistent.

**Note for executor:** smart rows (Tasks 2-4) carry the headline value and have ZERO external dependency — land them solidly first. The embedding model (Task 7) is the only network/native-binary risk; it's isolated behind `EmbedderUnavailable` + a degrade path so the search feature ships usefully even if the model can't load in this environment. Never require network in any unit test.
