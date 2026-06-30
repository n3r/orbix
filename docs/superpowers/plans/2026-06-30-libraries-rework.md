# Library Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the "Section" layer so Libraries are managed directly, each with a title and one or more media sources (local or SMB) whose contents merge into one mixed-content library.

**Architecture:** Collapse `Library → Section → Source` into `Library → Source`; `MediaItem` moves from `sectionId` to `libraryId`. SMB support lives entirely in `apps/api`: a mount manager mounts CIFS shares to `/data/mounts/{sourceId}` and a `resolveSourceRoot` adapter hands the resulting local path to the existing pure scanner — so `packages/core` and all ffprobe/ffmpeg/streaming code are untouched. Migration promotes each existing Section to a top-level Library, preserving items/files/history.

**Tech Stack:** pnpm 10.22.0 + Turborepo, Node 22, Fastify, Prisma + Postgres/pgvector, BullMQ/Redis, Vite + React + TanStack Query, vitest, Playwright. SMB via `mount -t cifs` (cifs-utils) inside the container. Secrets via Node `crypto` (AES-256-GCM).

## Global Constraints

- Use the repo-local pnpm (`pnpm 10.22.0`); Node 22.
- `packages/core` stays pure: **no DB/network/ffmpeg/fs imports**; everything injected.
- The SPA only ever calls relative `/api/...`; never hardcode an API origin.
- `MediaFile.size` is `BigInt` → `.toString()` before any `JSON.stringify`.
- Kids/maturity filtering stays server-enforced on every catalog route (logic unchanged; key by `libraryId`).
- `SESSION_SECRET` ≥32 chars (already enforced); SMB passwords encrypted at rest with a key derived from it; **never** returned by any API response.
- Run `pnpm lint` (or `pnpm --filter <pkg> lint`) per change — a lint-only error can pass typecheck+test and hide behind Turbo cache.
- Gates before done: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- After host smokes, reap dev servers: `pkill -f "tsx.*watch src/server.ts"; pkill -f vite`.
- e2e global-setup wipes accounts/profiles — only ever run against a throwaway DB.

## File map

| File | Change |
|---|---|
| `packages/db/prisma/schema.prisma` | Library (+order, +sources, +items, −type, −sections), Source (libraryId, kind, smb*, status, statusMessage), MediaItem (sectionId→libraryId), remove Section |
| `packages/db/prisma/migrations/<ts>_libraries_rework/migration.sql` | Create — promote Section→Library, repoint FKs, drop Section |
| `packages/core/src/library/library.ts` (+`.test.ts`) | Source = discriminated union local\|smb; library patch; drop section validators |
| `packages/core/src/scanner/scan.ts` (+`.test.ts`) | `sectionId`→`libraryId` in opts + `upsertItemAndFile` input |
| `packages/config/src/env.ts` (+`.test.ts`) | Add `MOUNTS_DIR` default `./data/mounts` |
| `apps/api/src/lib/secrets.ts` (+`.test.ts`) | Create — AES-256-GCM encrypt/decrypt |
| `apps/api/src/lib/smb.ts` (+`.test.ts`) | Create — CIFS mount manager (injectable) |
| `apps/api/src/lib/source-root.ts` (+`.test.ts`) | Create — `resolveSourceRoot(source, deps)` |
| `apps/api/src/lib/mount-runtime.ts` | Create — wires real MountDeps + resolver + unmount from env |
| `apps/api/src/routes/libraries.ts` (+`.test.ts`) | Factory `librariesRoute(env, deps?)`; libraries + sources CRUD, no sections |
| `apps/api/src/routes/scan.ts` | `/libraries/:id/scan`; enqueue full source rows |
| `apps/api/src/routes/catalog.ts` (+`.test.ts`) | `/libraries/:id/items`; where `libraryId` |
| `apps/api/src/plugins/queue.ts` | `ScanJobData.libraryId`; resolve roots; upsert `libraryId`; enrichment by libraryId |
| `apps/api/src/plugins/mounts.ts` | Create — boot-mount enabled SMB sources |
| `apps/api/src/app.ts` | Register `mountsPlugin(env)`; `librariesRoute(env)` |
| `apps/web/src/lib/types.ts` | Source/Library reshaped; Section removed |
| `apps/web/src/lib/queries.ts` | `useLibraryItems` → `/libraries/:id/items` |
| `apps/web/src/components/shell/Sidebar.tsx` | List libraries directly → `/library/:libraryId` |
| `apps/web/src/pages/LibraryPage.tsx` | `:libraryId` + `useLibraryItems` |
| `apps/web/src/router.tsx` | `/library/:libraryId` |
| `apps/web/src/pages/AdminLibrariesPage.tsx` | Library→sources; source kind toggle; status; scan per library |
| `apps/api/Dockerfile`, `apps/api/Dockerfile.dev` | Install `cifs-utils` |
| `docker-compose.yml`, `deploy/portainer-stack.yml` | api: `cap_add: [SYS_ADMIN]`, `security_opt`, `MOUNTS_DIR`, mounts volume |
| `deploy/README.md`, `CLAUDE.md`, `.env.example` | Document SMB privileges + `MOUNTS_DIR` |
| `apps/web/e2e/*` | section→library specs |

---

### Task 1: DB schema + promote-Section migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<timestamp>_libraries_rework/migration.sql`

**Interfaces:**
- Produces: `Library { id, name, order, createdAt, sources[], items[] }`; `Source { id, libraryId, kind, path?, smbHost?, smbShare?, smbSubpath?, smbUsername?, smbPassword?, smbDomain?, enabled, status, statusMessage?, lastScanAt? }`; `MediaItem.libraryId` (replaces `sectionId`); `Section` removed.

- [ ] **Step 1: Edit schema.prisma** — replace the `Library`, `Section`, `Source` models (lines 43–73) with:

```prisma
model Library {
  id        String      @id @default(cuid())
  name      String
  order     Int         @default(0)
  createdAt DateTime    @default(now())
  sources   Source[]
  items     MediaItem[]
}

model Source {
  id            String    @id @default(cuid())
  libraryId     String
  library       Library   @relation(fields: [libraryId], references: [id], onDelete: Cascade)
  kind          String    @default("local")
  path          String?
  smbHost       String?
  smbShare      String?
  smbSubpath    String?
  smbUsername   String?
  smbPassword   String?
  smbDomain     String?
  enabled       Boolean   @default(true)
  status        String    @default("ok")
  statusMessage String?
  lastScanAt    DateTime?

  @@index([libraryId])
}
```

And in `MediaItem`: replace `sectionId String` + the `section` relation with:

```prisma
  libraryId    String
  library      Library            @relation(fields: [libraryId], references: [id], onDelete: Cascade)
```

and change `@@index([sectionId, sortTitle])` → `@@index([libraryId, sortTitle])`. Delete the entire `Section` model.

- [ ] **Step 2: Create the migration directory + SQL.** Use a timestamp newer than `20260630130000_tv_series` (e.g. `20260701000000_libraries_rework`). Write `migration.sql`:

