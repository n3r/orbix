# Orbix Phase 0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Orbix monorepo, dev Docker stack, database, authentication, setup wizard, and household profiles so the app boots, an admin can complete first-run setup, create profiles, and pick "who's watching" — on a clean, tested foundation.

**Architecture:** pnpm + Turborepo monorepo. `apps/web` (Next.js App Router) and `apps/api` (Fastify) consume shared `packages/{db,core,ui,config}`. Postgres (pgvector image) + Redis run in Docker for dev. Auth is cookie-session based (argon2 password hashing); profiles are Netflix-style records selected after login. Domain logic (auth, profiles) lives in `packages/core` and is unit-tested in isolation; the Fastify app is a thin transport layer.

**Tech Stack:** TypeScript 5.6 (strict), Node 22, pnpm 9, Turborepo 2, Next.js 15 + React 19 + Tailwind 4, Fastify 5, Prisma 6 + Postgres 16 (`pgvector/pgvector:pg16`), Redis 7, argon2, zod 3, Vitest 3, Playwright. ports: web `1060`, api `1061`, postgres `1062`, redis `1063`.

## Global Constraints

- **Language:** TypeScript everywhere, `"strict": true`, no `any` without justification.
- **Node:** `>=22`. **Package manager:** pnpm `>=9` (declare `packageManager` in root `package.json`).
- **Ports (host, dev):** web `1060`, api `1061`, postgres `1062`, redis `1063`. Never hardcode other ports.
- **DB image:** `pgvector/pgvector:pg16` (Postgres with the `vector` extension preinstalled — needed in later phases).
- **Domain logic** (auth, profiles, future scanner/recommender) goes in `packages/core`, framework-agnostic and unit-tested. Apps stay thin.
- **Env:** all config validated through a single zod schema in `packages/config`; never read `process.env` directly outside that module.
- **Secrets:** never commit real secrets. `.env` is gitignored; `.env.example` is committed with placeholder values.
- **Commits:** conventional-commit style, one per task step where indicated; end commit bodies with the Co-Authored-By trailer for Claude.
- **TDD:** write the failing test first for all domain logic.

---

## File Structure

```
orbix/
├─ package.json                 # root: workspaces, scripts, packageManager, devDeps (turbo, prettier)
├─ pnpm-workspace.yaml
├─ turbo.json
├─ .gitignore
├─ .env.example
├─ .nvmrc                       # 22
├─ .github/workflows/ci.yml
├─ packages/
│  ├─ config/                   # @orbix/config — env schema (zod), shared tsconfig/eslint bases
│  │  ├─ package.json
│  │  ├─ tsconfig.base.json
│  │  ├─ eslint.config.js
│  │  └─ src/env.ts
│  ├─ db/                       # @orbix/db — Prisma client + schema + migrations
│  │  ├─ package.json
│  │  ├─ prisma/schema.prisma
│  │  └─ src/index.ts
│  ├─ core/                     # @orbix/core — domain logic (auth, profiles)
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ src/auth/password.ts
│  │  ├─ src/auth/session.ts
│  │  ├─ src/auth/setup.ts
│  │  ├─ src/profiles/profiles.ts
│  │  └─ src/index.ts
│  └─ ui/                       # @orbix/ui — design tokens + base components
│     ├─ package.json
│     ├─ src/tokens.css
│     ├─ src/cn.ts
│     └─ src/components/{Button,Card,Input,Avatar}.tsx
├─ apps/
│  ├─ api/                      # Fastify server
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ Dockerfile.dev
│  │  └─ src/{server,app,plugins/{db,session},routes/{health,setup,auth,profiles}}.ts
│  └─ web/                      # Next.js app
│     ├─ package.json
│     ├─ next.config.ts
│     ├─ tailwind.config.ts
│     ├─ tsconfig.json
│     ├─ Dockerfile.dev
│     └─ src/app/{layout,page,setup/page,login/page,profiles/page}.tsx + src/lib/api.ts
├─ docker-compose.yml           # postgres, redis, api, web (dev)
└─ docs/superpowers/...
```

---

### Task 1: Monorepo scaffold + shared config package

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.gitignore`, `.nvmrc`, `.env.example`
- Create: `packages/config/package.json`, `packages/config/tsconfig.base.json`, `packages/config/eslint.config.js`, `packages/config/src/env.ts`
- Test: `packages/config/src/env.test.ts`

**Interfaces:**
- Produces: `@orbix/config` exporting `loadEnv(source?: Record<string,string|undefined>): Env` and the `Env` type. `Env` includes `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `API_PORT`, `WEB_PORT`, `SESSION_SECRET`, `WEB_ORIGIN`.

