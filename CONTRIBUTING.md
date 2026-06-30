# Contributing to Orbix

Thanks for helping make Orbix better. This guide describes how to prepare a change that can be reviewed and merged.

## Before You Start

- Read [README.md](README.md), [deploy/README.md](deploy/README.md), and the current design notes under `docs/superpowers/`.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all project spaces.
- Check existing issues and pull requests before opening duplicate work.
- For security issues, do not open a public issue. Use [SECURITY.md](SECURITY.md).
- Keep changes scoped. A small pull request with a clear behavior change is easier to review than a broad refactor.

## Product Constraints

Preserve these properties unless a maintainer explicitly accepts a design change:

- Browsing and playback must work offline after scan/enrichment.
- TMDB and other remote providers are scan/admin-time inputs only; metadata and artwork must be cached locally.
- HLS playback must use the bundled `hls.js`; do not load it from a CDN.
- Embeddings should use local model files; runtime remote model downloads are not acceptable by default.
- Kids safety is server-enforced. UI-only filtering is a defect.
- Production media mounts are read-only. Orbix should never modify user media files.

## Development Setup

Use Node 22 and the repo-local pnpm version pinned in `packageManager`.

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:generate
pnpm db:migrate
```

Default local services:

- Web: `http://localhost:1060`
- API: `http://localhost:1061`
- Postgres: `localhost:1062`
- Redis: `localhost:1063`

Do not commit `.env`, `deploy/.env`, real tokens, media paths, or logs containing secrets.

## Architecture Rules

- Put reusable domain logic in `packages/core` when feasible.
- Keep API route handlers thin: validate, authorize, call domain/data helpers, serialize.
- Prefer dependency injection for filesystem, network, database, ffmpeg, and model side effects.
- Use Prisma for normal database access. Use raw SQL only where necessary and keep it parameterized.
- Convert Prisma `BigInt` values to strings before returning JSON.
- Use `requireAuth(app)` for authenticated API routes and `requireNonKids(app)` for admin/management routes that kids profiles must not use.

## Testing

Run the narrowest relevant checks while developing, then run the package gates for touched packages before opening a pull request.

Main gates:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --filter @orbix/web test:e2e
```

Focused examples:

```bash
pnpm --filter @orbix/core test
pnpm --filter @orbix/core exec vitest run src/playback/strategy.test.ts
pnpm --filter @orbix/api test
pnpm --filter @orbix/api lint
pnpm --filter @orbix/web build
docker compose -f deploy/portainer-stack.yml config
```

If you cannot run a relevant check, say exactly which check was skipped and why in the pull request.

## Pull Requests

A good pull request includes:

- A concise description of the behavior change.
- Tests or a clear explanation for why tests are not practical.
- Screenshots or short screen recordings for UI changes.
- Notes for migrations, deployment changes, or compatibility risks.
- Confirmation that no real secrets, media paths, or private logs are included.

Use conventional commit style where it helps readability, but it is not required unless maintainers ask for it.

## Developer Certificate of Origin

Orbix uses the Developer Certificate of Origin 1.1. By signing off your commits, you certify that you have the right to submit the contribution under the project license.

Add a sign-off with:

```bash
git commit -s
```

Each commit should include a line like:

```text
Signed-off-by: Your Name <you@example.com>
```

## License of Contributions

By contributing to Orbix, you agree that your contributions are licensed under the same license as the project: GNU Affero General Public License v3.0 only (`AGPL-3.0-only`).
