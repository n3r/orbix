# TV Phase 1 — Catalog Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the live-TV catalog server foundation: the seven `Tv*` Prisma models, a pure core `tv/` domain (M3U parser, name cleaner, iptv-org/M3U sync planners, stable numbering, stream ordering), a `tv` BullMQ queue whose `tv-sync` job syncs the iptv-org index (ETag-conditional) and user M3U playlists into Postgres with logos cached to disk, plus the admin sources CRUD + SSE routes and the kids-gated reader API (`/tv/home`, `/tv/guide`, channel detail, programmes stub, favorites, tune events).

**Architecture:** All hard logic lives in `packages/core/src/tv/` as pure functions over plain data (no fs/network/DB — the house core/api split); `apps/api` supplies real adapters: `lib/iptv-org.ts` (conditional GET with ETags in `Setting` rows and JSON bodies on disk), `plugins/tv-queue.ts` (BullMQ queue `tv`, worker, SSE progress via a module-level `tvEvents` emitter + `tvDoneCache` replay — the exact `queue.ts` scan pattern), and two route files registered under `/api`. Kids profiles get a hard server-side 403 on every non-admin `/tv/*` route via a shared `requireTvAccess` preHandler.

**Tech Stack:** TypeScript, Node 22, pnpm 10.22.0 + Turborepo, Vitest, Prisma + Postgres 16, Fastify, BullMQ (Redis).

**Spec:** docs/superpowers/specs/2026-07-03-tv-live-channels-design.md

## Global Constraints

- **Toolchain:** pnpm 10.22.0 (repo-local, pinned in `packageManager`), Node 22 — never a global pnpm.
- **Core purity:** `packages/core/src/tv/**` imports no fs/network/DB/ffmpeg; everything is injected at the `apps/api` seam; core tests touch no IO.
- **Gates per task:** every task ends with `pnpm typecheck && pnpm lint && pnpm test` green — lint is NOT optional (Turbo caches hide lint-only errors like `no-useless-escape`).
- **Browser code calls relative `/api` only** — this plan is server-side, but the rule binds the logo URLs we emit: always `/api/images/...`, never an absolute origin.
- **No Prisma enums:** string columns + `// "a" | "b"` comments; cuid ids; `onDelete: Cascade` on every child relation; no BigInt anywhere in `Tv*` (keep JSON serialization trivially safe).
- **Kids = server-enforced:** every non-admin `/tv/*` route composes `requireTvAccess` (403 `{error:"not_allowed_for_kids"}`); admin routes compose `requireAuth`+`requireAdmin`+`requireNonKids`. UI-only filtering is a defect.
- **Commit style:** `feat(tv):` / `test(tv):` / `chore(db):` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` on every commit.
- **Never imported:** NSFW channels, blocklisted channels, and closed channels — with one deliberate, test-locked carve-out (Task 4): a closed channel survives only when its `replaced_by` successor exists upstream but is not itself importable here (otherwise the household would lose a still-working stream).
- **Numbers are never auto-renumbered:** existing extIds keep their numbers forever; new channels append after the global max (`assignNumbers`), provider `tvg-chno` is parsed but ignored.

## File Structure

- `packages/db/prisma/schema.prisma` — 7 new models (`TvSource`, `TvChannel`, `TvStream`, `TvProgramme`, `TvEpgSource`, `TvFavorite`, `TvPlayEvent`) + migration `add_tv_live_channels`.
- `packages/core/src/tv/types.ts` — shared TV domain types (fixed cross-phase contract).
- `packages/core/src/tv/parse-m3u.ts` — `parseM3u` (CRLF-safe IPTV dialect).
- `packages/core/src/tv/clean-name.ts` — `cleanChannelName`.
- `packages/core/src/tv/sync-planner.ts` — `planIptvOrgSync`, `planM3uSync`.
- `packages/core/src/tv/numbering.ts` — `assignNumbers`.
- `packages/core/src/tv/pick-stream.ts` — `classifyProtocol`, `orderStreams`.
- `packages/core/src/metadata/images.ts` — `ImageKind` gains `"channel"`.
- `packages/core/src/index.ts` — export the six new tv modules.
- `apps/api/src/lib/iptv-org.ts` — conditional-GET fetch adapter (injected `fetchImpl`).
- `apps/api/src/lib/tv-access.ts` — `requireTvAccess` preHandler.
- `apps/api/src/plugins/tv-queue.ts` — `tvEvents`, `tvDoneCache`, `TvSyncJobData`, `tvQueuePlugin` (queue `tv`, job `tv-sync`, test-mode stub, onClose).
- `apps/api/src/routes/tv-sources.ts` — admin CRUD + upload + sync trigger + SSE.
- `apps/api/src/routes/tv-catalog.ts` — home/guide/channel/programmes/favorites/events readers.
- `apps/api/src/app.ts` — register plugin + routes, 24 h `tv-sync` interval.
- `README.md` — TV catalog feature bullet.

---

### Task 1: Prisma schema — the seven `Tv*` models + `add_tv_live_channels` migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (append a new section; touch nothing existing)
- Create: `packages/db/prisma/migrations/<timestamp>_add_tv_live_channels/migration.sql` (generated)

**Interfaces:**
- Produces: Prisma client models `tvSource`, `tvChannel`, `tvStream`, `tvProgramme`, `tvEpgSource`, `tvFavorite`, `tvPlayEvent` exactly as the spec's Data model section. All later tasks consume these.

- [ ] **Step 1: Append the schema block**

At the end of `packages/db/prisma/schema.prisma` (after `EpisodeTranslation`), paste this block verbatim (copied field-for-field from the spec):

```prisma
// ── TV live channels ─────────────────────────────────────────────────────────

model TvSource {
  id            String      @id @default(cuid())
  kind          String      // "iptv-org" | "m3u"
  name          String
  url           String?     // m3u URL (null for iptv-org / uploaded file)
  filePath      String?     // uploaded playlist stored under METADATA_DIR/tv/playlists
  countries     String[]    @default([]) // iptv-org: enabled country codes (their codes, e.g. "RU","UK")
  epgUrl        String?     // auto-detected url-tvg or manual
  enabled       Boolean     @default(true)
  status        String      @default("ok") // "ok" | "syncing" | "error"
  statusMessage String?
  lastSyncAt    DateTime?
  createdAt     DateTime    @default(now())
  channels      TvChannel[]
}

model TvChannel {
  id          String        @id @default(cuid())
  sourceId    String
  source      TvSource      @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  extId       String        // iptv-org channel id ("ChannelOne.ru") or m3u-derived stable key
  name        String        // cleaned display name
  rawName     String?       // original playlist name ("RU| ПЕРВЫЙ HD 1080p")
  altNames    String[]      @default([])
  number      Int           // stable; assigned once, monotonically; never auto-renumbered
  country     String?       // iptv-org country code
  languages   String[]      @default([])
  categories  String[]      @default([])
  logoUrl     String?
  logoPath    String?       // disk cache under METADATA_DIR, served via /api/images/*
  website     String?
  epgId       String?       // XMLTV id; defaults from extId(@mainFeed); admin-remappable
  quality     String?       // best known ("1080p")
  kidsAllowed Boolean       @default(false) // schema-ready; kids UI later
  hidden      Boolean       @default(false)
  addedAt     DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
  streams     TvStream[]
  programmes  TvProgramme[]
  favorites   TvFavorite[]
  playEvents  TvPlayEvent[]

  @@unique([sourceId, extId])
  @@index([country])
  @@index([number])
}

model TvStream {
  id          String    @id @default(cuid())
  channelId   String
  channel     TvChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  url         String
  feedId      String?   // iptv-org feed id ("SD","HD","Plus1") — provenance only
  quality     String?
  label       String?   // "Geo-blocked" | "Not 24/7" | null
  referrer    String?
  userAgent   String?
  priority    Int       @default(0) // lower tried first; main feed first
  protocol    String    @default("hls") // "hls" | "dash" | "other" — only hls playable v1
  status      String    @default("unknown") // "unknown" | "ok" | "degraded" | "dead"
  failCount   Int       @default(0)
  lastOkAt    DateTime?
  lastCheckAt DateTime?

  @@unique([channelId, url])
  @@index([channelId, priority])
}

model TvProgramme {
  id          String    @id @default(cuid())
  channelId   String
  channel     TvChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  start       DateTime
  stop        DateTime
  title       String
  description String?
  category    String?
  lang        String?

  @@unique([channelId, start])
  @@index([channelId, stop])
}

model TvEpgSource {
  id            String    @id @default(cuid())
  name          String
  url           String    // .xml or .xml.gz
  enabled       Boolean   @default(true)
  offsetMin     Int       @default(0) // the #1 EPG complaint (hours-off guides) gets a knob from day 1
  status        String    @default("ok")
  statusMessage String?
  lastSyncAt    DateTime?
  createdAt     DateTime  @default(now())
}

model TvFavorite {
  id        String    @id @default(cuid())
  profileId String
  channelId String
  channel   TvChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  position  Int       @default(0)
  createdAt DateTime  @default(now())

  @@unique([profileId, channelId])
  @@index([profileId, position])
}

model TvPlayEvent {
  id        String    @id @default(cuid())
  profileId String
  channelId String
  channel   TvChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  at        DateTime  @default(now())

  @@index([profileId, at])
}
```

- [ ] **Step 2: Generate the migration against a throwaway DB**

The shared dev DB has unmerged drift (see the dev-db-divergence memory) — **never** run `migrate dev` against it. Create a throwaway DB and point `DATABASE_URL` at it just for this command:

```bash
docker compose exec postgres psql -U orbix -c 'DROP DATABASE IF EXISTS orbix_tv_plan;' -c 'CREATE DATABASE orbix_tv_plan;'
DATABASE_URL="postgresql://orbix:orbix@localhost:1062/orbix_tv_plan?schema=public" \
  pnpm --filter @orbix/db exec prisma migrate dev --name add_tv_live_channels
```

Expected: all existing migrations apply to the fresh DB, then a new folder `packages/db/prisma/migrations/<ts>_add_tv_live_channels/` appears (same naming convention as `20260701075110_tvdb_ids`). Review its `migration.sql`: exactly 7 `CREATE TABLE` statements, FKs with `ON DELETE CASCADE`, unique indexes `TvChannel_sourceId_extId_key`, `TvStream_channelId_url_key`, `TvProgramme_channelId_start_key`, `TvFavorite_profileId_channelId_key`, plus the declared secondary indexes. **No ALTER/DROP of existing tables.**

- [ ] **Step 3: Regenerate the Prisma client and drop the throwaway DB**

```bash
pnpm db:generate
docker compose exec postgres psql -U orbix -c 'DROP DATABASE IF EXISTS orbix_tv_plan;'
```

Expected: generate succeeds; the client now exposes `prisma.tvSource` … `prisma.tvPlayEvent`.

- [ ] **Step 4: Gates**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS (schema-only change; nothing consumes the models yet).

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "chore(db): Tv* live-channel models (add_tv_live_channels migration)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: core `tv/types.ts` + `tv/parse-m3u.ts` (TDD)

**Files:**
- Create: `packages/core/src/tv/types.ts`
- Create: `packages/core/src/tv/parse-m3u.ts`
- Test: `packages/core/src/tv/parse-m3u.test.ts`

**Interfaces:**
- Produces (fixed cross-phase contract — do not rename):
  - `interface TvM3uEntry { name: string; url: string; tvgId?: string; tvgName?: string; tvgLogo?: string; tvgShift?: string; tvgChno?: string; groupTitles: string[]; referrer?: string; userAgent?: string; origin?: string; }`
  - `interface TvM3uPlaylist { entries: TvM3uEntry[]; epgUrls: string[]; }`
  - `interface IptvOrgChannel { id: string; name: string; alt_names: string[]; country: string; categories: string[]; is_nsfw: boolean; closed: string | null; replaced_by: string | null; website: string | null; }`
  - `interface IptvOrgFeed { channel: string; id: string; name: string; is_main: boolean; languages: string[]; format: string | null; }`
  - `interface IptvOrgStream { channel: string | null; feed: string | null; title: string; url: string; referrer: string | null; user_agent: string | null; quality: string | null; label: string | null; }`
  - `interface IptvOrgLogo { channel: string; feed: string | null; url: string; width: number; height: number; format: string | null; }`
  - `interface StreamPlan { url: string; feedId: string | null; quality: string | null; label: string | null; referrer: string | null; userAgent: string | null; priority: number; protocol: "hls" | "dash" | "other"; }`
  - `interface ChannelUpsertPlan { extId: string; name: string; rawName: string | null; altNames: string[]; country: string | null; languages: string[]; categories: string[]; logoUrl: string | null; website: string | null; epgId: string | null; quality: string | null; streams: StreamPlan[]; }`
  - `function parseM3u(text: string): TvM3uPlaylist`

- [ ] **Step 1: Create the types module**

Create `packages/core/src/tv/types.ts`:

```ts
// ── M3U playlist shapes ──────────────────────────────────────────────────────

/** One channel entry parsed from an IPTV M3U playlist. */
export interface TvM3uEntry {
  /** Display name (text after the #EXTINF comma; falls back to tvg-name). */
  name: string;
  /** Stream URL with any `|Header=Value` pipe suffix already stripped. */
  url: string;
  tvgId?: string;
  tvgName?: string;
  tvgLogo?: string;
  /** Parsed but ignored downstream (EPG shift is a later-phase concern). */
  tvgShift?: string;
  /** Parsed but ignored downstream (provider numbers are junk — TiviMate practice). */
  tvgChno?: string;
  /** `group-title` split on ";" — a channel can sit in several groups. */
  groupTitles: string[];
  /** From #EXTVLCOPT:http-referrer or a `|Referer=` pipe suffix. */
  referrer?: string;
  /** From #EXTVLCOPT:http-user-agent or a `|User-Agent=` pipe suffix. */
  userAgent?: string;
  /** From #EXTVLCOPT:http-origin or an `|Origin=` pipe suffix. */
  origin?: string;
}

export interface TvM3uPlaylist {
  entries: TvM3uEntry[];
  /** From the #EXTM3U header's url-tvg / x-tvg-url attribute (comma-separated). */
  epgUrls: string[];
}

// ── iptv-org API shapes (https://iptv-org.github.io/api/*.json) ─────────────
// Field names mirror the upstream JSON exactly (snake_case) — these are wire
// types, not domain types.

export interface IptvOrgChannel {
  id: string;
  name: string;
  alt_names: string[];
  /** iptv-org country code — authoritative, NOT ISO ("UK", not "GB"). */
  country: string;
  categories: string[];
  is_nsfw: boolean;
  /** Closure date (channel no longer broadcasts) or null. */
  closed: string | null;
  /** Successor channel id when renamed/rebranded, or null. */
  replaced_by: string | null;
  website: string | null;
}

export interface IptvOrgFeed {
  /** Owning channel id. */
  channel: string;
  /** Feed id within the channel ("SD", "HD", "Plus1"). */
  id: string;
  name: string;
  /** Exactly one main feed per channel upstream. */
  is_main: boolean;
  languages: string[];
  format: string | null;
}

export interface IptvOrgStream {
  /** Channel id, or null when the stream is unmatched upstream. */
  channel: string | null;
  feed: string | null;
  title: string;
  url: string;
  referrer: string | null;
  user_agent: string | null;
  quality: string | null;
  label: string | null;
}

