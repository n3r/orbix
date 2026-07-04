# Orbix → DXP4800 NAS Deployment — Design

**Date:** 2026-07-01
**Goal:** Deploy Orbix onto the DXP4800 Plus primary NAS so it can be tested against
the real (large) media library, with hardware transcoding enabled.

---

## Target environment

| Property | Value |
|----------|-------|
| Host | DXP4800 Plus (UGREEN), `192.168.1.95` |
| SSH | `ssh dxp4800` → `nik3r@192.168.1.95` |
| OS | Debian 12 (UGOS), x86_64 |
| CPU/GPU | Intel (Alder Lake-N class) with iGPU (`/dev/dri`) |
| RAM | 32 GB |
| Docker | Installed (Docker + compose plugin) |
| Firewall | Not installed on the NAS → published ports are LAN-reachable |
| Media | Shared folder `/Media` (real host path to be detected at deploy) |

Existing services to avoid colliding with: Plex `32400`, Jellyfin `8096`,
qBittorrent `8888`, UGOS web `9443/9999`, Node Exporter `9100`, iperf `5201`.
Orbix will publish `8080` (expected free — verified in Phase 0).

## Decisions (locked)

1. **Deploy method:** plain `docker compose` over SSH, built **on the NAS** from the
   repo source. No Portainer on the NAS (Portainer lives on Homelab).
2. **Media path:** the real host path behind `/Media` is **detected during deploy**,
   not assumed, then bind-mounted read-only to `/media` via `ORBIX_MEDIA_PATH`.
3. **Access:** `http://192.168.1.95:8080` (IP:port only; no reverse proxy / DNS now).
4. **Hardware transcoding:** VAAPI/QuickSync **enabled from the start**.

## Stack shape

Reuse `deploy/portainer-stack.yml` (postgres + redis + single api-that-serves-SPA)
unchanged, driven by a `deploy/.env` on the NAS, plus a NAS-only GPU override file so
the tracked stack file stays pristine:

- `deploy/portainer-stack.yml` — base stack (already in repo).
- `deploy/.env` — secrets + host paths (created on the NAS, never committed).
- `deploy/dxp4800.gpu.override.yml` — adds `/dev/dri` device + `render` group for VAAPI.

Compose invocation on the NAS:

```
docker compose --env-file deploy/.env \
  -f deploy/portainer-stack.yml \
  -f deploy/dxp4800.gpu.override.yml \
  up -d --build
```

## Image change required for VAAPI

The production image (`apps/api/Dockerfile`, `node:22-bookworm-slim`) installs
`ffmpeg` + `curl` + `cifs-utils` but **no Intel VAAPI runtime driver**. Mapping
`/dev/dri` alone will not give working VAAPI on Alder-Lake-N. Add the Intel media
driver + `vainfo` to the image (enabling Debian `non-free` for that package):

- `intel-media-va-driver` (iHD driver for modern Intel iGPUs)
- `vainfo` (diagnostics; lets us confirm the driver loads inside the container)