```sql
-- 1. New columns (nullable first so existing rows survive)
ALTER TABLE "Library" ADD COLUMN "order" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Source" ADD COLUMN "libraryId" TEXT;
ALTER TABLE "Source" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "Source" ADD COLUMN "smbHost" TEXT;
ALTER TABLE "Source" ADD COLUMN "smbShare" TEXT;
ALTER TABLE "Source" ADD COLUMN "smbSubpath" TEXT;
ALTER TABLE "Source" ADD COLUMN "smbUsername" TEXT;
ALTER TABLE "Source" ADD COLUMN "smbPassword" TEXT;
ALTER TABLE "Source" ADD COLUMN "smbDomain" TEXT;
ALTER TABLE "Source" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE "Source" ADD COLUMN "statusMessage" TEXT;
ALTER TABLE "Source" ALTER COLUMN "path" DROP NOT NULL;

ALTER TABLE "MediaItem" ADD COLUMN "libraryId" TEXT;

-- 2. Promote each Section to a top-level Library, reusing the section id as the new library id
INSERT INTO "Library" ("id", "name", "order", "createdAt")
SELECT "id", "name", "order", now() FROM "Section";

-- 3. Repoint Source + MediaItem to the new library ids (== old section ids)
UPDATE "Source" SET "libraryId" = "sectionId";
UPDATE "MediaItem" SET "libraryId" = "sectionId";

-- 4. Drop the old wrapper libraries (those that had sections); empty libraries are kept
DELETE FROM "Library" WHERE "id" IN (SELECT DISTINCT "libraryId" FROM "Section");

-- 5. Enforce NOT NULL + FKs, drop old columns/tables
ALTER TABLE "Source" ALTER COLUMN "libraryId" SET NOT NULL;
ALTER TABLE "MediaItem" ALTER COLUMN "libraryId" SET NOT NULL;

ALTER TABLE "Source" DROP CONSTRAINT "Source_sectionId_fkey";
ALTER TABLE "MediaItem" DROP CONSTRAINT "MediaItem_sectionId_fkey";
DROP INDEX IF EXISTS "Source_sectionId_idx";
DROP INDEX IF EXISTS "MediaItem_sectionId_sortTitle_idx";
ALTER TABLE "Source" DROP COLUMN "sectionId";
ALTER TABLE "MediaItem" DROP COLUMN "sectionId";

ALTER TABLE "Library" DROP COLUMN "type";
DROP TABLE "Section";

CREATE INDEX "Source_libraryId_idx" ON "Source"("libraryId");
CREATE INDEX "MediaItem_libraryId_sortTitle_idx" ON "MediaItem"("libraryId", "sortTitle");

ALTER TABLE "Source" ADD CONSTRAINT "Source_libraryId_fkey"
  FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaItem" ADD CONSTRAINT "MediaItem_libraryId_fkey"
  FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

> Note: confirm the exact existing constraint/index names against `20260629151920_catalog/migration.sql` and the live DB (`\d "Source"`); adjust the `DROP CONSTRAINT`/`DROP INDEX` names to match if they differ.

- [ ] **Step 3: Generate the client.** Run `pnpm db:generate`. Expected: completes; `@orbix/db` exports updated types (no `section` on MediaItem).

- [ ] **Step 4: Verify migration on a throwaway DB.** With docker postgres up (`docker compose up -d postgres`), against a scratch database seed an old-shape row set and apply:

```bash
# create scratch DB
docker compose exec -T postgres psql -U orbix -c 'DROP DATABASE IF EXISTS migtest; CREATE DATABASE migtest;'
# apply all migrations EXCEPT the new one to get the old shape, seed, then deploy the new one:
DATABASE_URL=postgresql://orbix:orbix@localhost:1062/migtest pnpm --filter @orbix/db exec prisma migrate deploy
```

Expected: `migrate deploy` runs every migration including `libraries_rework` cleanly with no error. Then assert the promote worked by seeding BEFORE the last migration if feasible; at minimum confirm `\d "MediaItem"` shows `libraryId` and no `sectionId`, and `Section` table is gone:

```bash
docker compose exec -T postgres psql -U orbix -d migtest -c '\d "MediaItem"' | grep -q libraryId && echo OK
docker compose exec -T postgres psql -U orbix -d migtest -c "SELECT to_regclass('public.\"Section\"');" | grep -q '^$\|null\|^ *$' && echo SECTION_GONE
docker compose exec -T postgres psql -U orbix -c 'DROP DATABASE migtest;'
```

Expected: prints `OK` and the `Section` regclass query returns empty (table dropped).

- [ ] **Step 5: Commit.**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat(db): collapse Section into Library; add SMB source fields + promote migration"
```

---

### Task 2: Core library validation (local | smb sources)

**Files:**
- Modify: `packages/core/src/library/library.ts`
- Test: `packages/core/src/library/library.test.ts`

**Interfaces:**
- Produces: `validateLibraryInput(input): { name: string }`; `validateLibraryPatch(input): { name?: string; order?: number }`; `validateSourceInput(input): SourceInput` where `SourceInput = { kind: "local"; path: string } | { kind: "smb"; host: string; share: string; subpath?: string; username?: string; password?: string; domain?: string }`. Removes `validateSectionInput`, `validateSectionPatch`.

- [ ] **Step 1: Rewrite `library.test.ts`** to the new surface:

```ts
import { describe, it, expect } from "vitest";
import { validateSourceInput, validateLibraryInput, validateLibraryPatch, LibraryValidationError } from "./library";

describe("validateLibraryInput", () => {
  it("accepts a name", () => {
    expect(validateLibraryInput({ name: "Films" }).name).toBe("Films");
  });
  it("rejects empty name", () => {
    expect(() => validateLibraryInput({ name: "" })).toThrow(LibraryValidationError);
  });
});

describe("validateLibraryPatch", () => {
  it("accepts partial name", () => {
    expect(validateLibraryPatch({ name: "X" })).toEqual({ name: "X" });
  });
  it("accepts partial order", () => {
    expect(validateLibraryPatch({ order: 3 })).toEqual({ order: 3 });
  });
  it("accepts empty patch", () => {
    expect(validateLibraryPatch({})).toEqual({});
  });
  it("rejects negative order", () => {
    expect(() => validateLibraryPatch({ order: -1 })).toThrow(LibraryValidationError);
  });
});

describe("validateSourceInput", () => {
  it("accepts a local source", () => {
    const r = validateSourceInput({ kind: "local", path: "/movies" });
    expect(r).toEqual({ kind: "local", path: "/movies" });
  });
  it("rejects a local source with empty path", () => {
    expect(() => validateSourceInput({ kind: "local", path: "" })).toThrow(LibraryValidationError);
  });
  it("accepts an smb source", () => {
    const r = validateSourceInput({ kind: "smb", host: "nas", share: "media", username: "u", password: "p" });
    expect(r).toMatchObject({ kind: "smb", host: "nas", share: "media" });
  });
  it("rejects an smb source missing host", () => {
    expect(() => validateSourceInput({ kind: "smb", share: "media" })).toThrow(LibraryValidationError);
  });
  it("rejects an unknown kind", () => {
    expect(() => validateSourceInput({ kind: "nfs", path: "/x" })).toThrow(LibraryValidationError);
  });
});
```

- [ ] **Step 2: Run it, expect fail.** `pnpm --filter @orbix/core exec vitest run src/library/library.test.ts` — fails (old exports / shape).

- [ ] **Step 3: Rewrite `library.ts`:**

```ts
import { z } from "zod";

export class LibraryValidationError extends Error {}

const LibrarySchema = z.object({
  name: z.string().min(1).max(80),
});

const LibraryPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  order: z.number().int().min(0).optional(),
});

const LocalSourceSchema = z.object({
  kind: z.literal("local"),
  path: z.string().min(1),
});

const SmbSourceSchema = z.object({
  kind: z.literal("smb"),
  host: z.string().min(1),
  share: z.string().min(1),
  subpath: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  domain: z.string().optional(),
});

const SourceSchema = z.discriminatedUnion("kind", [LocalSourceSchema, SmbSourceSchema]);

export type SourceInput = z.infer<typeof SourceSchema>;

export function validateLibraryInput(input: unknown) {
  const r = LibrarySchema.safeParse(input);
  if (!r.success) throw new LibraryValidationError(r.error.message);
  return r.data;
}

export function validateLibraryPatch(input: unknown): { name?: string; order?: number } {
  const r = LibraryPatchSchema.safeParse(input);
  if (!r.success) throw new LibraryValidationError(r.error.message);
  return r.data;
}

export function validateSourceInput(input: unknown): SourceInput {
  const r = SourceSchema.safeParse(input);
  if (!r.success) throw new LibraryValidationError(r.error.message);
  return r.data;
}
```

- [ ] **Step 4: Run tests, expect pass.** `pnpm --filter @orbix/core exec vitest run src/library/library.test.ts`.

- [ ] **Step 5: Check the package barrel.** Grep `packages/core/src/index.ts` (or wherever `@orbix/core` re-exports) for `validateSectionInput`/`validateSectionPatch` and remove those exports; ensure `validateLibraryPatch` + `SourceInput` are exported. Run `pnpm --filter @orbix/core typecheck`.

- [ ] **Step 6: Commit.** `git add packages/core/src/library && git commit -m "feat(core): source validation as local|smb discriminated union"`

---

### Task 3: Core scanner libraryId rename

**Files:**
- Modify: `packages/core/src/scanner/scan.ts`
- Test: `packages/core/src/scanner/scan.test.ts`

**Interfaces:**
- Consumes: `parseMediaPath`, `MediaFileTechnical` (unchanged).
- Produces: `scanSource(opts: { libraryId: string; root: string }, deps)`; `ScanDeps.upsertItemAndFile` input field `libraryId` (was `sectionId`).

- [ ] **Step 1: Update `scan.test.ts`** — replace every `sectionId` with `libraryId` (the file has one such reference plus any fake `upsertItemAndFile` asserting the field). Run `pnpm --filter @orbix/core exec vitest run src/scanner/scan.test.ts` — expect fail.