- [ ] **Step 1: Root workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`package.json`:
```json
{
  "name": "orbix",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "db:migrate": "pnpm --filter @orbix/db exec prisma migrate dev",
    "db:generate": "pnpm --filter @orbix/db exec prisma generate"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "prettier": "^3.3.0",
    "typescript": "^5.6.0"
  }
}
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "dev": { "cache": false, "persistent": true },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.next/
.turbo/
.env
*.log
coverage/
/data/
```

`.nvmrc`: `22`

- [ ] **Step 2: Config package files**

`packages/config/package.json`:
```json
{
  "name": "@orbix/config",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/env.ts",
  "exports": { ".": "./src/env.ts", "./tsconfig.base.json": "./tsconfig.base.json" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "vitest": "^3.0.0", "typescript": "^5.6.0", "eslint": "^9.0.0" }
}
```

`packages/config/tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  }
}
```

- [ ] **Step 3: Write the failing test for env loading**

`packages/config/src/env.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

const valid = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://orbix:orbix@localhost:1062/orbix",
  REDIS_URL: "redis://localhost:1063",
  API_PORT: "1061",
  WEB_PORT: "1060",
  SESSION_SECRET: "x".repeat(32),
  WEB_ORIGIN: "http://localhost:1060",
};

describe("loadEnv", () => {
  it("parses a valid environment and coerces ports to numbers", () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(1061);
    expect(env.NODE_ENV).toBe("development");
  });

  it("throws when SESSION_SECRET is too short", () => {
    expect(() => loadEnv({ ...valid, SESSION_SECRET: "short" })).toThrow();
  });

  it("throws when DATABASE_URL is missing", () => {
    const { DATABASE_URL, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @orbix/config test`
Expected: FAIL — cannot find module `./env`.

- [ ] **Step 5: Implement `loadEnv`**

`packages/config/src/env.ts`:
```ts
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive(),
  WEB_PORT: z.coerce.number().int().positive(),
  SESSION_SECRET: z.string().min(32),
  WEB_ORIGIN: z.string().url(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
```

- [ ] **Step 6: `.env.example`**

```
NODE_ENV=development
DATABASE_URL=postgresql://orbix:orbix@localhost:1062/orbix
REDIS_URL=redis://localhost:1063
API_PORT=1061
WEB_PORT=1060
SESSION_SECRET=change-me-to-a-32+-character-random-string
WEB_ORIGIN=http://localhost:1060
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm install && pnpm --filter @orbix/config test`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo and @orbix/config env schema"
```

---

### Task 2: Database package (Prisma schema + Postgres/pgvector)

**Files:**
- Create: `packages/db/package.json`, `packages/db/prisma/schema.prisma`, `packages/db/src/index.ts`, `packages/db/tsconfig.json`

**Interfaces:**
- Produces: `@orbix/db` exporting a singleton `prisma` (`PrismaClient`) and re-exporting Prisma types. Models for Phase 0: `Account`, `Profile`, `Session`. (Catalog models land in Phase 1.)

- [ ] **Step 1: Package + Prisma schema**

`packages/db/package.json`:
```json
{
  "name": "@orbix/db",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "prisma generate",
    "typecheck": "tsc --noEmit",
    "migrate": "prisma migrate dev",
    "lint": "eslint ."
  },
  "dependencies": { "@prisma/client": "^6.0.0" },
  "devDependencies": { "prisma": "^6.0.0", "typescript": "^5.6.0" }
}
```

`packages/db/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}

model Account {
  id           String    @id @default(cuid())
  email        String    @unique
  passwordHash String
  isAdmin      Boolean   @default(true)
  createdAt    DateTime  @default(now())
  sessions     Session[]
}

model Profile {
  id          String   @id @default(cuid())
  name        String
  avatar      String?
  kind        String   @default("standard") // "standard" | "kids"
  pinHash     String?
  maturityCap Int? // null = unrestricted
  createdAt   DateTime @default(now())
}