export interface IptvOrgLogo {
  channel: string;
  feed: string | null;
  url: string;
  width: number;
  height: number;
  format: string | null;
}

// ── Sync planner output ──────────────────────────────────────────────────────

export interface StreamPlan {
  url: string;
  feedId: string | null;
  quality: string | null;
  label: string | null;
  referrer: string | null;
  userAgent: string | null;
  /** Lower tried first; main-feed streams first. */
  priority: number;
  protocol: "hls" | "dash" | "other";
}

/** One channel to upsert by (sourceId, extId) — the sync job's unit of work. */
export interface ChannelUpsertPlan {
  extId: string;
  name: string;
  rawName: string | null;
  altNames: string[];
  country: string | null;
  languages: string[];
  categories: string[];
  logoUrl: string | null;
  website: string | null;
  /** XMLTV id: `extId@mainFeedId` when a main feed exists, else extId (m3u: tvg-id). */
  epgId: string | null;
  /** Best known quality across streams ("1080p"). */
  quality: string | null;
  streams: StreamPlan[];
}
```

- [ ] **Step 2: Write the failing parser test**

Create `packages/core/src/tv/parse-m3u.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseM3u } from "./parse-m3u";

// Real-world shaped playlist: CRLF line endings, #EXTVLCOPT header options,
// #KODIPROP noise, a pipe-suffixed URL, multi-category group-title, url-tvg
// with two URLs, a stray comment, and an orphan URL without #EXTINF.
const FIXTURE = [
  '#EXTM3U url-tvg="https://epg.example.one/EPG_LITE.xml.gz, https://epg.example.two/ru.xml"',
  '#EXTINF:-1 tvg-id="ChannelOne.ru" tvg-name="Первый канал" tvg-logo="https://logos.example/1tv.png" tvg-shift="+3" tvg-chno="1" group-title="Comedy;Family;Movies",RU| ПЕРВЫЙ HD 1080p',
  "#EXTVLCOPT:http-referrer=https://player.example.ru/",
  "#EXTVLCOPT:http-user-agent=Mozilla/5.0 (SmartTV; rv:120.0)",
  "#EXTVLCOPT:http-origin=https://player.example.ru",
  "#KODIPROP:inputstream.adaptive.manifest_type=hls",
  "https://cdn.example.ru/1tv/index.m3u8",
  "",
  '#EXTINF:0 group-title="News",2x2 (576i)',
  "https://cdn.example.ru/2x2/playlist.m3u8|User-Agent=TiviMate/5.1.6&Referer=https://ref.example/",
  "# a stray comment the parser must tolerate",
  "https://orphan.example/no-extinf.m3u8",
].join("\r\n");