- [ ] **Step 2: Edit `scan.ts`:** in `ScanDeps.upsertItemAndFile` input type change `sectionId: string;` → `libraryId: string;`; in `scanSource` signature change `opts: { sectionId: string; root: string }` → `opts: { libraryId: string; root: string }`; in the call to `deps.upsertItemAndFile({ ... })` change `sectionId: opts.sectionId,` → `libraryId: opts.libraryId,`.

- [ ] **Step 3: Run tests, expect pass.** `pnpm --filter @orbix/core exec vitest run src/scanner/scan.test.ts`.

- [ ] **Step 4: Commit.** `git add packages/core/src/scanner && git commit -m "refactor(core): scanner keys items by libraryId"`

---

### Task 4: API secrets (AES-256-GCM)

**Files:**
- Create: `apps/api/src/lib/secrets.ts`
- Test: `apps/api/src/lib/secrets.test.ts`

**Interfaces:**
- Produces: `encryptSecret(plain: string, secret: string): string`; `decryptSecret(blob: string, secret: string): string` (inverse). Blob format `iv:tag:ciphertext` base64.

- [ ] **Step 1: Write `secrets.test.ts`:**

```ts
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./secrets";

const KEY = "x".repeat(32);

describe("secrets", () => {
  it("round-trips a value", () => {
    const blob = encryptSecret("hunter2", KEY);
    expect(blob).not.toContain("hunter2");
    expect(decryptSecret(blob, KEY)).toBe("hunter2");
  });
  it("produces different ciphertext each call (random IV)", () => {
    expect(encryptSecret("a", KEY)).not.toBe(encryptSecret("a", KEY));
  });
  it("fails to decrypt with the wrong key", () => {
    const blob = encryptSecret("a", KEY);
    expect(() => decryptSecret(blob, "y".repeat(32))).toThrow();
  });
  it("throws on malformed blob", () => {
    expect(() => decryptSecret("nope", KEY)).toThrow();
  });
});
```

- [ ] **Step 2: Run it, expect fail.** `pnpm --filter @orbix/api exec vitest run src/lib/secrets.test.ts`.

- [ ] **Step 3: Write `secrets.ts`:**

```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";

function keyFrom(secret: string): Buffer {
  return scryptSync(secret, "orbix-source-secrets", 32);
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(blob: string, secret: string): string {
  const [ivB, tagB, dataB] = blob.split(":");
  if (!ivB || !tagB || !dataB) throw new Error("malformed secret blob");
  const decipher = createDecipheriv(ALGO, keyFrom(secret), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run tests, expect pass.** `pnpm --filter @orbix/api exec vitest run src/lib/secrets.test.ts`.

- [ ] **Step 5: Commit.** `git add apps/api/src/lib/secrets.ts apps/api/src/lib/secrets.test.ts && git commit -m "feat(api): AES-256-GCM secret encryption for source credentials"`

---

### Task 5: Config MOUNTS_DIR

**Files:**
- Modify: `packages/config/src/env.ts`
- Test: `packages/config/src/env.test.ts`

**Interfaces:**
- Produces: `Env.MOUNTS_DIR: string` (default `./data/mounts`).

- [ ] **Step 1: Add a test** to `env.test.ts`:

```ts
  it("defaults MOUNTS_DIR", () => {
    expect(loadEnv(valid).MOUNTS_DIR).toBe("./data/mounts");
  });
```

- [ ] **Step 2: Run it, expect fail.** `pnpm --filter @orbix/config exec vitest run`.

- [ ] **Step 3: Edit `env.ts`** — after the `MODELS_DIR` line add: `MOUNTS_DIR: z.string().default("./data/mounts"),`.

- [ ] **Step 4: Run tests, expect pass.** `pnpm --filter @orbix/config exec vitest run`.

- [ ] **Step 5: Commit.** `git add packages/config/src && git commit -m "feat(config): add MOUNTS_DIR env"`

---

### Task 6: API SMB mount manager

**Files:**
- Create: `apps/api/src/lib/smb.ts`
- Test: `apps/api/src/lib/smb.test.ts`

**Interfaces:**
- Produces:
  - `interface SmbSourceRecord { id: string; smbHost: string | null; smbShare: string | null; smbSubpath: string | null; smbUsername: string | null; smbPassword: string | null; smbDomain: string | null }` (password already decrypted)
  - `interface MountDeps { mountsDir: string; run(cmd, args): Promise<void>; readMounts(): Promise<string>; mkdir(dir): Promise<void>; writeCred(file, contents): Promise<void>; rmCred(file): Promise<void> }`
  - `mountPointFor(deps, id): string`
  - `isMounted(deps, id): Promise<boolean>`
  - `ensureMounted(deps, src: SmbSourceRecord): Promise<string>` (returns mount point)
  - `unmount(deps, id): Promise<void>`
  - `realMountDeps(mountsDir): MountDeps`

- [ ] **Step 1: Write `smb.test.ts`** (fakes only — no real mount):

```ts
import { describe, it, expect } from "vitest";
import { ensureMounted, isMounted, mountPointFor, unmount, type MountDeps, type SmbSourceRecord } from "./smb";

function fakeDeps(initialMounts = ""): MountDeps & { calls: string[][]; mounts: string } {
  const state = { mounts: initialMounts };
  const calls: string[][] = [];
  return {
    calls,
    get mounts() { return state.mounts; },
    mountsDir: "/data/mounts",
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "mount") state.mounts += `//x ${args[3]} cifs ro 0 0\n`;
      if (cmd === "umount") state.mounts = state.mounts.split("\n").filter((l) => l.split(" ")[1] !== args[0]).join("\n");
    },
    readMounts: async () => state.mounts,
    mkdir: async () => {},
    writeCred: async () => {},
    rmCred: async () => {},
  } as MountDeps & { calls: string[][]; mounts: string };
}

const src: SmbSourceRecord = {
  id: "src1", smbHost: "nas", smbShare: "media", smbSubpath: null,
  smbUsername: "u", smbPassword: "p", smbDomain: null,
};

