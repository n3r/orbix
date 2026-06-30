# Orbix

A self-hosted, open-source media server built to do three things better:

1. **Discovery for large libraries** — smart, auto-generated home rows *and* natural-language mood search ("something light and funny under 2 hours"), so you can find what to watch tonight without scrolling thousands of titles.
2. **Works during an internet outage** — all metadata and artwork are cached to local disk at scan time; browsing and playback never need the internet.
3. **A genuinely nice, fast UI** — modern, responsive, poster-forward.

Runs on your NAS via Docker/Portainer. Web-first (responsive); no native apps required.

## Features

- **Profiles** — Netflix-style household profiles (Personal / Family / Kids…) selected after login, each with its own watch history, resume positions, recommendations, and "My List". Kids profiles are **server-enforced** by maturity rating across every route.
- **Multi-source libraries** — libraries → sections → sources (folders); add/scan/manage from the admin UI. Incremental rescans.
- **Metadata enrichment** — TMDB metadata + locally-cached posters/backdrops (offline after scan). Manual match/poster fix UI for the inevitable mismatch. Periodic refresh job.
- **In-browser playback** — direct play for compatible files; on-the-fly **remux/transcode to fMP4 HLS** (ffmpeg) for MKV/HEVC/etc., with seek, subtitles (text → WebVTT), and per-profile resume + Continue Watching.
- **Discovery** — content-based smart rows + natural-language mood search using **local sentence embeddings** (bge-small via transformers.js + pgvector), fully offline; degrades gracefully if the model is absent.
- **Self-hostable** — dev stack via `docker compose`; production via a Portainer NAS stack with a baked offline model, read-only media mount, and persistent named volumes.

## Architecture

TypeScript monorepo (pnpm + Turborepo):

```
apps/
  web/      Next.js (App Router) + Tailwind — UI, player, admin
  api/      Fastify + Prisma — REST + SSE, auth, scan, stream, discovery
packages/
  core/     framework-agnostic domain logic (scanner, metadata, playback, discovery, ratings) — unit-tested
  db/       Prisma schema + migrations (Postgres + pgvector)
  ui/       shared design-system components
  config/   zod-validated env schema
deploy/     Portainer NAS production stack + guide
```

- **Postgres 16 + pgvector** (catalog, profiles, history, embeddings) · **Redis** (BullMQ scan/transcode jobs) · **ffmpeg** (remux/transcode).
- Hard domain logic (transcode strategy, HLS playlist/args, similarity, NL constraints, rating tiers) lives in `packages/core` with dependency injection so it's tested without ffmpeg, network, or a DB.

## Development

Requires Node 22, pnpm 10, Docker.

```bash
pnpm install
docker compose up -d          # postgres(+pgvector), redis, api, web
# web: http://localhost:1060   api: http://localhost:1061
```

Then open `http://localhost:1060`, complete the setup wizard, add a library pointing at your media, set a TMDB token in Settings, and scan.

```bash
pnpm typecheck && pnpm lint && pnpm test      # gates
pnpm --filter @orbix/web test:e2e             # Playwright e2e
```

## Deploy to a NAS

See [`deploy/README.md`](deploy/README.md) for the Portainer guide (stack, env, read-only media mount, first-run, backups, optional hardware transcoding).

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

TBD.
