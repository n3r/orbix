# ──────────────────────────────────────────────────────────────────
# Orbix API — Production Dockerfile
#
# Build context: repo root  (docker build -f apps/api/Dockerfile .)
#
# Design notes:
#  - Runs via tsx in production (avoids a complex TS/monorepo build step;
#    tsx is already a declared devDependency and resolves workspace imports).
#    This is intentional for MVP robustness over image size.
#  - The bge-small-en-v1.5 embedding model (~130 MB) is baked in during build
#    (ORBIX_ALLOW_MODEL_DOWNLOAD=true, network required at build time).
#    Model lives at /app/data/models inside the image, so MODELS_DIR defaults
#    to /app/data/models. No external volume is required for models.
#  - On container start: prisma migrate deploy runs, then the API starts.
# ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# System deps: ffmpeg + ffprobe (transcoding), curl (healthcheck),
# cifs-utils (mount SMB/CIFS shares for external library sources),
# intel-media-va-driver + vainfo (Intel VAAPI/QuickSync HW transcode via the iHD
# driver — needed for Gen8+/Alder-Lake iGPUs; without it, /dev/dri alone yields no
# working VAAPI encoders). The driver lives in Debian's non-free component, enabled
# just for this install step. Harmless on hosts without an Intel iGPU.
RUN . /etc/os-release \
    && echo "deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://deb.debian.org/debian ${VERSION_CODENAME} non-free non-free-firmware" \
       > /etc/apt/sources.list.d/nonfree.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg curl cifs-utils intel-media-va-driver vainfo \
    && rm -rf /var/lib/apt/lists/*

# Default VAAPI driver for modern Intel iGPUs (Gen8+/Alder Lake). Ignored if VAAPI
# is unused or no iGPU is present.
ENV LIBVA_DRIVER_NAME=iHD

# Enable corepack so pnpm is available
RUN corepack enable

WORKDIR /app

# ── Layer ordering matters: cheap-to-invalidate copies come LAST. ────
# Only the dependency manifests are copied before `pnpm install`, and only the
# model script before the model bake, so a plain code change re-runs just the
# final source copy + Prisma/Vite build — NOT `pnpm install` or the ~130 MB
# HuggingFace model download (both slow and flaky over the network).

# 1. Dependency manifests only → install (cached unless a package.json/lock changes)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/ui/package.json ./packages/ui/
# Install all dependencies (including devDeps so tsx + prisma CLI are available)
RUN pnpm install --frozen-lockfile

# 2. ── Bake the embedding model (needs network at build time) ────────
# Downloads Xenova/bge-small-en-v1.5 (~130 MB) into /app/data/models. Copied
# with only the script present so a source change never re-triggers the
# download (the script + installed deps are its only inputs).
# Set MODELS_DIR=/app/data/models at runtime (matches this baked path).
# If this step fails (no network), remove it and use option (b):
#   mount an orbix-models volume, set MODELS_DIR=/data/models, and call
#   POST /discovery/backfill after first run to trigger the download.
COPY apps/api/scripts/download-model.mjs ./apps/api/scripts/
RUN MODELS_DIR=/app/data/models \
    node apps/api/scripts/download-model.mjs

# 3. Full monorepo source, then the code-dependent build steps.
COPY . .

# Generate Prisma client
RUN pnpm --filter @orbix/db exec prisma generate

# Build the Vite SPA; Fastify serves it from WEB_DIST via @fastify/static.
# (Collapses the former separate web container into this one — same origin.)
RUN pnpm --filter @orbix/web build
ENV WEB_DIST=/app/apps/web/dist

EXPOSE 1061

# Run migrations then start the API via tsx
CMD ["sh", "-c", \
  "pnpm --filter @orbix/db exec prisma migrate deploy && \
   pnpm --filter @orbix/api exec tsx src/server.ts"]