The in-app **"Test encoders"** button (Settings → Encoder, PR #18) is the
post-deploy verification gate: if `hevc_vaapi`/`h264_vaapi` pass there, HW transcode
is live; if not, we fall back to software cleanly and debug the driver.

## Phases

### Phase 0 — Access & recon (blocker first)
- Establish **non-interactive SSH** to the NAS (authorize a key via `ssh-copy-id`
  using the stored password once). Nothing else proceeds until this works.
- Read-only probe: real host path behind `/Media` (inspect Plex/Jellyfin bind mounts
  + `findmnt` / `/proc/mounts`); `/dev/dri` contents and `render`/`video` group GIDs
  (`getent group render`); free space on `/var/lib/docker`; port `8080` free
  (`ss -ltn`); internet reachable for the build.

### Phase 1 — Image change
- Edit `apps/api/Dockerfile`: add the Intel VA driver + `vainfo`.

### Phase 2 — Code + config onto the NAS
- `rsync` the working tree → `~/orbix` on the NAS, excluding `node_modules`, `data/`,
  `.git`, `apps/*/dist`, `deploy/.env`, and the root `docker-compose.override.yml`.
- Create `deploy/.env` on the NAS from `.env.production.example`:
  - `POSTGRES_PASSWORD` (strong) and matching `DATABASE_URL`
  - `SESSION_SECRET` = `openssl rand -base64 32` (≥32 chars)
  - `WEB_ORIGIN=http://192.168.1.95:8080`, `WEB_PORT=8080`
  - `ORBIX_MEDIA_PATH=<detected host path>`
  - `REDIS_URL=redis://redis:6379`, `EMBEDDINGS_ENABLED=true`, `NODE_ENV=production`
- Create `deploy/dxp4800.gpu.override.yml`:
  ```yaml
  services:
    api:
      devices:
        - "/dev/dri:/dev/dri"
      group_add:
        - "<render GID>"   # numeric host GID from getent group render
  ```

### Phase 3 — Deploy
- Run the compose invocation above from `~/orbix` (first build ~5–15 min: pnpm
  install, SPA build, ~130 MB model bake — all need network).
- Watch `api` logs: `prisma migrate deploy` applies migrations → "Server listening on
  port 1061" → container healthcheck goes healthy.

### Phase 4 — First run & verify
- Open `http://192.168.1.95:8080` → setup wizard → create admin account.
- Settings → Integrations → enter **TMDB token** (+ TVDB token if used).
- Settings → Encoder → **Test encoders** → confirm VAAPI encoders pass → select
  `hevc_vaapi` or `h264_vaapi`.
- Libraries → Add Library → source path **`/media`** → **Scan**; watch scan progress.
- Play a title that requires transcoding → confirm HLS playback and that VAAPI is used.

### Phase 5 — Wrap-up
- Record persistent data locations (named volumes `orbix-db`, `orbix-metadata`,
  `orbix-transcode`, `orbix-mounts`) and backup one-liners (see `deploy/README.md`).
- Optional follow-up: add Orbix to `network_msk` docs/changelog; add `orbix.lan` +
  nginx reverse proxy later if we want a hostname instead of IP:port.

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| VAAPI runtime driver missing from image | Phase 1 adds `intel-media-va-driver`; Test Encoders confirms; clean software fallback |
| SSH key not authorized on NAS | Resolved in Phase 0 before any deploy action |
| `/Media` real host path unknown | Detected in Phase 0 (Plex bind inspection + findmnt), not assumed |
| Build needs internet + disk | Verified reachable/free in Phase 0; NAS already runs internet services |
| Port `8080` already used | Verified free in Phase 0; if taken, set `WEB_PORT`/`WEB_ORIGIN` to a free port |
| `render` group GID mismatch inside container | Use the numeric host GID in `group_add`; api runs as root so device access works regardless |
| Secrets leakage | `deploy/.env` created only on the NAS, excluded from rsync and never committed |

## As-built (2026-07-01)

Deployed successfully to `http://192.168.1.95:8080` (container `deploy-api-1`,
postgres + redis healthy, all 12 migrations applied, `/health` → `{"status":"ok",
"db":true}` from the LAN). Confirmed facts and deviations from the original plan:

- **Media host path:** `/volume1/Media` (world-readable btrfs), mounted read-only to
  `/media`; 9 top-level library folders visible in-container.
- **iGPU:** `render` GID **105**, `video` GID 44; `/dev/dri` mapped via the override.
- **VAAPI confirmed:** Intel **iHD driver 23.1.1** loads inside the container; H.264 +
  HEVC hardware encode entrypoints (`VAEntrypointEncSliceLP`) available.
- **Sudo/docker:** `nik3r` was not in the `docker` group and sudo needs a password;
  resolved by adding `nik3r` to the `docker` group (one-time), enabling unattended
  compose over SSH.
- **Code transfer:** `git archive HEAD | ssh … tar x` (the NAS rsync 3.4.1 rejected the
  transfer with an IO error); ships only tracked source.

Two real bugs found and fixed on this branch (both would bite any deployer):

1. **`WEB_PORT` missing from the api container env** — `deploy/portainer-stack.yml`
   used `WEB_PORT` only in the host `ports:` mapping, but `loadEnv()` requires it as an
   int, so the container crash-looped with *"Invalid environment: WEB_PORT: Expected
   number, received nan"*. Fixed by passing `WEB_PORT` into the api environment.
2. **Debian `non-free` Signed-By conflict** — a plain `nonfree.list` for the bookworm
   suite conflicted with the base image's deb822 `Signed-By` pin, aborting apt. Fixed
   by pinning the same `debian-archive-keyring.gpg` in the added source line.

Also tightened `.dockerignore` (`**/data`) so nested `data/` caches aren't baked into
the image from a dev checkout.

## Out of scope (for this deploy)

- Reverse proxy / TLS / `orbix.lan` DNS (IP:port only for the test).
- CI/registry-based image delivery (we build on the NAS).
- Automated backups / monitoring integration.
