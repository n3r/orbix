---
name: verify
description: Runtime-verify an Orbix change end-to-end — spin the dev compose stack on alternate ports, seed a synthetic catalog, drive /api and the web UI headlessly.
---

# Verifying Orbix changes at runtime

The dev stack (`docker compose up -d`) bind-mounts source into the api/web
containers (tsx watch / Vite HMR), so the running containers always serve the
checkout's working tree — no rebuild needed for src-only changes (rebuild only
when deps/Dockerfile change).

## Port conflicts (two checkouts)

Only one stack can own 1060–1063. If another Orbix compose project is running
(check `docker ps --format '{{.Names}}\t{{.Ports}}'`), do NOT stop it — remap
this checkout with an override (allocate free ports via `portctl` if present):

```yaml
# ports-override.yml — !override replaces instead of appending
services:
  postgres: { ports: !override ["1073:5432"] }
  redis:    { ports: !override ["1074:6379"] }
  api:      { ports: !override ["1072:1061"] }
  web:      { ports: !override ["1071:1060"] }
```

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml -f ports-override.yml up -d
```

`WEB_ORIGIN`/CORS doesn't matter through the Vite proxy (same-origin in the browser).

## Fresh DB → account, profile, session

`./data/postgres` is the bind-mounted cluster. If empty:

```bash
curl -s -H "Content-Type: application/json" -d '{"email":"verify@test.local","password":"verify-password-123"}' http://localhost:1072/api/setup
curl -s -c jar.txt -H "Content-Type: application/json" -d '{...same...}' http://localhost:1072/api/auth/login
curl -s -b jar.txt -c jar.txt -H "Content-Type: application/json" -d '{"name":"Verifier","kind":"standard"}' http://localhost:1072/api/profiles
curl -s -b jar.txt -c jar.txt -X POST -H "Content-Type: application/json" -d '{}' http://localhost:1072/api/profiles/<id>/select
```

Profile create REQUIRES `kind` ("standard" | "kids"+maturityCap) or it 400s
`invalid_profile`. Wipe `data/postgres` after verification if you seeded it —
a stale synthetic account confuses later sessions.

## Seeding a catalog without media files

Catalog/home/discovery routes only read Postgres — MediaItems don't need real
files unless you play them. Seed via
`docker exec -i <project>-postgres-1 psql -U orbix -d orbix -v ON_ERROR_STOP=1 < seed.sql`:

- `MediaItem` needs explicit `id` and `"updatedAt"` (cuid/updatedAt are
  Prisma-side, not DB defaults). Same for PlayEvent/PlaybackState/WishlistEntry ids.
- Genres/keywords: insert `Genre`/`Keyword`, link via `MediaItemGenre`/`MediaItemKeyword`.
- History = `PlayEvent` rows; continue-watching = `PlaybackState` (episodeId '' for movies);
  wishlist = `WishlistEntry` — all keyed by profileId.
- Discovery rows compete for supply: with <40 items later rows (topRated,
  series, genre #2) legitimately come up empty; seed ~70+ across several
  genres, mixed movie/series kinds, with imdbRating/rtRating set.

## Driving the web UI headlessly

The claude-in-chrome extension is often not connected; use Playwright from
apps/web (binaries are in ~/Library/Caches/ms-playwright). Session cookies are
port-agnostic (domain localhost) — copy them from the curl jar:

```js
import { chromium } from "@playwright/test";   // script must live under apps/web for module resolution
await ctx.addCookies([
  { name: "orbix_session", value: "<from jar>", domain: "localhost", path: "/", httpOnly: true },
  { name: "orbix_profile", value: "<profile id>", domain: "localhost", path: "/", httpOnly: true },
]);
await page.goto("http://localhost:1071/", { waitUntil: "networkidle" });
```

Row headings are `h2`; screenshot + `page.locator("h2").allTextContents()`
covers the homepage. NEVER run the Playwright e2e suite against a DB you care
about — its global-setup wipes accounts/profiles.

## Teardown

```bash
docker compose -p <project> down
rm -rf data/postgres          # only if you seeded a throwaway cluster
portctl release --app orbix --instance <name>
```