describe("smb mount manager", () => {
  it("mounts when not already mounted", async () => {
    const deps = fakeDeps();
    const mp = await ensureMounted(deps, src);
    expect(mp).toBe(mountPointFor(deps, "src1"));
    expect(deps.calls[0]?.[0]).toBe("mount");
    expect(deps.calls[0]).toContain("//nas/media");
  });
  it("is idempotent — no second mount call", async () => {
    const deps = fakeDeps();
    await ensureMounted(deps, src);
    const before = deps.calls.length;
    await ensureMounted(deps, src);
    expect(deps.calls.length).toBe(before);
    expect(await isMounted(deps, "src1")).toBe(true);
  });
  it("unmounts only when mounted", async () => {
    const deps = fakeDeps();
    await unmount(deps, "src1"); // no-op
    expect(deps.calls.length).toBe(0);
    await ensureMounted(deps, src);
    await unmount(deps, "src1");
    expect(deps.calls.some((c) => c[0] === "umount")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, expect fail.** `pnpm --filter @orbix/api exec vitest run src/lib/smb.test.ts`.

- [ ] **Step 3: Write `smb.ts`:**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface SmbSourceRecord {
  id: string;
  smbHost: string | null;
  smbShare: string | null;
  smbSubpath: string | null;
  smbUsername: string | null;
  smbPassword: string | null; // already decrypted
  smbDomain: string | null;
}

export interface MountDeps {
  mountsDir: string;
  run: (cmd: string, args: string[]) => Promise<void>;
  readMounts: () => Promise<string>;
  mkdir: (dir: string) => Promise<void>;
  writeCred: (file: string, contents: string) => Promise<void>;
  rmCred: (file: string) => Promise<void>;
}

export function mountPointFor(deps: MountDeps, id: string): string {
  return path.join(deps.mountsDir, id);
}

export async function isMounted(deps: MountDeps, id: string): Promise<boolean> {
  const mp = mountPointFor(deps, id);
  const mounts = await deps.readMounts();
  return mounts.split("\n").some((line) => line.split(" ")[1] === mp);
}

export async function ensureMounted(deps: MountDeps, src: SmbSourceRecord): Promise<string> {
  const mp = mountPointFor(deps, src.id);
  if (await isMounted(deps, src.id)) return mp;
  await deps.mkdir(mp);
  const credFile = path.join(deps.mountsDir, `.cred-${src.id}`);
  const cred =
    `username=${src.smbUsername ?? "guest"}\n` +
    `password=${src.smbPassword ?? ""}\n` +
    `domain=${src.smbDomain ?? ""}\n`;
  await deps.writeCred(credFile, cred);
  try {
    const unc = `//${src.smbHost}/${src.smbShare}`;
    await deps.run("mount", ["-t", "cifs", unc, mp, "-o", `ro,credentials=${credFile},iocharset=utf8`]);
  } finally {
    await deps.rmCred(credFile).catch(() => {});
  }
  return mp;
}

export async function unmount(deps: MountDeps, id: string): Promise<void> {
  if (!(await isMounted(deps, id))) return;
  await deps.run("umount", [mountPointFor(deps, id)]);
}

export function realMountDeps(mountsDir: string): MountDeps {
  return {
    mountsDir,
    run: async (cmd, args) => {
      await execFileAsync(cmd, args);
    },
    readMounts: () => fs.readFile("/proc/mounts", "utf8").catch(() => ""),
    mkdir: async (dir) => {
      await fs.mkdir(dir, { recursive: true });
    },
    writeCred: (file, contents) => fs.writeFile(file, contents, { mode: 0o600 }),
    rmCred: (file) => fs.rm(file, { force: true }),
  };
}
```

- [ ] **Step 4: Run tests, expect pass.** `pnpm --filter @orbix/api exec vitest run src/lib/smb.test.ts`.

- [ ] **Step 5: Commit.** `git add apps/api/src/lib/smb.ts apps/api/src/lib/smb.test.ts && git commit -m "feat(api): CIFS mount manager (injectable)"`

---

### Task 7: API source-root resolver + mount runtime

**Files:**
- Create: `apps/api/src/lib/source-root.ts`
- Test: `apps/api/src/lib/source-root.test.ts`
- Create: `apps/api/src/lib/mount-runtime.ts`

**Interfaces:**
- Consumes: `MountDeps`, `ensureMounted` (Task 6); `decryptSecret` (Task 4); `Env` (Task 5).
- Produces:
  - `interface SourceRootRecord extends SmbSourceRecord { kind: string; path: string | null }`
  - `interface ResolveDeps { mount: MountDeps; decrypt: (blob: string) => string }`
  - `resolveSourceRoot(src: SourceRootRecord, deps: ResolveDeps): Promise<string>`
  - `interface MountRuntime { resolve(src): Promise<string>; unmount(id): Promise<void>; ensureAll(srcs): Promise<void> }`
  - `buildMountRuntime(env: Env): MountRuntime`

- [ ] **Step 1: Write `source-root.test.ts`:**

```ts
import { describe, it, expect } from "vitest";
import { resolveSourceRoot, type SourceRootRecord, type ResolveDeps } from "./source-root";

const base: SourceRootRecord = {
  id: "s1", kind: "local", path: "/movies",
  smbHost: null, smbShare: null, smbSubpath: null,
  smbUsername: null, smbPassword: null, smbDomain: null,
};

function deps(mounted: string[] = []): ResolveDeps & { ran: string[][] } {
  const ran: string[][] = [];
  return {
    ran,
    decrypt: (b) => b.replace("enc:", ""),
    mount: {
      mountsDir: "/data/mounts",
      run: async (c, a) => { ran.push([c, ...a]); mounted.push(a[3] ?? ""); },
      readMounts: async () => mounted.map((m) => `//x ${m} cifs ro 0 0`).join("\n"),
      mkdir: async () => {},
      writeCred: async () => {},
      rmCred: async () => {},
    },
  } as ResolveDeps & { ran: string[][] };
}

describe("resolveSourceRoot", () => {
  it("returns the path for a local source", async () => {
    expect(await resolveSourceRoot(base, deps())).toBe("/movies");
  });
  it("throws when a local source has no path", async () => {
    await expect(resolveSourceRoot({ ...base, path: null }, deps())).rejects.toThrow();
  });
  it("mounts an smb source and returns the mount point", async () => {
    const src: SourceRootRecord = { ...base, kind: "smb", path: null, smbHost: "nas", smbShare: "media", smbPassword: "enc:pw" };
    const root = await resolveSourceRoot(src, deps());
    expect(root).toBe("/data/mounts/s1");
  });
  it("appends smbSubpath to the mount point", async () => {
    const src: SourceRootRecord = { ...base, kind: "smb", path: null, smbHost: "nas", smbShare: "media", smbSubpath: "Films" };
    expect(await resolveSourceRoot(src, deps())).toBe("/data/mounts/s1/Films");
  });
  it("throws on unknown kind", async () => {
    await expect(resolveSourceRoot({ ...base, kind: "nfs" }, deps())).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it, expect fail.** `pnpm --filter @orbix/api exec vitest run src/lib/source-root.test.ts`.

- [ ] **Step 3: Write `source-root.ts`:**

```ts
import path from "node:path";
import { ensureMounted, type MountDeps, type SmbSourceRecord } from "./smb";

export interface SourceRootRecord extends SmbSourceRecord {
  kind: string;
  path: string | null;
}

export interface ResolveDeps {
  mount: MountDeps;
  decrypt: (blob: string) => string;
}

export async function resolveSourceRoot(src: SourceRootRecord, deps: ResolveDeps): Promise<string> {
  if (src.kind === "local") {
    if (!src.path) throw new Error(`local source ${src.id} has no path`);
    return src.path;
  }
  if (src.kind === "smb") {
    const decrypted: SmbSourceRecord = {
      ...src,
      smbPassword: src.smbPassword ? deps.decrypt(src.smbPassword) : null,
    };
    const mp = await ensureMounted(deps.mount, decrypted);
    return src.smbSubpath ? path.join(mp, src.smbSubpath) : mp;
  }
  throw new Error(`unknown source kind: ${src.kind}`);
}
```

- [ ] **Step 4: Run tests, expect pass.** `pnpm --filter @orbix/api exec vitest run src/lib/source-root.test.ts`.

- [ ] **Step 5: Write `mount-runtime.ts`** (real wiring; not unit-tested — exercised in smoke):

```ts
import type { Env } from "@orbix/config";
import { realMountDeps, unmount as unmountSource, type MountDeps } from "./smb";
import { resolveSourceRoot, type SourceRootRecord } from "./source-root";
import { decryptSecret } from "./secrets";

export interface MountRuntime {
  resolve: (src: SourceRootRecord) => Promise<string>;
  unmount: (id: string) => Promise<void>;
}

export function buildMountRuntime(env: Env): MountRuntime {
  const mount: MountDeps = realMountDeps(env.MOUNTS_DIR);
  const decrypt = (blob: string) => decryptSecret(blob, env.SESSION_SECRET);
  return {
    resolve: (src) => resolveSourceRoot(src, { mount, decrypt }),
    unmount: (id) => unmountSource(mount, id),
  };
}
```

- [ ] **Step 6: Typecheck + commit.** `pnpm --filter @orbix/api typecheck` then `git add apps/api/src/lib/source-root.ts apps/api/src/lib/source-root.test.ts apps/api/src/lib/mount-runtime.ts && git commit -m "feat(api): resolveSourceRoot + mount runtime"`

---

### Task 8: API libraries + sources routes

**Files:**
- Modify: `apps/api/src/routes/libraries.ts`
- Test: `apps/api/src/routes/libraries.test.ts` (create)
- Modify: `apps/api/src/app.ts` (registration → `librariesRoute(env)`)

**Interfaces:**
- Consumes: `validateLibraryInput`, `validateLibraryPatch`, `validateSourceInput`, `LibraryValidationError` (Task 2); `encryptSecret` (Task 4); `MountRuntime`, `buildMountRuntime` (Task 7); `Env`.
- Produces: factory `librariesRoute(env: Env, deps?: { runtime?: MountRuntime })`. Endpoints: `GET /libraries`; `POST /libraries`; `PATCH /libraries/:id`; `DELETE /libraries/:id`; `POST /libraries/:id/sources`; `PATCH /sources/:id`; `DELETE /sources/:id`. Source serialization helper `sanitizeSource(row)` omits `smbPassword`.

- [ ] **Step 1: Write `libraries.test.ts`.** Follow the existing api route test harness (look at `apps/api/src/routes/profiles.test.ts` / `auth.test.ts` for the in-memory/Prisma test setup and how they build the app + authenticate). Cover: create library; list returns sources without `smbPassword`; add a local source with a readable temp dir succeeds; add a local source with a non-existent path → 400 `path_unreadable`; add an smb source stores `kind:"smb"` and is returned without password; PATCH library order; DELETE library cascades. Inject a fake `runtime` whose `resolve` returns a temp dir and `unmount` is a noop so no real mount occurs. Example shape for the SMB case:

```ts
// build app with librariesRoute(testEnv, { runtime: { resolve: async () => tmpDir, unmount: async () => {} } })
// POST /api/libraries/{id}/sources  { kind: "smb", host: "nas", share: "media", username: "u", password: "p" }
// expect 200, body.kind === "smb", body.smbPassword === undefined
// then GET /api/libraries → source present, no smbPassword field
```

Run it, expect fail (`pnpm --filter @orbix/api exec vitest run src/routes/libraries.test.ts`).

- [ ] **Step 2: Rewrite `libraries.ts`:**

```ts
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import {
  validateLibraryInput,
  validateLibraryPatch,
  validateSourceInput,
  LibraryValidationError,
} from "@orbix/core";
import { Prisma } from "@orbix/db";
import type { Env } from "@orbix/config";
import { requireAuth } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import { encryptSecret } from "../lib/secrets";
import { buildMountRuntime, type MountRuntime } from "../lib/mount-runtime";

const SOURCE_PUBLIC = {
  id: true, libraryId: true, kind: true, path: true,
  smbHost: true, smbShare: true, smbSubpath: true, smbUsername: true, smbDomain: true,
  enabled: true, status: true, statusMessage: true, lastScanAt: true,
} satisfies Prisma.SourceSelect; // NOTE: never select smbPassword

export function librariesRoute(env: Env, deps?: { runtime?: MountRuntime }) {
  const runtime = deps?.runtime ?? buildMountRuntime(env);

  return async function libraries(app: FastifyInstance) {
    // GET /libraries — libraries + sanitized sources
    app.get("/libraries", { preHandler: requireAuth(app) }, async () =>
      app.prisma.library.findMany({
        orderBy: { order: "asc" },
        include: { sources: { select: SOURCE_PUBLIC } },
      }),
    );

    // POST /libraries
    app.post<{ Body: unknown }>("/libraries", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      try {
        const v = validateLibraryInput(req.body);
        return await app.prisma.library.create({ data: { name: v.name }, select: { id: true, name: true } });
      } catch (e) {
        if (e instanceof LibraryValidationError) return reply.code(400).send({ error: "invalid" });
        throw e;
      }
    });

    // PATCH /libraries/:id
    app.patch<{ Params: { id: string }; Body: unknown }>("/libraries/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      try {
        const patch = validateLibraryPatch(req.body);
        const data: { name?: string; order?: number } = {};
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.order !== undefined) data.order = patch.order;
        return await app.prisma.library.update({ where: { id: req.params.id }, data, select: { id: true, name: true, order: true } });
      } catch (e) {
        if (e instanceof LibraryValidationError) return reply.code(400).send({ error: "invalid" });
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    });

    // DELETE /libraries/:id
    app.delete<{ Params: { id: string } }>("/libraries/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      // Unmount any SMB sources first (best-effort)
      const smb = await app.prisma.source.findMany({ where: { libraryId: req.params.id, kind: "smb" }, select: { id: true } });
      await Promise.all(smb.map((s) => runtime.unmount(s.id).catch(() => {})));
      try {
        await app.prisma.library.delete({ where: { id: req.params.id } });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    });

    // POST /libraries/:id/sources
    app.post<{ Params: { id: string }; Body: unknown }>("/libraries/:id/sources", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      const libraryId = req.params.id;
      let v;
      try {
        v = validateSourceInput(req.body);
      } catch (e) {
        if (e instanceof LibraryValidationError) return reply.code(400).send({ error: "invalid" });
        throw e;
      }

      if (v.kind === "local") {
        try {
          await fs.promises.access(v.path, fs.constants.R_OK);
        } catch {
          return reply.code(400).send({ error: "path_unreadable" });
        }
        const source = await app.prisma.source.create({
          data: { libraryId, kind: "local", path: v.path },
          select: SOURCE_PUBLIC,
        });
        return source;
      }

      // smb — store encrypted password, then attempt a test mount (non-fatal)
      const created = await app.prisma.source.create({
        data: {
          libraryId, kind: "smb",
          smbHost: v.host, smbShare: v.share, smbSubpath: v.subpath ?? null,
          smbUsername: v.username ?? null,
          smbPassword: v.password ? encryptSecret(v.password, env.SESSION_SECRET) : null,
          smbDomain: v.domain ?? null,
        },
        select: { ...SOURCE_PUBLIC, smbPassword: true },
      });
      try {
        await runtime.resolve(created);
        await app.prisma.source.update({ where: { id: created.id }, data: { status: "ok", statusMessage: null } });
      } catch (err) {
        await app.prisma.source.update({
          where: { id: created.id },
          data: { status: "error", statusMessage: err instanceof Error ? err.message : "mount failed" },
        });
      }
      const { smbPassword: _drop, ...safe } = created;
      return await app.prisma.source.findUnique({ where: { id: created.id }, select: SOURCE_PUBLIC }) ?? safe;
    });

    // PATCH /sources/:id  — { enabled?: boolean }
    app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>("/sources/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") return reply.code(400).send({ error: "invalid" });
      try {
        const source = await app.prisma.source.update({ where: { id: req.params.id }, data: { enabled }, select: SOURCE_PUBLIC });
        if (!enabled && source.kind === "smb") await runtime.unmount(source.id).catch(() => {});
        return source;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    });

    // DELETE /sources/:id
    app.delete<{ Params: { id: string } }>("/sources/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
      const existing = await app.prisma.source.findUnique({ where: { id: req.params.id }, select: { id: true, kind: true } });
      if (existing?.kind === "smb") await runtime.unmount(existing.id).catch(() => {});
      try {
        await app.prisma.source.delete({ where: { id: req.params.id } });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
    });
  };
}
```

> The `smbPassword: true` in the create-select is only so the test-mount can pass the encrypted blob into `runtime.resolve`; the returned object re-reads via `SOURCE_PUBLIC` (no password). If `Prisma.SourceSelect`'s `satisfies` complains, drop the `satisfies` annotation and keep the literal.

- [ ] **Step 3: Update `app.ts`.** Change the import `import librariesRoute from "./routes/libraries";` → `import { librariesRoute } from "./routes/libraries";` and the registration `await app.register(librariesRoute, { prefix: "/api" });` → `await app.register(librariesRoute(env), { prefix: "/api" });`.

- [ ] **Step 4: Run tests, expect pass.** `pnpm --filter @orbix/api exec vitest run src/routes/libraries.test.ts`.

- [ ] **Step 5: Commit.** `git add apps/api/src/routes/libraries.ts apps/api/src/routes/libraries.test.ts apps/api/src/app.ts && git commit -m "feat(api): libraries + sources routes (local|smb), no sections"`

---

### Task 9: API scan route → per library

**Files:**
- Modify: `apps/api/src/routes/scan.ts`

**Interfaces:**
- Consumes: `app.scanQueue` (BullMQ) with the new `ScanJobData` (Task 10).
- Produces: `POST /libraries/:id/scan` → `{ jobId }`; enqueues full source rows needed for resolution.

- [ ] **Step 1: Edit `scan.ts`** — replace the POST handler:

```ts
  // POST /libraries/:id/scan — enqueue a scan job, return { jobId }
  app.post<{ Params: { id: string } }>(
    "/libraries/:id/scan",
    { preHandler: [requireAuth(app), requireNonKids(app)] },
    async (req, reply) => {
      const libraryId = req.params.id;

      const sources = await app.prisma.source.findMany({
        where: { libraryId, enabled: true },
        select: {
          id: true, kind: true, path: true,
          smbHost: true, smbShare: true, smbSubpath: true,
          smbUsername: true, smbPassword: true, smbDomain: true,
        },
      });

      if (sources.length === 0) {
        return reply.code(400).send({ error: "no_sources" });
      }

      const jobId = randomUUID();
      await app.scanQueue.add("scan", { jobId, libraryId, sources });

      return { jobId };
    },
  );
```

(The SSE `/scan/:jobId/stream` handler is unchanged.)

- [ ] **Step 2: Typecheck.** `pnpm --filter @orbix/api typecheck` — will error until Task 10 updates `ScanJobData`; that's expected. (Do Task 10 next; they compile together.)

- [ ] **Step 3: Commit** (with Task 10, see below).

---

### Task 10: Scan worker + mounts plugin

**Files:**
- Modify: `apps/api/src/plugins/queue.ts`
- Create: `apps/api/src/plugins/mounts.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `MountRuntime`, `buildMountRuntime` (Task 7); `scanSource` libraryId form (Task 3).
- Produces: `ScanJobData = { jobId: string; libraryId: string; sources: SourceRow[] }` where `SourceRow = { id, kind, path, smbHost, smbShare, smbSubpath, smbUsername, smbPassword, smbDomain }`; `queuePlugin(env, deps?: { runtime?: MountRuntime })`; `mountsPlugin(env)`.

- [ ] **Step 1: Edit `queue.ts` — job data shape (lines ~83–87):**

```ts
export interface ScanSourceRow {
  id: string;
  kind: string;
  path: string | null;
  smbHost: string | null;
  smbShare: string | null;
  smbSubpath: string | null;
  smbUsername: string | null;
  smbPassword: string | null;
  smbDomain: string | null;
}

export interface ScanJobData {
  jobId: string;
  libraryId: string;
  sources: ScanSourceRow[];
}
```

- [ ] **Step 2: Edit `queuePlugin` signature + runtime.** Change `export function queuePlugin(env: Env) {` → `export function queuePlugin(env: Env, deps?: { runtime?: MountRuntime }) {` and inside, before the processor: `const runtime = deps?.runtime ?? buildMountRuntime(env);`. Add imports at top: `import { buildMountRuntime, type MountRuntime } from "../lib/mount-runtime";`.

- [ ] **Step 3: Edit the processor destructure + upsert + scan loop.**
  - Line ~100: `const { jobId, sectionId, sources } = job.data;` → `const { jobId, libraryId, sources } = job.data;`.
  - In `upsertItemAndFile` input type (~128) and all four usages (~178, 188, 230, 241): `sectionId` → `libraryId` (the field name in the `input` object and in the prisma `where`/`data` — `MediaItem.libraryId`). The input param type field becomes `libraryId: string;`.
  - The scan loop (~272–293): resolve each source to a root and skip failures:

```ts
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]!;

        scanEvents.emit(jobId, { phase: "scanning", processed: i, total: sources.length });

        let root: string;
        try {
          root = await runtime.resolve(source);
        } catch (err) {
          const message = err instanceof Error ? err.message : "source unavailable";
          await prisma.source.update({ where: { id: source.id }, data: { status: "error", statusMessage: message } });
          scanEvents.emit(jobId, { phase: "scanning", processed: i, total: sources.length, message: `skipped source: ${message}` });
          continue;
        }
        await prisma.source.update({ where: { id: source.id }, data: { status: "ok", statusMessage: null } });

        const result = await scanSource(
          { libraryId, root },
          { listFiles, probe, findFileByPath, upsertItemAndFile },
        );

        totalAdded += result.added;
        totalUpdated += result.updated;
        totalSkipped += result.skipped;

        for (const id of result.itemIds) allItemIds.add(id);

        await prisma.source.update({ where: { id: source.id }, data: { lastScanAt: new Date() } });
      }
```

  - Enrichment set (~552): `where: { sectionId, matchState: "unmatched" }` → `where: { libraryId, matchState: "unmatched" }`.

- [ ] **Step 4: Create `mounts.ts`:**

```ts
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import { buildMountRuntime } from "../lib/mount-runtime";

// On boot, mount all enabled SMB sources so scans / streaming can read them.
// Failures are logged, never fatal (e.g. dev hosts without cifs-utils).
export function mountsPlugin(env: Env) {
  return fp(async (app: FastifyInstance) => {
    const runtime = buildMountRuntime(env);
    app.addHook("onReady", async () => {
      const sources = await app.prisma.source.findMany({
        where: { kind: "smb", enabled: true },
        select: {
          id: true, kind: true, path: true,
          smbHost: true, smbShare: true, smbSubpath: true,
          smbUsername: true, smbPassword: true, smbDomain: true,
        },
      });
      for (const src of sources) {
        try {
          await runtime.resolve(src);
          await app.prisma.source.update({ where: { id: src.id }, data: { status: "ok", statusMessage: null } });
        } catch (err) {
          const message = err instanceof Error ? err.message : "mount failed";
          app.log.warn({ sourceId: src.id, err }, "SMB mount failed on boot");
          await app.prisma.source.update({ where: { id: src.id }, data: { status: "error", statusMessage: message } });
        }
      }
    });
  });
}
```

- [ ] **Step 5: Register in `app.ts`.** Add import `import { mountsPlugin } from "./plugins/mounts";` and register it after `queuePlugin` (needs `app.prisma`, so after `dbPlugin`): add `await app.register(mountsPlugin(env));` right after the `queuePlugin` registration line.

- [ ] **Step 6: Typecheck whole api.** `pnpm --filter @orbix/api typecheck` — expect pass now (Task 9 + 10 together).

- [ ] **Step 7: Commit.** `git add apps/api/src/plugins/queue.ts apps/api/src/plugins/mounts.ts apps/api/src/routes/scan.ts apps/api/src/app.ts && git commit -m "feat(api): per-library scan, source-root resolution, boot mounts"`

---

### Task 11: API catalog route → per library

**Files:**
- Modify: `apps/api/src/routes/catalog.ts`
- Test: `apps/api/src/routes/catalog.test.ts` (create if absent, else extend)

**Interfaces:**
- Produces: `GET /libraries/:id/items?sort=&q=` (was `/sections/:id/items`); item filter `where.libraryId`.

- [ ] **Step 1: Add/Update a test** asserting `GET /api/libraries/:id/items` returns items for that library and applies the kids rating filter (mirror any existing `catalog`/`discovery` test harness). Run, expect fail.

- [ ] **Step 2: Edit `catalog.ts`** — change the route string `"/sections/:id/items"` → `"/libraries/:id/items"`, the comment on line 6, and the `where` clause `sectionId: id,` → `libraryId: id,`. Nothing else changes.

- [ ] **Step 3: Run tests, expect pass.** `pnpm --filter @orbix/api exec vitest run src/routes/catalog.test.ts`.

- [ ] **Step 4: Commit.** `git add apps/api/src/routes/catalog.ts apps/api/src/routes/catalog.test.ts && git commit -m "feat(api): catalog items keyed by libraryId"`

---

### Task 12: Web types + queries

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/queries.ts`

**Interfaces:**
- Produces: `Source { id, libraryId, kind: "local"|"smb", path: string|null, smbHost?, smbShare?, smbSubpath?, smbUsername?, smbDomain?, enabled, status, statusMessage: string|null, lastScanAt: string|null }`; `Library { id, name, order, createdAt, sources: Source[] }`; `Section` removed. `useLibraryItems(libraryId, sort, q)` → `/libraries/:id/items`.

- [ ] **Step 1: Edit `types.ts`** — replace the `Source`, `Section`, `Library` interfaces (lines 5–28) with:

```ts
export interface Source {
  id: string;
  libraryId: string;
  kind: "local" | "smb";
  path: string | null;
  smbHost?: string | null;
  smbShare?: string | null;
  smbSubpath?: string | null;
  smbUsername?: string | null;
  smbDomain?: string | null;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  lastScanAt: string | null;
}

export interface Library {
  id: string;
  name: string;
  order: number;
  createdAt: string;
  sources: Source[];
}
```

- [ ] **Step 2: Edit `queries.ts`** — replace `useSectionItems` (lines 28–38) with:

```ts
export function useLibraryItems(libraryId: string | undefined, sort: string, q: string) {
  return useQuery({
    queryKey: ["library-items", libraryId, sort, q],
    enabled: !!libraryId,
    queryFn: () => {
      const qs = new URLSearchParams({ sort });
      if (q) qs.set("q", q);
      return apiJson<MediaCard[]>(`/libraries/${libraryId}/items?${qs}`);
    },
  });
}
```

- [ ] **Step 3: Typecheck** — `pnpm --filter @orbix/web typecheck` will surface every consumer (Sidebar, LibraryPage, AdminLibrariesPage). Those are fixed in Tasks 13–14; this task may leave web typecheck red until then. That's expected — do not commit web in a broken state; commit Tasks 12–14 together at the end of Task 14.

---

### Task 13: Web Sidebar + LibraryPage + router

**Files:**
- Modify: `apps/web/src/components/shell/Sidebar.tsx`
- Modify: `apps/web/src/pages/LibraryPage.tsx`
- Modify: `apps/web/src/router.tsx`

**Interfaces:**
- Consumes: `Library` + `useLibraryItems` (Task 12).

- [ ] **Step 1: Edit `Sidebar.tsx`** — replace the library nav tree (lines 119–137) with a flat list of libraries:

```tsx
          {libraries.map((lib) => (
            <NavLink
              key={lib.id}
              href={`/library/${lib.id}`}
              active={pathname === `/library/${lib.id}`}
              onNavigate={onNavigate}
            >
              <FilmIcon /> {lib.name}
            </NavLink>
          ))}
```

Remove the now-unused `multiLib` const (line 77) and the `<LibraryIcon /> {lib.name}` group label block. (`LibraryIcon` is still used by the Admin link, so keep the component.)

- [ ] **Step 2: Edit `LibraryPage.tsx`** — change imports/usage:
  - `import { useSectionItems } from "@/lib/queries";` → `import { useLibraryItems } from "@/lib/queries";`
  - `const { sectionId } = useParams();` → `const { libraryId } = useParams();`
  - `const { data: items = [], isLoading, error } = useSectionItems(sectionId, sort, q);` → `useLibraryItems(libraryId, sort, q);`

- [ ] **Step 3: Edit `router.tsx`** — `{ path: "/library/:sectionId", element: <LibraryPage /> }` → `{ path: "/library/:libraryId", element: <LibraryPage /> }`.

---

### Task 14: Web Admin Libraries page (sources + SMB) + web gates

**Files:**
- Modify: `apps/web/src/pages/AdminLibrariesPage.tsx`

**Interfaces:**
- Consumes: `Library`, `Source` (Task 12); endpoints `POST/PATCH/DELETE /libraries`, `POST /libraries/:id/sources`, `PATCH/DELETE /sources/:id`, `POST /libraries/:id/scan` (Tasks 8–9).

- [ ] **Step 1: Replace `AdminLibrariesPage.tsx`** with a version that has no sections — each Library directly lists its sources, has an "Add source" form with a Local/SMB toggle, shows each source's `status`, and a per-library Scan button. Full file:

```tsx
import { useState, useEffect, useRef } from "react";
import { Link } from "react-router";
import { Button, Card, Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { queryClient } from "@/lib/queryClient";
import type { Library } from "@/lib/types";

interface ScanState {
  phase: string;
  processed?: number;
  total?: number;
  added?: number;
  updated?: number;
  skipped?: number;
  matched?: number;
  message?: string;
}

type SourceKind = "local" | "smb";
interface SourceDraft {
  kind: SourceKind;
  path: string;
  host: string;
  share: string;
  subpath: string;
  username: string;
  password: string;
  domain: string;
}
const emptyDraft: SourceDraft = { kind: "local", path: "", host: "", share: "", subpath: "", username: "", password: "", domain: "" };

export default function AdminLibrariesPage() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [newLibName, setNewLibName] = useState("");
  const [libSaving, setLibSaving] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);

  // Add-source draft + state keyed by libraryId
  const [drafts, setDrafts] = useState<Record<string, SourceDraft>>({});
  const [sourceSaving, setSourceSaving] = useState<Record<string, boolean>>({});
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});

  // Scan state keyed by libraryId
  const [scanStates, setScanStates] = useState<Record<string, ScanState>>({});
  const [scanLoading, setScanLoading] = useState<Record<string, boolean>>({});
  const esRef = useRef<Map<string, EventSource>>(new Map());

  useEffect(() => {
    const sources = esRef.current;
    return () => { sources.forEach((es) => es.close()); sources.clear(); };
  }, []);

  async function loadLibraries() {
    try {
      const res = await apiFetch("/libraries");
      if (!res.ok) { setError("Failed to load libraries"); return; }
      setLibraries((await res.json()) as Library[]);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    await loadLibraries();
    void queryClient.invalidateQueries({ queryKey: ["libraries"] });
  }

  useEffect(() => { loadLibraries(); }, []);

  function draftFor(libraryId: string): SourceDraft {
    return drafts[libraryId] ?? emptyDraft;
  }
  function setDraft(libraryId: string, patch: Partial<SourceDraft>) {
    setDrafts((d) => ({ ...d, [libraryId]: { ...draftFor(libraryId), ...patch } }));
  }

  async function handleCreateLibrary(e: React.FormEvent) {
    e.preventDefault();
    setLibError(null);
    setLibSaving(true);
    try {
      const res = await apiFetch("/libraries", { method: "POST", body: JSON.stringify({ name: newLibName }) });
      if (res.ok) { setNewLibName(""); await refresh(); }
      else { const b = (await res.json()) as { error?: string }; setLibError(b.error ?? "Failed to create library"); }
    } catch {
      setLibError("Network error");
    } finally {
      setLibSaving(false);
    }
  }

  async function handleDeleteLibrary(id: string) {
    await apiFetch(`/libraries/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function handleCreateSource(e: React.FormEvent, libraryId: string) {
    e.preventDefault();
    setSourceErrors((s) => ({ ...s, [libraryId]: "" }));
    setSourceSaving((s) => ({ ...s, [libraryId]: true }));
    const d = draftFor(libraryId);
    const body =
      d.kind === "local"
        ? { kind: "local", path: d.path }
        : { kind: "smb", host: d.host, share: d.share, subpath: d.subpath || undefined, username: d.username || undefined, password: d.password || undefined, domain: d.domain || undefined };
    try {
      const res = await apiFetch(`/libraries/${libraryId}/sources`, { method: "POST", body: JSON.stringify(body) });
      if (res.ok) { setDrafts((dd) => ({ ...dd, [libraryId]: emptyDraft })); await refresh(); }
      else { const b = (await res.json()) as { error?: string }; setSourceErrors((s) => ({ ...s, [libraryId]: b.error ?? "Failed to add source" })); }
    } catch {
      setSourceErrors((s) => ({ ...s, [libraryId]: "Network error" }));
    } finally {
      setSourceSaving((s) => ({ ...s, [libraryId]: false }));
    }
  }

  async function handleDeleteSource(id: string) {
    await apiFetch(`/sources/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function handleScan(libraryId: string) {
    setScanLoading((s) => ({ ...s, [libraryId]: true }));
    setScanStates((s) => ({ ...s, [libraryId]: { phase: "starting" } }));
    try {
      const res = await apiFetch(`/libraries/${libraryId}/scan`, { method: "POST" });
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        setScanStates((s) => ({ ...s, [libraryId]: { phase: "error: " + (b.error ?? "unknown") } }));
        setScanLoading((s) => ({ ...s, [libraryId]: false }));
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      esRef.current.get(libraryId)?.close();
      const es = new EventSource(`/api/scan/${jobId}/stream`);
      esRef.current.set(libraryId, es);
      es.onmessage = (event: MessageEvent<string>) => {
        const data = JSON.parse(event.data) as ScanState;
        setScanStates((s) => ({ ...s, [libraryId]: data }));
        if (data.phase === "done" || data.phase === "error") {
          es.close();
          esRef.current.delete(libraryId);
          setScanLoading((s) => ({ ...s, [libraryId]: false }));
          if (data.phase === "done") void refresh();
        }
      };
      es.onerror = () => {
        setScanStates((s) => ({ ...s, [libraryId]: { phase: "stream error" } }));
        es.close();
        esRef.current.delete(libraryId);
        setScanLoading((s) => ({ ...s, [libraryId]: false }));
      };
    } catch {
      setScanStates((s) => ({ ...s, [libraryId]: { phase: "error" } }));
      setScanLoading((s) => ({ ...s, [libraryId]: false }));
    }
  }

  function formatScanState(state: ScanState): string {
    if (state.phase === "done") return `Done — added: ${state.added ?? 0}, updated: ${state.updated ?? 0}, matched: ${state.matched ?? 0}`;
    if (state.phase === "error") return `Scan failed: ${state.message ?? "unknown error"}`;
    if (state.processed !== undefined && state.total !== undefined) return `${state.phase}: ${state.processed}/${state.total}${state.message ? ` — ${state.message}` : ""}`;
    return state.phase;
  }

  function sourceLabel(src: Library["sources"][number]): string {
    return src.kind === "smb" ? `smb://${src.smbHost ?? "?"}/${src.smbShare ?? "?"}${src.smbSubpath ? "/" + src.smbSubpath : ""}` : src.path ?? "";
  }

  if (loading) {
    return <main className="p-8"><p className="text-[var(--text-dim)]">Loading…</p></main>;
  }

  return (
    <main className="px-6 md:px-8 lg:px-10 py-8">
     <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-[var(--text)]">Libraries</h1>
        <Link to="/admin/settings" className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]">Settings</Link>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Add Library</h2>
        <form onSubmit={handleCreateLibrary} className="flex gap-2">
          <Input value={newLibName} onChange={(e) => setNewLibName(e.target.value)} placeholder="Library name" required />
          <Button type="submit" disabled={libSaving}>{libSaving ? "Adding…" : "Add"}</Button>
        </form>
        {libError && <p className="mt-2 text-sm text-red-400">{libError}</p>}
      </Card>

      {libraries.map((lib) => {
        const d = draftFor(lib.id);
        return (
        <Card key={lib.id}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-[var(--text)]">{lib.name}</h2>
            <div className="flex gap-2 items-center">
              <Button onClick={() => handleScan(lib.id)} disabled={scanLoading[lib.id]}>
                {scanLoading[lib.id] ? "Scanning…" : "Scan"}
              </Button>
              <Button variant="ghost" onClick={() => handleDeleteLibrary(lib.id)}>Delete</Button>
            </div>
          </div>

          {scanStates[lib.id] && (
            <p className="text-sm text-[var(--text-dim)] mb-3">{formatScanState(scanStates[lib.id]!)}</p>
          )}

          {lib.sources.length > 0 && (
            <ul className="mb-4 flex flex-col gap-1">
              {lib.sources.map((src) => (
                <li key={src.id} className="flex items-center justify-between text-sm text-[var(--text-dim)]">
                  <span className="font-mono truncate">
                    {sourceLabel(src)}
                    {src.status === "error" && <span className="ml-2 text-red-400">(error: {src.statusMessage})</span>}
                  </span>
                  <Button variant="ghost" onClick={() => handleDeleteSource(src.id)}>Remove</Button>
                </li>
              ))}
            </ul>
          )}

          {/* Add Source */}
          <form onSubmit={(e) => handleCreateSource(e, lib.id)} className="flex flex-col gap-2 border-t border-[var(--surface-2)] pt-3">
            <div className="flex gap-2">
              <select
                value={d.kind}
                onChange={(e) => setDraft(lib.id, { kind: e.target.value as SourceKind })}
                className="rounded-[var(--radius-sm)] border border-[var(--surface-2)] bg-[var(--surface)] px-2 text-[var(--text)]"
              >
                <option value="local">Local</option>
                <option value="smb">SMB</option>
              </select>
              {d.kind === "local" ? (
                <Input value={d.path} onChange={(e) => setDraft(lib.id, { path: e.target.value })} placeholder="/path/to/media/folder" required />
              ) : (
                <Input value={d.host} onChange={(e) => setDraft(lib.id, { host: e.target.value })} placeholder="NAS host (e.g. 192.168.1.10)" required />
              )}
              <Button type="submit" disabled={sourceSaving[lib.id]}>{sourceSaving[lib.id] ? "Adding…" : "Add Source"}</Button>
            </div>
            {d.kind === "smb" && (
              <div className="grid grid-cols-2 gap-2">
                <Input value={d.share} onChange={(e) => setDraft(lib.id, { share: e.target.value })} placeholder="Share (e.g. media)" required />
                <Input value={d.subpath} onChange={(e) => setDraft(lib.id, { subpath: e.target.value })} placeholder="Subpath (optional)" />
                <Input value={d.username} onChange={(e) => setDraft(lib.id, { username: e.target.value })} placeholder="Username (optional)" />
                <Input type="password" value={d.password} onChange={(e) => setDraft(lib.id, { password: e.target.value })} placeholder="Password (optional)" />
                <Input value={d.domain} onChange={(e) => setDraft(lib.id, { domain: e.target.value })} placeholder="Domain (optional)" />
              </div>
            )}
          </form>
          {sourceErrors[lib.id] && <p className="mt-1 text-sm text-red-400">{sourceErrors[lib.id]}</p>}
        </Card>
        );
      })}
     </div>
    </main>
  );
}
```

- [ ] **Step 2: Web typecheck + lint.** `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint`. Fix any stragglers.

- [ ] **Step 3: Commit web layer (Tasks 12–14 together).** `git add apps/web/src && git commit -m "feat(web): manage libraries directly with local/SMB sources"`

---

### Task 15: Docker / deploy / docs

**Files:**
- Modify: `apps/api/Dockerfile`, `apps/api/Dockerfile.dev`
- Modify: `docker-compose.yml`, `deploy/portainer-stack.yml`
- Modify: `deploy/README.md`, `CLAUDE.md`, `.env.example`

- [ ] **Step 1: Install cifs-utils in both API images.** In `apps/api/Dockerfile` change the apt line to `ffmpeg curl cifs-utils`. Open `apps/api/Dockerfile.dev` and add `cifs-utils` to its apt-get install list the same way (read the file first to match its exact line).

- [ ] **Step 2: Grant mount privileges + MOUNTS_DIR in `docker-compose.yml`** — under the `api` service add:

```yaml
    cap_add: ["SYS_ADMIN"]
    security_opt: ["apparmor:unconfined"]
    devices: ["/dev/fuse"]
    environment:
      # ...existing vars...
      MOUNTS_DIR: /data/mounts
    volumes:
      # ...existing src mounts...
      - ./data/mounts:/data/mounts:rshared
```

(Keep existing `environment`/`volumes` entries — append these. `:rshared` lets mounts inside the container propagate.)

- [ ] **Step 3: Mirror in `deploy/portainer-stack.yml`** — read it, add the same `cap_add`, `security_opt`, `devices`, `MOUNTS_DIR`, and a `/data/mounts` volume to its api/app service, matching that file's volume style.

- [ ] **Step 4: Document.** In `deploy/README.md` add a short "External (SMB) sources" section: SMB shares are mounted inside the container, which requires `cap_add: SYS_ADMIN` + `security_opt: apparmor:unconfined` (already in the stack); without them SMB sources show `status: error` and are skipped while local libraries keep working; credentials are stored encrypted (AES-256-GCM, key derived from `SESSION_SECRET`). In `CLAUDE.md` under "Conventions & gotchas" add one line: SMB sources mount to `MOUNTS_DIR` (`/data/mounts`) via cifs-utils; resolution lives in `apps/api/src/lib/source-root.ts`; core stays mount-agnostic. In `.env.example` add `MOUNTS_DIR=./data/mounts`.

- [ ] **Step 5: Commit.** `git add apps/api/Dockerfile apps/api/Dockerfile.dev docker-compose.yml deploy CLAUDE.md .env.example && git commit -m "build: cifs-utils + mount privileges for SMB sources; docs"`

---

### Task 16: e2e + full gates + PR

**Files:**
- Modify: `apps/web/e2e/*` (any spec referencing sections or `/library/:sectionId` / `/sections/*` endpoints)

- [ ] **Step 1: Find e2e references.** `grep -rn "section\|/sections\|sectionId" apps/web/e2e` (and any Playwright helpers). Update navigation/setup that creates a Section or hits `/sections/...` to instead create a Library + source and hit `/libraries/...`. (See the e2e harness notes in `.superpowers` / memory: run only against a throwaway DB; global-setup wipes accounts.)

- [ ] **Step 2: Full gates.**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all pass. Fix anything red before proceeding.

- [ ] **Step 3: Manual smoke (host).** Bring up infra, run a real scan of a local folder and (if available) an SMB share, confirm libraries render in the sidebar and the library page lists merged items. Then reap servers:

```bash
pkill -f "tsx.*watch src/server.ts"; pkill -f vite
```

- [ ] **Step 4: e2e (throwaway DB).** `pnpm --filter @orbix/web test:e2e` against the throwaway DB. Expected: pass.

- [ ] **Step 5: Push + open PR.**

```bash
git push -u origin feat/libraries-rework
gh pr create --title "Rework libraries: drop sections, multi-source libraries with SMB" --body "<summary + test evidence>"
```

---

## Self-Review

**Spec coverage:**
- Drop sections → Tasks 1, 3, 8, 9, 11, 12, 13, 14 (schema, scanner, routes, web).
- Library title in menu → Task 13 (Sidebar).
- Sources local|smb → Tasks 2, 6, 7, 8 (validation, mount, resolver, routes) + 14 (UI).
- Multiple sources merged → Tasks 9, 10 (per-library scan over all sources, items share libraryId).
- Mixed content → enforced by *removing* type constraints (Task 1 drops `Library.type`/`Section.kind`); `MediaItem.kind` per item untouched.
- Migration (promote sections) → Task 1.
- SMB container-mount + privileges + docs → Tasks 6, 7, 10, 15.
- Secrets at rest → Tasks 4, 8.
- Separate PR → Task 16.

**Placeholder scan:** No TBD/TODO; every code step shows full code; test code is concrete.

**Type consistency:** `libraryId` used uniformly (core scanner, queue, routes, web). `validateSourceInput` returns the discriminated union consumed by `libraries.ts`. `SOURCE_PUBLIC` select never includes `smbPassword`. `MountRuntime.resolve/unmount` signatures match between `mount-runtime.ts`, `libraries.ts`, `queue.ts`, `mounts.ts`. `useLibraryItems` name matches LibraryPage import.

**Known follow-ups (not blockers):** confirm exact constraint/index names in Task 1 against the live `20260629151920_catalog` migration; verify `apps/api` route test harness pattern from an existing `*.test.ts` before writing Task 8/11 tests.
