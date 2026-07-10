# Homepage rows expansion — design

**Date:** 2026-07-05
**Goal:** The homepage renders only four row types (Continue Watching, Because You Watched,
Hidden Gems, Tonight) — and a fresh profile sees just two of them (no history → no
continue/because rows). Generate section ideas and add the best ones, so every profile gets a
rich, Netflix-density homepage.

## Idea pool (brainstormed)

Catalog-driven (work for fresh profiles):

1. **Recently added** — newest library additions (`addedAt` desc). The single most-expected
   row on a self-hosted server: "I just ripped/downloaded something, show it to me."
2. **Critically acclaimed** — top titles by the existing multi-source `qualityScore`
   (IMDb/RT/Metacritic/TMDB, all already cached).
3. **Genre rows** ("Comedy", "Sci-Fi", …) — the Netflix staple; personalized pick of *which*
   genres via watch-history affinity, catalog-frequency fallback for fresh profiles.
4. **Binge-worthy series** — `kind = "series"` spotlight; homepages of mixed libraries are
   otherwise movie-dominated.
5. Short & sweet (runtime < 90 min) — overlaps Tonight's runtime-comfort objective; skip.
6. Throwback / by-decade rows — Hidden Gems already boosts older titles (`ageDiscoveryScore`);
   skip to avoid two nostalgia rows.
7. Family night (G/PG on adult profiles) — niche; kids profiles already get a filtered whole
   home; skip.

Profile-driven:

8. **From your wishlist** — the user's explicit watch-later list, today buried on `/wishlist`.
   Highest-intent row on the page.
9. Watch it again (finished titles) — low value at library scale where rewatching is a search
   away; skip for now.
10. Director/actor spotlight — needs a densely-credited library to fill; deferred.
11. Top picks for you — objective already covered by Tonight + Hidden Gems blend; skip.

## Selected rows (1–4, 8)

| key | title (en) | membership | needs |
|---|---|---|---|
| `wishlist` | From your wishlist | profile wishlist order (newest first), played kept | WishlistEntry input |
| `recentlyAdded` | Recently added | unplayed, `addedAt` desc | — |
| `genre:<Name>` ×2 | genre name (localized server-side) | unplayed in genre, quality+affinity+freshness, diverse | genre affinity ranking |
| `topRated` | Critically acclaimed | unplayed with ≥1 real rating and qualityScore ≥ 0.68, desc | — |
| `series` | Binge-worthy series | unplayed `kind="series"`, quality+affinity+freshness, diverse | `kind` on RowCatalogItem |

A fresh profile now gets up to six rows (recentlyAdded, hiddenGems, genre×2, tonight,
topRated, series); an active profile up to ten.

## Row order (emission = computation = priority)

1. `continue` 2. `wishlist` 3. `becauseYouWatched` 4. `recentlyAdded` 5. `hiddenGems`
6. `genre` #1 7. `tonight` 8. `genre` #2 9. `topRated` 10. `series`

Factual rows (continue, wishlist, recentlyAdded) neither consume nor feed the
`surfacedRecommendationIds` dedupe set. Discovery rows (becauseYouWatched top-N, hiddenGems,
genre, tonight, topRated, series) exclude previously surfaced ids and add their picks, in
emission order — earlier rows win contested items. Tonight now feeds the set too (it is no
longer last).

## Invariants preserved

- **Pure core.** All membership logic stays in `packages/core/src/discovery/rows.ts`
  (`buildSmartRows`) — no Date.now/Math.random, deterministic tiebreaks (`id` asc).
- **All-played catalog + empty wishlist + no continue → zero rows** (existing test):
  every new discovery row filters `!playedByProfile`; recentlyAdded does too (its job is
  "new things you haven't seen", and played items already live in Continue/history).
- **Kids filtering stays server-enforced:** the route's catalog query and the must-include
  union query both already apply `kidsRatingWhere`; wishlist ids join through the same
  filtered `itemById`, so a capped profile can never see a blocked wishlist/genre item.
- **Additive API.** `/home/rows` keeps its shape (`{key, title, items}`); tvOS renders rows
  generically by key+server title, so new rows appear there with zero client changes.

## Mechanics

- **Min row size 4** for the new discovery rows (recentlyAdded, genre, topRated, series):
  a two-card "row" reads as broken. Wishlist renders from 1 item (explicit user intent).
- **Genre pick:** rank genres by frequency over history items' features; if history yields
  < 3 genre-bearing items, rank by unplayed-catalog frequency. Take the first two genres
  whose candidate row (after exclusions) reaches the minimum size. Genre-row scoring:
  0.5·quality + 0.3·affinity + 0.2·freshness, `selectDiverse` (penalty 0.12), limit 12.
- **topRated:** requires ≥ 1 finite rating source (no 0.55 unrated default) and
  qualityScore ≥ 0.68; sorted desc, limit 10.
- **series:** 0.45·quality + 0.3·affinity + 0.25·freshness, `selectDiverse`, limit 10.
- **recentlyAdded:** unplayed sorted by `addedAt` desc (missing addedAt sinks), limit 20.
- **wishlist:** ids in stored order filtered to catalog membership, limit 20.

## API route changes (`apps/api/src/routes/discovery.ts`)

- Add `kind` to `itemSelect` and the catalog mapping.
- Load `wishlistEntry.findMany({where:{profileId}, orderBy:{addedAt:"desc"}})` in the
  existing parallel batch; union its ids into `mustIncludeIds` (extras query keeps the kids
  rating filter — blocked items simply drop out).
- Pass `wishlist` to `buildSmartRows`.
- Localize `genre:*` row titles: when `lang !== "en"`, look up `GenreTranslation` for the
  emitted genre names and substitute. (`becauseYouWatched` already embeds a localized item
  title the same way — data-bearing titles come from the server.)

## Web changes

- `MediaRow.LOCALIZED_ROW_KEYS` += `wishlist`, `recentlyAdded`, `topRated`, `series`.
- `locales/{en,es,de,pt,ru,fr}/catalog.json` add the four headings, reusing each locale's
  established wishlist noun ("Мой список", "Mi lista", …). Genre rows keep the
  server-provided (already localized) title.

## Testing

- Core vitest: wishlist order/played-kept/omitted-when-empty; recentlyAdded order + unplayed
  + min-size; genre pick from history vs catalog fallback + no dup between genre rows;
  topRated rating-required + threshold; series kind filter; global no-dup among discovery
  rows; determinism; the all-played → zero-rows invariant (wishlist row exempt).
- API vitest: wishlist row hydration + must-include beyond cap; genre title localization.
- Existing web HomePage/MediaRow tests keep passing (rows are data-driven).
