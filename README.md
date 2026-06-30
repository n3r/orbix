# Orbix

[![CI](https://github.com/n3r/orbix/actions/workflows/ci.yml/badge.svg)](https://github.com/n3r/orbix/actions/workflows/ci.yml)

Orbix is a self-hosted, open-source media server for a household movie library. It is built for a LAN/NAS setup, with local metadata caching, browser playback, household profiles, and discovery features that keep working after scan-time enrichment.

## Project Status

Orbix is pre-1.0 MVP software. The core movie-library workflow is implemented, but APIs, deployment details, and data migrations may still change before a stable release. Use it for testing and early self-hosted deployments, not as an internet-exposed service.

## Core Promises

1. **Offline after scan** - browsing and playback should not require the internet after metadata and artwork have been enriched and cached locally.
2. **Fast discovery for large libraries** - smart home rows and natural-language mood search help find a movie without scrolling through everything.
3. **Self-hosted household UX** - responsive web UI, profiles, server-enforced kids filtering, and NAS-friendly Docker deployment.

## Features

- **Profiles** - household profiles with per-profile watch history, resume positions, recommendations, and lists. Kids profiles are enforced on the server across catalog, playback, and admin routes.
- **Libraries and scans** - libraries, sections, and read-only media sources managed from the admin UI, with incremental rescans.
- **Metadata enrichment** - TMDB metadata, posters, and backdrops are fetched during scan/admin actions and cached locally for offline browsing.
- **Playback** - direct play where possible, plus ffmpeg-based remux/transcode to fMP4 HLS for browser playback. HLS uses the bundled `hls.js`.
- **Discovery** - content-based rows and natural-language search using local sentence embeddings and pgvector; it degrades when embeddings are disabled or unavailable.
- **NAS deployment** - development stack with Docker Compose and production-oriented Portainer stack with persistent volumes and read-only media mounts.

## Repository Layout

```text
apps/
  web/      Next.js App Router UI, Tailwind, player, admin screens
  api/      Fastify API, Prisma access, auth/session cookies, REST/SSE routes, jobs
packages/
  core/     framework-independent domain logic
  db/       Prisma schema, migrations, singleton Prisma client
  config/   zod-validated runtime environment schema
  ui/       shared React UI components and design tokens
deploy/     Portainer/NAS production stack and deployment guide
docs/       design specs and phase plans
```

Hard domain logic belongs in `packages/core` where it can be tested without Fastify, Next.js, a database, ffmpeg, or network access. Application code should stay thin around validation, authorization, adapters, and serialization.

## Requirements

- Node.js 22+
- pnpm 10.22.0, pinned through `packageManager`
- Docker with Compose
- ffmpeg/ffprobe available in the API runtime
- A TMDB API token for metadata enrichment

## Quick Start

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:generate
pnpm db:migrate
```

Development services:

| Service | URL |
| --- | --- |
| Web | `http://localhost:1060` |
| API | `http://localhost:1061` |
| Postgres | `localhost:1062` |
| Redis | `localhost:1063` |

Open `http://localhost:1060`, complete the setup wizard, add a library source that points at your media, set a TMDB token in Settings, and scan.

## Verification

Main gates:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --filter @orbix/web test:e2e
```

Useful focused gates:

```bash
pnpm --filter @orbix/core test
pnpm --filter @orbix/api test
pnpm --filter @orbix/api lint
pnpm --filter @orbix/web build
pnpm --filter @orbix/web typecheck
docker compose -f deploy/portainer-stack.yml config
```

## Deploy

See [deploy/README.md](deploy/README.md) for the Portainer NAS guide, production environment variables, backup notes, hardware transcoding notes, and known kids-profile limitations.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, coding standards, test expectations, and the Developer Certificate of Origin sign-off requirement.

Project participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

For bugs, feature requests, and support questions, use the GitHub issue templates. Do not include secrets, real tokens, or private media paths in public issues.

## Security

Orbix is intended for trusted LAN use. Do not expose it directly to the public internet without a reverse proxy, TLS, and additional hardening. Report vulnerabilities privately through the process in [SECURITY.md](SECURITY.md).

## License

Orbix is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). Contributions are accepted under the same license.

This product uses the TMDB API but is not endorsed or certified by TMDB. See [NOTICE](NOTICE) for attribution details.
