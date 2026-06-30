# Orbix — Portainer NAS Deploy Guide

This guide walks you through deploying Orbix on a NAS (Synology, QNAP, etc.) using Portainer.

---

## Prerequisites

- **Portainer CE** (or BE) installed on your NAS — [portainer.io](https://www.portainer.io/install)
- **Docker** running on the NAS (Synology: Container Manager; QNAP: Container Station)
- **A media share** accessible from Docker (e.g. `/volume1/media` on Synology)
- **Git access** from the NAS (or upload the compose file manually)
- **TMDB API token** (free at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)) — required for metadata enrichment

> **TMDB attribution:** Orbix uses the TMDB API for metadata but is not endorsed or certified by TMDB. All metadata and poster images are © their respective rights holders via TMDB.

---

## Quick Start

### 1. Add the Stack in Portainer

**Option A — From Git:**
1. Portainer → **Stacks** → **Add stack** → **Repository**
2. Repository URL: `https://github.com/your-org/orbix`
3. Compose path: `deploy/portainer-stack.yml`
4. Enable "Auto update" if desired (polls for changes)

**Option B — Upload file:**
1. Portainer → **Stacks** → **Add stack** → **Upload**
2. Upload `deploy/portainer-stack.yml`

---

### 2. Set Environment Variables

In the stack editor, switch to the **Environment variables** tab and set:

| Variable | Description | Example |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | Database password (choose a strong one) | `s3cr3t-db-pass` |
| `DATABASE_URL` | Full Postgres URL | `postgresql://orbix:s3cr3t-db-pass@postgres:5432/orbix` |
| `REDIS_URL` | Redis URL | `redis://redis:6379` |
| `SESSION_SECRET` | Cookie signing secret (min 32 chars) | run `openssl rand -base64 32` |
| `WEB_ORIGIN` | Public URL for CORS | `http://192.168.1.100:8080` |
| `WEB_PORT` | Host port for web UI | `8080` |
| `ORBIX_MEDIA_PATH` | Absolute NAS path to your media | `/volume1/media` |

See `deploy/.env.production.example` for the full list with comments.

**Generate a session secret:**
```bash
openssl rand -base64 32
```

---

### 3. Deploy

Click **Deploy the stack**. Portainer will:
1. Build the Docker image (a single `api` image that also bundles the built web UI) from source — this takes **5–15 minutes** on first deploy (model download, SPA build)
2. Start postgres and redis, wait for them to be healthy
3. Start the API — it runs `prisma migrate deploy` automatically on each start, then serves both the web UI and `/api` on the same port

**Watch the logs** in Portainer → Containers → select `orbix-api-1` → Logs.

---

### 4. First-Run Setup

1. Open `http://YOUR-NAS-IP:8080` in your browser
2. You'll be redirected to the **Setup Wizard** — create your admin account
3. Go to **Settings** → **Integrations** → enter your TMDB API token
4. Go to **Libraries** → **Add Library** → set the path to `/media` (the read-only media mount inside the container)
5. Click **Scan** to start indexing your media

---

## Where Your Data Lives

All persistent data is stored in **named Docker volumes**:

| Volume | Container path | Contents |
|--------|---------------|----------|
| `orbix-db` | (postgres) | PostgreSQL database |
| `orbix-metadata` | `/data/metadata` | Poster/art cache, NFO files |
| `orbix-transcode` | `/data/transcode` | HLS transcode segments |
| `orbix-mounts` | `/data/mounts` | Mount points for SMB/CIFS external sources |

**Your media files** are mounted **read-only** from `ORBIX_MEDIA_PATH` — Orbix never modifies your media.

### Backups

Back up the named volumes with:
```bash
# Backup postgres
docker run --rm -v orbix-db:/data -v $(pwd):/backup alpine \
  tar czf /backup/orbix-db-$(date +%Y%m%d).tar.gz -C /data .

# Backup metadata (posters, etc.)
docker run --rm -v orbix-metadata:/data -v $(pwd):/backup alpine \
  tar czf /backup/orbix-metadata-$(date +%Y%m%d).tar.gz -C /data .
```

---

## External (SMB) Sources

A library can pull from **local** folders (under your mounted `/media`) and/or
**external SMB/CIFS** shares. Add sources per library in **Admin → Libraries**.

SMB shares are mounted **inside the API container** to `/data/mounts/<sourceId>`
(read-only), then scanned and streamed exactly like local paths. This requires
the container privileges already set in the stack:

```yaml
cap_add: ["SYS_ADMIN"]
security_opt: ["apparmor:unconfined"]
```

Notes:

- Without those privileges (or `cifs-utils` in the image), an SMB source shows
  **status `error`** with a message and is skipped on scan — **local libraries
  keep working**.
- SMB **credentials are encrypted at rest** (AES-256-GCM, key derived from
  `SESSION_SECRET`) and are never returned by the API.
- Mounts are re-established on container start and are read-only.

---

## Updating Orbix

1. Pull the latest code (or update the git stack in Portainer)
2. Re-deploy the stack — Portainer rebuilds the images
3. The API runs `prisma migrate deploy` automatically on start, applying any schema changes

---

## Ports

| Port | Service | Description |
|------|---------|-------------|
| `8080` | Orbix | Web UI **and** API (`/api/*`) on the same origin — share this with your users |

To change the port, set `WEB_PORT=XXXX` and update `WEB_ORIGIN` to match.

---

## Optional: Hardware Transcoding (Intel/AMD iGPU)

If your NAS has an Intel or AMD integrated GPU, you can enable hardware-accelerated transcoding (VAAPI/QuickSync).

In `portainer-stack.yml`, find the commented block in the `api` service and uncomment:
```yaml
    devices:
      - "/dev/dri:/dev/dri"
    group_add:
      - video
      - render
```

Then go to **Settings** → **Encoder** and select `hevc_vaapi` or `h264_vaapi`.

> The NAS user running Docker must be in the `video` and `render` groups (or the container must run as root).

---

## Embedding Model

The bge-small-en-v1.5 semantic search model (~130 MB) is **baked into the API image** during build. No internet access is needed at runtime and there is no first-run download delay.

To use an external volume for the model instead (e.g. to share it between image rebuilds):
1. Uncomment `# - orbix-models:/data/models` in the volumes section of `portainer-stack.yml`
2. Uncomment `# orbix-models:` in the top-level `volumes:` section
3. Set `MODELS_DIR=/data/models` in your environment
4. Remove the `RUN ... node apps/api/scripts/download-model.mjs` step from `apps/api/Dockerfile` to avoid
   baking the model into the image. The model is then fetched once on first use; to allow that one-time
   download set `ORBIX_ALLOW_MODEL_DOWNLOAD=true` in your environment (network required on first run only).
   Leave it unset/`false` afterwards to keep the app fully offline.

---

## Parental Controls (Kids Profiles)

Orbix supports **kids profiles** with a maturity cap (G / PG / PG-13). The library filter and all admin/management routes are **server-enforced**:

- Content routes return only titles at or below the cap; unrated titles are blocked.
- Admin routes (`/items/*/match-candidates`, `/items/*/match`, `/items/*/poster`, `/maintenance/refresh`, `/maintenance/cache`, `/settings`, library create/patch/delete, section scan) return **403 Not Allowed for Kids** when a kids profile is active.
- Switching **out** of a kids profile to a standard profile is PIN-gated at `/profiles/:id/select`.

**Known limitation — cookie-based profile selection:**
Profile selection is stored in the `orbix_profile` HTTP-only cookie. A determined child with full access to the device's browser (dev-tools, cookie editor, etc.) could clear that cookie, reverting to an unrestricted session. The server treats a missing profile cookie as unrestricted (no filter). Binding the profile choice to the server-side session is planned for a future release.

**Recommended mitigations (MVP):**
1. **Set a PIN on all standard/admin profiles.** A child cannot switch to a standard profile without the PIN, even if they clear the cookie (the next page load will redirect to `/profiles` and require a PIN to select an unrestricted profile).
2. **Do not give children a logged-in browser session on the host device.** Use a separate device or browser profile without saved session cookies.

The web root (`/`) already redirects to `/profiles` when no profile cookie is present (Phase 3 behaviour), so clearing the cookie does not silently bypass the profile selector — the user is forced to pick a profile again, which means entering the PIN for any standard profile.

---

## Troubleshooting

**`orbix-api-1` won't start — "Invalid environment"**
→ Check that all required env vars are set (`DATABASE_URL`, `SESSION_SECRET`, `WEB_ORIGIN`, etc.)

**`prisma migrate deploy` fails**
→ Check that `DATABASE_URL` is correct and postgres is healthy: `docker logs orbix-postgres-1`

**Web shows blank page / 502**
→ The API may still be starting. Check api container logs; wait for "Server listening on port 1061"

**Media not found in library scan**
→ Confirm `ORBIX_MEDIA_PATH` is the correct host path. Inside the container it is always `/media`.

**Port 8080 already in use**
→ Set `WEB_PORT=8888` (or any free port) and update `WEB_ORIGIN` to match.