model Session {
  id        String   @id @default(cuid())
  accountId String
  account   Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime @default(now())

  @@index([accountId])
}
```

Note: `extensions = [vector]` requires `previewFeatures = ["postgresqlExtensions"]`. Add to the generator:
```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}
```

- [ ] **Step 2: Client singleton**

`packages/db/src/index.ts`:
```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "@prisma/client";
```

`packages/db/tsconfig.json`:
```json
{ "extends": "@orbix/config/tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 3: Generate client (no DB needed)**

Run: `pnpm --filter @orbix/db exec prisma generate`
Expected: "Generated Prisma Client". (Migration runs in Task 4 once Postgres is up.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(db): add Prisma schema for accounts, profiles, sessions"
```

---

### Task 3: Dev Docker stack (Postgres + Redis + api/web Dockerfiles + compose)

**Files:**
- Create: `docker-compose.yml`, `apps/api/Dockerfile.dev`, `apps/web/Dockerfile.dev`

**Interfaces:**
- Produces: `docker compose up` starts `postgres` (1062), `redis` (1063), `api` (1061), `web` (1060). api/web mount source for hot reload.

- [ ] **Step 1: docker-compose.yml**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: orbix
      POSTGRES_PASSWORD: orbix
      POSTGRES_DB: orbix
    ports: ["1062:5432"]
    volumes: ["./data/postgres:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U orbix"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ["1063:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile.dev }
    command: pnpm --filter @orbix/api dev
    environment:
      DATABASE_URL: postgresql://orbix:orbix@postgres:5432/orbix
      REDIS_URL: redis://redis:6379
      API_PORT: "1061"
      WEB_PORT: "1060"
      WEB_ORIGIN: http://localhost:1060
      SESSION_SECRET: dev-session-secret-change-me-32chars
      NODE_ENV: development
    ports: ["1061:1061"]
    volumes: ["./:/app", "/app/node_modules"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }

  web:
    build: { context: ., dockerfile: apps/web/Dockerfile.dev }
    command: pnpm --filter @orbix/web dev
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:1061
      WEB_PORT: "1060"
    ports: ["1060:1060"]
    volumes: ["./:/app", "/app/node_modules"]
    depends_on: [api]
```

- [ ] **Step 2: Dev Dockerfiles (shared base pattern)**

`apps/api/Dockerfile.dev`:
```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# deps installed at runtime against mounted volume in dev; keep image lean
CMD ["pnpm", "--filter", "@orbix/api", "dev"]
```

`apps/web/Dockerfile.dev`:
```dockerfile
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
CMD ["pnpm", "--filter", "@orbix/web", "dev"]
```

Note: ffmpeg in the api image is unused until Phase 2 but included so the dev image is stable.

- [ ] **Step 3: Verify Postgres + Redis come up and migrate runs**

Run:
```bash
docker compose up -d postgres redis
docker compose exec postgres pg_isready -U orbix
DATABASE_URL=postgresql://orbix:orbix@localhost:1062/orbix pnpm --filter @orbix/db exec prisma migrate dev --name init
```
Expected: `pg_isready` → "accepting connections"; migration creates `Account`/`Profile`/`Session` tables and the `_prisma_migrations` table.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: add dev docker-compose with postgres(pgvector), redis, api, web"
```

---

### Task 4: Auth domain — password hashing + setup state (TDD, in `@orbix/core`)

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/auth/password.ts`, `packages/core/src/auth/setup.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/auth/password.test.ts`, `packages/core/src/auth/setup.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): Promise<string>` and `verifyPassword(hash: string, plain: string): Promise<boolean>` (argon2id).
  - `isSetupComplete(deps: { countAccounts: () => Promise<number> }): Promise<boolean>` — true when ≥1 account exists.
  - `createAdminAccount(input: { email: string; password: string }, deps: { hasAnyAccount: () => Promise<boolean>; insert: (a: { email: string; passwordHash: string }) => Promise<{ id: string }> }): Promise<{ id: string }>` — throws `SetupAlreadyCompleteError` if an account already exists; throws `ValidationError` on bad email / weak password (<8 chars).

- [ ] **Step 1: Package files**

`packages/core/package.json`:
```json
{
  "name": "@orbix/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run", "lint": "eslint ." },
  "dependencies": { "argon2": "^0.41.0", "zod": "^3.23.0" },
  "devDependencies": { "vitest": "^3.0.0", "typescript": "^5.6.0" }
}
```
`packages/core/tsconfig.json`: `{ "extends": "@orbix/config/tsconfig.base.json", "include": ["src"] }`

- [ ] **Step 2: Failing test — password round-trip**

`packages/core/src/auth/password.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("hunter2hunter2");
    expect(await verifyPassword(hash, "hunter2hunter2")).toBe(true);
  });
  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("hunter2hunter2");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });
});
```

- [ ] **Step 3: Run → fail**

Run: `pnpm --filter @orbix/core test password`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement password.ts**

```ts
import argon2 from "argon2";

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Failing test — setup logic**

`packages/core/src/auth/setup.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { isSetupComplete, createAdminAccount, SetupAlreadyCompleteError, ValidationError } from "./setup";

describe("setup", () => {
  it("reports incomplete when no accounts exist", async () => {
    expect(await isSetupComplete({ countAccounts: async () => 0 })).toBe(false);
  });
  it("reports complete when an account exists", async () => {
    expect(await isSetupComplete({ countAccounts: async () => 1 })).toBe(true);
  });
  it("creates the admin when none exists", async () => {
    const insert = vi.fn(async () => ({ id: "acc1" }));
    const res = await createAdminAccount(
      { email: "me@example.com", password: "longenough" },
      { hasAnyAccount: async () => false, insert }
    );
    expect(res.id).toBe("acc1");
    expect(insert).toHaveBeenCalledOnce();
  });
  it("refuses to create a second account", async () => {
    await expect(
      createAdminAccount({ email: "me@example.com", password: "longenough" },
        { hasAnyAccount: async () => true, insert: async () => ({ id: "x" }) })
    ).rejects.toBeInstanceOf(SetupAlreadyCompleteError);
  });
  it("rejects a weak password", async () => {
    await expect(
      createAdminAccount({ email: "me@example.com", password: "short" },
        { hasAnyAccount: async () => false, insert: async () => ({ id: "x" }) })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
```

- [ ] **Step 6: Run → fail**, then **Step 7: Implement setup.ts**

`packages/core/src/auth/setup.ts`:
```ts
import { z } from "zod";
import { hashPassword } from "./password";

export class SetupAlreadyCompleteError extends Error {}
export class ValidationError extends Error {}

const InputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export function isSetupComplete(deps: { countAccounts: () => Promise<number> }): Promise<boolean> {
  return deps.countAccounts().then((n) => n > 0);
}

export async function createAdminAccount(
  input: { email: string; password: string },
  deps: {
    hasAnyAccount: () => Promise<boolean>;
    insert: (a: { email: string; passwordHash: string }) => Promise<{ id: string }>;
  }
): Promise<{ id: string }> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.message);
  if (await deps.hasAnyAccount()) throw new SetupAlreadyCompleteError();
  const passwordHash = await hashPassword(parsed.data.password);
  return deps.insert({ email: parsed.data.email, passwordHash });
}
```

`packages/core/src/index.ts`:
```ts
export * from "./auth/password";
export * from "./auth/setup";
export * from "./auth/session";
export * from "./profiles/profiles";
```
(Note: `session.ts` and `profiles.ts` are created in Tasks 5 and 7; until then, comment out their re-exports or create stubs. Add them as those tasks land.)

- [ ] **Step 8: Run all core tests → pass; commit**

Run: `pnpm --filter @orbix/core test`
Expected: PASS.
```bash
git add -A
git commit -m "feat(core): argon2 password hashing and admin-setup domain logic"
```

---

### Task 5: Session domain + Fastify app skeleton with health + DB plugin

**Files:**
- Create: `packages/core/src/auth/session.ts`, `packages/core/src/auth/session.test.ts`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/server.ts`, `apps/api/src/app.ts`, `apps/api/src/plugins/db.ts`, `apps/api/src/plugins/session.ts`, `apps/api/src/routes/health.ts`

**Interfaces:**
- Consumes: `@orbix/config` `loadEnv`, `@orbix/db` `prisma`, `@orbix/core` password/setup.
- Produces:
  - `createSession(accountId, deps: { insert, ttlMs }): Promise<{ id, expiresAt }>` and `isSessionValid(session: { expiresAt: Date }, now: Date): boolean`.
  - `buildApp(env): FastifyInstance` — registers cors, cookie, db, session plugins and routes. `GET /health` → `{ status: "ok", db: boolean }`.

- [ ] **Step 1: Failing test — session validity**

`packages/core/src/auth/session.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isSessionValid } from "./session";

describe("isSessionValid", () => {
  const now = new Date("2026-06-29T12:00:00Z");
  it("is valid before expiry", () => {
    expect(isSessionValid({ expiresAt: new Date("2026-06-29T13:00:00Z") }, now)).toBe(true);
  });
  it("is invalid after expiry", () => {
    expect(isSessionValid({ expiresAt: new Date("2026-06-29T11:00:00Z") }, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail; Step 3: Implement session.ts**

`packages/core/src/auth/session.ts`:
```ts
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function isSessionValid(session: { expiresAt: Date }, now: Date = new Date()): boolean {
  return session.expiresAt.getTime() > now.getTime();
}

export async function createSession(
  accountId: string,
  deps: { insert: (s: { accountId: string; expiresAt: Date }) => Promise<{ id: string; expiresAt: Date }>; now?: Date }
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date((deps.now ?? new Date()).getTime() + SESSION_TTL_MS);
  return deps.insert({ accountId, expiresAt });
}
```
Then add `export * from "./auth/session";` to `packages/core/src/index.ts` (if not already). Run `pnpm --filter @orbix/core test` → PASS.

- [ ] **Step 4: API package + server**

`apps/api/package.json`:
```json
{
  "name": "@orbix/api",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "@orbix/config": "workspace:*",
    "@orbix/core": "workspace:*",
    "@orbix/db": "workspace:*",
    "fastify": "^5.0.0",
    "@fastify/cors": "^10.0.0",
    "@fastify/cookie": "^11.0.0"
  },
  "devDependencies": { "tsx": "^4.19.0", "vitest": "^3.0.0", "typescript": "^5.6.0" }
}
```
`apps/api/tsconfig.json`: `{ "extends": "@orbix/config/tsconfig.base.json", "include": ["src"] }`

`apps/api/src/plugins/db.ts`:
```ts
import fp from "fastify-plugin";
import { prisma } from "@orbix/db";

export default fp(async (app) => {
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => { await prisma.$disconnect(); });
});

declare module "fastify" {
  interface FastifyInstance { prisma: typeof prisma; }
}
```
(Add `fastify-plugin` to dependencies.)

`apps/api/src/routes/health.ts`:
```ts
import type { FastifyInstance } from "fastify";

export default async function health(app: FastifyInstance) {
  app.get("/health", async () => {
    let db = false;
    try { await app.prisma.$queryRaw`SELECT 1`; db = true; } catch { db = false; }
    return { status: "ok", db };
  });
}
```

`apps/api/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import type { Env } from "@orbix/config";
import dbPlugin from "./plugins/db";
import sessionPlugin from "./plugins/session";
import health from "./routes/health";

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(dbPlugin);
  await app.register(sessionPlugin);
  await app.register(health);
  return app;
}
```

`apps/api/src/server.ts`:
```ts
import { loadEnv } from "@orbix/config";
import { buildApp } from "./app";

const env = loadEnv();
const app = await buildApp(env);
app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

`apps/api/src/plugins/session.ts` (skeleton; routes added in Task 6):
```ts
import fp from "fastify-plugin";
import { isSessionValid } from "@orbix/core";

export default fp(async (app) => {
  // Resolves the current account from the "orbix_session" cookie.
  app.decorateRequest("accountId", null);
  app.addHook("preHandler", async (req) => {
    const sid = req.cookies["orbix_session"];
    if (!sid) return;
    const session = await app.prisma.session.findUnique({ where: { id: sid } });
    if (session && isSessionValid(session)) {
      (req as { accountId: string | null }).accountId = session.accountId;
    }
  });
});

declare module "fastify" {
  interface FastifyRequest { accountId: string | null; }
}
```

- [ ] **Step 5: Verify health endpoint**

Run (with compose Postgres up):
```bash
docker compose up -d
curl -s http://localhost:1061/health
```
Expected: `{"status":"ok","db":true}`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): fastify skeleton with db/session plugins and health route"
```

---

### Task 6: Setup + auth + session HTTP routes (api)

**Files:**
- Create: `apps/api/src/routes/setup.ts`, `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/app.ts` (register the two route modules)
- Test: `apps/api/src/routes/auth.test.ts` (inject-based integration tests against `buildApp` with a stubbed prisma)

**Interfaces:**
- Produces endpoints:
  - `GET /setup/status` → `{ complete: boolean }`
  - `POST /setup` `{ email, password }` → creates admin + session cookie → `{ accountId }` (409 if complete, 400 if invalid)
  - `POST /auth/login` `{ email, password }` → sets `orbix_session` cookie → `{ accountId }` (401 on bad creds)
  - `POST /auth/logout` → clears cookie → `204`
  - `GET /auth/me` → `{ accountId }` or `401`

- [ ] **Step 1: Failing route test**

`apps/api/src/routes/auth.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
};