describe("parseM3u", () => {
  it("parses entries, attributes and per-entry headers from a CRLF playlist", () => {
    const { entries, epgUrls } = parseM3u(FIXTURE);
    expect(entries).toHaveLength(2);

    expect(entries[0]).toEqual({
      name: "RU| ПЕРВЫЙ HD 1080p",
      url: "https://cdn.example.ru/1tv/index.m3u8",
      tvgId: "ChannelOne.ru",
      tvgName: "Первый канал",
      tvgLogo: "https://logos.example/1tv.png",
      tvgShift: "+3",
      tvgChno: "1",
      groupTitles: ["Comedy", "Family", "Movies"],
      referrer: "https://player.example.ru/",
      userAgent: "Mozilla/5.0 (SmartTV; rv:120.0)",
      origin: "https://player.example.ru",
    });

    expect(entries[1]).toEqual({
      name: "2x2 (576i)",
      url: "https://cdn.example.ru/2x2/playlist.m3u8",
      groupTitles: ["News"],
      userAgent: "TiviMate/5.1.6",
      referrer: "https://ref.example/",
    });

    expect(epgUrls).toEqual([
      "https://epg.example.one/EPG_LITE.xml.gz",
      "https://epg.example.two/ru.xml",
    ]);
  });

  it("skips URL lines with no preceding #EXTINF", () => {
    const { entries } = parseM3u(FIXTURE);
    expect(entries.some((e) => e.url.includes("orphan.example"))).toBe(false);
  });

  it("does not leak #EXTVLCOPT headers across entries", () => {
    const { entries } = parseM3u(FIXTURE);
    expect(entries[1].origin).toBeUndefined();
  });

  it("returns empty results for empty input", () => {
    expect(parseM3u("")).toEqual({ entries: [], epgUrls: [] });
  });

  it("keeps a pending #EXTINF across blank and comment lines", () => {
    const text = ['#EXTINF:-1 tvg-id="A.tv",A TV', "", "# note", "https://a.example/a.m3u8"].join(
      "\r\n",
    );
    const { entries } = parseM3u(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].tvgId).toBe("A.tv");
    expect(entries[0].name).toBe("A TV");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/parse-m3u.test.ts`
Expected: FAIL — cannot resolve import `./parse-m3u` (module does not exist yet).

- [ ] **Step 4: Implement the parser**

Create `packages/core/src/tv/parse-m3u.ts`:

```ts
import type { TvM3uEntry, TvM3uPlaylist } from "./types";

const ATTR_RE = /([\w-]+)="([^"]*)"/g;

/** Parse `#EXTINF:<dur> attr="v" …,Display Name` into attrs + display name. */
function parseExtinf(line: string): { attrs: Record<string, string>; name: string } {
  const body = line.slice("#EXTINF:".length);
  // Strip the duration token ("-1", "0", "12.5").
  const dur = /^\s*-?\d+(?:\.\d+)?/.exec(body);
  const rest = dur ? body.slice(dur[0].length) : body;

  const attrs: Record<string, string> = {};
  let attrsEnd = 0;
  for (const m of rest.matchAll(ATTR_RE)) {
    attrs[m[1].toLowerCase()] = m[2];
    attrsEnd = (m.index ?? 0) + m[0].length;
  }
  // The display name is everything after the comma that follows the last
  // attribute (names themselves may contain commas — take the whole tail).
  const tail = rest.slice(attrsEnd);
  const comma = tail.indexOf(",");
  const name = (comma >= 0 ? tail.slice(comma + 1) : tail).trim();
  return { attrs, name };
}

/** Split a `URL|Key=Value&Key2=Value2` pipe suffix into url + header map. */
function parsePipeSuffix(rawUrl: string): { url: string; headers: Record<string, string> } {
  const pipe = rawUrl.indexOf("|");
  if (pipe < 0) return { url: rawUrl, headers: {} };
  const headers: Record<string, string> = {};
  for (const pair of rawUrl.slice(pipe + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    headers[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
  }
  return { url: rawUrl.slice(0, pipe), headers };
}

/**
 * Parse an IPTV-dialect M3U playlist into entries + EPG URLs.
 *
 * CRLF-safe (iptv-org playlists are CRLF). Understands #EXTINF attributes
 * (tvg-id/tvg-name/tvg-logo/tvg-shift/tvg-chno/group-title incl. ";"-multi),
 * #EXTVLCOPT http-referrer/http-user-agent/http-origin, `URL|Header=Value`
 * pipe suffixes (which override #EXTVLCOPT), and the header's url-tvg /
 * x-tvg-url EPG URLs. #KODIPROP and unknown comments are tolerated and
 * ignored. URL lines with no preceding #EXTINF are skipped.
 */
export function parseM3u(text: string): TvM3uPlaylist {
  const entries: TvM3uEntry[] = [];
  const epgUrls: string[] = [];

  let pending: { attrs: Record<string, string>; name: string } | null = null;
  let vlcOpts: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line.startsWith("#EXTM3U")) {
      for (const m of line.matchAll(ATTR_RE)) {
        const key = m[1].toLowerCase();
        if (key === "url-tvg" || key === "x-tvg-url") {
          for (const u of m[2].split(",")) {
            const trimmed = u.trim();
            if (trimmed) epgUrls.push(trimmed);
          }
        }
      }
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pending = parseExtinf(line);
      vlcOpts = {};
      continue;
    }
    if (line.startsWith("#EXTVLCOPT:")) {
      const body = line.slice("#EXTVLCOPT:".length);
      const eq = body.indexOf("=");
      if (eq > 0) vlcOpts[body.slice(0, eq).trim().toLowerCase()] = body.slice(eq + 1).trim();
      continue;
    }
    if (line.startsWith("#")) continue; // #KODIPROP and other comments: tolerated, ignored

    // A URL line. Without channel info there is nothing to import — skip.
    if (!pending) continue;

    const { url, headers } = parsePipeSuffix(line);
    const attrs = pending.attrs;
    const name = pending.name || attrs["tvg-name"] || "Channel";
    const groupTitles = (attrs["group-title"] ?? "")
      .split(";")
      .map((g) => g.trim())
      .filter((g) => g.length > 0);

    // Pipe-suffix headers are the more specific form — they win over #EXTVLCOPT.
    const referrer = headers["referer"] ?? headers["referrer"] ?? vlcOpts["http-referrer"];
    const userAgent = headers["user-agent"] ?? vlcOpts["http-user-agent"];
    const origin = headers["origin"] ?? vlcOpts["http-origin"];

    entries.push({
      name,
      url,
      ...(attrs["tvg-id"] ? { tvgId: attrs["tvg-id"] } : {}),
      ...(attrs["tvg-name"] ? { tvgName: attrs["tvg-name"] } : {}),
      ...(attrs["tvg-logo"] ? { tvgLogo: attrs["tvg-logo"] } : {}),
      ...(attrs["tvg-shift"] ? { tvgShift: attrs["tvg-shift"] } : {}),
      ...(attrs["tvg-chno"] ? { tvgChno: attrs["tvg-chno"] } : {}),
      groupTitles,
      ...(referrer ? { referrer } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(origin ? { origin } : {}),
    });
    pending = null;
    vlcOpts = {};
  }

  return { entries, epgUrls };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/parse-m3u.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Scoped lint + typecheck**

Run: `pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tv/types.ts packages/core/src/tv/parse-m3u.ts packages/core/src/tv/parse-m3u.test.ts
git commit -m "feat(tv): core TV domain types + CRLF-safe IPTV M3U parser" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: core `tv/clean-name.ts` (TDD)

**Files:**
- Create: `packages/core/src/tv/clean-name.ts`
- Test: `packages/core/src/tv/clean-name.test.ts`

**Interfaces:**
- Produces: `function cleanChannelName(raw: string): { name: string; quality: string | null; label: string | null }` (fixed contract). Consumed by `planM3uSync` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tv/clean-name.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cleanChannelName } from "./clean-name";

describe("cleanChannelName", () => {
  it("strips a country prefix and resolves quality (resolution beats HD word)", () => {
    expect(cleanChannelName("RU| ПЕРВЫЙ HD 1080p")).toEqual({
      name: "ПЕРВЫЙ",
      quality: "1080p",
      label: null,
    });
  });

  it("extracts a parenthesised resolution", () => {
    expect(cleanChannelName("2x2 (576i)")).toEqual({ name: "2x2", quality: "576i", label: null });
  });

  it("extracts bracketed status labels", () => {
    expect(cleanChannelName("Fashion TV [Not 24/7]")).toEqual({
      name: "Fashion TV",
      quality: null,
      label: "Not 24/7",
    });
    expect(cleanChannelName("MTV 00s [Geo-blocked]")).toEqual({
      name: "MTV 00s",
      quality: null,
      label: "Geo-blocked",
    });
  });

  it("uses a quality word when no resolution token is present", () => {
    expect(cleanChannelName("CNN HD")).toEqual({ name: "CNN", quality: "HD", label: null });
  });

  it("is idempotent on already-clean names", () => {
    for (const name of ["ПЕРВЫЙ", "2x2", "BBC One", "France 24"]) {
      expect(cleanChannelName(name)).toEqual({ name, quality: null, label: null });
    }
  });

  it("falls back to the raw name when cleaning would empty it", () => {
    expect(cleanChannelName("HD").name).toBe("HD");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/clean-name.test.ts`
Expected: FAIL — cannot resolve import `./clean-name`.

- [ ] **Step 3: Implement**

Create `packages/core/src/tv/clean-name.ts`:

```ts
export interface CleanedChannelName {
  name: string;
  quality: string | null;
  label: string | null;
}

// "RU| ПЕРВЫЙ", "USA| CNN" — 2-3 uppercase ASCII letters + a pipe.
const COUNTRY_PREFIX_RE = /^[A-Z]{2,3}\s*\|\s*/;
// Resolution token, optionally parenthesised: 1080p, 576i, (720p) …
const RESOLUTION_RE = /\(?\b(\d{3,4}[pi])\b\)?/i;
// Bare quality words; stripped from the name, used as quality only when no
// resolution token exists ("CNN HD" → quality "HD").
const QUALITY_WORD_RE = /\b(UHD|FHD|HD|SD|4K|8K)\b/gi;
// Bracketed status suffixes: [Not 24/7], [Geo-blocked] …
const BRACKET_RE = /\[([^\]]*)\]/g;

/**
 * Clean a raw playlist channel name ("RU| ПЕРВЫЙ HD 1080p") into a display
 * name plus extracted quality ("1080p" | "576i" | "HD" | null) and status
 * label ("Not 24/7" | "Geo-blocked" | null). Idempotent: cleaning an
 * already-clean name returns it unchanged.
 */
export function cleanChannelName(raw: string): CleanedChannelName {
  let s = raw.trim();
  let label: string | null = null;
  let quality: string | null = null;

  s = s.replace(COUNTRY_PREFIX_RE, "");

  s = s.replace(BRACKET_RE, (_m: string, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed && label == null) label = trimmed; // first bracket wins
    return " ";
  });

  const res = RESOLUTION_RE.exec(s);
  if (res) {
    quality = res[1].toLowerCase();
    s = s.replace(res[0], " ");
  }

  const words = [...s.matchAll(QUALITY_WORD_RE)];
  if (words.length > 0) {
    if (quality == null) quality = words[0][1].toUpperCase();
    s = s.replace(QUALITY_WORD_RE, " ");
  }

  s = s.replace(/\(\s*\)/g, " "); // leftover empty parens
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/[\s\-–—|]+$/g, "").trim(); // trailing separators

  return { name: s.length > 0 ? s : raw.trim(), quality, label };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/clean-name.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Scoped lint**

Run: `pnpm --filter @orbix/core lint`
Expected: PASS (watch for `no-useless-escape` in the regexes — the character classes above are already escape-clean).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tv/clean-name.ts packages/core/src/tv/clean-name.test.ts
git commit -m "feat(tv): channel name cleaner (country prefix, quality, status labels)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: core `tv/pick-stream.ts` + `tv/numbering.ts` + `tv/sync-planner.ts` (TDD)

**Files:**
- Create: `packages/core/src/tv/pick-stream.ts`
- Create: `packages/core/src/tv/numbering.ts`
- Create: `packages/core/src/tv/sync-planner.ts`
- Test: `packages/core/src/tv/pick-stream.test.ts`
- Test: `packages/core/src/tv/numbering.test.ts`
- Test: `packages/core/src/tv/sync-planner.test.ts`

**Interfaces:**
- Consumes: `types.ts` (Task 2), `cleanChannelName` + `parseM3u` output shape (Tasks 2-3).
- Produces (fixed contract):
  - `function classifyProtocol(url: string): "hls" | "dash" | "other"`
  - `function orderStreams<T extends { priority: number; status: string; protocol: string }>(streams: T[]): T[]` — playable hls first; status rank ok>unknown>degraded, dead excluded; then priority asc
  - `function assignNumbers(existingMax: number, existing: Map<string, number>, incoming: { extId: string; country: string | null; name: string }[]): Map<string, number>`
  - `function planIptvOrgSync(input: { channels: IptvOrgChannel[]; feeds: IptvOrgFeed[]; streams: IptvOrgStream[]; logos: IptvOrgLogo[]; blocklist: { channel: string }[]; countries: string[] }): ChannelUpsertPlan[]`
  - `function planM3uSync(playlist: TvM3uPlaylist): ChannelUpsertPlan[]`

- [ ] **Step 1: Write the failing pick-stream test**

Create `packages/core/src/tv/pick-stream.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyProtocol, orderStreams } from "./pick-stream";

describe("classifyProtocol", () => {
  it("classifies by URL extension, ignoring query strings and case", () => {
    expect(classifyProtocol("https://cdn.example/live/index.m3u8")).toBe("hls");
    expect(classifyProtocol("https://cdn.example/live/master.M3U8?token=abc")).toBe("hls");
    expect(classifyProtocol("https://cdn.example/dash/manifest.mpd")).toBe("dash");
    expect(classifyProtocol("http://203.0.113.7:8080/stream.ts")).toBe("other");
    expect(classifyProtocol("rtmp://cdn.example/live")).toBe("other");
  });
});

describe("orderStreams", () => {
  const streams = [
    { id: "dead", priority: 0, status: "dead", protocol: "hls" },
    { id: "dash", priority: 0, status: "ok", protocol: "dash" },
    { id: "degraded", priority: 0, status: "degraded", protocol: "hls" },
    { id: "unknown-p1", priority: 1, status: "unknown", protocol: "hls" },
    { id: "ok-p2", priority: 2, status: "ok", protocol: "hls" },
    { id: "ok-p1", priority: 1, status: "ok", protocol: "hls" },
  ];

  it("excludes dead and non-HLS, ranks ok > unknown > degraded, then priority asc", () => {
    expect(orderStreams(streams).map((s) => s.id)).toEqual([
      "ok-p1",
      "ok-p2",
      "unknown-p1",
      "degraded",
    ]);
  });

  it("does not mutate its input", () => {
    const before = streams.map((s) => s.id);
    orderStreams(streams);
    expect(streams.map((s) => s.id)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/pick-stream.test.ts`
Expected: FAIL — cannot resolve import `./pick-stream`.

- [ ] **Step 3: Implement pick-stream**

Create `packages/core/src/tv/pick-stream.ts`:

```ts
/** Classify a stream URL by container extension: .m3u8 → hls, .mpd → dash, else other. */
export function classifyProtocol(url: string): "hls" | "dash" | "other" {
  let probe = url;
  try {
    probe = new URL(url).pathname; // drop query/hash so "index.m3u8?token=x" classifies
  } catch {
    // not parseable as a URL — classify on the raw string
  }
  const lower = probe.toLowerCase();
  if (lower.endsWith(".m3u8")) return "hls";
  if (lower.endsWith(".mpd")) return "dash";
  return "other";
}

const STATUS_RANK: Record<string, number> = { ok: 0, unknown: 1, degraded: 2 };

/**
 * Order streams for playback: HLS only (v1 plays nothing else), dead excluded,
 * ranked by status (ok > unknown > degraded), then priority ascending.
 * Returns a new array — the input is never mutated.
 */
export function orderStreams<T extends { priority: number; status: string; protocol: string }>(
  streams: T[],
): T[] {
  return streams
    .filter((s) => s.protocol === "hls" && s.status !== "dead")
    .sort((a, b) => {
      const ra = STATUS_RANK[a.status] ?? 1;
      const rb = STATUS_RANK[b.status] ?? 1;
      if (ra !== rb) return ra - rb;
      return a.priority - b.priority;
    });
}
```

- [ ] **Step 4: Verify pick-stream passes**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/pick-stream.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing numbering test**

Create `packages/core/src/tv/numbering.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assignNumbers } from "./numbering";

describe("assignNumbers", () => {
  it("assigns first-import numbers sorted by country then name (null country last)", () => {
    const out = assignNumbers(0, new Map(), [
      { extId: "b.ru", country: "RU", name: "B Channel" },
      { extId: "a.uk", country: "UK", name: "A Channel" },
      { extId: "a.ru", country: "RU", name: "A Channel" },
      { extId: "m3u-1", country: null, name: "My Playlist Channel" },
    ]);
    expect(out.get("a.ru")).toBe(1);
    expect(out.get("b.ru")).toBe(2);
    expect(out.get("a.uk")).toBe(3);
    expect(out.get("m3u-1")).toBe(4);
  });

  it("keeps existing numbers and appends new channels after the global max", () => {
    const existing = new Map([
      ["a.ru", 2],
      ["b.ru", 5],
    ]);
    const out = assignNumbers(41, existing, [
      { extId: "a.ru", country: "RU", name: "A" },
      { extId: "c.ru", country: "RU", name: "C" },
      { extId: "b.ru", country: "RU", name: "B" },
    ]);
    expect(out.get("a.ru")).toBe(2); // stable — never renumbered
    expect(out.get("b.ru")).toBe(5);
    expect(out.get("c.ru")).toBe(42); // appended after the global max
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/numbering.test.ts`
Expected: FAIL — cannot resolve import `./numbering`.

- [ ] **Step 7: Implement numbering**

Create `packages/core/src/tv/numbering.ts`:

```ts
/**
 * Assign stable channel numbers. Channels already numbered (present in
 * `existing`, keyed by extId) keep their numbers — numbers are never reused or
 * auto-renumbered. New channels append after `existingMax` (the max number
 * across ALL sources), ordered country-then-name (plain code-point comparison
 * for determinism across ICU builds; null country sorts last).
 */
export function assignNumbers(
  existingMax: number,
  existing: Map<string, number>,
  incoming: { extId: string; country: string | null; name: string }[],
): Map<string, number> {
  const out = new Map<string, number>();
  const fresh: { extId: string; country: string | null; name: string }[] = [];

  for (const c of incoming) {
    const current = existing.get(c.extId);
    if (current != null) out.set(c.extId, current);
    else fresh.push(c);
  }

  fresh.sort((a, b) => {
    const ca = a.country ?? "\uffff"; // null country after every real code
    const cb = b.country ?? "\uffff";
    if (ca !== cb) return ca < cb ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.extId < b.extId ? -1 : a.extId > b.extId ? 1 : 0;
  });

  let next = existingMax;
  for (const c of fresh) {
    next += 1;
    out.set(c.extId, next);
  }
  return out;
}
```

- [ ] **Step 8: Verify numbering passes**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/numbering.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Write the failing sync-planner test**

Create `packages/core/src/tv/sync-planner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planIptvOrgSync, planM3uSync } from "./sync-planner";
import type {
  IptvOrgChannel,
  IptvOrgFeed,
  IptvOrgLogo,
  IptvOrgStream,
  TvM3uPlaylist,
} from "./types";

function ch(
  id: string,
  name: string,
  country: string,
  extra: Partial<IptvOrgChannel> = {},
): IptvOrgChannel {
  return {
    id,
    name,
    alt_names: [],
    country,
    categories: [],
    is_nsfw: false,
    closed: null,
    replaced_by: null,
    website: null,
    ...extra,
  };
}

function st(channel: string | null, url: string, extra: Partial<IptvOrgStream> = {}): IptvOrgStream {
  return {
    channel,
    feed: null,
    title: "",
    url,
    referrer: null,
    user_agent: null,
    quality: null,
    label: null,
    ...extra,
  };
}

const channels: IptvOrgChannel[] = [
  ch("ChannelOne.ru", "Channel One", "RU", {
    alt_names: ["Первый канал"],
    categories: ["general"],
    website: "https://1tv.ru",
  }),
  ch("BBCOne.uk", "BBC One", "UK", { categories: ["general"] }),
  ch("Adult.ru", "Adult", "RU", { is_nsfw: true }),
  ch("Blocked.ru", "Blocked", "RU"),
  ch("OldName.ru", "Old Name", "RU", { closed: "2024-01-01", replaced_by: "NewName.ru" }),
  ch("NewName.ru", "New Name", "RU"),
  ch("GoneForever.ru", "Gone Forever", "RU", { closed: "2020-05-05" }),
  ch("MovedAbroad.ru", "Moved Abroad", "RU", { closed: "2023-02-02", replaced_by: "Moved.fr" }),
  ch("NoStreams.ru", "No Streams", "RU"),
  ch("Telecinco.es", "Telecinco", "ES"),
];

const feeds: IptvOrgFeed[] = [
  { channel: "ChannelOne.ru", id: "SD", name: "SD", is_main: true, languages: ["rus"], format: "576i" },
  { channel: "ChannelOne.ru", id: "HD", name: "HD", is_main: false, languages: ["rus"], format: "1080i" },
];

const streams: IptvOrgStream[] = [
  st("ChannelOne.ru", "https://cdn.example/1tv-hd.m3u8", { feed: "HD", quality: "1080p" }),
  st("ChannelOne.ru", "https://cdn.example/1tv-sd.m3u8", {
    feed: "SD",
    quality: "480p",
    referrer: "https://ref.example/",
    user_agent: "Mozilla/5.0",
  }),
  st("ChannelOne.ru", "https://mirror.example/1tv.m3u8", { label: "Not 24/7" }),
  st("ChannelOne.ru", "https://cdn.example/1tv-hd.m3u8", { feed: "HD" }), // duplicate URL
  st("BBCOne.uk", "https://bbc.example/one.mpd"),
  st("Blocked.ru", "https://blocked.example/x.m3u8"),
  st("Adult.ru", "https://adult.example/x.m3u8"),
  st("OldName.ru", "https://old.example/x.m3u8"),
  st("NewName.ru", "https://new.example/x.m3u8"),
  st("GoneForever.ru", "https://gone.example/x.m3u8"),
  st("MovedAbroad.ru", "https://moved.example/x.m3u8"),
  st("Telecinco.es", "https://t5.example/x.m3u8"),
  st(null, "https://unmatched.example/x.m3u8"), // unmatched stream — ignored
];

const logos: IptvOrgLogo[] = [
  { channel: "ChannelOne.ru", feed: null, url: "https://logos.example/1tv-small.png", width: 256, height: 256, format: "png" },
  { channel: "ChannelOne.ru", feed: "HD", url: "https://logos.example/1tv-wide.png", width: 512, height: 512, format: "png" },
  { channel: "ChannelOne.ru", feed: null, url: "https://logos.example/1tv-huge.jpg", width: 1024, height: 1024, format: "jpg" },
];

const blocklist = [{ channel: "Blocked.ru" }];

describe("planIptvOrgSync", () => {
  const plans = planIptvOrgSync({ channels, feeds, streams, logos, blocklist, countries: ["RU", "UK"] });
  const ids = plans.map((p) => p.extId);

  it("filters to enabled countries, passing iptv-org codes through verbatim (UK, not GB)", () => {
    expect(ids).toContain("BBCOne.uk");
    expect(ids).not.toContain("Telecinco.es");
  });

  it("excludes NSFW, blocklisted and stream-less channels", () => {
    expect(ids).not.toContain("Adult.ru");
    expect(ids).not.toContain("Blocked.ru");
    expect(ids).not.toContain("NoStreams.ru");
  });

  it("drops closed channels (replaced in-batch or dead-ended) but keeps one whose replacement is not importable", () => {
    expect(ids).not.toContain("OldName.ru"); // replacement NewName.ru is in this batch
    expect(ids).toContain("NewName.ru");
    expect(ids).not.toContain("GoneForever.ru"); // closed with no successor
    expect(ids).toContain("MovedAbroad.ru"); // successor Moved.fr is not importable here
  });

  it("flattens feeds main-first, dedupes stream URLs and classifies protocols", () => {
    const one = plans.find((p) => p.extId === "ChannelOne.ru")!;
    expect(one.streams.map((s) => s.url)).toEqual([
      "https://cdn.example/1tv-sd.m3u8", // main feed (SD) first
      "https://mirror.example/1tv.m3u8", // channel-level stream next
      "https://cdn.example/1tv-hd.m3u8", // other feed last; duplicate URL dropped
    ]);
    expect(one.streams.map((s) => s.priority)).toEqual([0, 1, 2]);
    expect(one.streams[0]).toMatchObject({
      feedId: "SD",
      referrer: "https://ref.example/",
      userAgent: "Mozilla/5.0",
      protocol: "hls",
    });
    expect(one.streams[1].label).toBe("Not 24/7");
    const bbc = plans.find((p) => p.extId === "BBCOne.uk")!;
    expect(bbc.streams[0].protocol).toBe("dash");
  });

  it("derives epgId from the main feed, quality from the best stream, languages from the main feed", () => {
    const one = plans.find((p) => p.extId === "ChannelOne.ru")!;
    expect(one.epgId).toBe("ChannelOne.ru@SD");
    expect(one.quality).toBe("1080p");
    expect(one.languages).toEqual(["rus"]);
    expect(one.altNames).toEqual(["Первый канал"]);
    expect(one.website).toBe("https://1tv.ru");
    expect(one.country).toBe("RU");
    expect(one.rawName).toBeNull();
    const bbc = plans.find((p) => p.extId === "BBCOne.uk")!;
    expect(bbc.epgId).toBe("BBCOne.uk"); // no feeds → bare extId
  });

  it("picks the widest PNG/SVG logo (a wider JPG loses)", () => {
    const one = plans.find((p) => p.extId === "ChannelOne.ru")!;
    expect(one.logoUrl).toBe("https://logos.example/1tv-wide.png");
    const bbc = plans.find((p) => p.extId === "BBCOne.uk")!;
    expect(bbc.logoUrl).toBeNull(); // no logos at all
  });
});

describe("planM3uSync", () => {
  const playlist: TvM3uPlaylist = {
    epgUrls: ["https://epg.example/guide.xml"],
    entries: [
      {
        name: "RU| ПЕРВЫЙ HD 1080p",
        url: "https://a.example/1tv.m3u8",
        tvgId: "ChannelOne.ru",
        tvgLogo: "https://logos.example/1tv.png",
        groupTitles: ["General", "Federal"],
        referrer: "https://ref.example/",
      },
      { name: "RU| ПЕРВЫЙ (backup)", url: "https://b.example/1tv.m3u8", tvgId: "ChannelOne.ru", groupTitles: [] },
      { name: "2x2 (576i)", url: "https://a.example/2x2.m3u8", groupTitles: ["Comedy"], userAgent: "TiviMate/5.1.6" },
    ],
  };
  const plans = planM3uSync(playlist);

  it("groups repeated tvg-ids into one channel with multiple prioritized streams", () => {
    expect(plans).toHaveLength(2);
    const one = plans[0];
    expect(one.extId).toBe("ChannelOne.ru");
    expect(one.name).toBe("ПЕРВЫЙ");
    expect(one.rawName).toBe("RU| ПЕРВЫЙ HD 1080p");
    expect(one.quality).toBe("1080p");
    expect(one.epgId).toBe("ChannelOne.ru");
    expect(one.country).toBeNull();
    expect(one.categories).toEqual(["general", "federal"]);
    expect(one.logoUrl).toBe("https://logos.example/1tv.png");
    expect(one.streams.map((s) => [s.url, s.priority])).toEqual([
      ["https://a.example/1tv.m3u8", 0],
      ["https://b.example/1tv.m3u8", 1],
    ]);
    expect(one.streams[0].referrer).toBe("https://ref.example/");
    expect(one.streams[0].protocol).toBe("hls");
  });

  it("derives a stable hashed extId when tvg-id is absent", () => {
    const two = plans[1];
    expect(two.extId).toMatch(/^m3u-[0-9a-f]{8}$/);
    expect(two.name).toBe("2x2");
    expect(two.quality).toBe("576i");
    expect(two.epgId).toBeNull();
    expect(two.streams[0].userAgent).toBe("TiviMate/5.1.6");
    const again = planM3uSync(playlist);
    expect(again[1].extId).toBe(two.extId); // stable across runs
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/sync-planner.test.ts`
Expected: FAIL — cannot resolve import `./sync-planner`.

- [ ] **Step 11: Implement the sync planner**

Create `packages/core/src/tv/sync-planner.ts`:

```ts
import type {
  ChannelUpsertPlan,
  IptvOrgChannel,
  IptvOrgFeed,
  IptvOrgLogo,
  IptvOrgStream,
  StreamPlan,
  TvM3uPlaylist,
} from "./types";
import { classifyProtocol } from "./pick-stream";
import { cleanChannelName } from "./clean-name";

// ── shared helpers ───────────────────────────────────────────────────────────

/** Numeric height of a quality token ("1080p" → 1080); 0 when unknown. */
function qualityHeight(q: string | null | undefined): number {
  if (!q) return 0;
  const m = /^(\d{3,4})[pi]/i.exec(q.trim());
  return m ? Number(m[1]) : 0;
}

/** Highest-resolution stream quality among a plan's streams, else null. */
function bestQuality(streams: StreamPlan[]): string | null {
  let best: string | null = null;
  for (const s of streams) {
    if (s.quality && qualityHeight(s.quality) >= qualityHeight(best)) best = s.quality;
  }
  return best;
}

// ── iptv-org ─────────────────────────────────────────────────────────────────

const LOGO_FORMAT_PREF: Record<string, number> = { svg: 0, png: 0 };

/**
 * Best logo for a channel: PNG/SVG preferred over lossy formats, then widest,
 * then channel-level (feed == null) over feed-specific.
 */
function pickLogo(logos: IptvOrgLogo[]): string | null {
  if (logos.length === 0) return null;
  const ranked = [...logos].sort((a, b) => {
    const fa = LOGO_FORMAT_PREF[(a.format ?? "").toLowerCase()] ?? 1;
    const fb = LOGO_FORMAT_PREF[(b.format ?? "").toLowerCase()] ?? 1;
    if (fa !== fb) return fa - fb;
    if (a.width !== b.width) return b.width - a.width;
    return (a.feed == null ? 0 : 1) - (b.feed == null ? 0 : 1);
  });
  return ranked[0].url;
}

/**
 * Plan an iptv-org catalog sync: filter to enabled countries (their codes are
 * authoritative — "UK", not "GB"; no ISO mapping), drop NSFW / blocklisted /
 * stream-less channels, apply the closed-channel rule, flatten feeds
 * (main-first priority, URL-deduped), and pick epgId/quality/logo.
 *
 * Closed-channel rule: a closed channel with no successor is dead — dropped;
 * a closed channel whose `replaced_by` successor is itself in this batch is a
 * duplicate of the successor — dropped; a closed channel whose successor is
 * NOT importable here (other country, no streams…) is kept so the household
 * doesn't lose a still-working stream.
 */
export function planIptvOrgSync(input: {
  channels: IptvOrgChannel[];
  feeds: IptvOrgFeed[];
  streams: IptvOrgStream[];
  logos: IptvOrgLogo[];
  blocklist: { channel: string }[];
  countries: string[];
}): ChannelUpsertPlan[] {
  const countrySet = new Set(input.countries.map((c) => c.trim().toUpperCase()));
  const blocked = new Set(input.blocklist.map((b) => b.channel));

  const streamsByChannel = new Map<string, IptvOrgStream[]>();
  for (const s of input.streams) {
    if (!s.channel) continue; // unmatched upstream — nothing to attach to
    const list = streamsByChannel.get(s.channel);
    if (list) list.push(s);
    else streamsByChannel.set(s.channel, [s]);
  }

  const mainFeedByChannel = new Map<string, IptvOrgFeed>();
  for (const f of input.feeds) {
    if (f.is_main) mainFeedByChannel.set(f.channel, f);
  }

  const logosByChannel = new Map<string, IptvOrgLogo[]>();
  for (const l of input.logos) {
    const list = logosByChannel.get(l.channel);
    if (list) list.push(l);
    else logosByChannel.set(l.channel, [l]);
  }

  // Pass 1: candidates — enabled country, not NSFW, not blocklisted, ≥1 stream.
  const candidates = input.channels.filter(
    (c) =>
      countrySet.has(c.country.toUpperCase()) &&
      !c.is_nsfw &&
      !blocked.has(c.id) &&
      (streamsByChannel.get(c.id)?.length ?? 0) > 0,
  );
  const candidateIds = new Set(candidates.map((c) => c.id));

  // Pass 2: the closed-channel rule (see doc comment above).
  const included = candidates.filter((c) => {
    if (c.closed == null) return true;
    if (c.replaced_by == null) return false;
    return !candidateIds.has(c.replaced_by);
  });

  const plans: ChannelUpsertPlan[] = [];
  for (const c of included) {
    const mainFeed = mainFeedByChannel.get(c.id) ?? null;
    const raw = streamsByChannel.get(c.id) ?? [];

    // Main-feed streams first, then channel-level (feed == null), then other
    // feeds; Array.sort is stable, so upstream order holds within each group.
    const rank = (s: IptvOrgStream): number =>
      s.feed != null && s.feed === mainFeed?.id ? 0 : s.feed == null ? 1 : 2;
    const ordered = [...raw].sort((a, b) => rank(a) - rank(b));

    const seenUrls = new Set<string>();
    const streams: StreamPlan[] = [];
    for (const s of ordered) {
      if (seenUrls.has(s.url)) continue; // dedupe by URL, first occurrence wins
      seenUrls.add(s.url);
      streams.push({
        url: s.url,
        feedId: s.feed,
        quality: s.quality,
        label: s.label,
        referrer: s.referrer,
        userAgent: s.user_agent,
        priority: streams.length,
        protocol: classifyProtocol(s.url),
      });
    }

    plans.push({
      extId: c.id,
      name: c.name,
      rawName: null, // iptv-org names are already clean
      altNames: c.alt_names,
      country: c.country,
      languages: mainFeed?.languages ?? [], // channels.json carries no languages; the main feed does
      categories: c.categories,
      logoUrl: pickLogo(logosByChannel.get(c.id) ?? []),
      website: c.website,
      epgId: mainFeed ? `${c.id}@${mainFeed.id}` : c.id,
      quality: bestQuality(streams),
      streams,
    });
  }
  return plans;
}

// ── M3U ──────────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit hex hash — stable extId for entries without a tvg-id. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Plan an M3U playlist sync: one channel per tvg-id (repeats become alternate
 * streams, URL-deduped), stable hashed extId when tvg-id is absent, cleaned
 * display names (raw kept in rawName), lowercased group-titles as categories,
 * epgId = tvg-id (the XMLTV id convention in the m3u world) or null.
 */
export function planM3uSync(playlist: TvM3uPlaylist): ChannelUpsertPlan[] {
  const byExtId = new Map<string, ChannelUpsertPlan>();

  for (const entry of playlist.entries) {
    const cleaned = cleanChannelName(entry.name);
    const extId = entry.tvgId ?? `m3u-${fnv1a(`${entry.name}|${entry.url}`)}`;
    const stream: StreamPlan = {
      url: entry.url,
      feedId: null,
      quality: cleaned.quality,
      label: cleaned.label,
      referrer: entry.referrer ?? null,
      userAgent: entry.userAgent ?? null,
      priority: 0, // adjusted below when appending to an existing channel
      protocol: classifyProtocol(entry.url),
    };

    const existing = byExtId.get(extId);
    if (existing) {
      // Same tvg-id again: an alternate stream for the same channel.
      if (!existing.streams.some((s) => s.url === stream.url)) {
        stream.priority = existing.streams.length;
        existing.streams.push(stream);
      }
      if (existing.quality == null && cleaned.quality != null) existing.quality = cleaned.quality;
      if (existing.logoUrl == null && entry.tvgLogo) existing.logoUrl = entry.tvgLogo;
      continue;
    }

    byExtId.set(extId, {
      extId,
      name: cleaned.name,
      rawName: entry.name,
      altNames: [],
      country: null, // m3u playlists carry no reliable country signal
      languages: [],
      categories: entry.groupTitles.map((g) => g.trim().toLowerCase()).filter((g) => g.length > 0),
      logoUrl: entry.tvgLogo ?? null,
      website: null,
      epgId: entry.tvgId ?? null,
      quality: cleaned.quality,
      streams: [stream],
    });
  }

  return [...byExtId.values()];
}
```

- [ ] **Step 12: Run the full tv suite to verify it passes**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/`
Expected: PASS (all parse-m3u, clean-name, pick-stream, numbering, sync-planner tests).

- [ ] **Step 13: Scoped lint + typecheck**

Run: `pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add packages/core/src/tv
git commit -m "feat(tv): sync planners, stable numbering, stream ordering (pure core)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `ImageKind` gains `"channel"` + core export surface

**Files:**
- Modify: `packages/core/src/metadata/images.ts` (`ImageKind` union + `DEFAULT_SIZE`)
- Modify: `packages/core/src/index.ts` (export the six tv modules)
- Test: `packages/core/src/metadata/images.test.ts` (add a `cacheImageFromUrl` channel case)

**Interfaces:**
- Consumes: existing `cacheImageFromUrl(url, kind, deps)` (unchanged).
- Produces: `type ImageKind = "poster" | "backdrop" | "logo" | "still" | "channel"`; all Task 2-4 exports available from `@orbix/core` (consumed by `apps/api` in Tasks 6-8). Channel logos land under `METADATA_DIR/channel/<basename>` and are served as `/api/images/channel/<basename>` by the existing images route.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/metadata/images.test.ts` — a new import and describe block (the file already defines `makeFetchSpy`/`makeWriteSpy`):

Change the import line at the top to:

```ts
import { cacheImage, cacheImageFromUrl } from "./images";
```

Append at the end of the file:

```ts
describe("cacheImageFromUrl (channel logos)", () => {
  it("caches a channel logo from an absolute URL under channel/", async () => {
    const { fetchImpl, calls: fetchCalls } = makeFetchSpy();
    const { writeFile, calls: writeCalls } = makeWriteSpy();

    const rel = await cacheImageFromUrl("https://logos.example/ru/1tv.png", "channel", {
      fetchImpl,
      writeFile,
      exists: async () => false,
      baseDir: "/meta",
    });

    expect(rel).toBe("channel/1tv.png");
    expect(writeCalls[0].absPath).toBe(path.join("/meta", "channel/1tv.png"));
    expect(fetchCalls[0]).toBe("https://logos.example/ru/1tv.png");
  });
});
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `pnpm --filter @orbix/core typecheck`
Expected: FAIL — TS2345: `"channel"` is not assignable to `ImageKind`. (Vitest strips types via esbuild, so the runtime test alone would deceptively pass — the honest failing gate for a type-union change is typecheck.)

- [ ] **Step 3: Extend the union and the size table**

In `packages/core/src/metadata/images.ts`, change:

```ts
export type ImageKind = "poster" | "backdrop" | "logo" | "still";
```

to:

```ts
export type ImageKind = "poster" | "backdrop" | "logo" | "still" | "channel";
```

and add to `DEFAULT_SIZE` (after `still: "w300",`):

```ts
  // TV channel logos are cached from absolute URLs via cacheImageFromUrl,
  // which ignores size — this entry only keeps the Record total.
  channel: "w500",
};
```

(Keep the closing brace — only the `channel` line + comment are new.)

- [ ] **Step 4: Export the tv modules from the core index**

In `packages/core/src/index.ts`, append after the last existing export (`export * from "./menu/resolve";`):

```ts
export * from "./tv/types";
export * from "./tv/parse-m3u";
export * from "./tv/clean-name";
export * from "./tv/sync-planner";
export * from "./tv/numbering";
export * from "./tv/pick-stream";
```

- [ ] **Step 5: Verify typecheck and the full core suite pass**

Run: `pnpm --filter @orbix/core typecheck && pnpm --filter @orbix/core test`
Expected: PASS — including every pre-existing images test (the union widening is additive) and the new channel case.

- [ ] **Step 6: Scoped lint**

Run: `pnpm --filter @orbix/core lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/metadata/images.ts packages/core/src/metadata/images.test.ts packages/core/src/index.ts
git commit -m "feat(tv): channel ImageKind + export the core tv module" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: api `lib/iptv-org.ts` (TDD) + `plugins/tv-queue.ts` + app wiring

**Files:**
- Create: `apps/api/src/lib/iptv-org.ts`
- Create: `apps/api/src/plugins/tv-queue.ts`
- Modify: `apps/api/src/app.ts` (register `tvQueuePlugin` after `queuePlugin`; 24 h unref'd `tv-sync` interval)
- Test: `apps/api/src/lib/iptv-org.test.ts`

**Interfaces:**
- Consumes: `parseM3u`, `planIptvOrgSync`, `planM3uSync`, `assignNumbers`, `cacheImageFromUrl`, `getSetting`, `setSetting`, iptv-org wire types (all from `@orbix/core`); Prisma `tv*` models (Task 1).
- Produces (fixed contract):
  - `export const tvEvents: EventEmitter` (module-level, in `plugins/tv-queue.ts`)
  - `export const tvDoneCache: Map<string, Record<string, unknown>>` (5-min TTL entries)
  - `export interface TvSyncJobData { jobId: string; sourceId?: string }`
  - `export function tvQueuePlugin(env: Env)` — decorates `app.tvQueue: Queue<TvSyncJobData>` (queue name `"tv"`), worker processes job name `"tv-sync"`, `NODE_ENV==="test"` stub branch, `onClose` cleanup, FastifyInstance module augmentation.
  - `lib/iptv-org.ts`: `IptvOrgDeps` (injected `fetchImpl` + etag/cache IO), `fetchIptvOrgFile<T>(file, deps)`, `fetchIptvOrgCatalog(deps)`, `buildIptvOrgDeps(app, env)` — ETags in Setting keys `tvSync:etag:<file>`, JSON bodies under `METADATA_DIR/tv/iptv-org/`, parsed-JSON short-circuit on 304.
- Progress events on the `jobId` channel: `{phase:"channels", processed, total}`, `{phase:"logos", processed, total}`, final `{phase:"done", channels, streams, logosCached}` (cached in `tvDoneCache`), `{phase:"error", message}` on failure.

- [ ] **Step 1: Write the failing iptv-org adapter test**

Create `apps/api/src/lib/iptv-org.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchIptvOrgFile, type IptvOrgDeps } from "./iptv-org";

function memoryDeps(fetchImpl: typeof fetch) {
  const etags = new Map<string, string>();
  const cache = new Map<string, string>();
  const deps: IptvOrgDeps = {
    fetchImpl,
    readEtag: async (f) => etags.get(f) ?? null,
    writeEtag: async (f, tag) => {
      etags.set(f, tag);
    },
    readCache: async (f) => cache.get(f) ?? null,
    writeCache: async (f, text) => {
      cache.set(f, text);
    },
  };
  return { deps, etags, cache };
}

describe("fetchIptvOrgFile", () => {
  it("fetches unconditionally the first time, stores the ETag + body cache, and parses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: "ChannelOne.ru" }]), {
          status: 200,
          headers: { etag: 'W/"v1"' },
        }),
    ) as unknown as typeof fetch;
    const { deps, etags, cache } = memoryDeps(fetchImpl);

    const data = await fetchIptvOrgFile<{ id: string }[]>("channels.json", deps);
    expect(data).toEqual([{ id: "ChannelOne.ru" }]);
    expect(etags.get("channels.json")).toBe('W/"v1"');
    expect(cache.get("channels.json")).toBe(JSON.stringify([{ id: "ChannelOne.ru" }]));
    const firstInit = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(firstInit).toBeUndefined(); // no If-None-Match without a stored ETag
  });

  it("sends If-None-Match and short-circuits to the parsed cache on 304", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    const { deps, etags, cache } = memoryDeps(fetchImpl);
    etags.set("streams.json", 'W/"v7"');
    cache.set("streams.json", JSON.stringify([{ url: "https://x/live.m3u8" }]));

    const data = await fetchIptvOrgFile<{ url: string }[]>("streams.json", deps);
    expect(data).toEqual([{ url: "https://x/live.m3u8" }]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://iptv-org.github.io/api/streams.json");
    expect((init as RequestInit).headers).toEqual({ "if-none-match": 'W/"v7"' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches unconditionally when a 304 hits a lost cache", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 304 });
      return new Response(JSON.stringify([1, 2]), { status: 200, headers: { etag: 'W/"v8"' } });
    }) as unknown as typeof fetch;
    const { deps, etags } = memoryDeps(fetchImpl);
    etags.set("logos.json", 'W/"v7"'); // the ETag survived but the disk cache did not

    const data = await fetchIptvOrgFile<number[]>("logos.json", deps);
    expect(data).toEqual([1, 2]);
    expect(calls).toBe(2);
    const secondInit = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(secondInit).toBeUndefined(); // the retry carries no If-None-Match
    expect(etags.get("logos.json")).toBe('W/"v8"');
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const { deps } = memoryDeps(fetchImpl);
    await expect(fetchIptvOrgFile("blocklist.json", deps)).rejects.toThrow(/503/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/lib/iptv-org.test.ts`
Expected: FAIL — cannot resolve import `./iptv-org`.

- [ ] **Step 3: Implement the iptv-org adapter**

Create `apps/api/src/lib/iptv-org.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import {
  getSetting,
  setSetting,
  type IptvOrgChannel,
  type IptvOrgFeed,
  type IptvOrgLogo,
  type IptvOrgStream,
} from "@orbix/core";

const API_BASE = "https://iptv-org.github.io/api";

/** Injected IO so unit tests never touch network, disk, or the DB. */
export interface IptvOrgDeps {
  fetchImpl: typeof fetch;
  readEtag: (file: string) => Promise<string | null>;
  writeEtag: (file: string, etag: string) => Promise<void>;
  readCache: (file: string) => Promise<string | null>;
  writeCache: (file: string, text: string) => Promise<void>;
}

/**
 * Conditional GET of one iptv-org API file. Upstream rebuilds daily (~00:32
 * UTC) and serves ETags: a 304 short-circuits to the parsed on-disk cache; a
 * 304 against a lost cache falls back to one unconditional refetch.
 */
export async function fetchIptvOrgFile<T>(file: string, deps: IptvOrgDeps): Promise<T> {
  const url = `${API_BASE}/${file}`;
  const etag = await deps.readEtag(file);
  let res = await deps.fetchImpl(url, etag ? { headers: { "if-none-match": etag } } : undefined);
  if (res.status === 304) {
    const cached = await deps.readCache(file);
    if (cached != null) return JSON.parse(cached) as T;
    res = await deps.fetchImpl(url); // cache lost — refetch unconditionally
  }
  if (!res.ok) throw new Error(`iptv-org fetch failed: HTTP ${res.status} for ${file}`);
  const text = await res.text();
  await deps.writeCache(file, text);
  const newTag = res.headers.get("etag");
  if (newTag) await deps.writeEtag(file, newTag);
  return JSON.parse(text) as T;
}

export interface IptvOrgCatalog {
  channels: IptvOrgChannel[];
  feeds: IptvOrgFeed[];
  streams: IptvOrgStream[];
  logos: IptvOrgLogo[];
  blocklist: { channel: string }[];
}

/** The five catalog files, fetched in parallel (each ETag-conditional). */
export async function fetchIptvOrgCatalog(deps: IptvOrgDeps): Promise<IptvOrgCatalog> {
  const [channels, feeds, streams, logos, blocklist] = await Promise.all([
    fetchIptvOrgFile<IptvOrgChannel[]>("channels.json", deps),
    fetchIptvOrgFile<IptvOrgFeed[]>("feeds.json", deps),
    fetchIptvOrgFile<IptvOrgStream[]>("streams.json", deps),
    fetchIptvOrgFile<IptvOrgLogo[]>("logos.json", deps),
    fetchIptvOrgFile<{ channel: string }[]>("blocklist.json", deps),
  ]);
  return { channels, feeds, streams, logos, blocklist };
}

/** Real adapters: ETags in Setting rows (`tvSync:etag:<file>`), bodies on disk. */
export function buildIptvOrgDeps(app: FastifyInstance, env: Env): IptvOrgDeps {
  const cacheDir = path.join(env.METADATA_DIR, "tv", "iptv-org");
  const read = (k: string) => app.prisma.setting.findUnique({ where: { key: k } });
  const write = async (k: string, v: unknown) => {
    await app.prisma.setting.upsert({
      where: { key: k },
      create: { key: k, value: v as object },
      update: { value: v as object },
    });
  };
  return {
    fetchImpl: fetch,
    readEtag: async (file) =>
      (await getSetting<string>(`tvSync:etag:${file}`, { fallback: "", read })) || null,
    writeEtag: (file, etag) => setSetting(`tvSync:etag:${file}`, etag, { write }),
    readCache: async (file) => {
      try {
        return await fs.promises.readFile(path.join(cacheDir, file), "utf8");
      } catch {
        return null;
      }
    },
    writeCache: async (file, text) => {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(path.join(cacheDir, file), text, "utf8");
    },
  };
}
```

- [ ] **Step 4: Verify the adapter tests pass**

Run: `pnpm --filter @orbix/api exec vitest run src/lib/iptv-org.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement the tv queue plugin (worker + sync processor)**

Create `apps/api/src/plugins/tv-queue.ts`. The processor is adapter wiring around the pure planners — its logic seams (planners, parser, iptv-org fetch, route enqueue) are all unit-tested; the wiring itself follows the exact scan-processor pattern in `queue.ts`:

```ts
import fp from "fastify-plugin";
import { Queue, Worker, type Job } from "bullmq";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import {
  assignNumbers,
  cacheImageFromUrl,
  parseM3u,
  planIptvOrgSync,
  planM3uSync,
  type ChannelUpsertPlan,
} from "@orbix/core";
import { buildIptvOrgDeps, fetchIptvOrgCatalog } from "../lib/iptv-org";

// ── Module-level in-process EventEmitter for SSE progress ──────────────────

export const tvEvents = new EventEmitter();
tvEvents.setMaxListeners(200);

/**
 * Cache of "done"/"error" events keyed by jobId so late SSE subscribers can
 * get the result even if the sync finished before they connected.
 */
export const tvDoneCache = new Map<string, Record<string, unknown>>();

export interface TvSyncJobData {
  jobId: string;
  /** Sync one source; absent = sync every enabled source (the scheduler path). */
  sourceId?: string;
}

// ── Plugin factory ───────────────────────────────────────────────────────────

export function tvQueuePlugin(env: Env) {
  return fp(async (app: FastifyInstance) => {
    // Same rationale as queuePlugin: tests never process jobs and point
    // REDIS_URL at a bogus host — creating real BullMQ queues/workers leaks
    // ioredis DNS failures as unhandled rejections. Decorate an inert stub.
    if (env.NODE_ENV === "test") {
      const stub = { add: async () => undefined, close: async () => undefined };
      app.decorate("tvQueue", stub as unknown as Queue<TvSyncJobData>);
      return;
    }

    const connection = { url: env.REDIS_URL };
    const queue = new Queue<TvSyncJobData>("tv", { connection });

    interface SyncCounters {
      channels: number;
      streams: number;
      logosCached: number;
    }

    // ── Sync one source ─────────────────────────────────────────────────────

    async function syncSource(
      source: {
        id: string;
        kind: string;
        name: string;
        url: string | null;
        filePath: string | null;
        countries: string[];
      },
      jobId: string,
    ): Promise<SyncCounters> {
      const { prisma } = app;
      await prisma.tvSource.update({
        where: { id: source.id },
        data: { status: "syncing", statusMessage: null },
      });
      try {
        // 1. Plan (pure core; only the inputs differ by source kind).
        let plans: ChannelUpsertPlan[];
        let epgUrls: string[] = [];
        if (source.kind === "iptv-org") {
          const catalog = await fetchIptvOrgCatalog(buildIptvOrgDeps(app, env));
          plans = planIptvOrgSync({ ...catalog, countries: source.countries });
        } else {
          let text: string;
          if (source.url) {
            const res = await fetch(source.url);
            if (!res.ok) throw new Error(`playlist fetch failed: HTTP ${res.status}`);
            text = await res.text();
          } else if (source.filePath) {
            text = await fs.promises.readFile(source.filePath, "utf8");
          } else {
            throw new Error("m3u source has neither url nor filePath");
          }
          const playlist = parseM3u(text);
          plans = planM3uSync(playlist);
          epgUrls = playlist.epgUrls;
        }

        // 2. Numbers: existing extIds keep theirs; new channels append after
        //    the GLOBAL max (numbers are never reused or auto-renumbered).
        const existingRows = await prisma.tvChannel.findMany({
          where: { sourceId: source.id },
          select: { id: true, extId: true, number: true, logoUrl: true, logoPath: true },
        });
        const existingByExt = new Map(existingRows.map((r) => [r.extId, r]));
        const maxAgg = await prisma.tvChannel.aggregate({ _max: { number: true } });
        const numbers = assignNumbers(
          maxAgg._max.number ?? 0,
          new Map(existingRows.map((r) => [r.extId, r.number])),
          plans.map((p) => ({ extId: p.extId, country: p.country, name: p.name })),
        );

        // 3. Upsert channels by (sourceId, extId) + replace streams wholesale.
        //    NOTE: replacing resets stream status to "unknown" on every sync —
        //    accepted for v1; the tv-health job (later phase) re-learns status
        //    within a day. Manual `hidden` flags are NOT touched on update.
        const logoTargets: { channelId: string; logoUrl: string }[] = [];
        let processed = 0;
        let streamCount = 0;
        for (const plan of plans) {
          const existing = existingByExt.get(plan.extId);
          const data = {
            name: plan.name,
            rawName: plan.rawName,
            altNames: plan.altNames,
            country: plan.country,
            languages: plan.languages,
            categories: plan.categories,
            website: plan.website,
            quality: plan.quality,
            logoUrl: plan.logoUrl,
          };
          let channelId: string;
          if (existing) {
            await prisma.tvChannel.update({ where: { id: existing.id }, data });
            channelId = existing.id;
          } else {
            const created = await prisma.tvChannel.create({
              data: {
                ...data,
                sourceId: source.id,
                extId: plan.extId,
                number: numbers.get(plan.extId)!,
                epgId: plan.epgId,
              },
              select: { id: true },
            });
            channelId = created.id;
          }

          await prisma.tvStream.deleteMany({ where: { channelId } });
          if (plan.streams.length > 0) {
            await prisma.tvStream.createMany({
              data: plan.streams.map((s) => ({
                channelId,
                url: s.url,
                feedId: s.feedId,
                quality: s.quality,
                label: s.label,
                referrer: s.referrer,
                userAgent: s.userAgent,
                priority: s.priority,
                protocol: s.protocol,
              })),
            });
          }
          streamCount += plan.streams.length;

          // Logo caching happens AFTER all upserts — collect targets now.
          if (plan.logoUrl && (!existing || existing.logoPath == null || existing.logoUrl !== plan.logoUrl)) {
            logoTargets.push({ channelId, logoUrl: plan.logoUrl });
          }

          processed++;
          if (processed % 50 === 0 || processed === plans.length) {
            tvEvents.emit(jobId, { phase: "channels", processed, total: plans.length });
          }
        }

        // 4. Channels that vanished upstream: hide them and mark their streams
        //    dead (rows are kept — favorites/recents keep referential integrity).
        const planExtIds = new Set(plans.map((p) => p.extId));
        const vanishedIds = existingRows.filter((r) => !planExtIds.has(r.extId)).map((r) => r.id);
        if (vanishedIds.length > 0) {
          await prisma.tvChannel.updateMany({
            where: { id: { in: vanishedIds } },
            data: { hidden: true },
          });
          await prisma.tvStream.updateMany({
            where: { channelId: { in: vanishedIds } },
            data: { status: "dead" },
          });
        }

        // 5. Auto-create EPG sources from the playlist's url-tvg header (dedupe by url).
        for (const url of epgUrls) {
          const dup = await prisma.tvEpgSource.findFirst({ where: { url }, select: { id: true } });
          if (!dup) {
            await prisma.tvEpgSource.create({ data: { name: `${source.name} EPG`, url } });
          }
        }

        // 6. Cache logos to disk AFTER upserts (offline guarantee). Per-image
        //    failures leave logoPath null — the UI falls back to a monogram.
        const io = {
          fetchImpl: fetch,
          exists: (a: string) =>
            fs.promises.access(a).then(
              () => true,
              () => false,
            ),
          writeFile: async (a: string, bytes: Uint8Array) => {
            await fs.promises.mkdir(path.dirname(a), { recursive: true });
            await fs.promises.writeFile(a, bytes);
          },
          baseDir: env.METADATA_DIR,
        };
        let logosCached = 0;
        let logosProcessed = 0;
        for (const target of logoTargets) {
          try {
            const rel = await cacheImageFromUrl(target.logoUrl, "channel", io);
            await prisma.tvChannel.update({
              where: { id: target.channelId },
              data: { logoPath: rel },
            });
            logosCached++;
          } catch (err) {
            app.log.debug(
              { err, channelId: target.channelId },
              "[tv-sync] logo cache failed — monogram fallback",
            );
          }
          logosProcessed++;
          if (logosProcessed % 50 === 0 || logosProcessed === logoTargets.length) {
            tvEvents.emit(jobId, { phase: "logos", processed: logosProcessed, total: logoTargets.length });
          }
        }

        await prisma.tvSource.update({
          where: { id: source.id },
          data: { status: "ok", statusMessage: null, lastSyncAt: new Date() },
        });
        return { channels: plans.length, streams: streamCount, logosCached };
      } catch (err) {
        await prisma.tvSource.update({
          where: { id: source.id },
          data: { status: "error", statusMessage: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
    }

    // ── Processor ───────────────────────────────────────────────────────────

    async function processor(job: Job<TvSyncJobData>): Promise<void> {
      if (job.name !== "tv-sync") return;
      const { jobId, sourceId } = job.data;
      try {
        const sources = await app.prisma.tvSource.findMany({
          where: sourceId ? { id: sourceId } : { enabled: true },
          select: { id: true, kind: true, name: true, url: true, filePath: true, countries: true },
          orderBy: { createdAt: "asc" },
        });
        const totals: Record<string, number> = { channels: 0, streams: 0, logosCached: 0 };
        for (const source of sources) {
          const c = await syncSource(source, jobId);
          totals.channels += c.channels;
          totals.streams += c.streams;
          totals.logosCached += c.logosCached;
        }
        const doneEvent: Record<string, unknown> = { phase: "done", ...totals };
        // Cache so late SSE subscribers get the result; evict after 5 min.
        tvDoneCache.set(jobId, doneEvent);
        const doneTimer = setTimeout(() => tvDoneCache.delete(jobId), 5 * 60 * 1000);
        doneTimer.unref?.();
        tvEvents.emit(jobId, doneEvent);
      } catch (err) {
        const errEvt: Record<string, unknown> = {
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        tvDoneCache.set(jobId, errEvt);
        const errTimer = setTimeout(() => tvDoneCache.delete(jobId), 5 * 60 * 1000);
        errTimer.unref?.();
        tvEvents.emit(jobId, errEvt);
        throw err;
      }
    }

    // ── Worker ───────────────────────────────────────────────────────────────

    const worker = new Worker<TvSyncJobData, void>("tv", processor, { connection });
    worker.on("error", (err) => app.log.error({ err }, "tv worker error"));

    app.decorate("tvQueue", queue);

    app.addHook("onClose", async () => {
      await worker.close();
      await queue.close();
    });
  });
}

// ── Fastify type augmentation ─────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyInstance {
    tvQueue: Queue<TvSyncJobData>;
  }
}
```

- [ ] **Step 6: Wire the plugin + daily interval into app.ts**

In `apps/api/src/app.ts`:

1. Add imports (beside the existing plugin imports):

```ts
import { tvQueuePlugin } from "./plugins/tv-queue";
import { randomUUID } from "node:crypto";
```

2. Register the plugin immediately after `queuePlugin` (order is part of the contract):

```ts
  await app.register(queuePlugin(env, { runtime }));
  await app.register(tvQueuePlugin(env));
```

3. Beside the existing metadata-refresh interval (after `refreshTimer.unref();`), add:

```ts
  // ── Periodic TV catalog sync (daily; skips cleanly when TV is unconfigured) ──
  const TV_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
  const tvSyncTimer = setInterval(async () => {
    try {
      const enabled = await app.prisma.tvSource.count({ where: { enabled: true } });
      if (enabled === 0) return; // no enabled TvSource rows — nothing to enqueue
      await app.tvQueue.add("tv-sync", { jobId: randomUUID() });
    } catch (err) {
      app.log.error({ err }, "Scheduled tv-sync enqueue failed");
    }
  }, TV_SYNC_INTERVAL_MS);
  tvSyncTimer.unref(); // don't block process shutdown
```

- [ ] **Step 7: Gates**

Run: `pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api test`
Expected: PASS — all pre-existing api route tests still pass (in test mode the plugin only decorates the stub; the interval never fires inside a test's lifetime and is unref'd).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/iptv-org.ts apps/api/src/lib/iptv-org.test.ts apps/api/src/plugins/tv-queue.ts apps/api/src/app.ts
git commit -m "feat(tv): tv BullMQ queue + tv-sync processor + ETag-conditional iptv-org adapter" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: api `lib/tv-access.ts` + `routes/tv-sources.ts` (TDD)

**Files:**
- Create: `apps/api/src/lib/tv-access.ts`
- Create: `apps/api/src/routes/tv-sources.ts`
- Modify: `apps/api/src/app.ts` (register `tvSourcesRoute(env)` under `/api`)
- Test: `apps/api/src/routes/tv-sources.test.ts`

**Interfaces:**
- Consumes: `requireAuth`/`requireAdmin` (`lib/auth.ts`), `requireNonKids`/`activeProfile` (`lib/catalog-filter.ts`), `tvEvents`/`tvDoneCache` (Task 6), `app.tvQueue`, Prisma `tvSource`/`tvEpgSource`.
- Produces (fixed contract):
  - `export function requireTvAccess(app: FastifyInstance)` — preHandler: 401 pass-through if unauthenticated, 403 `{error:"not_allowed_for_kids"}` when the active profile is a kids profile (consumed by Task 8).
  - `export function tvSourcesRoute(env: Env)` — admin routes: `GET/POST/PATCH/DELETE /tv/sources[...]` (m3u file-content upload stored under `${env.METADATA_DIR}/tv/playlists/<sourceId>.m3u`), `POST /tv/sources/:id/sync` → enqueue `tv-sync` → `{ jobId }`, `GET /tv/sync/events?jobId=` (SSE, scan.ts shape, done-cache replay).

- [ ] **Step 1: Create the shared kids guard**

Create `apps/api/src/lib/tv-access.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { activeProfile } from "./catalog-filter";

/**
 * preHandler for every non-admin /tv route: TV is absent for kids profiles in
 * v1, enforced server-side (UI-only hiding is a defect). Compose after
 * requireAuth; the 401 here is only a fail-safe for routes that forget.
 */
export function requireTvAccess(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.accountId) return reply.code(401).send({ error: "unauthenticated" });
    const profile = await activeProfile(app, req);
    if (profile?.kind === "kids") {
      return reply.code(403).send({ error: "not_allowed_for_kids" });
    }
  };
}
```

- [ ] **Step 2: Write the failing route tests**

Create `apps/api/src/routes/tv-sources.test.ts` (house idiom: `buildApp` with a full test `Env` literal, prisma monkey-patching, `orbix_session` cookie injection — same as `catalog.test.ts`, plus a per-suite temp `METADATA_DIR` because the upload really writes a file):

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../app";
import { tvDoneCache } from "../plugins/tv-queue";
import type { Env } from "@orbix/config";

const metadataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbix-tv-sources-"));

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: metadataDir, TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const COOKIES = { orbix_session: "s1", orbix_profile: "p1" };

function patchAuth(app: any, { admin = true, kids = false } = {}) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.account = { findUnique: async () => ({ isAdmin: admin }) };
  app.prisma.profile = {
    findUnique: async () => ({
      id: "p1", name: "P", avatar: null,
      kind: kids ? "kids" : "standard", maturityCap: kids ? 0 : null, language: "en",
    }),
  };
}

afterEach(() => {
  tvDoneCache.clear();
});

describe("admin gates on /tv/sources", () => {
  it("401 without a session", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = { findUnique: async () => null };
    const res = await app.inject({ method: "GET", url: "/api/tv/sources" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403 for a non-admin account", async () => {
    const app = await buildApp(env);
    patchAuth(app, { admin: false });
    const res = await app.inject({ method: "GET", url: "/api/tv/sources", cookies: COOKIES });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("403 for a kids profile even on an admin account", async () => {
    const app = await buildApp(env);
    patchAuth(app, { kids: true });
    (app as any).prisma.tvSource = { findMany: async () => [] };
    const res = await app.inject({ method: "GET", url: "/api/tv/sources", cookies: COOKIES });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not_allowed_for_kids" });
    await app.close();
  });
});

describe("POST /tv/sources", () => {
  it("stores an uploaded m3u under METADATA_DIR/tv/playlists/<sourceId>.m3u", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    let updated: any = null;
    (app as any).prisma.tvSource = {
      create: async (args: any) => ({ id: "src1", ...args.data, filePath: null }),
      update: async (args: any) => {
        updated = args;
        return { id: "src1", kind: "m3u", ...args.data };
      },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/tv/sources",
      cookies: COOKIES,
      payload: {
        kind: "m3u",
        name: "My playlist",
        fileContent: "#EXTM3U\r\n#EXTINF:-1,One\r\nhttps://x/1.m3u8\r\n",
      },
    });
    expect(res.statusCode).toBe(200);
    const expected = path.join(metadataDir, "tv", "playlists", "src1.m3u");
    expect(updated.data.filePath).toBe(expected);
    expect(fs.readFileSync(expected, "utf8")).toContain("#EXTINF:-1,One");
    await app.close();
  });

  it("rejects an m3u source with neither url nor fileContent", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    const res = await app.inject({
      method: "POST", url: "/api/tv/sources", cookies: COOKIES,
      payload: { kind: "m3u", name: "Empty" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("409s a second iptv-org source and 400s one without countries", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    (app as any).prisma.tvSource = { findFirst: async () => ({ id: "existing" }), create: async () => ({}) };
    const dup = await app.inject({
      method: "POST", url: "/api/tv/sources", cookies: COOKIES,
      payload: { kind: "iptv-org", name: "Catalog", countries: ["RU"] },
    });
    expect(dup.statusCode).toBe(409);

    (app as any).prisma.tvSource = { findFirst: async () => null, create: async () => ({}) };
    const bad = await app.inject({
      method: "POST", url: "/api/tv/sources", cookies: COOKIES,
      payload: { kind: "iptv-org", name: "Catalog", countries: [] },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("uppercases country codes on create (iptv-org codes are authoritative)", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    let created: any = null;
    (app as any).prisma.tvSource = {
      findFirst: async () => null,
      create: async (args: any) => {
        created = args;
        return { id: "s", ...args.data };
      },
    };
    const res = await app.inject({
      method: "POST", url: "/api/tv/sources", cookies: COOKIES,
      payload: { kind: "iptv-org", name: "Catalog", countries: ["ru", "uk "] },
    });
    expect(res.statusCode).toBe(200);
    expect(created.data.countries).toEqual(["RU", "UK"]);
    await app.close();
  });
});

describe("POST /tv/sources/:id/sync", () => {
  it("enqueues a tv-sync job for the source", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    (app as any).prisma.tvSource = { findUnique: async () => ({ id: "src1" }) };
    let job: any = null;
    (app as any).tvQueue.add = async (name: string, data: unknown) => {
      job = { name, data };
    };
    const res = await app.inject({ method: "POST", url: "/api/tv/sources/src1/sync", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    const { jobId } = res.json();
    expect(typeof jobId).toBe("string");
    expect(job).toEqual({ name: "tv-sync", data: { jobId, sourceId: "src1" } });
    await app.close();
  });

  it("404s an unknown source", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    (app as any).prisma.tvSource = { findUnique: async () => null };
    const res = await app.inject({ method: "POST", url: "/api/tv/sources/nope/sync", cookies: COOKIES });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /tv/sync/events (SSE)", () => {
  it("replays the done-cache entry and closes", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    tvDoneCache.set("job-1", { phase: "done", channels: 612, streams: 745, logosCached: 530 });
    const res = await app.inject({
      method: "GET", url: "/api/tv/sync/events?jobId=job-1", cookies: COOKIES,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.payload).toBe(
      `data: ${JSON.stringify({ phase: "done", channels: 612, streams: 745, logosCached: 530 })}\n\n`,
    );
    await app.close();
  });

  it("400s without a jobId", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    const res = await app.inject({ method: "GET", url: "/api/tv/sync/events", cookies: COOKIES });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("DELETE /tv/sources/:id", () => {
  it("removes the uploaded playlist file best-effort", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    const filePath = path.join(metadataDir, "tv", "playlists", "gone.m3u");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "#EXTM3U\n");
    (app as any).prisma.tvSource = { delete: async () => ({ id: "gone", filePath }) };
    const res = await app.inject({ method: "DELETE", url: "/api/tv/sources/gone", cookies: COOKIES });
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(filePath)).toBe(false);
    await app.close();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/tv-sources.test.ts`
Expected: FAIL — the routes are not registered yet, so every inject returns 404 where the tests expect 200/204/400/401/403/409.

- [ ] **Step 4: Implement the routes**

Create `apps/api/src/routes/tv-sources.ts`:

```ts
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Env } from "@orbix/config";
import { Prisma } from "@orbix/db";
import { requireAuth, requireAdmin } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import { tvEvents, tvDoneCache } from "../plugins/tv-queue";

interface TvSourceBody {
  kind?: string;
  name?: string;
  url?: string;
  countries?: unknown;
  epgUrl?: string;
  /** Raw playlist text (JSON upload — the repo has no multipart dependency). */
  fileContent?: string;
  enabled?: boolean;
}

/** Normalize a countries payload to trimmed UPPERCASE codes; null when invalid. */
function parseCountries(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const c of input) {
    if (typeof c !== "string") return null;
    const code = c.trim().toUpperCase();
    if (code) out.push(code);
  }
  return out;
}

// Playlists can be a few MB — Fastify's default 1 MiB body limit is too small
// for an uploaded M3U. 25 MiB is far above any real-world playlist.
const PLAYLIST_BODY_LIMIT = 25 * 1024 * 1024;

export function tvSourcesRoute(env: Env) {
  return async function tvSources(app: FastifyInstance) {
    const manage = { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] };
    const playlistsDir = path.join(env.METADATA_DIR, "tv", "playlists");

    async function writePlaylist(sourceId: string, content: string): Promise<string> {
      const filePath = path.join(playlistsDir, `${sourceId}.m3u`);
      await fs.promises.mkdir(playlistsDir, { recursive: true });
      await fs.promises.writeFile(filePath, content, "utf8");
      return filePath;
    }

    // GET /tv/sources — every TvSource field is safe to return (no secrets).
    app.get("/tv/sources", manage, async () =>
      app.prisma.tvSource.findMany({ orderBy: { createdAt: "asc" } }),
    );

    // POST /tv/sources
    //   { kind:"iptv-org", name, countries }  (max one row — 409 on a second)
    //   { kind:"m3u", name, url? | fileContent?, epgUrl? }
    app.post<{ Body: TvSourceBody }>(
      "/tv/sources",
      { ...manage, bodyLimit: PLAYLIST_BODY_LIMIT },
      async (req, reply) => {
        const body = req.body ?? {};
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return reply.code(400).send({ error: "invalid_name" });

        if (body.kind === "iptv-org") {
          const existing = await app.prisma.tvSource.findFirst({
            where: { kind: "iptv-org" },
            select: { id: true },
          });
          if (existing) return reply.code(409).send({ error: "iptv_org_exists" });
          const countries = parseCountries(body.countries);
          if (!countries || countries.length === 0) {
            return reply.code(400).send({ error: "countries_required" });
          }
          return await app.prisma.tvSource.create({
            data: { kind: "iptv-org", name, countries },
          });
        }

        if (body.kind === "m3u") {
          const url = typeof body.url === "string" ? body.url.trim() : "";
          const fileContent = typeof body.fileContent === "string" ? body.fileContent : "";
          if (!url && !fileContent) return reply.code(400).send({ error: "url_or_file_required" });
          const epgUrl =
            typeof body.epgUrl === "string" && body.epgUrl.trim() ? body.epgUrl.trim() : null;
          const created = await app.prisma.tvSource.create({
            data: { kind: "m3u", name, url: url || null, epgUrl },
          });
          if (fileContent) {
            const filePath = await writePlaylist(created.id, fileContent);
            return await app.prisma.tvSource.update({
              where: { id: created.id },
              data: { filePath },
            });
          }
          return created;
        }

        return reply.code(400).send({ error: "invalid_kind" });
      },
    );

    // PATCH /tv/sources/:id — partial update; fileContent replaces the stored playlist.
    app.patch<{ Params: { id: string }; Body: TvSourceBody }>(
      "/tv/sources/:id",
      { ...manage, bodyLimit: PLAYLIST_BODY_LIMIT },
      async (req, reply) => {
        const body = req.body ?? {};
        const data: Prisma.TvSourceUpdateInput = {};
        if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
        if (typeof body.enabled === "boolean") data.enabled = body.enabled;
        if (typeof body.url === "string") data.url = body.url.trim() || null;
        if (typeof body.epgUrl === "string") data.epgUrl = body.epgUrl.trim() || null;
        if (body.countries !== undefined) {
          const countries = parseCountries(body.countries);
          if (!countries) return reply.code(400).send({ error: "invalid_countries" });
          data.countries = countries;
        }
        try {
          let source = await app.prisma.tvSource.update({ where: { id: req.params.id }, data });
          if (typeof body.fileContent === "string" && body.fileContent && source.kind === "m3u") {
            const filePath = await writePlaylist(source.id, body.fileContent);
            source = await app.prisma.tvSource.update({
              where: { id: source.id },
              data: { filePath },
            });
          }
          return source;
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
            return reply.code(404).send({ error: "not_found" });
          }
          throw e;
        }
      },
    );

    // DELETE /tv/sources/:id — channels cascade; uploaded playlist removed best-effort.
    app.delete<{ Params: { id: string } }>("/tv/sources/:id", manage, async (req, reply) => {
      try {
        const source = await app.prisma.tvSource.delete({ where: { id: req.params.id } });
        if (source.filePath) await fs.promises.unlink(source.filePath).catch(() => {});
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
          return reply.code(404).send({ error: "not_found" });
        }
        throw e;
      }
    });

    // POST /tv/sources/:id/sync — enqueue a tv-sync job, return { jobId }.
    app.post<{ Params: { id: string } }>("/tv/sources/:id/sync", manage, async (req, reply) => {
      const source = await app.prisma.tvSource.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!source) return reply.code(404).send({ error: "not_found" });
      const jobId = randomUUID();
      await app.tvQueue.add("tv-sync", { jobId, sourceId: source.id });
      return { jobId };
    });

    // GET /tv/sync/events?jobId= — SSE; forward tvEvents for this jobId until
    // "done"/"error" (scan.ts shape: hijack, done-cache replay for late subscribers).
    app.get<{ Querystring: { jobId?: string } }>("/tv/sync/events", manage, async (req, reply) => {
      const jobId = req.query.jobId;
      if (!jobId) return reply.code(400).send({ error: "job_id_required" });

      // Take raw control of the response so Fastify does not touch it again.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      // If the sync finished before the client connected, replay the cached event.
      const cached = tvDoneCache.get(jobId);
      if (cached) {
        res.write(`data: ${JSON.stringify(cached)}\n\n`);
        res.end();
        return;
      }

      const listener = (event: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event["phase"] === "done" || event["phase"] === "error") {
          tvEvents.off(jobId, listener);
          res.end();
        }
      };

      // Clean up if the client disconnects early.
      req.raw.on("close", () => {
        tvEvents.off(jobId, listener);
      });

      tvEvents.on(jobId, listener);
    });
  };
}
```

- [ ] **Step 5: Register in app.ts**

In `apps/api/src/app.ts`, add the import beside the other route imports:

```ts
import { tvSourcesRoute } from "./routes/tv-sources";
```

and register it after `refreshRoute` (before the interval blocks / `staticWebPlugin`):

```ts
  await app.register(tvSourcesRoute(env), { prefix: "/api" });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/tv-sources.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 7: Scoped lint + typecheck**

Run: `pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/tv-access.ts apps/api/src/routes/tv-sources.ts apps/api/src/routes/tv-sources.test.ts apps/api/src/app.ts
git commit -m "feat(tv): requireTvAccess guard + admin TV sources CRUD, upload, sync trigger, SSE" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: api `routes/tv-catalog.ts` — home, guide, channel, programmes stub, favorites, events (TDD)

**Files:**
- Create: `apps/api/src/routes/tv-catalog.ts`
- Modify: `apps/api/src/app.ts` (register `tvCatalogRoute` under `/api`)
- Test: `apps/api/src/routes/tv-catalog.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `requireTvAccess` (Task 7), `activeProfile`, Prisma `tvChannel`/`tvFavorite`/`tvPlayEvent`.
- Produces (fixed contract):
  - `TvChannelCard = { id, number, name, country, categories, quality, logo: string | null /* /api/images/channel/x.png */, healthy: boolean, favorite: boolean }`
  - `GET /tv/home` → `{ recents: TvChannelCard[], favorites: TvChannelCard[], countries: { code: string; channels: TvChannelCard[] }[], categories: { id: string; channels: TvChannelCard[] }[] }` — recents = latest tune per channel (from `TvPlayEvent`, cap 20); rails cap 30 channels; only categories that have channels ("on now" annotations arrive with the EPG phase).
  - `GET /tv/guide?country&category&favorites&q&offset&limit` → `{ total, offset, limit, channels: TvChannelCard[] }` (offset default 0; limit default 100, hard cap 200; ordered by `number` asc — never the whole catalog).
  - `GET /tv/channels/:id` → channel detail (streams summarised without URLs).
  - `GET /tv/channels/:id/programmes` → `{ programmes: [] }` until the EPG phase (phase 3 of the TV rollout) — shape locked now.
  - `PUT/DELETE /tv/favorites/:channelId`, `GET /tv/favorites` → `{ favorites: TvChannelCard[] }`, `POST /tv/events/:channelId` → `{ ok: true }`.
  - Hidden channels are excluded/404 everywhere. No BigInt in any response (Tv* models have none — keep it that way).

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/routes/tv-catalog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const COOKIES = { orbix_session: "s1", orbix_profile: "p1" };

function patchAuth(app: any, { kids = false, profile = true } = {}) {
  app.prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  app.prisma.account = { findUnique: async () => ({ isAdmin: true }) };
  app.prisma.profile = {
    findUnique: async () =>
      profile
        ? {
            id: "p1", name: kids ? "Kid" : "Me", avatar: null,
            kind: kids ? "kids" : "standard", maturityCap: kids ? 0 : null, language: "en",
          }
        : null,
  };
}

function emptyTvModels(app: any) {
  app.prisma.tvChannel = { findMany: async () => [], findUnique: async () => null, count: async () => 0 };
  app.prisma.tvFavorite = {
    findMany: async () => [],
    findUnique: async () => null,
    aggregate: async () => ({ _max: { position: null } }),
    upsert: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
  };
  app.prisma.tvPlayEvent = { findMany: async () => [], create: async () => ({}) };
}

function channelRow(over: Record<string, unknown> = {}) {
  return {
    id: "c1", number: 1, name: "Channel One", country: "RU",
    categories: ["general"], quality: "1080p", logoPath: "channel/1tv.png", hidden: false,
    streams: [{ protocol: "hls", status: "unknown" }],
    ...over,
  };
}

const KIDS_BLOCKED_ROUTES: { method: "GET" | "PUT" | "DELETE" | "POST"; url: string }[] = [
  { method: "GET", url: "/api/tv/home" },
  { method: "GET", url: "/api/tv/guide" },
  { method: "GET", url: "/api/tv/channels/c1" },
  { method: "GET", url: "/api/tv/channels/c1/programmes" },
  { method: "GET", url: "/api/tv/favorites" },
  { method: "PUT", url: "/api/tv/favorites/c1" },
  { method: "DELETE", url: "/api/tv/favorites/c1" },
  { method: "POST", url: "/api/tv/events/c1" },
];

describe("kids enforcement", () => {
  it("403s every /tv route for a kids profile", async () => {
    const app = await buildApp(env);
    patchAuth(app, { kids: true });
    emptyTvModels(app);
    for (const { method, url } of KIDS_BLOCKED_ROUTES) {
      const res = await app.inject({ method, url, cookies: COOKIES });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json(), `${method} ${url}`).toEqual({ error: "not_allowed_for_kids" });
    }
    await app.close();
  });

  it("401s without a session", async () => {
    const app = await buildApp(env);
    (app as any).prisma.session = { findUnique: async () => null };
    const res = await app.inject({ method: "GET", url: "/api/tv/home" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /tv/home", () => {
  it("builds recents/favorites/countries/categories rails from visible channels", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    const c1 = channelRow();
    const c2 = channelRow({
      id: "c2", number: 2, name: "2x2", categories: ["comedy"], logoPath: null,
      streams: [{ protocol: "hls", status: "dead" }, { protocol: "other", status: "ok" }],
    });
    const c3 = channelRow({ id: "c3", number: 3, name: "BBC One", country: "UK" });
    let channelWhere: any = null;
    (app as any).prisma.tvChannel = {
      findMany: async (args: any) => {
        channelWhere = args.where;
        return [c1, c2, c3];
      },
    };
    (app as any).prisma.tvFavorite = { findMany: async () => [{ channelId: "c3" }] };
    (app as any).prisma.tvPlayEvent = {
      // newest first; c2 appears twice → deduped
      findMany: async () => [{ channelId: "c2" }, { channelId: "c1" }, { channelId: "c2" }],
    };

    const res = await app.inject({ method: "GET", url: "/api/tv/home", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(channelWhere).toEqual({ hidden: false }); // hidden excluded at the query

    const body = res.json();
    expect(body.recents.map((c: any) => c.id)).toEqual(["c2", "c1"]);
    expect(body.favorites.map((c: any) => c.id)).toEqual(["c3"]);
    expect(body.favorites[0].favorite).toBe(true);
    expect(body.countries.map((r: any) => r.code)).toEqual(["RU", "UK"]); // RU: 2 channels, UK: 1
    expect(body.countries[0].channels.map((c: any) => c.id)).toEqual(["c1", "c2"]);
    expect(body.categories.map((r: any) => r.id)).toEqual(["general", "comedy"]);

    // Card mapping: no live HLS stream → unhealthy; no logoPath → null (monogram).
    const c2card = body.recents[0];
    expect(c2card).toEqual({
      id: "c2", number: 2, name: "2x2", country: "RU", categories: ["comedy"],
      quality: "1080p", logo: null, healthy: false, favorite: false,
    });
    const c1card = body.recents[1];
    expect(c1card.logo).toBe("/api/images/channel/1tv.png");
    expect(c1card.healthy).toBe(true);
    await app.close();
  });
});

describe("GET /tv/guide", () => {
  it("caps limit at 200, applies offset and country/category/q filters", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    let captured: any = null;
    (app as any).prisma.tvChannel = {
      count: async () => 450,
      findMany: async (args: any) => {
        captured = args;
        return [channelRow()];
      },
    };
    const res = await app.inject({
      method: "GET",
      url: "/api/tv/guide?limit=999&offset=40&country=ru&category=News&q=first",
      cookies: COOKIES,
    });
    expect(res.statusCode).toBe(200);
    expect(captured.take).toBe(200); // hard cap
    expect(captured.skip).toBe(40);
    expect(captured.orderBy).toEqual({ number: "asc" }); // numeric sort, never string
    expect(captured.where.hidden).toBe(false);
    expect(captured.where.country).toBe("RU");
    expect(captured.where.categories).toEqual({ has: "news" });
    expect(captured.where.name).toEqual({ contains: "first", mode: "insensitive" });
    expect(res.json()).toMatchObject({ total: 450, offset: 40, limit: 200 });
    await app.close();
  });

  it("filters to the profile's favorites when favorites=true", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    let captured: any = null;
    (app as any).prisma.tvChannel = {
      count: async () => 1,
      findMany: async (args: any) => {
        captured = args;
        return [channelRow({ id: "c9", number: 9 })];
      },
    };
    (app as any).prisma.tvFavorite = { findMany: async () => [{ channelId: "c9" }] };
    const res = await app.inject({ method: "GET", url: "/api/tv/guide?favorites=true", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(captured.where.id).toEqual({ in: ["c9"] });
    expect(res.json().channels[0].favorite).toBe(true);
    await app.close();
  });

  it("uses defaults offset=0 limit=100", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    let captured: any = null;
    (app as any).prisma.tvChannel = {
      count: async () => 0,
      findMany: async (args: any) => {
        captured = args;
        return [];
      },
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/guide", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(captured.skip).toBe(0);
    expect(captured.take).toBe(100);
    await app.close();
  });
});

describe("GET /tv/channels/:id", () => {
  it("returns detail with summarised streams (no URLs) and 404s hidden channels", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    (app as any).prisma.tvChannel = {
      findUnique: async () => ({
        id: "c1", number: 1, name: "Channel One", rawName: "RU| ПЕРВЫЙ HD",
        country: "RU", languages: ["rus"], categories: ["general"],
        website: "https://1tv.ru", epgId: "ChannelOne.ru@SD", quality: "1080p",
        logoPath: "channel/1tv.png", hidden: false,
        streams: [
          { id: "s1", quality: "1080p", label: null, protocol: "hls", status: "ok", priority: 0, url: "https://leak.example/x.m3u8" },
        ],
      }),
    };
    (app as any).prisma.tvFavorite = { findUnique: async () => ({ id: "f1" }) };
    const res = await app.inject({ method: "GET", url: "/api/tv/channels/c1", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: "c1", number: 1, name: "Channel One", epgId: "ChannelOne.ru@SD",
      logo: "/api/images/channel/1tv.png", healthy: true, favorite: true,
    });
    expect(body.streams).toEqual([
      { id: "s1", quality: "1080p", label: null, protocol: "hls", status: "ok", priority: 0 },
    ]); // url never leaks

    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "cH", hidden: true, streams: [] }) };
    const hidden = await app.inject({ method: "GET", url: "/api/tv/channels/cH", cookies: COOKIES });
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /tv/channels/:id/programmes", () => {
  it("returns the locked empty shape until the EPG phase", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "c1", hidden: false }) };
    const res = await app.inject({ method: "GET", url: "/api/tv/channels/c1/programmes", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ programmes: [] });
    await app.close();
  });
});

describe("favorites", () => {
  it("PUT upserts with an appended position", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "c1", hidden: false }) };
    let upserted: any = null;
    (app as any).prisma.tvFavorite = {
      aggregate: async () => ({ _max: { position: 2 } }),
      upsert: async (args: any) => {
        upserted = args;
        return {};
      },
    };
    const res = await app.inject({ method: "PUT", url: "/api/tv/favorites/c1", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(upserted.create).toEqual({ profileId: "p1", channelId: "c1", position: 3 });
    expect(upserted.update).toEqual({}); // re-favoriting keeps the position
    await app.close();
  });

  it("DELETE removes and returns 204; GET lists ordered cards and drops hidden", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    let deleted: any = null;
    (app as any).prisma.tvFavorite = {
      deleteMany: async (args: any) => {
        deleted = args;
        return { count: 1 };
      },
      findMany: async () => [
        { channelId: "c1", channel: channelRow() },
        { channelId: "cH", channel: channelRow({ id: "cH", hidden: true }) },
      ],
    };
    const del = await app.inject({ method: "DELETE", url: "/api/tv/favorites/c1", cookies: COOKIES });
    expect(del.statusCode).toBe(204);
    expect(deleted.where).toEqual({ profileId: "p1", channelId: "c1" });

    const list = await app.inject({ method: "GET", url: "/api/tv/favorites", cookies: COOKIES });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.favorites.map((c: any) => c.id)).toEqual(["c1"]); // hidden favorite dropped
    expect(body.favorites[0].favorite).toBe(true);
    await app.close();
  });

  it("400s favorites without an active profile", async () => {
    const app = await buildApp(env);
    patchAuth(app, { profile: false });
    emptyTvModels(app);
    const res = await app.inject({
      method: "PUT", url: "/api/tv/favorites/c1", cookies: { orbix_session: "s1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no_profile" });
    await app.close();
  });
});

describe("POST /tv/events/:channelId", () => {
  it("records a tune event for the active profile", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "c1", hidden: false }) };
    let created: any = null;
    (app as any).prisma.tvPlayEvent = {
      create: async (args: any) => {
        created = args;
        return {};
      },
    };
    const res = await app.inject({ method: "POST", url: "/api/tv/events/c1", cookies: COOKIES });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(created.data).toEqual({ profileId: "p1", channelId: "c1" });
    await app.close();
  });

  it("404s a hidden or unknown channel", async () => {
    const app = await buildApp(env);
    patchAuth(app);
    emptyTvModels(app);
    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "cH", hidden: true }) };
    const res = await app.inject({ method: "POST", url: "/api/tv/events/cH", cookies: COOKIES });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/tv-catalog.test.ts`
Expected: FAIL — unregistered routes return 404 where 200/400/403 is expected.

- [ ] **Step 3: Implement the reader routes**

Create `apps/api/src/routes/tv-catalog.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../lib/auth";
import { requireTvAccess } from "../lib/tv-access";
import { activeProfile } from "../lib/catalog-filter";

// ── Shared card shape (fixed cross-phase contract) ──────────────────────────

export interface TvChannelCard {
  id: string;
  number: number;
  name: string;
  country: string | null;
  categories: string[];
  quality: string | null;
  /** Same-origin cached-image URL ("/api/images/channel/x.png") or null → UI monogram. */
  logo: string | null;
  healthy: boolean;
  favorite: boolean;
}

interface ChannelRow {
  id: string;
  number: number;
  name: string;
  country: string | null;
  categories: string[];
  quality: string | null;
  logoPath: string | null;
  hidden: boolean;
  streams: { protocol: string; status: string }[];
}

const CHANNEL_CARD_SELECT = {
  id: true,
  number: true,
  name: true,
  country: true,
  categories: true,
  quality: true,
  logoPath: true,
  hidden: true,
  streams: { select: { protocol: true, status: true } },
} as const;

const RAIL_CAP = 30;
const RECENTS_CAP = 20;

function toCard(ch: ChannelRow, favoriteIds: ReadonlySet<string>): TvChannelCard {
  return {
    id: ch.id,
    number: ch.number,
    name: ch.name,
    country: ch.country,
    categories: ch.categories,
    quality: ch.quality,
    logo: ch.logoPath ? `/api/images/${ch.logoPath}` : null,
    healthy: ch.streams.some((s) => s.protocol === "hls" && s.status !== "dead"),
    favorite: favoriteIds.has(ch.id),
  };
}

export default async function tvCatalogRoute(app: FastifyInstance) {
  const guard = { preHandler: [requireAuth(app), requireTvAccess(app)] };

  // GET /tv/home — rails: recents, favorites, per-country, per-category.
  app.get("/tv/home", guard, async (req) => {
    const profile = await activeProfile(app, req);

    const [favRows, events, channels] = await Promise.all([
      profile
        ? app.prisma.tvFavorite.findMany({
            where: { profileId: profile.id },
            orderBy: { position: "asc" },
            select: { channelId: true },
          })
        : Promise.resolve([]),
      profile
        ? // Prisma's distinct is applied post-query and interacts badly with
          // take — fetch a recent window and dedupe by channel in memory.
          app.prisma.tvPlayEvent.findMany({
            where: { profileId: profile.id },
            orderBy: { at: "desc" },
            take: 200,
            select: { channelId: true },
          })
        : Promise.resolve([]),
      app.prisma.tvChannel.findMany({
        where: { hidden: false },
        orderBy: { number: "asc" },
        select: CHANNEL_CARD_SELECT,
      }),
    ]);

    const favoriteIds = new Set(favRows.map((r) => r.channelId));
    const byId = new Map<string, ChannelRow>(channels.map((c) => [c.id, c]));

    // Recents: latest tune per channel, most recent first, cap 20.
    const seen = new Set<string>();
    const recentIds: string[] = [];
    for (const e of events) {
      if (seen.has(e.channelId)) continue;
      seen.add(e.channelId);
      recentIds.push(e.channelId);
      if (recentIds.length >= RECENTS_CAP) break;
    }
    const recents = recentIds
      .map((id) => byId.get(id))
      .filter((c): c is ChannelRow => c != null)
      .map((c) => toCard(c, favoriteIds));

    const favorites = favRows
      .map((f) => byId.get(f.channelId))
      .filter((c): c is ChannelRow => c != null)
      .map((c) => toCard(c, favoriteIds));

    // Country rails, largest first (channel lists inherit number order).
    const byCountry = new Map<string, ChannelRow[]>();
    for (const c of channels) {
      if (!c.country) continue;
      const list = byCountry.get(c.country);
      if (list) list.push(c);
      else byCountry.set(c.country, [c]);
    }
    const countries = [...byCountry.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([code, list]) => ({
        code,
        channels: list.slice(0, RAIL_CAP).map((c) => toCard(c, favoriteIds)),
      }));

    // Category rails ("on now" annotations arrive with the EPG phase).
    const byCategory = new Map<string, ChannelRow[]>();
    for (const c of channels) {
      for (const cat of c.categories) {
        const list = byCategory.get(cat);
        if (list) list.push(c);
        else byCategory.set(cat, [c]);
      }
    }
    const categories = [...byCategory.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([id, list]) => ({
        id,
        channels: list.slice(0, RAIL_CAP).map((c) => toCard(c, favoriteIds)),
      }));

    return { recents, favorites, countries, categories };
  });

  // GET /tv/guide — windowed channel list; now/next joins arrive with EPG.
  app.get<{
    Querystring: {
      country?: string;
      category?: string;
      favorites?: string;
      q?: string;
      offset?: string;
      limit?: string;
    };
  }>("/tv/guide", guard, async (req) => {
    const profile = await activeProfile(app, req);
    const offsetRaw = Number.parseInt(req.query.offset ?? "", 10);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
    const limitRaw = Number.parseInt(req.query.limit ?? "", 10);
    const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100, 200);
    const q = req.query.q?.trim();
    const favoritesOnly = req.query.favorites === "true" || req.query.favorites === "1";

    const favRows = profile
      ? await app.prisma.tvFavorite.findMany({
          where: { profileId: profile.id },
          select: { channelId: true },
        })
      : [];
    const favoriteIds = new Set(favRows.map((r) => r.channelId));
    if (favoritesOnly && favoriteIds.size === 0) {
      return { total: 0, offset, limit, channels: [] };
    }

    const where = {
      hidden: false,
      ...(req.query.country ? { country: req.query.country.trim().toUpperCase() } : {}),
      ...(req.query.category ? { categories: { has: req.query.category.trim().toLowerCase() } } : {}),
      ...(favoritesOnly ? { id: { in: [...favoriteIds] } } : {}),
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
    };

    const [total, rows] = await Promise.all([
      app.prisma.tvChannel.count({ where }),
      app.prisma.tvChannel.findMany({
        where,
        orderBy: { number: "asc" },
        skip: offset,
        take: limit,
        select: CHANNEL_CARD_SELECT,
      }),
    ]);

    return { total, offset, limit, channels: rows.map((c) => toCard(c, favoriteIds)) };
  });

  // GET /tv/channels/:id — detail; hidden channels are 404 everywhere.
  app.get<{ Params: { id: string } }>("/tv/channels/:id", guard, async (req, reply) => {
    const [profile, ch] = await Promise.all([
      activeProfile(app, req),
      app.prisma.tvChannel.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          number: true,
          name: true,
          rawName: true,
          country: true,
          languages: true,
          categories: true,
          website: true,
          epgId: true,
          quality: true,
          logoPath: true,
          hidden: true,
          streams: {
            select: { id: true, quality: true, label: true, protocol: true, status: true, priority: true },
            orderBy: { priority: "asc" },
          },
        },
      }),
    ]);
    if (!ch || ch.hidden) return reply.code(404).send({ error: "not_found" });

    const favorite = profile
      ? (await app.prisma.tvFavorite.findUnique({
          where: { profileId_channelId: { profileId: profile.id, channelId: ch.id } },
          select: { id: true },
        })) != null
      : false;

    return {
      id: ch.id,
      number: ch.number,
      name: ch.name,
      rawName: ch.rawName,
      country: ch.country,
      languages: ch.languages,
      categories: ch.categories,
      website: ch.website,
      epgId: ch.epgId,
      quality: ch.quality,
      logo: ch.logoPath ? `/api/images/${ch.logoPath}` : null,
      healthy: ch.streams.some((s) => s.protocol === "hls" && s.status !== "dead"),
      favorite,
      // Stream URLs are deliberately not exposed — playback goes through the
      // phase-2 proxy; the admin channel manager (later phase) gets its own view.
      streams: ch.streams.map((s) => ({
        id: s.id,
        quality: s.quality,
        label: s.label,
        protocol: s.protocol,
        status: s.status,
        priority: s.priority,
      })),
    };
  });

  // GET /tv/channels/:id/programmes — contract-stable stub until the EPG phase
  // (phase 3 of the TV rollout); the shape is locked now so the UI can build
  // against it.
  app.get<{ Params: { id: string }; Querystring: { day?: string } }>(
    "/tv/channels/:id/programmes",
    guard,
    async (req, reply) => {
      const ch = await app.prisma.tvChannel.findUnique({
        where: { id: req.params.id },
        select: { id: true, hidden: true },
      });
      if (!ch || ch.hidden) return reply.code(404).send({ error: "not_found" });
      return { programmes: [] };
    },
  );

  // ── Favorites (per-profile) ────────────────────────────────────────────────

  // PUT /tv/favorites/:channelId — idempotent add, appended position.
  app.put<{ Params: { channelId: string } }>("/tv/favorites/:channelId", guard, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.code(400).send({ error: "no_profile" });
    const ch = await app.prisma.tvChannel.findUnique({
      where: { id: req.params.channelId },
      select: { id: true, hidden: true },
    });
    if (!ch || ch.hidden) return reply.code(404).send({ error: "not_found" });
    const max = await app.prisma.tvFavorite.aggregate({
      where: { profileId: profile.id },
      _max: { position: true },
    });
    await app.prisma.tvFavorite.upsert({
      where: { profileId_channelId: { profileId: profile.id, channelId: ch.id } },
      create: { profileId: profile.id, channelId: ch.id, position: (max._max.position ?? 0) + 1 },
      update: {}, // already a favorite — keep its position
    });
    return { ok: true };
  });

  // DELETE /tv/favorites/:channelId
  app.delete<{ Params: { channelId: string } }>(
    "/tv/favorites/:channelId",
    guard,
    async (req, reply) => {
      const profile = await activeProfile(app, req);
      if (!profile) return reply.code(400).send({ error: "no_profile" });
      await app.prisma.tvFavorite.deleteMany({
        where: { profileId: profile.id, channelId: req.params.channelId },
      });
      return reply.code(204).send();
    },
  );

  // GET /tv/favorites — ordered by position; hidden channels filtered out.
  app.get("/tv/favorites", guard, async (req) => {
    const profile = await activeProfile(app, req);
    if (!profile) return { favorites: [] };
    const rows = await app.prisma.tvFavorite.findMany({
      where: { profileId: profile.id },
      orderBy: { position: "asc" },
      select: { channelId: true, channel: { select: CHANNEL_CARD_SELECT } },
    });
    const favoriteIds = new Set(rows.map((r) => r.channelId));
    return {
      favorites: rows.filter((r) => !r.channel.hidden).map((r) => toCard(r.channel, favoriteIds)),
    };
  });

  // POST /tv/events/:channelId — tune event (recents); client fire-and-forgets.
  app.post<{ Params: { channelId: string } }>("/tv/events/:channelId", guard, async (req, reply) => {
    const profile = await activeProfile(app, req);
    if (!profile) return reply.code(400).send({ error: "no_profile" });
    const ch = await app.prisma.tvChannel.findUnique({
      where: { id: req.params.channelId },
      select: { id: true, hidden: true },
    });
    if (!ch || ch.hidden) return reply.code(404).send({ error: "not_found" });
    await app.prisma.tvPlayEvent.create({ data: { profileId: profile.id, channelId: ch.id } });
    return { ok: true };
  });
}
```

- [ ] **Step 4: Register in app.ts**

In `apps/api/src/app.ts`, add the import:

```ts
import tvCatalogRoute from "./routes/tv-catalog";
```

and register it right after `tvSourcesRoute`:

```ts
  await app.register(tvCatalogRoute, { prefix: "/api" });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/tv-catalog.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Scoped lint + typecheck**

Run: `pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/tv-catalog.ts apps/api/src/routes/tv-catalog.test.ts apps/api/src/app.ts
git commit -m "feat(tv): reader API — home rails, windowed guide, channel detail, favorites, tune events" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: README feature bullet + full gates

**Files:**
- Modify: `README.md` (Features list)

**Interfaces:**
- Consumes: nothing new. **No new env vars** — `.env.example` stays untouched (the TV domain runs entirely on `METADATA_DIR`, `REDIS_URL`, `DATABASE_URL`, `SESSION_SECRET`, all pre-existing).

- [ ] **Step 1: Add the TV bullet to README Features**

In `README.md`, in the `## Features` list, insert after the **Discovery** bullet:

```markdown
- **TV (live channels)** — a browsable worldwide catalog of free, publicly available live channels: opt-in runtime sync of the iptv-org public-domain index (DMCA blocklist honored, NSFW excluded) plus your own M3U playlists, with channel logos cached to disk for offline browsing. Orbix ships no channels and no stream URLs; availability depends on your network position. Hidden for kids profiles (server-enforced).
```

- [ ] **Step 2: Full gates (all four — build included before merge)**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all four PASS across every package. If anything fails, fix it in the owning task's files before committing (do not commit red).

- [ ] **Step 3: Reap any stray dev servers (hygiene)**

If any manual smokes were run on the host during this plan:

```bash
pkill -f "tsx.*watch src/server.ts"; pkill -f vite
```

- [ ] **Step 4: Final commit**

```bash
git add README.md
git commit -m "feat(tv): document the live TV catalog in the README feature list" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Execution notes (read once before Task 1)

- **Dependency order is strict:** Task 1 (schema) → Tasks 2-4 (pure core, TDD) → Task 5 (exports — `apps/api` can only import the tv module after this) → Task 6 (queue plugin) → Task 7 (sources routes; creates `requireTvAccess`) → Task 8 (reader routes; consumes `requireTvAccess`) → Task 9 (docs + gates).
- **The tv-sync processor body is adapter wiring** (the same trust level as the scan processor in `queue.ts`): its logic seams — planners, parser, name cleaner, numbering, the iptv-org conditional fetch, the enqueue route — are all unit-tested; do not try to run the worker in vitest (it needs Redis).
- **Known v1 trade-offs (deliberate, do not "fix" while executing):** stream statuses reset to `"unknown"` on every sync (health job re-learns them later); a channel hidden by a vanish is not auto-unhidden if it reappears (protects future manual admin hides); `cacheImageFromUrl` keys logos by URL basename (collisions across channels are theoretically possible — same accepted trade-off as fanart logos); `/tv/home` loads all visible channels in one query (fine at household scale; windowing lives in `/tv/guide`).
- **SSE route note:** `GET /tv/sync/events` takes `?jobId=` because progress events and the done-cache are keyed by jobId (the scan.ts model). Only the replay path is unit-testable with `app.inject`; the live-listener path would hang a test (no worker in test mode).
