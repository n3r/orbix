# Library rework: drop Sections, multi-source libraries with SMB

**Date:** 2026-06-30
**Branch:** `feat/libraries-rework`
**Status:** Approved (design questions answered by user)

## Goal

Rework how Orbix manages Libraries:

1. Remove the "Section" concept — manage Libraries directly.
2. Each Library has a title (shown in the menu) and one or more media sources. A source is **internal (local)** or **external (SMB)**.
3. A Library can have multiple sources; its catalog is the **merged** result of all of them.
4. A Library can contain movies, TV series, or a mix (content type is per-item, never constrained per library).

## Decisions (from user)

- **SMB depth:** Orbix mounts the CIFS share *inside the container* to a local path, then scans/streams it exactly like a local path. All existing ffprobe/ffmpeg/`@fastify/static` I/O is reused unchanged.
- **Migration:** Promote each existing `Section` to a top-level `Library` (sections are today's browse destinations). Non-destructive — playback history, embeddings, and files survive.
- **Library content type:** Dropped entirely. Libraries are inherently mixed; `MediaItem.kind` ("movie"/"series") remains the only content-type marker.
- **SMB mounts default to read-only (`ro`).** Per-source `enabled` toggle retained.

## Current state (main)

Hierarchy is `Library → Section → Source → MediaItem → MediaFile`. Functionally **Section is the browse unit**: the Sidebar links to sections, `LibraryPage` routes by `:sectionId`, `MediaItem.sectionId` ties items to sections, and scan is per-section (`POST /sections/:id/scan`).

- `Library.type` and `Section.kind` are **dead fields** — defaulted, never read or enforced.
- `Source.path` is a **local filesystem path only**, validated via `fs.access(R_OK)`. There is **no SMB/external support of any kind**.
- The pure scanner (`packages/core/src/scanner/scan.ts` `scanSource({ sectionId, root }, deps)`) already takes a **local `root`** and injected adapters — core never touches fs/network directly.

## Data model

```prisma
model Library {
  id        String      @id @default(cuid())
  name      String                          // shown in the menu
  order     Int         @default(0)         // menu ordering (replaces Section.order)
  createdAt DateTime    @default(now())
  sources   Source[]
  items     MediaItem[]
}

model Source {
  id            String    @id @default(cuid())
  libraryId     String
  library       Library   @relation(fields: [libraryId], references: [id], onDelete: Cascade)
  kind          String    @default("local")  // "local" | "smb"
  path          String?                       // local root (required when kind=local)
  smbHost       String?                       // kind=smb
  smbShare      String?
  smbSubpath    String?                       // optional subdir within the share
  smbUsername   String?
  smbPassword   String?                       // AES-256-GCM at rest; NEVER returned by API
  smbDomain     String?
  enabled       Boolean   @default(true)
  status        String    @default("ok")      // "ok" | "error" | "unmounted"
  statusMessage String?
  lastScanAt    DateTime?
  @@index([libraryId])
}
```

- `MediaItem`: `sectionId → libraryId` (relation + index `@@index([libraryId, sortTitle])`).
- `Section` model **removed**. `Library.type` and `Section.kind` removed.

### Field-shape notes

- `path` is nullable in the DB but **required when `kind="local"`** — enforced in the zod schema / route, not the DB (mirrors how Source validation already lives in `packages/core/src/library/library.ts`).
- SMB sources never store a user-supplied local path; their effective root is derived deterministically as `/data/mounts/{sourceId}` (+ `smbSubpath`).

## Source → local root resolution (key abstraction)

The entire SMB story lives in **`apps/api`**. `packages/core` stays pure — it only ever receives a local `root`.

`apps/api/src/lib/source-root.ts` → `resolveSourceRoot(source): Promise<string>`:
- **local** → returns `source.path`.
- **smb** → ensures the share is mounted at `/data/mounts/{sourceId}`, returns that path joined with `smbSubpath`.

`apps/api/src/lib/smb.ts` (mount manager):
- `ensureMounted(source)` — if not already in `/proc/mounts`, runs `mount -t cifs //host/share /data/mounts/{id} -o ro,credentials=<tmpfile>,uid=...,gid=...`. The credentials temp file (mode 600, holding `username`/`password`/`domain`) keeps the password out of the process list; it is deleted after the mount call.
- `unmount(source)` — `umount` on delete/disable; ignore "not mounted".
- `isMounted(source)` — checks `/proc/mounts`.

`apps/api/src/plugins/mounts.ts` — on boot, mounts all enabled SMB sources; logs failures and **does not crash**.

**Graceful degradation:** if `mount.cifs` is absent or the mount fails (dev on macOS, missing `SYS_ADMIN`), the source is flagged `status="error"` + `statusMessage`, and is **skipped during scan** — local sources still scan and the app keeps running. No test or dev environment requires a real SMB server.

**Secrets:** `apps/api/src/lib/secrets.ts` — AES-256-GCM, key derived with scrypt from `SESSION_SECRET` (already required ≥32 chars), so **no new required env var**. `encryptSecret`/`decryptSecret`. SMB passwords are encrypted at rest and never serialized back to clients.

### Injectability for tests

`resolveSourceRoot` (and the mounter it calls) is passed into the scan worker as an adapter, exactly like the existing `probeFile`/`scanSource` adapters in `apps/api/src/plugins/queue.ts`. API tests inject a fake that returns a temp dir; **no test mounts a real share**.

## API routes

| Old | New |
|---|---|
| `GET /libraries` (with sections) | `GET /libraries` → libraries + **sanitized** sources (no `smbPassword`) |
| `POST /libraries` (`{name}`) | unchanged |
| — | `PATCH /libraries/:id` (`{name?, order?}`) |
| `DELETE /libraries/:id` | unchanged (cascades sources + items) |
| `POST /sections`, `PATCH/DELETE /sections/:id` | **removed** |
| `POST /sources` (`{sectionId, path}`) | `POST /libraries/:id/sources` — `{kind:"local", path}` **or** `{kind:"smb", host, share, subpath?, username?, password?, domain?}`; local path validated readable, SMB attempts a test mount |
| `DELETE /sources/:id` | unchanged (+ unmount if smb) |
| — | `PATCH /sources/:id` (`{enabled?}`) |
| `POST /sections/:id/scan` | `POST /libraries/:id/scan` (scans all enabled sources) |
| `GET /sections/:id/items` | `GET /libraries/:id/items` |
| `GET /items/:id`, `GET /scan/:jobId/stream` | unchanged |

Auth guards unchanged (`requireAuth` + `requireNonKids` for management). **Kids/maturity filtering stays enforced on every catalog route** — logic identical, just keyed by `libraryId`.

## Scan worker

`ScanJobData` becomes `{ jobId, libraryId, sources: [{ id, ... }] }`. For each **enabled** source the worker calls `resolveSourceRoot` (mounting SMB first), then runs the **existing pure `scanSource`** against the resulting local root, upserting items with `libraryId`. A per-source resolve/mount failure is reported in SSE progress (`message`) and that source is skipped; remaining sources proceed. Merge across sources is automatic (all items share the library).

`scanSource` opts and the `upsertItemAndFile` adapter rename `sectionId → libraryId` in `packages/core`.

## Web UI

- **`Sidebar.tsx`** — lists libraries directly (no section nesting); links to `/library/:libraryId`, ordered by `Library.order`.
- **`LibraryPage.tsx`** — route param `:libraryId`; fetches `/libraries/:id/items`.
- **`AdminLibrariesPage.tsx`** — Library → its sources. "Add source" gains a **kind toggle**: *Local path* (existing input) or *SMB* (host / share / subpath / username / password / domain). Each source row shows `status` + `statusMessage`, an `enabled` toggle, and delete. Scan button is per-library.
- **`lib/types.ts`** — `Library { sources[] }`, `Source { kind, smb*, status, statusMessage, enabled }`; `Section` removed. `lib/queries.ts` / `lib/api.ts` endpoints updated. Router `:sectionId → :libraryId`.

## Migration (promote Section → Library, non-destructive)

Hand-written SQL migration (Prisma `--create-only`, then edited so data is preserved):

1. Add new columns nullable: `Library.order`; `Source.libraryId`, `kind`, `smb*`, `status`, `statusMessage`; `MediaItem.libraryId`.
2. `INSERT INTO "Library" (id, name, "order", "createdAt") SELECT id, name, "order", now() FROM "Section"` — reuse each section's id as its new library id, so FK rewrites are trivial.
3. `UPDATE "Source" SET "libraryId" = "sectionId"; UPDATE "MediaItem" SET "libraryId" = "sectionId";`
4. `DELETE FROM "Library" WHERE id IN (SELECT DISTINCT "libraryId" FROM "Section")` — drop the old wrapper libraries; original libraries that had **no** sections are kept as empty libraries.
5. Set `Source.libraryId` and `MediaItem.libraryId` `NOT NULL`; default `Source.kind='local'`.
6. Drop `Source.sectionId`, `MediaItem.sectionId`, `Section` table, `Library.type`, `Section.kind`.

Item ids are unchanged, so `PlaybackState`, `PlayEvent`, `Embedding`, `MediaFile`, `Season`, `Episode`, `Credit`, genre/keyword joins are all preserved. The api container applies this on start via `prisma migrate deploy`.

## Deploy / Docker

- `apps/api` image installs `cifs-utils`.
- `docker-compose.yml` and `deploy/portainer-stack.yml`: api service gets `cap_add: [SYS_ADMIN]`, `security_opt: [apparmor:unconfined]`, and a writable `/data/mounts` location.
- Documented in `deploy/README.md` and `CLAUDE.md`. Without these privileges SMB simply fails to mount and degrades to `status="error"`; local libraries are unaffected.

## Testing

- **Core:** `scanSource` `libraryId` rename — pure, fakes only; existing scan/parse tests updated.
- **API:** library/source route CRUD; `POST /libraries/:id/scan` with a **fake mounter**; `resolveSourceRoot` local + smb (fake) paths; `secrets` encrypt/decrypt round-trip; sanitized source serialization (no password leak); migration smoke against the docker postgres.
- **Web:** Admin source-kind form (local vs smb) + status display; Sidebar + LibraryPage keyed by `libraryId`.
- **e2e:** update section→library specs; run only against a throwaway DB (global-setup wipes accounts/profiles).

## Out of scope

- Full userspace SMB protocol client (no OS mount) — explicitly rejected.
- Per-profile library visibility / per-profile menus (separate unmerged `menu-update` work).
- NFS or other external protocols (SMB only this PR).
- Cross-source de-duplication of identical files.
