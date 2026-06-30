# ──────────────────────────────────────────────────────────────────
# Orbix Web — Production Dockerfile
#
# Build context: repo root  (docker build -f apps/web/Dockerfile .)
#
# Design notes:
#  - next build runs during the image build. API_INTERNAL_URL is set to the
#    compose network address so rewrites are correctly configured at build time.
#    At runtime next.config.ts re-reads the env var so the actual value wins.
#  - next start is used at runtime; WEB_PORT is read from the environment
#    (defaults to 1060 if not provided).
# ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

RUN corepack enable

WORKDIR /app

# Copy full monorepo
COPY . .

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Set the internal API URL for next build (rewrites evaluation)
# At runtime this is overridden by the container's actual env var.
ENV API_INTERNAL_URL=http://api:1061

# Build Next.js app
RUN pnpm --filter @orbix/web build

# Web binds to $WEB_PORT at runtime (the stack sets it, default 8080).
# EXPOSE is advisory only; the actual published port is set in portainer-stack.yml.
EXPOSE 8080

CMD ["sh", "-c", "pnpm --filter @orbix/web exec next start -p ${WEB_PORT:-1060}"]