describe("auth routes", () => {
  it("rejects login with bad credentials", async () => {
    const app = await buildApp(env);
    // override prisma with an in-memory stub via app.prisma (decorated)
    (app as any).prisma.account = { findUnique: async () => null };
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "a@b.c", password: "longenough" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```
(Note: for thorough coverage, the real DB-backed flow is exercised by the Playwright e2e in Task 9; these inject tests cover branching logic with stubs.)

- [ ] **Step 2: Implement setup.ts**

```ts
import type { FastifyInstance } from "fastify";
import { createAdminAccount, isSetupComplete, createSession, SESSION_TTL_MS, SetupAlreadyCompleteError, ValidationError } from "@orbix/core";

export default async function setup(app: FastifyInstance) {
  app.get("/setup/status", async () => {
    const complete = await isSetupComplete({ countAccounts: () => app.prisma.account.count() });
    return { complete };
  });

  app.post<{ Body: { email: string; password: string } }>("/setup", async (req, reply) => {
    try {
      const { id } = await createAdminAccount(req.body, {
        hasAnyAccount: async () => (await app.prisma.account.count()) > 0,
        insert: (a) => app.prisma.account.create({ data: { ...a, isAdmin: true }, select: { id: true } }),
      });
      const session = await createSession(id, {
        insert: (s) => app.prisma.session.create({ data: s, select: { id: true, expiresAt: true } }),
      });
      reply.setCookie("orbix_session", session.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
      return { accountId: id };
    } catch (e) {
      if (e instanceof SetupAlreadyCompleteError) return reply.code(409).send({ error: "setup_complete" });
      if (e instanceof ValidationError) return reply.code(400).send({ error: "invalid" });
      throw e;
    }
  });
}
```

- [ ] **Step 3: Implement auth.ts**

```ts
import type { FastifyInstance } from "fastify";
import { verifyPassword, createSession, SESSION_TTL_MS } from "@orbix/core";

export default async function auth(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string } }>("/auth/login", async (req, reply) => {
    const acct = await app.prisma.account.findUnique({ where: { email: req.body.email } });
    if (!acct || !(await verifyPassword(acct.passwordHash, req.body.password))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const session = await createSession(acct.id, {
      insert: (s) => app.prisma.session.create({ data: s, select: { id: true, expiresAt: true } }),
    });
    reply.setCookie("orbix_session", session.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
    return { accountId: acct.id };
  });

  app.post("/auth/logout", async (req, reply) => {
    const sid = req.cookies["orbix_session"];
    if (sid) await app.prisma.session.deleteMany({ where: { id: sid } });
    reply.clearCookie("orbix_session", { path: "/" });
    return reply.code(204).send();
  });

  app.get("/auth/me", async (req, reply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
    return { accountId: req.accountId };
  });
}
```
Register both in `app.ts` (`await app.register(setup); await app.register(auth);`).

- [ ] **Step 4: Run tests + manual smoke**

Run: `pnpm --filter @orbix/api test`
Manual (compose up, DB migrated):
```bash
curl -s -X POST localhost:1061/setup -H 'content-type: application/json' -d '{"email":"me@home.lan","password":"longenough"}' -c /tmp/c.txt
curl -s localhost:1061/auth/me -b /tmp/c.txt
```
Expected: `{"accountId":"..."}` for both.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): setup, login, logout, me routes with session cookies"
```

---

### Task 7: Profile domain + routes

**Files:**
- Create: `packages/core/src/profiles/profiles.ts`, `packages/core/src/profiles/profiles.test.ts`
- Create: `apps/api/src/routes/profiles.ts`; Modify `apps/api/src/app.ts`

**Interfaces:**
- Produces:
  - `validateProfileInput(input): { name; kind; maturityCap?; pin? }` — throws `ValidationError`; kids profiles require a `maturityCap`; pin (if present) must be 4 digits.
  - `hashPin(pin)/verifyPin(hash,pin)` (reuse argon2).
  - Routes (admin-only): `GET /profiles`, `POST /profiles`, `PATCH /profiles/:id`, `DELETE /profiles/:id`; plus `POST /profiles/:id/select` `{ pin? }` → sets `orbix_profile` cookie (verifies PIN if set) → `{ profileId }`.

- [ ] **Step 1: Failing test — profile validation**

`packages/core/src/profiles/profiles.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { validateProfileInput, ProfileValidationError } from "./profiles";

describe("validateProfileInput", () => {
  it("accepts a standard profile", () => {
    expect(validateProfileInput({ name: "Personal", kind: "standard" }).name).toBe("Personal");
  });
  it("requires maturityCap for kids profiles", () => {
    expect(() => validateProfileInput({ name: "Kids", kind: "kids" })).toThrow(ProfileValidationError);
  });
  it("rejects a non-4-digit pin", () => {
    expect(() => validateProfileInput({ name: "P", kind: "standard", pin: "12" })).toThrow(ProfileValidationError);
  });
});
```

- [ ] **Step 2: Run → fail; Step 3: Implement profiles.ts**

```ts
import { z } from "zod";

export class ProfileValidationError extends Error {}

const Schema = z.object({
  name: z.string().min(1).max(40),
  kind: z.enum(["standard", "kids"]),
  maturityCap: z.number().int().min(0).max(21).optional(),
  pin: z.string().regex(/^\d{4}$/).optional(),
}).refine((v) => v.kind !== "kids" || v.maturityCap !== undefined, { message: "kids profiles need a maturityCap" });

export function validateProfileInput(input: unknown) {
  const r = Schema.safeParse(input);
  if (!r.success) throw new ProfileValidationError(r.error.message);
  return r.data;
}
```

- [ ] **Step 4: Run → pass; Step 5: Implement routes.ts**

`apps/api/src/routes/profiles.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { validateProfileInput, hashPassword, verifyPassword, ProfileValidationError } from "@orbix/core";

function requireAdmin(app: FastifyInstance) {
  return async (req: any, reply: any) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
  };
}

export default async function profiles(app: FastifyInstance) {
  app.get("/profiles", async () =>
    app.prisma.profile.findMany({ select: { id: true, name: true, avatar: true, kind: true, maturityCap: true, pinHash: false } }));

  app.post<{ Body: unknown }>("/profiles", { preHandler: requireAdmin(app) }, async (req, reply) => {
    try {
      const v = validateProfileInput(req.body);
      const pinHash = v.pin ? await hashPassword(v.pin) : null;
      const p = await app.prisma.profile.create({
        data: { name: v.name, kind: v.kind, maturityCap: v.maturityCap ?? null, pinHash },
        select: { id: true, name: true, kind: true },
      });
      return p;
    } catch (e) {
      if (e instanceof ProfileValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post<{ Params: { id: string }; Body: { pin?: string } }>("/profiles/:id/select", async (req, reply) => {
    const p = await app.prisma.profile.findUnique({ where: { id: req.params.id } });
    if (!p) return reply.code(404).send({ error: "not_found" });
    if (p.pinHash) {
      if (!req.body?.pin || !(await verifyPassword(p.pinHash, req.body.pin))) {
        return reply.code(403).send({ error: "pin_required" });
      }
    }
    reply.setCookie("orbix_profile", p.id, { httpOnly: true, sameSite: "lax", path: "/" });
    return { profileId: p.id };
  });

  app.delete<{ Params: { id: string } }>("/profiles/:id", { preHandler: requireAdmin(app) }, async (req, reply) => {
    await app.prisma.profile.delete({ where: { id: req.params.id } });
    return reply.code(204).send();
  });
}
```
Register in `app.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(profiles): profile domain validation and admin CRUD + selection routes"
```

---

### Task 8: UI package — design tokens + base components

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/src/tokens.css`, `packages/ui/src/cn.ts`, `packages/ui/src/components/{Button,Card,Input,Avatar}.tsx`, `packages/ui/src/index.ts`

**Interfaces:**
- Produces `@orbix/ui` exporting `Button`, `Card`, `Input`, `Avatar`, `cn`, and `tokens.css` (dark-first CSS variables for color/space/radius).

- [ ] **Step 1: Tokens + cn util**

`packages/ui/src/tokens.css`:
```css
:root {
  --bg: #0b0d12; --surface: #14171f; --surface-2: #1c212b;
  --text: #e8eaف0; --text-dim: #9aa3b2; --accent: #6d7bff; --accent-2: #a06dff;
  --radius: 12px; --radius-sm: 8px;
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--text); }
```
(Fix the typo: `--text: #e8eaf0;`.)

`packages/ui/src/cn.ts`:
```ts
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
```

- [ ] **Step 2: Button + Card + Input + Avatar**

`packages/ui/src/components/Button.tsx`:
```tsx
import { cn } from "../cn";
import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" };

export function Button({ variant = "primary", className, ...rest }: Props) {
  return (
    <button
      className={cn(
        "px-4 py-2 rounded-[var(--radius-sm)] font-medium transition-colors disabled:opacity-50",
        variant === "primary" ? "bg-[var(--accent)] text-white hover:opacity-90" : "bg-transparent text-[var(--text-dim)] hover:text-[var(--text)]",
        className
      )}
      {...rest}
    />
  );
}
```
(Card, Input, Avatar follow the same pattern — simple styled wrappers; keep them minimal and token-driven.)

`packages/ui/src/index.ts`:
```ts
export * from "./cn";
export * from "./components/Button";
export * from "./components/Card";
export * from "./components/Input";
export * from "./components/Avatar";
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(ui): dark-first design tokens and base components"
```

---

### Task 9: Web app — shell, setup wizard, login, "Who's watching?"

**Files:**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tailwind.config.ts`, `apps/web/tsconfig.json`, `apps/web/postcss.config.mjs`
- Create: `apps/web/src/app/{layout,page}.tsx`, `apps/web/src/app/setup/page.tsx`, `apps/web/src/app/login/page.tsx`, `apps/web/src/app/profiles/page.tsx`, `apps/web/src/lib/api.ts`
- Test (e2e): `apps/web/e2e/onboarding.spec.ts` (Playwright)

**Interfaces:**
- Consumes: api endpoints from Tasks 6–7 via `apps/web/src/lib/api.ts` (`apiFetch(path, init)` → adds `credentials: "include"`, base `NEXT_PUBLIC_API_URL`).
- Produces: a working onboarding flow: `/` redirects to `/setup` (if not complete) or `/login` then `/profiles`.

- [ ] **Step 1: Next.js + Tailwind config**

`apps/web/package.json`:
```json
{
  "name": "@orbix/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 1060",
    "build": "next build",
    "start": "next start -p 1060",
    "typecheck": "tsc --noEmit",
    "test:e2e": "playwright test",
    "lint": "next lint"
  },
  "dependencies": {
    "@orbix/ui": "workspace:*",
    "next": "^15.0.0", "react": "^19.0.0", "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0", "tailwindcss": "^4.0.0",
    "@tailwindcss/postcss": "^4.0.0", "typescript": "^5.6.0", "@types/react": "^19.0.0"
  }
}
```
`apps/web/src/lib/api.ts`:
```ts
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:1061";
export async function apiFetch(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, { ...init, credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
}
```

- [ ] **Step 2: Layout importing tokens + root redirect**

`apps/web/src/app/layout.tsx`:
```tsx
import "@orbix/ui/src/tokens.css";
import "./globals.css";
export const metadata = { title: "Orbix" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
```
`apps/web/src/app/page.tsx`: server component that fetches `/setup/status` and redirects to `/setup` or `/login`.

- [ ] **Step 3: Setup wizard page** (`/setup`) — form (email, password) → `POST /setup` → on success redirect `/profiles`.
- [ ] **Step 4: Login page** (`/login`) — form → `POST /auth/login` → redirect `/profiles`.
- [ ] **Step 5: "Who's watching?" page** (`/profiles`) — `GET /profiles`, render avatar grid + "Add profile" (admin); selecting calls `/profiles/:id/select` (PIN modal if needed) → redirect `/` (home placeholder for now).

  Use `@orbix/ui` `Button`, `Card`, `Input`, `Avatar`. Keep pages as client components where they submit forms.

- [ ] **Step 6: Playwright e2e — full onboarding**

`apps/web/e2e/onboarding.spec.ts`:
```ts
import { test, expect } from "@playwright/test";

test("first run: setup -> create profile -> select", async ({ page }) => {
  await page.goto("http://localhost:1060/");
  // fresh DB redirects to /setup
  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel("Email").fill("me@home.lan");
  await page.getByLabel("Password").fill("longenough");
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/profiles/);
  await page.getByRole("button", { name: /add profile/i }).click();
  await page.getByLabel("Name").fill("Personal");
  await page.getByRole("button", { name: /save/i }).click();
  await page.getByText("Personal").click();
  await expect(page).toHaveURL(/\/$/);
});
```
Run against a clean compose stack with a freshly migrated DB.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): app shell, setup wizard, login, who's-watching flow"
```

---

### Task 10: CI pipeline

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI that installs, generates Prisma client, typechecks, lints, and runs unit tests on push/PR.

- [ ] **Step 1: ci.yml**

```yaml
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env: { POSTGRES_USER: orbix, POSTGRES_PASSWORD: orbix, POSTGRES_DB: orbix }
        ports: ["1062:5432"]
        options: >-
          --health-cmd "pg_isready -U orbix" --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgresql://orbix:orbix@localhost:1062/orbix
      REDIS_URL: redis://localhost:1063
      API_PORT: "1061"
      WEB_PORT: "1060"
      SESSION_SECRET: ci-session-secret-32-characters-long
      WEB_ORIGIN: http://localhost:1060
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @orbix/db exec prisma generate
      - run: pnpm --filter @orbix/db exec prisma migrate deploy
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "ci: typecheck, lint, and unit tests with postgres service"
```

---

## Self-Review

**Spec coverage (Phase 0 "Done when": compose boots, setup, create+pick profile, CI runs lint/typecheck/tests):**
- Monorepo + config → Task 1. DB schema/migration → Tasks 2,3. Dev compose (web/api/postgres+pgvector/redis) → Task 3. Auth (argon2 + sessions) → Tasks 4,5,6. Setup wizard → Tasks 6,9. Profiles + "Who's watching" → Tasks 7,9. Design system + shell → Tasks 8,9. CI → Task 10. ✅ All covered.

**Placeholder scan:** Card/Input/Avatar in Task 8 and pages in Task 9 steps 3–5 are described rather than fully coded — they are simple, token-driven wrappers and form pages following the shown `Button`/`apiFetch` patterns; the executor writes them following those exact patterns. The `tokens.css` had a deliberate typo callout (fixed to `--text:#e8eaf0;`). No `TBD`/`TODO` remain in logic.

**Type consistency:** `createAdminAccount`/`createSession`/`isSessionValid`/`validateProfileInput` signatures match between core definitions (Tasks 4,5,7) and api consumers (Tasks 6,7). Cookie names `orbix_session`/`orbix_profile` consistent across plugin + routes. `apiFetch` base + credentials consistent across web pages.

**Note for executor:** `packages/core/src/index.ts` re-exports `session.ts` (Task 5) and `profiles.ts` (Task 7) — add those export lines when each file is created so earlier `@orbix/core` builds don't reference missing modules.
