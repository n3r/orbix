# TV Phase 3 — EPG, Health Job, Channel Manager, i18n/e2e/Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement rollout phases 7–9 of the Live TV spec: an XMLTV EPG pipeline that fills `TvProgramme` (default sources auto-seeded per enabled country, admin CRUD), now/next everywhere (home rails, guide rows, channel schedule page, play response, player OSD/mini-guide), a nightly stream-health probe job, an admin channel manager (hidden/kidsAllowed/epgId/number), real translations of the `tv` namespace in all 6 locales, Playwright e2e coverage, and README/deploy docs.

**Architecture:** Pure XMLTV parsing (incremental SAX collector on `saxes`) and EPG channel-matching live in `packages/core/src/tv/` — bytes/strings in, rows out, zero I/O. `apps/api` supplies streaming/gunzip/Prisma adapters: testable job runners in `apps/api/src/jobs/` (`tv-epg.ts`, `tv-health.ts`, house pattern of `refresh-metadata.ts`) invoked by new `"tv-epg"`/`"tv-health"` job names in the existing `tv` BullMQ worker (`apps/api/src/plugins/tv-queue.ts`), scheduled by unref'd `setInterval`s in `app.ts`. Serving is Postgres-only: one grouped `TvProgramme` query decorates home/guide/play with now/next — never per-channel queries. Admin surface (`/tv/epg-sources`, `/tv/epg/refresh`, `/tv/admin/channels`) is a new route file guarded `requireAuth`+`requireAdmin`+`requireNonKids`. Web fills the now/next slots phase 2 left empty and adds two cards to `AccountTvPage`.

**Tech Stack:** TypeScript, pnpm 10.22.0 + Turborepo, Node 22, Fastify + Prisma (Postgres 16), BullMQ (Redis), `saxes` (new pure dep in core), `node:zlib` gunzip (api only), React 19 + TanStack Query + react-i18next, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-03-tv-live-channels-design.md` — sections "EPG pipeline (`tv-epg` job)", "`tv-health` job", "API surface", "Web UI", "Legal posture", "Testing", "Rollout phases" 7–9.

**Prerequisites (delivered by the phase 1+2 plans — treat as existing):** all `Tv*` Prisma models (incl. `TvEpgSource`, `TvProgramme @@unique([channelId, start])`); `apps/api/src/plugins/tv-queue.ts` (`app.tvQueue` on queue `"tv"`, `tvEvents` emitter, `tvDoneCache` map, worker with a `switch` on `job.name` handling `"tv-sync"`); core exports `parseM3u`, `cleanChannelName`, plan/sign/rewrite helpers; `apps/api/src/lib/tv-upstream.ts` `makeTvUpstream()`; `apps/api/src/lib/tv-access.ts` `requireTvAccess`; routes `tv-sources.ts`, `tv-catalog.ts` (with `/tv/home`, `/tv/guide`, `/tv/channels/:id/programmes` returning `{programmes: []}`), `tv-play.ts` (with `nowNext: null` placeholder); web `/tv` pages + `LiveTvPlayer` with empty now/next slots; `AccountTvPage`; `apps/web/src/locales/*/tv.json` (en authored; other 5 are English placeholder copies; `"tv"` already in `NAMESPACES`).

## Global Constraints

- **pnpm 10.22.0 / Node 22.** Always the repo-local pnpm.
- **Core purity:** `packages/core` imports no DB/network/ffmpeg/fs. `saxes` is a pure in-memory XML parser — allowed as a core dependency. Core tests get strings/fixtures only; **gzip never appears in core tests** (gunzip lives in `apps/api`).
- **Guide/home/play must never N+1 programmes.** Exactly ONE grouped `tvProgramme.findMany` per request, asserted in tests via a prisma-fake call log.
- **Every task ends with green gates:** `pnpm typecheck && pnpm lint && pnpm test`. Run the scoped `pnpm --filter <pkg> lint` per change too — lint-only errors hide behind Turbo's cache.
- **SPA calls relative `/api/...` only** via `apiFetch`/`apiJson` (`apps/web/src/lib/api.ts`). Never an absolute origin.
- **Kids exclusion is server-enforced:** every new route sits behind the same guards as its phase-1 siblings (`requireTvAccess` for member routes; `requireAuth`+`requireAdmin`+`requireNonKids` for admin routes).
- **i18n parity is enforced** by `apps/web/src/locales/parity.test.ts` — every key added to `en/tv.json` must exist in all five other locales (as a real translation, not an English copy).
- **e2e only against a throwaway DB** with `E2E_ALLOW_DB_RESET=1` — `apps/web/e2e/global-setup.ts` WIPES all accounts/profiles. Never point it at a populated dev DB.
- **No BigInt in `Tv*` models** — keep it that way (no `.toString()` dances).
- **Commits:** `feat(tv): …` / `docs(tv): …`, each ending with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Parallel-authorship caution:** phases 1–2 were planned in parallel. Where a task touches a phase-1/2 file, the first step is always *read the file as it actually exists* and adapt names/payload envelopes to it; the interfaces in this plan's contracts are fixed, internal glue is not.

---

### Task 1: Core — XMLTV incremental collector (`saxes`) + `parseXmltvDate` (TDD)

**Files:**
- Modify: `packages/core/package.json` (add `saxes`)
- Create: `packages/core/src/tv/xmltv.ts`
- Create: `packages/core/src/tv/xmltv.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./tv/xmltv";`)

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  ```ts
  export interface XmltvProgramme { epgId: string; start: Date; stop: Date; title: string; description: string | null; category: string | null; lang: string | null; }
  export interface XmltvChannelName { id: string; names: string[]; }
  export function createXmltvCollector(opts: {
    wantedIds: Set<string> | null;           // null = collect channel names only (discovery pass)
    offsetMin: number;
    windowStart: Date; windowEnd: Date;      // programmes intersecting [start,end) kept
    onProgramme: (p: XmltvProgramme) => void;
    onChannel?: (c: XmltvChannelName) => void;
  }): { write(chunk: string): void; end(): void };
  export function parseXmltvDate(s: string): Date | null;
  ```
- Semantics (fixed): XMLTV time `"20260703193000 +0300"`, missing offset → UTC, seconds optional. `offsetMin` applied AFTER parsing. First `<title>` wins (its `lang` attr → `lang`); `category` = first `<category>` text or null; `description` = first `<desc>` or null. Window keep-rule: `stop > windowStart && start < windowEnd`. **`wantedIds` membership is read live at each `</programme>`** — callers may mutate the Set mid-stream (Task 4 relies on this; XMLTV orders all `<channel>` before any `<programme>`).

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @orbix/core add saxes
```

- [ ] **Step 2: Write the failing test** — `packages/core/src/tv/xmltv.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  createXmltvCollector,
  parseXmltvDate,
  type XmltvChannelName,
  type XmltvProgramme,
} from "./xmltv";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="ChannelOne.ru">
    <display-name>Первый канал</display-name>
    <display-name>Channel One</display-name>
  </channel>
  <channel id="zdf.de">
    <display-name>ZDF HD</display-name>
  </channel>
  <programme start="20260703193000 +0300" stop="20260703210000 +0300" channel="ChannelOne.ru">
    <title lang="ru">Время</title>
    <title lang="en">Vremya</title>
    <desc lang="ru">Информационная программа.</desc>
    <category lang="ru">Новости</category>
    <category lang="ru">Инфо</category>
  </programme>
  <programme start="20260703100000 +0300" stop="20260703110000 +0300" channel="ChannelOne.ru">
    <title>Доброе утро</title>
  </programme>
  <programme start="20260703190000" stop="20260703200000" channel="untracked.id">
    <title>Skip me</title>
  </programme>
</tv>`;

const windowStart = new Date("2026-07-03T12:00:00.000Z");
const windowEnd = new Date("2026-07-05T12:00:00.000Z");

function collect(opts: { wantedIds: Set<string> | null; offsetMin?: number }) {
  const programmes: XmltvProgramme[] = [];
  const channels: XmltvChannelName[] = [];
  const c = createXmltvCollector({
    wantedIds: opts.wantedIds,
    offsetMin: opts.offsetMin ?? 0,
    windowStart,
    windowEnd,
    onProgramme: (p) => programmes.push(p),
    onChannel: (ch) => channels.push(ch),
  });
  return { c, programmes, channels };
}

describe("parseXmltvDate", () => {
  it("parses full form with offset", () => {
    expect(parseXmltvDate("20260703193000 +0300")?.toISOString()).toBe("2026-07-03T16:30:00.000Z");
  });
  it("parses a negative offset", () => {
    expect(parseXmltvDate("20260703193000 -0500")?.toISOString()).toBe("2026-07-04T00:30:00.000Z");
  });
  it("tolerates a missing offset as UTC", () => {
    expect(parseXmltvDate("20260703193000")?.toISOString()).toBe("2026-07-03T19:30:00.000Z");
  });
  it("tolerates missing seconds", () => {
    expect(parseXmltvDate("202607031930 +0000")?.toISOString()).toBe("2026-07-03T19:30:00.000Z");
  });
  it("returns null on garbage", () => {
    expect(parseXmltvDate("not-a-date")).toBeNull();
    expect(parseXmltvDate("")).toBeNull();
  });
});

describe("createXmltvCollector", () => {
  it("collects wanted programmes inside the window; first title/category win; lang from first title", () => {
    const { c, programmes } = collect({ wantedIds: new Set(["ChannelOne.ru", "zdf.de"]) });
    c.write(XML);
    c.end();
    // programme 2 (07:00–08:00Z) ends before windowStart → dropped; programme 3 untracked → dropped
    expect(programmes).toHaveLength(1);
    const p = programmes[0];
    expect(p.epgId).toBe("ChannelOne.ru");
    expect(p.title).toBe("Время");
    expect(p.lang).toBe("ru");
    expect(p.description).toBe("Информационная программа.");
    expect(p.category).toBe("Новости");
    expect(p.start.toISOString()).toBe("2026-07-03T16:30:00.000Z");
    expect(p.stop.toISOString()).toBe("2026-07-03T18:00:00.000Z");
  });

  it("applies offsetMin AFTER parsing", () => {
    const { c, programmes } = collect({ wantedIds: new Set(["ChannelOne.ru"]), offsetMin: 60 });
    c.write(XML);
    c.end();
    expect(programmes[0].start.toISOString()).toBe("2026-07-03T17:30:00.000Z");
    expect(programmes[0].stop.toISOString()).toBe("2026-07-03T19:00:00.000Z");
  });

  it("emits channel display-names via onChannel", () => {
    const { c, channels } = collect({ wantedIds: new Set(["ChannelOne.ru"]) });
    c.write(XML);
    c.end();
    expect(channels).toEqual([
      { id: "ChannelOne.ru", names: ["Первый канал", "Channel One"] },
      { id: "zdf.de", names: ["ZDF HD"] },
    ]);
  });

  it("wantedIds null = discovery pass: channels only, zero programmes", () => {
    const { c, programmes, channels } = collect({ wantedIds: null });
    c.write(XML);
    c.end();
    expect(programmes).toHaveLength(0);
    expect(channels).toHaveLength(2);
  });

  it("is chunk-boundary safe (split mid-tag and mid-Cyrillic text)", () => {
    const { c, programmes, channels } = collect({ wantedIds: new Set(["ChannelOne.ru"]) });
    const cut1 = XML.indexOf("Первый кан") + 9; // inside a Cyrillic display-name
    const cut2 = XML.indexOf("<programme") + 5; // inside a tag name
    c.write(XML.slice(0, cut1));
    c.write(XML.slice(cut1, cut2));
    c.write(XML.slice(cut2));
    c.end();
    expect(channels[0].names[0]).toBe("Первый канал");
    expect(programmes).toHaveLength(1);
    expect(programmes[0].title).toBe("Время");
  });

  it("reads wantedIds LIVE — ids added after channels streamed are honored for later programmes", () => {
    const wanted = new Set<string>();
    const programmes: XmltvProgramme[] = [];
    const c = createXmltvCollector({
      wantedIds: wanted,
      offsetMin: 0,
      windowStart,
      windowEnd,
      onProgramme: (p) => programmes.push(p),
      onChannel: (ch) => {
        if (ch.id === "ChannelOne.ru") wanted.add("ChannelOne.ru"); // simulate name-match admission
      },
    });
    c.write(XML);
    c.end();
    expect(programmes).toHaveLength(1);
  });

  it("skips malformed programmes (bad dates / missing title) without throwing", () => {
    const bad = `<tv><programme start="garbage" stop="20260703200000" channel="x"><title>t</title></programme>
      <programme start="20260703190000" stop="20260703200000" channel="x"></programme></tv>`;
    const { c, programmes } = collect({ wantedIds: new Set(["x"]) });
    c.write(bad);
    c.end();
    expect(programmes).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL (module not found)**

```bash
pnpm --filter @orbix/core exec vitest run src/tv/xmltv.test.ts
```

- [ ] **Step 4: Implement** — `packages/core/src/tv/xmltv.ts`:

```ts
import { SaxesParser } from "saxes";

/** One parsed XMLTV `<programme>` row, window-filtered and offset-applied. */
export interface XmltvProgramme {
  epgId: string;
  start: Date;
  stop: Date;
  title: string;
  description: string | null;
  category: string | null;
  lang: string | null;
}

/** An XMLTV `<channel>`'s id plus every `<display-name>` text, in file order. */
export interface XmltvChannelName {
  id: string;
  names: string[];
}

/**
 * Parse an XMLTV timestamp: "20260703193000 +0300". Seconds and the offset are
 * both optional; a missing offset means UTC. Returns null when the shape does
 * not match (feeds are machine-generated — no lenient recovery beyond this).
 */
export function parseXmltvDate(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2})(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se, sign, oh, om] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, se ? +se : 0);
  if (!sign) return new Date(utcMs);
  const offMin = (sign === "-" ? -1 : 1) * (+oh * 60 + +om);
  return new Date(utcMs - offMin * 60_000);
}

export interface XmltvCollectorOptions {
  /**
   * Programme filter: only rows whose `channel` attribute is in this set are
   * emitted. `null` = discovery pass (channel names only, no programmes).
   * Membership is checked LIVE at each `</programme>` — callers may add ids
   * mid-stream (XMLTV orders all <channel> elements before any <programme>,
   * so ids admitted while channels stream in still catch every programme).
   */
  wantedIds: Set<string> | null;
  /** Minutes added to every parsed start/stop (the "guide is hours off" knob). */
  offsetMin: number;
  windowStart: Date;
  /** Programmes intersecting [windowStart, windowEnd) are kept. */
  windowEnd: Date;
  onProgramme: (p: XmltvProgramme) => void;
  onChannel?: (c: XmltvChannelName) => void;
}

/**
 * Incremental XMLTV collector: feed it decoded string chunks, get rows out.
 * Pure — no fs/network/zlib; gunzip and byte→string decoding live in the api.
 * Malformed XML throws out of write()/end() (callers mark the source errored).
 */
export function createXmltvCollector(opts: XmltvCollectorOptions): {
  write(chunk: string): void;
  end(): void;
} {
  const parser = new SaxesParser();
  const offsetMs = opts.offsetMin * 60_000;

  // <channel> state
  let inChannel = false;
  let channelId = "";
  let channelNames: string[] = [];

  // <programme> state
  let inProgramme = false;
  let progChannel = "";
  let progStart: Date | null = null;
  let progStop: Date | null = null;
  let title: string | null = null;
  let titleLang: string | null = null;
  let desc: string | null = null;
  let category: string | null = null;

  // Text accumulation for the element we care about (multi-chunk safe).
  let textTarget: "display-name" | "title" | "desc" | "category" | null = null;
  let textBuf = "";

  parser.on("error", (err) => {
    throw err;
  });

  parser.on("opentag", (tag) => {
    const name = tag.name.toLowerCase();
    const attrs = tag.attributes as Record<string, string>;
    if (name === "channel") {
      inChannel = true;
      channelId = attrs["id"] ?? "";
      channelNames = [];
    } else if (name === "programme") {
      inProgramme = true;
      progChannel = attrs["channel"] ?? "";
      progStart = parseXmltvDate(attrs["start"] ?? "");
      progStop = parseXmltvDate(attrs["stop"] ?? "");
      title = null;
      titleLang = null;
      desc = null;
      category = null;
    } else if (inChannel && name === "display-name") {
      textTarget = "display-name";
      textBuf = "";
    } else if (inProgramme && (name === "title" || name === "desc" || name === "category")) {
      textTarget = name;
      textBuf = "";
      // v1: the FIRST <title> wins; capture its lang attr before it closes.
      if (name === "title" && title === null) titleLang = attrs["lang"] ?? null;
    }
  });

  const onText = (t: string) => {
    if (textTarget) textBuf += t;
  };
  parser.on("text", onText);
  parser.on("cdata", onText);

  parser.on("closetag", (tag) => {
    const name = tag.name.toLowerCase();
    if (textTarget && name === textTarget) {
      const text = textBuf.trim();
      if (name === "display-name") {
        if (text) channelNames.push(text);
      } else if (name === "title") {
        if (title === null && text) title = text; // first one wins (v1)
      } else if (name === "desc") {
        if (desc === null && text) desc = text;
      } else if (name === "category") {
        if (category === null && text) category = text;
      }
      textTarget = null;
      textBuf = "";
      return;
    }
    if (name === "channel" && inChannel) {
      inChannel = false;
      if (channelId && opts.onChannel) opts.onChannel({ id: channelId, names: channelNames });
    } else if (name === "programme" && inProgramme) {
      inProgramme = false;
      if (opts.wantedIds === null) return; // discovery pass
      if (!opts.wantedIds.has(progChannel)) return; // untracked channel
      if (!progStart || !progStop || !title) return; // malformed row → skip
      const start = new Date(progStart.getTime() + offsetMs); // offset AFTER parsing
      const stop = new Date(progStop.getTime() + offsetMs);
      if (!(stop > opts.windowStart && start < opts.windowEnd)) return; // window
      opts.onProgramme({
        epgId: progChannel,
        start,
        stop,
        title,
        description: desc,
        category,
        lang: titleLang,
      });
    }
  });

  return {
    write(chunk: string) {
      parser.write(chunk);
    },
    end() {
      parser.close();
    },
  };
}
```

- [ ] **Step 5: Export from the barrel** — append to `packages/core/src/index.ts` (next to the other `./tv/*` exports phase 1–2 added):

```ts
export * from "./tv/xmltv";
```

- [ ] **Step 6: Run — expect PASS**

```bash
pnpm --filter @orbix/core exec vitest run src/tv/xmltv.test.ts
```

- [ ] **Step 7: Scoped gates**

```bash
pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck && pnpm --filter @orbix/core test
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/src/tv/xmltv.ts packages/core/src/tv/xmltv.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(tv): core XMLTV incremental collector (saxes) + date parser

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Core — EPG channel matching (`normalizeChannelName`, `matchEpgChannels`) (TDD)

**Files:**
- Create: `packages/core/src/tv/epg-match.ts`
- Create: `packages/core/src/tv/epg-match.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./tv/epg-match";`)

**Interfaces:**
- Consumes: `XmltvChannelName` from `./xmltv`.
- Produces:
  ```ts
  export function normalizeChannelName(s: string): string;
  export function matchEpgChannels(
    channels: { id: string; epgId: string | null; name: string; altNames: string[] }[],
    xmltvChannels: XmltvChannelName[],
  ): Map<string, string>; // TvChannel.id -> xmltv channel id
  ```
- Semantics (fixed): pass 1 = exact `epgId` match against xmltv ids; pass 2 = unique normalized-name match (skip ambiguous — a normalized name shared by ≥2 xmltv ids, or a channel whose names hit ≥2 distinct xmltv ids); pass 2 never overrides pass 1. `normalizeChannelName`: NFC → lowercase → strip diacritics → drop bracketed/quality junk (`HD`, `FHD`, `UHD`, `SD`, `4K`, `1080p`, `(720p)`, `[Not 24/7]`, …) → non-alphanumerics to spaces → collapse whitespace. Implemented standalone (same rule family as `cleanChannelName`, but not coupled to it — defensive against phase-2 drift).

- [ ] **Step 1: Write the failing test** — `packages/core/src/tv/epg-match.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchEpgChannels, normalizeChannelName } from "./epg-match";

describe("normalizeChannelName", () => {
  it("lowercases, strips quality suffixes and collapses spaces", () => {
    expect(normalizeChannelName("ZDF HD")).toBe("zdf");
    expect(normalizeChannelName("TF1  (1080p)")).toBe("tf1");
    expect(normalizeChannelName("Rai 1 [Not 24/7]")).toBe("rai 1");
    expect(normalizeChannelName("Channel One FHD 50fps")).toBe("channel one");
  });
  it("strips diacritics and normalizes unicode", () => {
    expect(normalizeChannelName("Première")).toBe("premiere");
    expect(normalizeChannelName("México TV")).toBe("mexico tv");
  });
  it("handles Cyrillic consistently on both sides", () => {
    expect(normalizeChannelName("Первый канал HD")).toBe(normalizeChannelName("ПЕРВЫЙ КАНАЛ"));
  });
  it("keeps timeshift digits distinct", () => {
    expect(normalizeChannelName("Первый канал +1")).not.toBe(normalizeChannelName("Первый канал"));
  });
});

describe("matchEpgChannels", () => {
  const xmltv = [
    { id: "ChannelOne.ru", names: ["Первый канал", "Channel One"] },
    { id: "zdf.de", names: ["ZDF"] },
    { id: "dup-a.tv", names: ["Duplicate"] },
    { id: "dup-b.tv", names: ["Duplicate"] },
  ];

  it("pass 1: exact epgId match", () => {
    const out = matchEpgChannels(
      [{ id: "c1", epgId: "zdf.de", name: "Whatever", altNames: [] }],
      xmltv,
    );
    expect(out.get("c1")).toBe("zdf.de");
  });

  it("pass 2: unique normalized-name match via name or altNames", () => {
    const out = matchEpgChannels(
      [
        { id: "c1", epgId: null, name: "ZDF HD", altNames: [] },
        { id: "c2", epgId: "missing.id", name: "x", altNames: ["Первый канал HD"] },
      ],
      xmltv,
    );
    expect(out.get("c1")).toBe("zdf.de");
    expect(out.get("c2")).toBe("ChannelOne.ru");
  });

  it("skips ambiguous names (two xmltv ids share the normalized name)", () => {
    const out = matchEpgChannels(
      [{ id: "c1", epgId: null, name: "Duplicate", altNames: [] }],
      xmltv,
    );
    expect(out.has("c1")).toBe(false);
  });

  it("skips a channel whose candidate names hit two DIFFERENT xmltv ids", () => {
    const out = matchEpgChannels(
      [{ id: "c1", epgId: null, name: "ZDF", altNames: ["Channel One"] }],
      xmltv,
    );
    expect(out.has("c1")).toBe(false);
  });

  it("pass 2 never overrides pass 1", () => {
    const out = matchEpgChannels(
      [{ id: "c1", epgId: "zdf.de", name: "Первый канал", altNames: [] }],
      xmltv,
    );
    expect(out.get("c1")).toBe("zdf.de");
  });

  it("unmatched channels are simply absent", () => {
    const out = matchEpgChannels(
      [{ id: "c1", epgId: null, name: "Totally Unknown", altNames: [] }],
      xmltv,
    );
    expect(out.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @orbix/core exec vitest run src/tv/epg-match.test.ts
```

- [ ] **Step 3: Implement** — `packages/core/src/tv/epg-match.ts`:

```ts
import type { XmltvChannelName } from "./xmltv";

// Quality/codec/junk tokens that carry no identity (same family of rules as
// cleanChannelName, kept standalone so EPG matching has no coupling to the
// playlist cleaner's exact behavior).
const JUNK_TOKENS =
  /\b(?:uhd|fhd|hd|sd|4k|8k|hevc|h265|h264|50\s?fps|60\s?fps|2160p?|1080p?|720p?|576p?|480p?|360p?)\b/gi;

/**
 * Normalize a channel name for cross-source identity comparison:
 * NFC → lowercase → strip diacritics → drop bracketed/quality junk →
 * non-alphanumerics to spaces → collapse whitespace.
 */
export function normalizeChannelName(s: string): string {
  let out = s.normalize("NFC").toLowerCase();
  out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // strip combining marks
  out = out.replace(/\[[^\]]*\]|\([^)]*\)/g, " "); // [Not 24/7], (1080p), (backup)…
  out = out.replace(JUNK_TOKENS, " ");
  out = out.replace(/[^\p{L}\p{N}]+/gu, " "); // punctuation/symbols → space
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Map TvChannel.id -> xmltv channel id.
 * Pass 1: exact epgId match. Pass 2: unique normalized-name match — skipped
 * when the name is ambiguous on either side. Pass 2 never overrides pass 1.
 */
export function matchEpgChannels(
  channels: { id: string; epgId: string | null; name: string; altNames: string[] }[],
  xmltvChannels: XmltvChannelName[],
): Map<string, string> {
  const out = new Map<string, string>();
  const xmltvIds = new Set(xmltvChannels.map((c) => c.id));

  // Pass 1 — exact epgId
  for (const ch of channels) {
    if (ch.epgId && xmltvIds.has(ch.epgId)) out.set(ch.id, ch.epgId);
  }

  // Pass 2 — unique normalized-name
  const byName = new Map<string, Set<string>>();
  for (const xc of xmltvChannels) {
    for (const n of xc.names) {
      const key = normalizeChannelName(n);
      if (!key) continue;
      let set = byName.get(key);
      if (!set) byName.set(key, (set = new Set()));
      set.add(xc.id);
    }
  }
  for (const ch of channels) {
    if (out.has(ch.id)) continue; // never override pass 1
    const candidates = new Set<string>();
    for (const n of [ch.name, ...ch.altNames]) {
      const ids = byName.get(normalizeChannelName(n));
      if (ids) for (const id of ids) candidates.add(id);
    }
    if (candidates.size === 1) out.set(ch.id, [...candidates][0]);
    // 0 → no guide for this channel; ≥2 → ambiguous, fail-safe skip
  }
  return out;
}
```

- [ ] **Step 4: Export from the barrel** — append `export * from "./tv/epg-match";` to `packages/core/src/index.ts`.

- [ ] **Step 5: Run — expect PASS**

```bash
pnpm --filter @orbix/core exec vitest run src/tv/epg-match.test.ts
```

- [ ] **Step 6: Scoped gates + commit**

```bash
pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck && pnpm --filter @orbix/core test
git add packages/core/src/tv/epg-match.ts packages/core/src/tv/epg-match.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(tv): core EPG channel matching (epgId exact + unique normalized name)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: API — default EPG source seeding (`tv-epg.ts`) + hook into `tv-sources`

**Files:**
- Create: `apps/api/src/lib/tv-epg.ts`
- Create: `apps/api/src/lib/tv-epg.test.ts`
- Modify: `apps/api/src/routes/tv-sources.ts` (call seeding when iptv-org countries change)
- Modify: `apps/api/src/routes/tv-sources.test.ts` (add the seeding assertion)

**Interfaces:**
- Consumes: `PrismaClient` from `@orbix/db`.
- Produces:
  ```ts
  export const DEFAULT_EPG_SOURCES: { countries: string[]; name: string; url: string }[];
  export function seedEpgSourcesForCountries(prisma: PrismaClient, countries: string[]): Promise<number>; // upsert-by-url, returns created count
  ```

- [ ] **Step 1: Write the failing unit test** — `apps/api/src/lib/tv-epg.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@orbix/db";
import { DEFAULT_EPG_SOURCES, seedEpgSourcesForCountries } from "./tv-epg";

function fakePrisma(existingUrls: string[]) {
  const created: { name: string; url: string }[] = [];
  const prisma = {
    tvEpgSource: {
      findFirst: async ({ where }: { where: { url: string } }) =>
        existingUrls.includes(where.url) ? { id: "e1", url: where.url } : null,
      create: async ({ data }: { data: { name: string; url: string } }) => {
        created.push(data);
        return { id: `new-${created.length}`, ...data };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, created };
}

describe("DEFAULT_EPG_SOURCES", () => {
  it("routes all CIS countries to the single iptvx.one LITE feed", () => {
    const iptvx = DEFAULT_EPG_SOURCES.find((s) => s.url === "https://epg.iptvx.one/EPG_LITE.xml.gz");
    expect(iptvx?.name).toBe("iptvx.one (RU/CIS)");
    for (const cc of ["RU", "UA", "BY", "KZ", "KG", "UZ", "AM", "GE", "AZ", "MD"]) {
      expect(iptvx?.countries).toContain(cc);
    }
  });
  it("has one epgshare01 entry per covered country (UK not GB)", () => {
    const uk = DEFAULT_EPG_SOURCES.find((s) => s.countries.length === 1 && s.countries[0] === "UK");
    expect(uk?.url).toBe("https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz");
    expect(uk?.name).toBe("epgshare01 UK");
    const covered = DEFAULT_EPG_SOURCES.filter((s) => s.countries.length === 1).map((s) => s.countries[0]);
    expect(covered.sort()).toEqual(
      ["US", "UK", "DE", "FR", "ES", "IT", "PT", "BR", "TR", "NL", "RS", "GR", "PL", "SE", "NO", "FI", "DK"].sort(),
    );
  });
});

describe("seedEpgSourcesForCountries", () => {
  it("creates one row per matching default, upserting by url", async () => {
    const { prisma, created } = fakePrisma([]);
    const n = await seedEpgSourcesForCountries(prisma, ["RU", "DE"]);
    expect(n).toBe(2);
    expect(created.map((c) => c.url).sort()).toEqual([
      "https://epg.iptvx.one/EPG_LITE.xml.gz",
      "https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz",
    ].sort());
  });
  it("is idempotent: existing urls are not recreated", async () => {
    const { prisma, created } = fakePrisma(["https://epg.iptvx.one/EPG_LITE.xml.gz"]);
    const n = await seedEpgSourcesForCountries(prisma, ["RU", "UA"]); // both map to the same feed
    expect(n).toBe(0);
    expect(created).toHaveLength(0);
  });
  it("countries without a default create nothing", async () => {
    const { prisma, created } = fakePrisma([]);
    expect(await seedEpgSourcesForCountries(prisma, ["JP"])).toBe(0);
    expect(created).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @orbix/api exec vitest run src/lib/tv-epg.test.ts
```

- [ ] **Step 3: Implement** — `apps/api/src/lib/tv-epg.ts`:

```ts
import type { PrismaClient } from "@orbix/db";

const CIS = ["RU", "UA", "BY", "KZ", "KG", "UZ", "AM", "GE", "AZ", "MD"];
// iptv-org country codes (their countries.json is authoritative — "UK" not "GB").
const EPGSHARE_COUNTRIES = [
  "US", "UK", "DE", "FR", "ES", "IT", "PT", "BR", "TR",
  "NL", "RS", "GR", "PL", "SE", "NO", "FI", "DK",
];

/** Default XMLTV feeds seeded when an iptv-org country is enabled. */
export const DEFAULT_EPG_SOURCES: { countries: string[]; name: string; url: string }[] = [
  { countries: CIS, name: "iptvx.one (RU/CIS)", url: "https://epg.iptvx.one/EPG_LITE.xml.gz" },
  ...EPGSHARE_COUNTRIES.map((cc) => ({
    countries: [cc],
    name: `epgshare01 ${cc}`,
    url: `https://epgshare01.online/epgshare01/epg_ripper_${cc}1.xml.gz`,
  })),
];

/**
 * Upsert-by-url the default EPG sources covering the given country codes.
 * Never deletes or disables anything the admin already configured.
 * Returns the number of rows created.
 */
export async function seedEpgSourcesForCountries(
  prisma: PrismaClient,
  countries: string[],
): Promise<number> {
  const wanted = DEFAULT_EPG_SOURCES.filter((s) => s.countries.some((c) => countries.includes(c)));
  let created = 0;
  for (const s of wanted) {
    const existing = await prisma.tvEpgSource.findFirst({ where: { url: s.url } });
    if (existing) continue;
    await prisma.tvEpgSource.create({ data: { name: s.name, url: s.url } });
    created++;
  }
  return created;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @orbix/api exec vitest run src/lib/tv-epg.test.ts
```

- [ ] **Step 5: Hook into `tv-sources`.** Read `apps/api/src/routes/tv-sources.ts` as it exists. In the **POST `/tv/sources`** handler (when creating a source with `kind === "iptv-org"` and non-empty `countries`) and the **PATCH `/tv/sources/:id`** handler (when the update payload includes `countries` for an iptv-org source), add — after the DB write, before the reply:

```ts
import { seedEpgSourcesForCountries } from "../lib/tv-epg";
// …inside the handler, after the tvSource create/update succeeds:
if (countries && countries.length > 0) {
  await seedEpgSourcesForCountries(app.prisma, countries);
}
```

Keep the response shape exactly as phase 1 defined it.

- [ ] **Step 6: Extend the route test.** Read `apps/api/src/routes/tv-sources.test.ts` and mirror its existing admin mocks (session/account/profile monkey-patches — `requireAdmin` reads `prisma.account.findUnique(...).isAdmin`). Append a test:

```ts
it("seeds default EPG sources when iptv-org countries change", async () => {
  const app = await buildApp(env);
  (app as any).prisma.session = { findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }) };
  (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }) };
  (app as any).prisma.profile = { findUnique: async () => null };
  // Adapt the tvSource mock to the handler's actual calls (read the handler!)
  (app as any).prisma.tvSource = {
    findUnique: async () => ({ id: "src1", kind: "iptv-org", countries: [] }),
    update: async (args: unknown) => ({ id: "src1", kind: "iptv-org", countries: ["RU", "DE"], ...(args as { data: object }).data }),
  };
  const epgCreates: { url: string }[] = [];
  (app as any).prisma.tvEpgSource = {
    findFirst: async () => null,
    create: async ({ data }: { data: { url: string } }) => { epgCreates.push(data); return { id: "e1", ...data }; },
  };
  const res = await app.inject({
    method: "PATCH", url: "/api/tv/sources/src1",
    cookies: { orbix_session: "s1" },
    payload: { countries: ["RU", "DE"] },
  });
  expect(res.statusCode).toBeLessThan(300);
  expect(epgCreates.map((c) => c.url).sort()).toEqual([
    "https://epg.iptvx.one/EPG_LITE.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz",
  ].sort());
  await app.close();
});
```

Adjust the `tvSource` mock methods/payload field names to whatever the phase-1 handler actually calls — the assertion that matters is `epgCreates`.

- [ ] **Step 7: Run api tests, scoped gates, commit**

```bash
pnpm --filter @orbix/api exec vitest run src/lib/tv-epg.test.ts src/routes/tv-sources.test.ts
pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck
git add apps/api/src/lib/tv-epg.ts apps/api/src/lib/tv-epg.test.ts apps/api/src/routes/tv-sources.ts apps/api/src/routes/tv-sources.test.ts
git commit -m "$(cat <<'EOF'
feat(tv): auto-seed default XMLTV EPG sources per enabled country

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: API — `tv-epg` ingest job (gunzip pipeline, batch upserts, name-match fan-out)

**Files:**
- Create: `apps/api/src/jobs/tv-epg.ts`
- Create: `apps/api/src/jobs/tv-epg.test.ts`
- Modify: `apps/api/src/plugins/tv-queue.ts` (add `TvEpgJobData`, `"tv-epg"` case; widen the queue's job-data generic)

**Interfaces:**
- Consumes: `createXmltvCollector`, `matchEpgChannels`, `normalizeChannelName` from `@orbix/core`; `makeTvUpstream` from `../lib/tv-upstream` (queue wiring only — the job runner takes `fetchUpstream` injected); `tvEvents`/`tvDoneCache` from the plugin.
- Produces:
  ```ts
  // apps/api/src/jobs/tv-epg.ts
  export interface TvEpgDeps {
    fetchUpstream: (url: string, opts: { userAgent?: string; referrer?: string; wantText: boolean; timeoutMs?: number }) =>
      Promise<{ finalUrl: string; status: number; headers: Record<string, string>; body: unknown; text?: string }>;
    now?: () => Date;
    onProgress?: (p: { source: string; processed: number }) => void;
  }
  export interface TvEpgResult { sources: number; programmesUpserted: number; channelsMatchedByName: number; pruned: number; errors: string[]; }
  export async function runTvEpgSync(prisma: PrismaClient, deps: TvEpgDeps): Promise<TvEpgResult>;
  // apps/api/src/plugins/tv-queue.ts
  export interface TvEpgJobData { jobId: string }
  export interface TvHealthJobData { jobId: string }   // used by Task 6; declare both now
  ```
- Semantics (fixed): window now−6h .. now+48h; one download per enabled `TvEpgSource`; gunzip via `node:zlib` `createGunzip` when the URL path ends `.gz`; single parse pass with `wantedIds` = all `TvChannel.epgId` values, `onChannel` collecting names; batches of 500 via `prisma.$transaction` of upserts on `(channelId, start)`; epgId→channelId via a prebuilt map including `matchEpgChannels` output for channels whose epgId found no direct rows; prune `TvProgramme.stop < now−6h` after all sources; per-source `status`/`statusMessage`/`lastSyncAt`; progress events `{phase:"epg", source, processed}`; done event in `tvDoneCache`.

- [ ] **Step 1: Write the failing test** — `apps/api/src/jobs/tv-epg.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import type { PrismaClient } from "@orbix/db";
import { runTvEpgSync, type TvEpgDeps } from "./tv-epg";

const NOW = new Date("2026-07-03T16:00:00.000Z");

// One direct-epgId channel, one name-match-only channel, one untracked feed id.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="ChannelOne.ru"><display-name>Первый канал</display-name></channel>
  <channel id="zdf.de"><display-name>ZDF</display-name></channel>
  <channel id="noise.tv"><display-name>Noise</display-name></channel>
  <programme start="20260703190000 +0300" stop="20260703210000 +0300" channel="ChannelOne.ru">
    <title lang="ru">Время</title>
  </programme>
  <programme start="20260703180000 +0200" stop="20260703190000 +0200" channel="zdf.de">
    <title lang="de">heute journal</title>
  </programme>
  <programme start="20260701000000 +0000" stop="20260701010000 +0000" channel="ChannelOne.ru">
    <title>Stale — outside window</title>
  </programme>
  <programme start="20260703180000 +0000" stop="20260703190000 +0000" channel="noise.tv">
    <title>Untracked</title>
  </programme>
</tv>`;

interface UpsertCall { where: { channelId_start: { channelId: string; start: Date } }; create: { title: string; channelId: string } }

function fakePrisma(opts?: { sources?: object[] }) {
  const upserts: UpsertCall[] = [];
  const sourceUpdates: { id: string; data: Record<string, unknown> }[] = [];
  let deleteWhere: unknown = null;
  const prisma = {
    tvChannel: {
      findMany: async () => [
        { id: "ch-one", epgId: "ChannelOne.ru", name: "Первый канал", altNames: [] },
        { id: "ch-zdf", epgId: null, name: "ZDF HD", altNames: [] }, // name-match only
        { id: "ch-none", epgId: "absent.id", name: "Nothing Ever Matches", altNames: [] },
      ],
    },
    tvEpgSource: {
      findMany: async () => opts?.sources ?? [
        { id: "es1", name: "test feed", url: "https://example.test/epg.xml.gz", enabled: true, offsetMin: 0 },
      ],
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        sourceUpdates.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
    tvProgramme: {
      upsert: (args: UpsertCall) => { upserts.push(args); return Promise.resolve({}); },
      deleteMany: async ({ where }: { where: unknown }) => { deleteWhere = where; return { count: 3 }; },
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return { prisma: prisma as unknown as PrismaClient, upserts, sourceUpdates, getDeleteWhere: () => deleteWhere };
}

function gzBody(xml: string): Readable {
  const gz = gzipSync(Buffer.from(xml, "utf8"));
  // two chunks to prove streaming decompression works
  return Readable.from([gz.subarray(0, Math.floor(gz.length / 2)), gz.subarray(Math.floor(gz.length / 2))]);
}

describe("runTvEpgSync", () => {
  it("gunzips, windows, maps direct epgIds AND name-matched channels in one pass", async () => {
    const { prisma, upserts, sourceUpdates } = fakePrisma();
    const deps: TvEpgDeps = {
      fetchUpstream: async (url) => ({ finalUrl: url, status: 200, headers: {}, body: gzBody(XML) }),
      now: () => NOW,
    };
    const result = await runTvEpgSync(prisma, deps);

    // direct: Время @16:00Z–18:00Z for ch-one; name-match: heute journal for ch-zdf
    const byChannel = new Map(upserts.map((u) => [u.create.channelId, u]));
    expect(byChannel.get("ch-one")?.create.title).toBe("Время");
    expect(byChannel.get("ch-zdf")?.create.title).toBe("heute journal");
    // stale + untracked rows dropped
    expect(upserts).toHaveLength(2);
    expect(result.programmesUpserted).toBe(2);
    expect(result.channelsMatchedByName).toBe(1);
    expect(result.errors).toHaveLength(0);
    // source lifecycle: syncing → ok with lastSyncAt
    expect(sourceUpdates[0].data.status).toBe("syncing");
    const last = sourceUpdates.at(-1)!.data;
    expect(last.status).toBe("ok");
    expect(last.lastSyncAt).toBeInstanceOf(Date);
  });

  it("applies the source offsetMin to stored rows", async () => {
    const { prisma, upserts } = fakePrisma({
      sources: [{ id: "es1", name: "shifted", url: "https://example.test/epg.xml.gz", enabled: true, offsetMin: 60 }],
    });
    await runTvEpgSync(prisma, {
      fetchUpstream: async (url) => ({ finalUrl: url, status: 200, headers: {}, body: gzBody(XML) }),
      now: () => NOW,
    });
    const one = upserts.find((u) => u.create.channelId === "ch-one")!;
    expect(one.where.channelId_start.start.toISOString()).toBe("2026-07-03T17:00:00.000Z"); // 16:00Z + 60min
  });

  it("handles plain .xml (no gunzip) and multibyte chunk boundaries", async () => {
    const { prisma, upserts } = fakePrisma({
      sources: [{ id: "es1", name: "plain", url: "https://example.test/epg.xml", enabled: true, offsetMin: 0 }],
    });
    const buf = Buffer.from(XML, "utf8");
    const cut = buf.indexOf(Buffer.from("Время", "utf8")) + 3; // mid-Cyrillic-codepoint
    await runTvEpgSync(prisma, {
      fetchUpstream: async (url) => ({ finalUrl: url, status: 200, headers: {}, body: Readable.from([buf.subarray(0, cut), buf.subarray(cut)]) }),
      now: () => NOW,
    });
    expect(upserts.find((u) => u.create.channelId === "ch-one")?.create.title).toBe("Время");
  });

  it("marks a failing source error and continues; prunes after all sources", async () => {
    const { prisma, upserts, sourceUpdates, getDeleteWhere } = fakePrisma({
      sources: [
        { id: "bad", name: "bad", url: "https://example.test/dead.xml.gz", enabled: true, offsetMin: 0 },
        { id: "good", name: "good", url: "https://example.test/epg.xml.gz", enabled: true, offsetMin: 0 },
      ],
    });
    const result = await runTvEpgSync(prisma, {
      fetchUpstream: async (url) => {
        if (url.includes("dead")) throw new Error("connect timeout");
        return { finalUrl: url, status: 200, headers: {}, body: gzBody(XML) };
      },
      now: () => NOW,
    });
    expect(result.errors).toHaveLength(1);
    const bad = sourceUpdates.filter((u) => u.id === "bad").at(-1)!.data;
    expect(bad.status).toBe("error");
    expect(String(bad.statusMessage)).toContain("connect timeout");
    expect(upserts.length).toBe(2); // good source still ingested
    expect(result.pruned).toBe(3);
    // prune boundary = now − 6h
    expect(JSON.stringify(getDeleteWhere())).toContain("2026-07-03T10:00:00.000Z");
  });

  it("reports progress with the source name", async () => {
    const { prisma } = fakePrisma();
    const events: { source: string; processed: number }[] = [];
    await runTvEpgSync(prisma, {
      fetchUpstream: async (url) => ({ finalUrl: url, status: 200, headers: {}, body: gzBody(XML) }),
      now: () => NOW,
      onProgress: (p) => events.push(p),
    });
    expect(events.at(-1)).toEqual({ source: "test feed", processed: 2 });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @orbix/api exec vitest run src/jobs/tv-epg.test.ts
```

- [ ] **Step 3: Implement the job runner** — `apps/api/src/jobs/tv-epg.ts`:

```ts
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import type { PrismaClient } from "@orbix/db";
import {
  createXmltvCollector,
  matchEpgChannels,
  normalizeChannelName,
  type XmltvChannelName,
  type XmltvProgramme,
} from "@orbix/core";

export const EPG_WINDOW_BACK_MS = 6 * 60 * 60 * 1000; // now − 6 h
export const EPG_WINDOW_FWD_MS = 48 * 60 * 60 * 1000; // now + 48 h
const BATCH = 500;

export interface TvEpgDeps {
  fetchUpstream: (
    url: string,
    opts: { userAgent?: string; referrer?: string; wantText: boolean; timeoutMs?: number },
  ) => Promise<{ finalUrl: string; status: number; headers: Record<string, string>; body: unknown; text?: string }>;
  now?: () => Date;
  onProgress?: (p: { source: string; processed: number }) => void;
}

export interface TvEpgResult {
  sources: number;
  programmesUpserted: number;
  channelsMatchedByName: number;
  pruned: number;
  errors: string[];
}

function isGzUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith(".gz");
  } catch {
    return url.endsWith(".gz");
  }
}

function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as { getReader?: unknown }).getReader === "function") {
    return Readable.fromWeb(body as never);
  }
  throw new Error("unsupported upstream body type");
}

type Row = { channelId: string; p: XmltvProgramme };

async function upsertBatch(prisma: PrismaClient, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  await prisma.$transaction(
    rows.map(({ channelId, p }) =>
      prisma.tvProgramme.upsert({
        where: { channelId_start: { channelId, start: p.start } },
        update: { stop: p.stop, title: p.title, description: p.description, category: p.category, lang: p.lang },
        create: {
          channelId,
          start: p.start,
          stop: p.stop,
          title: p.title,
          description: p.description,
          category: p.category,
          lang: p.lang,
        },
      }),
    ),
  );
  return rows.length;
}

/**
 * Ingest every enabled TvEpgSource: stream the XMLTV download through gunzip
 * (when .gz) into the pure core collector, in ONE pass per source:
 *   - programmes for direct epgIds are flushed in batches of 500 as they stream;
 *   - channel display-names are collected, and any xmltv id whose name collides
 *     with one of our channel names is admitted into the live wantedIds set
 *     (XMLTV orders <channel> before <programme>, so nothing is missed);
 *   - after parsing, matchEpgChannels decides the unique name-based mapping and
 *     the buffered candidate rows are flushed through it.
 * Serving stays Postgres-only; this job is the only XML touchpoint.
 */
export async function runTvEpgSync(prisma: PrismaClient, deps: TvEpgDeps): Promise<TvEpgResult> {
  const now = deps.now ? deps.now() : new Date();
  const windowStart = new Date(now.getTime() - EPG_WINDOW_BACK_MS);
  const windowEnd = new Date(now.getTime() + EPG_WINDOW_FWD_MS);
  const result: TvEpgResult = { sources: 0, programmesUpserted: 0, channelsMatchedByName: 0, pruned: 0, errors: [] };

  const channels = await prisma.tvChannel.findMany({
    select: { id: true, epgId: true, name: true, altNames: true },
  });
  if (channels.length === 0) return result;

  // Direct epgId → channelId[] (several channels/sources can share an epgId).
  const direct = new Map<string, string[]>();
  for (const ch of channels) {
    if (!ch.epgId) continue;
    const list = direct.get(ch.epgId) ?? [];
    list.push(ch.id);
    direct.set(ch.epgId, list);
  }
  // Normalized DB names — used to admit candidate xmltv ids during the stream.
  const dbNames = new Set<string>();
  for (const ch of channels) {
    for (const n of [ch.name, ...ch.altNames]) {
      const key = normalizeChannelName(n);
      if (key) dbNames.add(key);
    }
  }
  const chById = new Map(channels.map((c) => [c.id, c]));

  const sources = await prisma.tvEpgSource.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } });

  for (const source of sources) {
    result.sources++;
    await prisma.tvEpgSource.update({
      where: { id: source.id },
      data: { status: "syncing", statusMessage: null },
    });
    try {
      const res = await deps.fetchUpstream(source.url, { wantText: false, timeoutMs: 30_000 });
      if (res.status !== 200) throw new Error(`upstream responded ${res.status}`);

      const wanted = new Set(direct.keys()); // LIVE set — candidates admitted below
      const xmltvChannels: XmltvChannelName[] = [];
      const directRows: Row[] = [];
      const candidateRows: XmltvProgramme[] = []; // ids admitted by name collision
      let processed = 0;

      const collector = createXmltvCollector({
        wantedIds: wanted,
        offsetMin: source.offsetMin,
        windowStart,
        windowEnd,
        onChannel: (c) => {
          xmltvChannels.push(c);
          // Admit colliding ids so their rows are captured in THIS pass; the
          // final unique mapping is decided by matchEpgChannels afterwards.
          if (!wanted.has(c.id) && c.names.some((n) => dbNames.has(normalizeChannelName(n)))) {
            wanted.add(c.id);
          }
        },
        onProgramme: (p) => {
          const chIds = direct.get(p.epgId);
          if (chIds) {
            for (const channelId of chIds) directRows.push({ channelId, p });
          } else {
            candidateRows.push(p); // resolved after the full channel list is known
          }
        },
      });

      const raw = toNodeReadable(res.body);
      const stream = isGzUrl(source.url) || isGzUrl(res.finalUrl) ? raw.pipe(createGunzip()) : raw;
      const decoder = new TextDecoder("utf-8"); // stream:true → multibyte-safe across chunks
      for await (const chunk of stream) {
        collector.write(decoder.decode(chunk as Buffer, { stream: true }));
        while (directRows.length >= BATCH) {
          processed += await upsertBatch(prisma, directRows.splice(0, BATCH));
          deps.onProgress?.({ source: source.name, processed });
        }
      }
      const tail = decoder.decode();
      if (tail) collector.write(tail);
      collector.end();
      processed += await upsertBatch(prisma, directRows.splice(0));

      // Name-based mapping for channels whose epgId found no direct rows.
      // NOTE (v1): an xmltv id that is ALSO some channel's direct epgId only
      // feeds that channel this run — its rows were flushed live, not buffered.
      const byXmltvId = new Map<string, string[]>();
      for (const [chId, xid] of matchEpgChannels(channels, xmltvChannels)) {
        if (chById.get(chId)?.epgId === xid) continue; // pass-1 → already direct
        result.channelsMatchedByName++;
        const list = byXmltvId.get(xid) ?? [];
        list.push(chId);
        byXmltvId.set(xid, list);
      }
      const matchedRows: Row[] = [];
      for (const p of candidateRows) {
        for (const channelId of byXmltvId.get(p.epgId) ?? []) matchedRows.push({ channelId, p });
      }
      while (matchedRows.length > 0) {
        processed += await upsertBatch(prisma, matchedRows.splice(0, BATCH));
      }
      result.programmesUpserted += processed;
      deps.onProgress?.({ source: source.name, processed });

      await prisma.tvEpgSource.update({
        where: { id: source.id },
        data: { status: "ok", statusMessage: null, lastSyncAt: now },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${source.name}: ${message}`);
      await prisma.tvEpgSource.update({
        where: { id: source.id },
        data: { status: "error", statusMessage: message.slice(0, 500) },
      });
    }
  }

  const pruned = await prisma.tvProgramme.deleteMany({ where: { stop: { lt: windowStart } } });
  result.pruned = pruned.count;
  return result;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @orbix/api exec vitest run src/jobs/tv-epg.test.ts
```

- [ ] **Step 5: Wire into the tv queue.** Read `apps/api/src/plugins/tv-queue.ts` first — mirror the exact progress/done payload envelope the existing `"tv-sync"` case uses. Then:

1. Export the job-data types and widen the queue generic:

```ts
export interface TvEpgJobData { jobId: string }
export interface TvHealthJobData { jobId: string }
export type TvJobData = TvSyncJobData | TvEpgJobData | TvHealthJobData;
// new Queue<TvJobData>("tv", …) / new Worker<TvJobData>("tv", …) — adjust the
// existing generics; the NODE_ENV === "test" stub cast widens the same way.
```

2. Add the case to the worker's job-name dispatch. NOTE: phase 1 shipped the processor as an `if (job.name !== "tv-sync") return;` guard with the try/catch inside — refactor that guard into a `switch (job.name)` (moving the existing tv-sync body into `case "tv-sync"`) before adding:

```ts
case "tv-epg": {
  const { jobId } = job.data as TvEpgJobData;
  const { fetchUpstream } = makeTvUpstream();
  try {
    const r = await runTvEpgSync(app.prisma, {
      fetchUpstream,
      onProgress: (p) =>
        tvEvents.emit(jobId, { phase: "epg", source: p.source, processed: p.processed }),
    });
    // Terminal event MUST use phase:"done" — the /tv/sync/events SSE route
    // (phase 1) listens on the jobId channel and closes on phase done|error.
    const done = {
      phase: "done", kind: "epg",
      sources: r.sources, programmesUpserted: r.programmesUpserted,
      channelsMatchedByName: r.channelsMatchedByName, pruned: r.pruned, errors: r.errors,
    };
    tvDoneCache.set(jobId, done);
    const t = setTimeout(() => tvDoneCache.delete(jobId), 5 * 60 * 1000); t.unref?.();
    tvEvents.emit(jobId, done);
  } catch (err) {
    const evt = { phase: "error", kind: "epg", message: err instanceof Error ? err.message : String(err) };
    tvDoneCache.set(jobId, evt);
    const t = setTimeout(() => tvDoneCache.delete(jobId), 5 * 60 * 1000); t.unref?.();
    tvEvents.emit(jobId, evt);
  }
  break;
}
```

(If the existing tv-sync case wraps its body differently — e.g. shared try/catch or an `emitDone` helper — reuse that shape verbatim instead.)

- [ ] **Step 6: Full api gates + commit**

```bash
pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api test
git add apps/api/src/jobs/tv-epg.ts apps/api/src/jobs/tv-epg.test.ts apps/api/src/plugins/tv-queue.ts
git commit -m "$(cat <<'EOF'
feat(tv): tv-epg ingest job — streaming gunzip, one-pass collect + name-match fan-out

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: API — now/next in `/tv/home`, `/tv/guide`, `/tv/channels/:id/play` + day schedule endpoint

**Files:**
- Create: `apps/api/src/lib/tv-now-next.ts`
- Create: `apps/api/src/lib/tv-now-next.test.ts`
- Modify: `apps/api/src/routes/tv-catalog.ts` (decorate home/guide; implement `?day=` on programmes)
- Modify: `apps/api/src/routes/tv-play.ts` (fill `nowNext`)
- Modify: `apps/api/src/routes/tv-catalog.test.ts`, `apps/api/src/routes/tv-play.test.ts` (append tests)

**Interfaces:**
- Produces:
  ```ts
  export interface TvNowNextSlot { title: string; start: string; stop: string } // ISO strings
  export interface TvNowNext { now: TvNowNextSlot | null; next: TvNowNextSlot | null }
  export async function loadNowNext(prisma: PrismaClient, channelIds: string[], at?: Date): Promise<Map<string, TvNowNext>>;
  ```
- Response contracts (fixed): `/tv/home` and `/tv/guide` channel entries gain `now: {title,start,stop} | null` and `next: {title,start,stop} | null`; `/tv/channels/:id/play` fills `nowNext: { now, next }`; `GET /tv/channels/:id/programmes?day=YYYY-MM-DD` returns `{ programmes: [{ id, start, stop, title, description, category }] }` for that (UTC) day, `start` asc, 400 on malformed `day`, defaults to the current UTC day when omitted.
- **N+1 ban:** exactly ONE `tvProgramme.findMany` per home/guide/play request, over all channel ids at once.

- [ ] **Step 1: Write the failing lib test** — `apps/api/src/lib/tv-now-next.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@orbix/db";
import { loadNowNext } from "./tv-now-next";

const AT = new Date("2026-07-03T16:00:00.000Z");

function fakePrisma(rows: { channelId: string; title: string; start: Date; stop: Date }[]) {
  const calls: unknown[] = [];
  const prisma = {
    tvProgramme: {
      findMany: async (args: unknown) => {
        calls.push(args);
        return rows;
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

describe("loadNowNext", () => {
  it("resolves now (start<=at<stop) and next (first start>at) per channel in ONE query", async () => {
    const { prisma, calls } = fakePrisma([
      { channelId: "a", title: "News", start: new Date("2026-07-03T15:30:00Z"), stop: new Date("2026-07-03T16:30:00Z") },
      { channelId: "a", title: "Film", start: new Date("2026-07-03T16:30:00Z"), stop: new Date("2026-07-03T18:00:00Z") },
      { channelId: "b", title: "Later", start: new Date("2026-07-03T17:00:00Z"), stop: new Date("2026-07-03T18:00:00Z") },
    ]);
    const map = await loadNowNext(prisma, ["a", "b", "c"], AT);
    expect(calls).toHaveLength(1); // grouped query — never per-channel
    expect(map.get("a")).toEqual({
      now: { title: "News", start: "2026-07-03T15:30:00.000Z", stop: "2026-07-03T16:30:00.000Z" },
      next: { title: "Film", start: "2026-07-03T16:30:00.000Z", stop: "2026-07-03T18:00:00.000Z" },
    });
    // gap: nothing on now, next still found
    expect(map.get("b")).toEqual({
      now: null,
      next: { title: "Later", start: "2026-07-03T17:00:00.000Z", stop: "2026-07-03T18:00:00.000Z" },
    });
    expect(map.get("c")).toBeUndefined(); // absent = caller renders {now:null,next:null}
  });

  it("short-circuits on empty ids without querying", async () => {
    const { prisma, calls } = fakePrisma([]);
    const map = await loadNowNext(prisma, [], AT);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @orbix/api exec vitest run src/lib/tv-now-next.test.ts
```

- [ ] **Step 3: Implement** — `apps/api/src/lib/tv-now-next.ts`:

```ts
import type { PrismaClient } from "@orbix/db";

export interface TvNowNextSlot {
  title: string;
  start: string; // ISO — serialization-ready
  stop: string;
}
export interface TvNowNext {
  now: TvNowNextSlot | null;
  next: TvNowNextSlot | null;
}

const LOOKAHEAD_MS = 12 * 60 * 60 * 1000;

/**
 * Now/next for a batch of channels in ONE grouped query (the guide/home N+1
 * ban lives here). Channels with no rows are simply absent from the map.
 */
export async function loadNowNext(
  prisma: PrismaClient,
  channelIds: string[],
  at: Date = new Date(),
): Promise<Map<string, TvNowNext>> {
  const map = new Map<string, TvNowNext>();
  if (channelIds.length === 0) return map;
  const rows = await prisma.tvProgramme.findMany({
    where: {
      channelId: { in: channelIds },
      stop: { gt: at },
      start: { lt: new Date(at.getTime() + LOOKAHEAD_MS) },
    },
    orderBy: { start: "asc" },
    select: { channelId: true, title: true, start: true, stop: true },
  });
  for (const r of rows) {
    const entry = map.get(r.channelId) ?? { now: null, next: null };
    const slot: TvNowNextSlot = { title: r.title, start: r.start.toISOString(), stop: r.stop.toISOString() };
    if (r.start <= at && r.stop > at) {
      if (!entry.now) entry.now = slot;
    } else if (r.start > at && !entry.next) {
      entry.next = slot;
    }
    map.set(r.channelId, entry);
  }
  return map;
}
```

- [ ] **Step 4: Run — expect PASS**, then decorate the routes. Read `apps/api/src/routes/tv-catalog.ts` and `tv-play.ts` as they exist; apply at the final serialization point of each handler:

**`/tv/guide`** (after the windowed channel page is selected):

```ts
import { loadNowNext } from "../lib/tv-now-next";
// …
const nowNext = await loadNowNext(app.prisma, channels.map((c) => c.id));
const decorated = channels.map((c) => ({ ...c, ...(nowNext.get(c.id) ?? { now: null, next: null }) }));
return { total, channels: decorated };
```

**`/tv/home`** (ONE call across every rail — collect ids first):

```ts
const ids = new Set<string>();
for (const card of [
  ...payload.recents,
  ...payload.favorites,
  ...payload.countries.flatMap((r) => r.channels),
  ...payload.categories.flatMap((r) => r.channels),
]) ids.add(card.id);
const nowNext = await loadNowNext(app.prisma, [...ids]);
const dec = <T extends { id: string }>(c: T) => ({ ...c, ...(nowNext.get(c.id) ?? { now: null, next: null }) });
// map dec() over every rail before replying
```

(Adapt the rail property names to the actual phase-1 payload shape `{recents, favorites, countries, categories}` — the invariant is: ids collected across ALL rails, ONE `loadNowNext` call, every card decorated.)

**`/tv/channels/:id/play`** in `tv-play.ts` — replace the `nowNext: null` placeholder:

```ts
const nowNext = (await loadNowNext(app.prisma, [channel.id])).get(channel.id) ?? { now: null, next: null };
// … include `nowNext` in the existing response object
```

**`/tv/channels/:id/programmes`** in `tv-catalog.ts` — replace the `{programmes: []}` stub body (keep the route path, guards, and 404-on-unknown-channel behavior phase 1 established):

```ts
const { day } = req.query as { day?: string };
let dayStart: Date;
if (day !== undefined) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return reply.code(400).send({ error: "invalid_day" });
  dayStart = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(dayStart.getTime())) return reply.code(400).send({ error: "invalid_day" });
} else {
  const t = new Date();
  dayStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}
const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
const rows = await app.prisma.tvProgramme.findMany({
  where: { channelId: id, stop: { gt: dayStart }, start: { lt: dayEnd } }, // overlap semantics
  orderBy: { start: "asc" },
  select: { id: true, start: true, stop: true, title: true, description: true, category: true },
});
return {
  programmes: rows.map((r) => ({ ...r, start: r.start.toISOString(), stop: r.stop.toISOString() })),
};
```

- [ ] **Step 5: Append route tests.** In `apps/api/src/routes/tv-catalog.test.ts` (reuse the file's existing auth/profile mocks and its tvChannel mocks — adapt names to what phase 1 wrote):

```ts
describe("now/next decoration", () => {
  // Standard (non-kids) member session — requireTvAccess passes. If the file
  // already has an equivalent helper from phase 1, reuse that one instead.
  async function memberApp() {
    const app = await buildApp(env);
    (app as any).prisma.session = { findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }) };
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }) };
    (app as any).prisma.profile = { findUnique: async () => null };
    return app;
  }

  it("GET /api/tv/guide attaches now/next with exactly ONE tvProgramme query", async () => {
    const app = await memberApp();
    (app as any).prisma.tvChannel = {
      count: async () => 2,
      findMany: async () => [
        { id: "a", number: 1, name: "One", country: "RU", logoPath: null, quality: null, hidden: false },
        { id: "b", number: 2, name: "Two", country: "DE", logoPath: null, quality: null, hidden: false },
      ],
    };
    const programmeCalls: unknown[] = [];
    (app as any).prisma.tvProgramme = {
      findMany: async (args: unknown) => {
        programmeCalls.push(args);
        return [
          { channelId: "a", title: "News", start: new Date(Date.now() - 600_000), stop: new Date(Date.now() + 600_000) },
        ];
      },
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/guide", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(programmeCalls).toHaveLength(1); // N+1 ban
    const body = res.json() as { channels: { id: string; now: { title: string } | null; next: unknown }[] };
    expect(body.channels.find((c) => c.id === "a")?.now?.title).toBe("News");
    expect(body.channels.find((c) => c.id === "b")?.now).toBeNull();
    await app.close();
  });

  it("GET /api/tv/home attaches now/next with exactly ONE tvProgramme query across all rails", async () => {
    const app = await memberApp();
    const card = { id: "a", number: 1, name: "One", country: "RU", logoPath: null, quality: null, hidden: false };
    // Adapt these model mocks to the calls the phase-1 /tv/home handler
    // actually makes (read it first) — the assertions below are the contract.
    (app as any).prisma.tvChannel = { findMany: async () => [card], count: async () => 1 };
    (app as any).prisma.tvFavorite = { findMany: async () => [] };
    (app as any).prisma.tvPlayEvent = { findMany: async () => [] };
    const programmeCalls: unknown[] = [];
    (app as any).prisma.tvProgramme = {
      findMany: async (args: unknown) => {
        programmeCalls.push(args);
        return [
          { channelId: "a", title: "News", start: new Date(Date.now() - 600_000), stop: new Date(Date.now() + 600_000) },
        ];
      },
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/home", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(programmeCalls).toHaveLength(1); // ONE grouped query across every rail
    const rails = res.json() as { countries: { channels: { id: string; now: { title: string } | null }[] }[] };
    const decorated = rails.countries.flatMap((r) => r.channels).find((c) => c.id === "a");
    expect(decorated?.now?.title).toBe("News");
    await app.close();
  });

  it("GET /api/tv/channels/:id/programmes?day= returns the UTC day, 400 on malformed day", async () => {
    const app = await memberApp();
    (app as any).prisma.tvChannel = { findUnique: async () => ({ id: "a" }) };
    let captured: any = null;
    (app as any).prisma.tvProgramme = {
      findMany: async (args: any) => {
        captured = args;
        return [{ id: "p1", start: new Date("2026-07-03T16:00:00Z"), stop: new Date("2026-07-03T17:00:00Z"), title: "Время", description: null, category: "Новости" }];
      },
    };
    const bad = await app.inject({ method: "GET", url: "/api/tv/channels/a/programmes?day=03-07-2026", cookies: { orbix_session: "s1" } });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: "GET", url: "/api/tv/channels/a/programmes?day=2026-07-03", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(captured.where.stop.gt.toISOString()).toBe("2026-07-03T00:00:00.000Z");
    expect(captured.where.start.lt.toISOString()).toBe("2026-07-04T00:00:00.000Z");
    expect(res.json().programmes[0].title).toBe("Время");
    await app.close();
  });
});
```

And in `tv-play.test.ts`, append (copy the mocks of the file's existing happy-path play test — session/profile/tvChannel/tvStream — and add the programme mock; only the two `nowNext` assertions and the single-query check are new):

```ts
it("GET /api/tv/channels/:id/play fills nowNext from one grouped query", async () => {
  // …clone the existing happy-path test's session/profile/tvChannel/tvStream mocks…
  const programmeCalls: unknown[] = [];
  (app as any).prisma.tvProgramme = {
    findMany: async (args: unknown) => {
      programmeCalls.push(args);
      return [
        { channelId: "ch1", title: "Время", start: new Date(Date.now() - 600_000), stop: new Date(Date.now() + 600_000) },
        { channelId: "ch1", title: "Кино", start: new Date(Date.now() + 600_000), stop: new Date(Date.now() + 4_200_000) },
      ];
    },
  };
  const res = await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies: { orbix_session: "s1" } });
  expect(res.statusCode).toBe(200);
  expect(programmeCalls).toHaveLength(1);
  expect(res.json().nowNext.now.title).toBe("Время");
  expect(res.json().nowNext.next.title).toBe("Кино");
  await app.close();
});
```

- [ ] **Step 6: Run, gates, commit**

```bash
pnpm --filter @orbix/api exec vitest run src/lib/tv-now-next.test.ts src/routes/tv-catalog.test.ts src/routes/tv-play.test.ts
pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api test
git add apps/api/src/lib/tv-now-next.ts apps/api/src/lib/tv-now-next.test.ts apps/api/src/routes/tv-catalog.ts apps/api/src/routes/tv-catalog.test.ts apps/api/src/routes/tv-play.ts apps/api/src/routes/tv-play.test.ts
git commit -m "$(cat <<'EOF'
feat(tv): now/next on home, guide, play (single grouped query) + day schedule endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: API — nightly `tv-health` probe job + `app.ts` schedulers

**Files:**
- Create: `apps/api/src/jobs/tv-health.ts`
- Create: `apps/api/src/jobs/tv-health.test.ts`
- Modify: `apps/api/src/plugins/tv-queue.ts` (add `"tv-health"` case)
- Modify: `apps/api/src/app.ts` (12 h tv-epg / 24 h+offset tv-health enqueue timers)

**Interfaces:**
- Produces:
  ```ts
  export interface TvHealthDeps {
    fetchUpstream: TvEpgDeps["fetchUpstream"]; // same signature as Task 4
    now?: () => Date;
    concurrency?: number; // default 8
  }
  export interface TvHealthResult { checked: number; ok: number; degraded: number; dead: number }
  export async function runTvHealthSweep(prisma: PrismaClient, deps: TvHealthDeps): Promise<TvHealthResult>;
  ```
- Semantics (fixed): candidates = hls streams where `lastCheckAt` null or `< now−24h`, AND (`status != "dead"` OR never checked OR `lastCheckAt < now−7d` — dead retried weekly); cap 500 per run ordered `lastCheckAt asc nulls first`; concurrency 8 (simple promise pool); probe = `fetchUpstream(url, { userAgent, referrer, wantText: true, timeoutMs: 10000 })`, healthy iff status 200 and body text contains `"#EXTM3U"`; healthy → `status:"ok"`, `failCount:0`, `lastOkAt`; unhealthy → `failCount++` with the SAME thresholds as `POST /tv/streams/:id/health` (degraded ≥3, dead ≥8, otherwise status unchanged); `lastCheckAt` always set.

- [ ] **Step 1: Reconcile thresholds first.** Open `apps/api/src/routes/tv-play.ts` `POST /tv/streams/:id/health`. If phase 1 exported a pure transition helper, import and reuse it. If the logic is inline, extract it to `apps/api/src/lib/tv-health-state.ts` and use it from BOTH the route and this job:

```ts
// apps/api/src/lib/tv-health-state.ts (only if phase 1 didn't already export one)
export const TV_DEGRADED_AT = 3;
export const TV_DEAD_AT = 8;

export function nextStreamHealth(
  prev: { status: string; failCount: number },
  ok: boolean,
): { status: string; failCount: number } {
  if (ok) return { status: "ok", failCount: 0 };
  const failCount = prev.failCount + 1;
  const status = failCount >= TV_DEAD_AT ? "dead" : failCount >= TV_DEGRADED_AT ? "degraded" : prev.status;
  return { status, failCount };
}
```

- [ ] **Step 2: Write the failing test** — `apps/api/src/jobs/tv-health.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@orbix/db";
import { runTvHealthSweep } from "./tv-health";

const NOW = new Date("2026-07-03T03:00:00.000Z");

type Stream = { id: string; url: string; userAgent: string | null; referrer: string | null; status: string; failCount: number };

function fakePrisma(streams: Stream[]) {
  let capturedFindArgs: any = null;
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const prisma = {
    tvStream: {
      findMany: async (args: any) => {
        capturedFindArgs = args;
        return streams;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, updates, getFindArgs: () => capturedFindArgs };
}

const s = (over: Partial<Stream>): Stream => ({
  id: "s1", url: "http://up.example/live.m3u8", userAgent: null, referrer: null, status: "unknown", failCount: 0, ...over,
});

describe("runTvHealthSweep", () => {
  it("selects only stale hls streams, capped and ordered nulls-first", async () => {
    const { prisma, getFindArgs } = fakePrisma([]);
    await runTvHealthSweep(prisma, { fetchUpstream: async () => { throw new Error("unused"); }, now: () => NOW });
    const args = getFindArgs();
    expect(args.where.protocol).toBe("hls");
    expect(args.take).toBe(500);
    expect(args.orderBy).toEqual({ lastCheckAt: { sort: "asc", nulls: "first" } });
    // staleness + dead-retry composition
    const [staleness, deadRetry] = args.where.AND;
    expect(staleness.OR[0]).toEqual({ lastCheckAt: null });
    expect(staleness.OR[1].lastCheckAt.lt.toISOString()).toBe("2026-07-02T03:00:00.000Z"); // now−24h
    expect(deadRetry.OR[0]).toEqual({ status: { not: "dead" } });
    expect(deadRetry.OR[2].lastCheckAt.lt.toISOString()).toBe("2026-06-26T03:00:00.000Z"); // now−7d
  });

  it("marks 200+#EXTM3U ok (reset failCount, lastOkAt) and failures via the shared thresholds", async () => {
    const { prisma, updates } = fakePrisma([
      s({ id: "good" }),
      s({ id: "bounce", failCount: 2, status: "unknown" }),   // 3rd failure → degraded
      s({ id: "dying", failCount: 7, status: "degraded" }),   // 8th failure → dead
      s({ id: "early", failCount: 0, status: "ok" }),         // 1st failure → status unchanged
    ]);
    const result = await runTvHealthSweep(prisma, {
      now: () => NOW,
      fetchUpstream: async (url) => {
        if (url.includes("good")) return { finalUrl: url, status: 200, headers: {}, body: null, text: "#EXTM3U\n#EXT-X-VERSION:3" };
        return { finalUrl: url, status: 403, headers: {}, body: null, text: "denied" };
      },
    });
    const byId = new Map(updates.map((u) => [u.id, u.data]));
    expect(byId.get("good")).toMatchObject({ status: "ok", failCount: 0, lastOkAt: NOW, lastCheckAt: NOW });
    expect(byId.get("bounce")).toMatchObject({ status: "degraded", failCount: 3 });
    expect(byId.get("dying")).toMatchObject({ status: "dead", failCount: 8 });
    expect(byId.get("early")).toMatchObject({ status: "ok", failCount: 1 }); // below threshold: unchanged
    expect(result).toEqual({ checked: 4, ok: 1, degraded: 1, dead: 1 });
  });

  it("treats thrown fetches as failures and passes stream headers + 10s timeout", async () => {
    const seen: { url: string; opts: any }[] = [];
    const { prisma, updates } = fakePrisma([s({ id: "hdr", userAgent: "UA/1", referrer: "http://ref" })]);
    await runTvHealthSweep(prisma, {
      now: () => NOW,
      fetchUpstream: async (url, opts) => { seen.push({ url, opts }); throw new Error("boom"); },
    });
    expect(seen[0].opts).toMatchObject({ userAgent: "UA/1", referrer: "http://ref", wantText: true, timeoutMs: 10_000 });
    expect(updates[0].data).toMatchObject({ failCount: 1, lastCheckAt: NOW });
  });

  it("bounds concurrency with a promise pool", async () => {
    const streams = Array.from({ length: 6 }, (_, i) => s({ id: `c${i}` }));
    const { prisma } = fakePrisma(streams);
    let inFlight = 0;
    let maxInFlight = 0;
    await runTvHealthSweep(prisma, {
      now: () => NOW,
      concurrency: 2,
      fetchUpstream: async (url) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { finalUrl: url, status: 200, headers: {}, body: null, text: "#EXTM3U" };
      },
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

```bash
pnpm --filter @orbix/api exec vitest run src/jobs/tv-health.test.ts
```

- [ ] **Step 4: Implement** — `apps/api/src/jobs/tv-health.ts`:

```ts
import type { PrismaClient } from "@orbix/db";
import { nextStreamHealth } from "../lib/tv-health-state"; // or phase 1's helper — see Step 1

export const HEALTH_RECHECK_MS = 24 * 60 * 60 * 1000;
export const HEALTH_DEAD_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
export const HEALTH_BATCH_CAP = 500;
export const HEALTH_CONCURRENCY = 8;

export interface TvHealthDeps {
  fetchUpstream: (
    url: string,
    opts: { userAgent?: string; referrer?: string; wantText: boolean; timeoutMs?: number },
  ) => Promise<{ finalUrl: string; status: number; headers: Record<string, string>; body: unknown; text?: string }>;
  now?: () => Date;
  concurrency?: number;
}

export interface TvHealthResult {
  checked: number;
  ok: number;
  degraded: number;
  dead: number;
}

/**
 * Nightly stream probe: GET the playlist with the stream's own headers and a
 * browser-default UA (the upstream helper's default), verdict = HTTP 200 with
 * "#EXTM3U" in the body. Geo-blocks from the server are honest dead-from-here —
 * exactly what the household experiences, since the server fetches everything.
 */
export async function runTvHealthSweep(prisma: PrismaClient, deps: TvHealthDeps): Promise<TvHealthResult> {
  const now = deps.now ? deps.now() : new Date();
  const stale = new Date(now.getTime() - HEALTH_RECHECK_MS);
  const deadRetry = new Date(now.getTime() - HEALTH_DEAD_RETRY_MS);

  const streams = await prisma.tvStream.findMany({
    where: {
      protocol: "hls", // only hls is playable v1 — probing others is noise
      AND: [
        { OR: [{ lastCheckAt: null }, { lastCheckAt: { lt: stale } }] },
        // dead streams get a weekly retry instead of the daily one
        { OR: [{ status: { not: "dead" } }, { lastCheckAt: null }, { lastCheckAt: { lt: deadRetry } }] },
      ],
    },
    orderBy: { lastCheckAt: { sort: "asc", nulls: "first" } },
    take: HEALTH_BATCH_CAP,
    select: { id: true, url: true, userAgent: true, referrer: true, status: true, failCount: true },
  });

  const result: TvHealthResult = { checked: 0, ok: 0, degraded: 0, dead: 0 };
  const limit = Math.max(1, deps.concurrency ?? HEALTH_CONCURRENCY);
  let cursor = 0;

  async function workerLoop(): Promise<void> {
    while (cursor < streams.length) {
      const stream = streams[cursor++];
      let healthy = false;
      try {
        const res = await deps.fetchUpstream(stream.url, {
          userAgent: stream.userAgent ?? undefined,
          referrer: stream.referrer ?? undefined,
          wantText: true,
          timeoutMs: 10_000,
        });
        healthy = res.status === 200 && (res.text ?? "").includes("#EXTM3U");
      } catch {
        healthy = false;
      }
      result.checked++;
      const nextState = nextStreamHealth(stream, healthy);
      if (healthy) {
        result.ok++;
        await prisma.tvStream.update({
          where: { id: stream.id },
          data: { ...nextState, lastOkAt: now, lastCheckAt: now },
        });
      } else {
        if (nextState.status === "degraded" && stream.status !== "degraded") result.degraded++;
        if (nextState.status === "dead" && stream.status !== "dead") result.dead++;
        await prisma.tvStream.update({
          where: { id: stream.id },
          data: { ...nextState, lastCheckAt: now },
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, streams.length) }, () => workerLoop()));
  return result;
}
```

- [ ] **Step 5: Run — expect PASS.** (If the transition-count expectations in Step 2 disagree with phase 1's actual helper semantics, the ROUTE's semantics win — adjust the test's expected statuses, never fork the thresholds.)

- [ ] **Step 6: Queue case + schedulers.**

`apps/api/src/plugins/tv-queue.ts` — add beside the Task 4 case (same envelope):

```ts
case "tv-health": {
  const { jobId } = job.data as TvHealthJobData;
  const { fetchUpstream } = makeTvUpstream();
  try {
    const r = await runTvHealthSweep(app.prisma, { fetchUpstream });
    // phase:"done" on the jobId channel — see the tv-epg case note (SSE contract).
    const done = { phase: "done", kind: "health", ...r };
    tvDoneCache.set(jobId, done);
    const t = setTimeout(() => tvDoneCache.delete(jobId), 5 * 60 * 1000); t.unref?.();
    tvEvents.emit(jobId, done);
  } catch (err) {
    const evt = { phase: "error", kind: "health", message: err instanceof Error ? err.message : String(err) };
    tvDoneCache.set(jobId, evt);
    const t = setTimeout(() => tvDoneCache.delete(jobId), 5 * 60 * 1000); t.unref?.();
    tvEvents.emit(jobId, evt);
  }
  break;
}
```

`apps/api/src/app.ts` — after the existing metadata-refresh timer block (same idiom: unref'd, try/catch, no-op cleanly):

```ts
// ── Periodic TV jobs: EPG every 12 h; stream health nightly, offset 1 h so the
// two never enqueue on the same tick. Cheap enqueues; the worker no-ops when
// nothing is configured, and we skip entirely while no channels are imported.
const TV_EPG_INTERVAL_MS = 12 * 60 * 60 * 1000;
const TV_HEALTH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TV_HEALTH_OFFSET_MS = 60 * 60 * 1000;

async function enqueueTvJob(name: "tv-epg" | "tv-health"): Promise<void> {
  try {
    const channelCount = await app.prisma.tvChannel.count();
    if (channelCount === 0) return; // TV unconfigured — skip
    await app.tvQueue.add(name, { jobId: crypto.randomUUID() });
  } catch (err) {
    app.log.error({ err }, `Scheduled ${name} enqueue failed`);
  }
}

const tvEpgTimer = setInterval(() => void enqueueTvJob("tv-epg"), TV_EPG_INTERVAL_MS);
tvEpgTimer.unref();
const tvHealthKickoff = setTimeout(() => {
  void enqueueTvJob("tv-health");
  const tvHealthTimer = setInterval(() => void enqueueTvJob("tv-health"), TV_HEALTH_INTERVAL_MS);
  tvHealthTimer.unref();
}, TV_HEALTH_INTERVAL_MS + TV_HEALTH_OFFSET_MS);
tvHealthKickoff.unref();
```

(`crypto` is the Node 22 global. In `NODE_ENV=test` the tvQueue stub's `add` is inert, and the timers never fire within a test's lifetime.)

- [ ] **Step 7: Gates + commit**

```bash
pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api test
git add apps/api/src/jobs/tv-health.ts apps/api/src/jobs/tv-health.test.ts apps/api/src/lib/tv-health-state.ts apps/api/src/plugins/tv-queue.ts apps/api/src/app.ts apps/api/src/routes/tv-play.ts
git commit -m "$(cat <<'EOF'
feat(tv): nightly tv-health probe job + 12h EPG / 24h health schedulers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: API — EPG sources CRUD, refresh trigger, admin channel manager (`tv-admin.ts`)

**Files:**
- Create: `apps/api/src/routes/tv-admin.ts`
- Create: `apps/api/src/routes/tv-admin.test.ts`
- Modify: `apps/api/src/app.ts` (register under `/api`)

**Interfaces:**
- Consumes: `requireAuth`, `requireAdmin` (`../lib/auth`), `requireNonKids` (`../lib/catalog-filter`); `app.tvQueue` + `TvEpgJobData`.
- Produces routes (all `preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)]`):
  - `GET /tv/epg-sources` → `TvEpgSource[]` (createdAt asc)
  - `POST /tv/epg-sources` `{name, url, offsetMin?}` → 201 created row (400 on empty name / non-http(s) url / non-integer offsetMin)
  - `PATCH /tv/epg-sources/:id` `{name?, url?, enabled?, offsetMin?}` → row (404 unknown, 400 invalid)
  - `DELETE /tv/epg-sources/:id` → 204 (404 unknown)
  - `POST /tv/epg/refresh` → 202 `{jobId}` (enqueues `"tv-epg"`)
  - `GET /tv/admin/channels?q&country&offset&limit` → `{total, channels: [{id, number, name, country, logoPath, hidden, kidsAllowed, epgId, quality}]}` — **includes hidden**, `number` asc, `q` case-insensitive contains on name OR rawName, limit default 50 / max 200
  - `PATCH /tv/admin/channels/:id` `{hidden?, kidsAllowed?, epgId?, number?}` → updated row (400: non-boolean toggles, `number` not a positive integer; `epgId` trimmed, `""` → null; 404 unknown)

- [ ] **Step 1: Write the failing route test** — `apps/api/src/routes/tv-admin.test.ts` (reuse the env const from `catalog.test.ts` and the admin mock trio):

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

async function adminApp() {
  const app = await buildApp(env);
  (app as any).prisma.session = { findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }) };
  (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }) };
  (app as any).prisma.profile = { findUnique: async () => null };
  return app;
}

describe("EPG sources CRUD", () => {
  it("lists, creates (validating url), patches and deletes", async () => {
    const app = await adminApp();
    const rows: any[] = [{ id: "e1", name: "iptvx.one (RU/CIS)", url: "https://epg.iptvx.one/EPG_LITE.xml.gz", enabled: true, offsetMin: 0, status: "ok", statusMessage: null, lastSyncAt: null, createdAt: new Date() }];
    (app as any).prisma.tvEpgSource = {
      findMany: async () => rows,
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
      create: async ({ data }: any) => ({ id: "e2", enabled: true, offsetMin: 0, status: "ok", statusMessage: null, lastSyncAt: null, createdAt: new Date(), ...data }),
      update: async ({ where, data }: any) => ({ ...rows[0], id: where.id, ...data }),
      delete: async () => rows[0],
    };
    expect((await app.inject({ method: "GET", url: "/api/tv/epg-sources", cookies: { orbix_session: "s1" } })).statusCode).toBe(200);
    const created = await app.inject({ method: "POST", url: "/api/tv/epg-sources", cookies: { orbix_session: "s1" }, payload: { name: "epg.pw RU", url: "https://epg.pw/xmltv/epg_RU.xml.gz" } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/tv/epg-sources", cookies: { orbix_session: "s1" }, payload: { name: "bad", url: "ftp://nope" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/tv/epg-sources/e1", cookies: { orbix_session: "s1" }, payload: { enabled: false, offsetMin: 60 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/tv/epg-sources/e1", cookies: { orbix_session: "s1" } })).statusCode).toBe(204);
    await app.close();
  });

  it("POST /api/tv/epg/refresh returns a jobId", async () => {
    const app = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/tv/epg/refresh", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(202);
    expect(typeof res.json().jobId).toBe("string");
    await app.close();
  });
});

describe("admin channel manager", () => {
  it("GET lists channels INCLUDING hidden, with q/country/paging mapped to the query", async () => {
    const app = await adminApp();
    let captured: any = null;
    (app as any).prisma.tvChannel = {
      count: async () => 1,
      findMany: async (args: any) => {
        captured = args;
        return [{ id: "c1", number: 5, name: "Первый канал", country: "RU", logoPath: null, hidden: true, kidsAllowed: false, epgId: "ChannelOne.ru", quality: "1080p" }];
      },
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/admin/channels?q=перв&country=RU&offset=10&limit=25", cookies: { orbix_session: "s1" } });
    expect(res.statusCode).toBe(200);
    expect(captured.where.hidden).toBeUndefined(); // includes hidden
    expect(captured.where.country).toBe("RU");
    expect(JSON.stringify(captured.where.OR)).toContain("insensitive");
    expect(captured.skip).toBe(10);
    expect(captured.take).toBe(25);
    expect(captured.orderBy).toEqual({ number: "asc" });
    expect(res.json()).toMatchObject({ total: 1 });
    await app.close();
  });

  it("PATCH validates and normalizes; 404 on unknown id", async () => {
    const app = await adminApp();
    let updated: any = null;
    (app as any).prisma.tvChannel = {
      findUnique: async ({ where }: any) => (where.id === "c1" ? { id: "c1" } : null),
      update: async ({ data }: any) => { updated = data; return { id: "c1", number: 7, name: "x", country: null, logoPath: null, hidden: false, kidsAllowed: true, epgId: null, quality: null, ...data }; },
    };
    expect((await app.inject({ method: "PATCH", url: "/api/tv/admin/channels/nope", cookies: { orbix_session: "s1" }, payload: { hidden: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/tv/admin/channels/c1", cookies: { orbix_session: "s1" }, payload: { number: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/tv/admin/channels/c1", cookies: { orbix_session: "s1" }, payload: { hidden: "yes" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "PATCH", url: "/api/tv/admin/channels/c1", cookies: { orbix_session: "s1" }, payload: { kidsAllowed: true, epgId: "  ", number: 7 } });
    expect(ok.statusCode).toBe(200);
    expect(updated).toEqual({ kidsAllowed: true, epgId: null, number: 7 }); // "" → null
    await app.close();
  });

  it("rejects non-admin accounts and kids profiles", async () => {
    const app = await adminApp();
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: false }) };
    expect((await app.inject({ method: "GET", url: "/api/tv/epg-sources", cookies: { orbix_session: "s1" } })).statusCode).toBe(403);
    (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }) };
    (app as any).prisma.profile = { findUnique: async () => ({ id: "p1", kind: "kids", maturityCap: 1 }) };
    const res = await app.inject({ method: "GET", url: "/api/tv/admin/channels", cookies: { orbix_session: "s1", orbix_profile: "p1" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
```

(Adapt the kids-profile mock fields to what `requireNonKids` actually reads — check `apps/api/src/lib/catalog-filter.ts`.)

- [ ] **Step 2: Run — expect FAIL** (`404`s — routes missing)

```bash
pnpm --filter @orbix/api exec vitest run src/routes/tv-admin.test.ts
```

- [ ] **Step 3: Implement** — `apps/api/src/routes/tv-admin.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { requireAuth, requireAdmin } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import type { TvEpgJobData } from "../plugins/tv-queue";

const CHANNEL_SELECT = {
  id: true, number: true, name: true, country: true, logoPath: true,
  hidden: true, kidsAllowed: true, epgId: true, quality: true,
} as const;

function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

export default async function tvAdminRoute(app: FastifyInstance): Promise<void> {
  const guards = { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] };

  // ── EPG sources CRUD ──────────────────────────────────────────────────────
  app.get("/tv/epg-sources", guards, async () => {
    return app.prisma.tvEpgSource.findMany({ orderBy: { createdAt: "asc" } });
  });

  app.post("/tv/epg-sources", guards, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; url?: string; offsetMin?: number };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const offsetMin = body.offsetMin ?? 0;
    if (!name || !isHttpUrl(url) || !Number.isInteger(offsetMin)) {
      return reply.code(400).send({ error: "invalid_epg_source" });
    }
    const created = await app.prisma.tvEpgSource.create({ data: { name, url, offsetMin } });
    return reply.code(201).send(created);
  });

  app.patch("/tv/epg-sources/:id", guards, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string; url?: string; enabled?: boolean; offsetMin?: number };
    const existing = await app.prisma.tvEpgSource.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) return reply.code(400).send({ error: "invalid_name" });
      data.name = body.name.trim();
    }
    if (body.url !== undefined) {
      if (typeof body.url !== "string" || !isHttpUrl(body.url.trim())) return reply.code(400).send({ error: "invalid_url" });
      data.url = body.url.trim();
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return reply.code(400).send({ error: "invalid_enabled" });
      data.enabled = body.enabled;
    }
    if (body.offsetMin !== undefined) {
      if (!Number.isInteger(body.offsetMin)) return reply.code(400).send({ error: "invalid_offset" });
      data.offsetMin = body.offsetMin;
    }
    return app.prisma.tvEpgSource.update({ where: { id }, data });
  });

  app.delete("/tv/epg-sources/:id", guards, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await app.prisma.tvEpgSource.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    await app.prisma.tvEpgSource.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.post("/tv/epg/refresh", guards, async (_req, reply) => {
    const jobId = randomUUID();
    await app.tvQueue.add("tv-epg", { jobId } satisfies TvEpgJobData);
    return reply.code(202).send({ jobId });
  });

  // ── Channel manager ───────────────────────────────────────────────────────
  app.get("/tv/admin/channels", guards, async (req) => {
    const q = req.query as { q?: string; country?: string; offset?: string; limit?: string };
    const offset = Math.max(0, Number.parseInt(q.offset ?? "0", 10) || 0);
    const limit = Math.min(200, Math.max(1, Number.parseInt(q.limit ?? "50", 10) || 50));
    const where: Record<string, unknown> = {}; // NOTE: no hidden filter — manager sees everything
    if (q.country) where.country = q.country;
    if (q.q && q.q.trim()) {
      const term = q.q.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { rawName: { contains: term, mode: "insensitive" } },
      ];
    }
    const [total, channels] = await Promise.all([
      app.prisma.tvChannel.count({ where }),
      app.prisma.tvChannel.findMany({
        where, orderBy: { number: "asc" }, skip: offset, take: limit, select: CHANNEL_SELECT,
      }),
    ]);
    return { total, channels };
  });

  app.patch("/tv/admin/channels/:id", guards, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { hidden?: unknown; kidsAllowed?: unknown; epgId?: unknown; number?: unknown };
    const existing = await app.prisma.tvChannel.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const data: Record<string, unknown> = {};
    if (body.hidden !== undefined) {
      if (typeof body.hidden !== "boolean") return reply.code(400).send({ error: "invalid_hidden" });
      data.hidden = body.hidden;
    }
    if (body.kidsAllowed !== undefined) {
      if (typeof body.kidsAllowed !== "boolean") return reply.code(400).send({ error: "invalid_kids_allowed" });
      data.kidsAllowed = body.kidsAllowed;
    }
    if (body.epgId !== undefined) {
      if (body.epgId !== null && typeof body.epgId !== "string") return reply.code(400).send({ error: "invalid_epg_id" });
      const trimmed = typeof body.epgId === "string" ? body.epgId.trim() : null;
      data.epgId = trimmed || null; // "" → null (no guide)
    }
    if (body.number !== undefined) {
      if (typeof body.number !== "number" || !Number.isInteger(body.number) || body.number < 1) {
        return reply.code(400).send({ error: "invalid_number" });
      }
      data.number = body.number;
    }
    return app.prisma.tvChannel.update({ where: { id }, data, select: CHANNEL_SELECT });
  });
}
```

- [ ] **Step 4: Register** in `apps/api/src/app.ts`, next to the other tv route registrations:

```ts
import tvAdminRoute from "./routes/tv-admin";
// …
await app.register(tvAdminRoute, { prefix: "/api" });
```

- [ ] **Step 5: Run — expect PASS; gates + commit**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/tv-admin.test.ts
pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api test
git add apps/api/src/routes/tv-admin.ts apps/api/src/routes/tv-admin.test.ts apps/api/src/app.ts
git commit -m "$(cat <<'EOF'
feat(tv): EPG sources CRUD + refresh trigger + admin channel manager API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Web — now/next surfaces (guide rows, home cards, channel schedule, player OSD/mini-guide)

> **Type reuse note:** phase 2's `apps/web/src/lib/types.ts` already exports `TvProgrammeSlot { title; start; stop }` and `TvChannelCard.now?/next?: TvProgrammeSlot | null`. Reuse/alias that type for the web-side slot instead of introducing a second structurally-identical `TvNowNextSlot` in `tv-time.ts` (`export type TvNowNextSlot = TvProgrammeSlot` is fine).

**Files:**
- Create: `apps/web/src/lib/tv-time.ts` (pure helpers) + `apps/web/src/lib/tv-time.test.ts`
- Create: `apps/web/src/components/tv/NowProgressBar.tsx`
- Modify: the phase-2 TV surfaces — locate them first, do not guess paths:
  ```bash
  git grep -ln "TvGuidePage\|TvHomePage\|TvChannelPage\|LiveTvPlayer\|TvChannelCard" apps/web/src
  ```
  Expected: `apps/web/src/pages/tv/TvGuidePage.tsx`, `…/TvHomePage.tsx`, `…/TvChannelPage.tsx`, `apps/web/src/components/tv/LiveTvPlayer.tsx`, plus the module declaring the `TvChannelCard` TS type.

**Interfaces:**
- Consumes: API fields added in Task 5 — `now/next: {title, start, stop} | null` on guide/home channel entries, `nowNext` on the play response, `GET /api/tv/channels/:id/programmes?day=YYYY-MM-DD`.
- Produces:
  ```ts
  // apps/web/src/lib/tv-time.ts
  export interface TvNowNextSlot { title: string; start: string; stop: string }
  export function nowProgressPercent(slot: { start: string; stop: string }, atMs?: number): number; // 0..100, clamped
  export function formatTvTime(iso: string, locale: string): string;   // localized HH:MM
  export function tvDayString(offsetDays: number, from?: Date): string; // local calendar day → "YYYY-MM-DD"
  ```

- [ ] **Step 1: Failing pure-helper test** — `apps/web/src/lib/tv-time.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nowProgressPercent, tvDayString } from "./tv-time";

describe("nowProgressPercent", () => {
  const slot = { start: "2026-07-03T16:00:00.000Z", stop: "2026-07-03T17:00:00.000Z" };
  it("is the elapsed fraction of the slot", () => {
    expect(nowProgressPercent(slot, Date.parse("2026-07-03T16:30:00.000Z"))).toBe(50);
  });
  it("clamps to [0,100]", () => {
    expect(nowProgressPercent(slot, Date.parse("2026-07-03T15:00:00.000Z"))).toBe(0);
    expect(nowProgressPercent(slot, Date.parse("2026-07-03T18:00:00.000Z"))).toBe(100);
  });
  it("degenerate slot → 0", () => {
    expect(nowProgressPercent({ start: slot.start, stop: slot.start }, Date.parse(slot.start))).toBe(0);
  });
});

describe("tvDayString", () => {
  it("formats the local calendar day with an offset", () => {
    const base = new Date(2026, 6, 3, 23, 30); // local time — crosses midnight with +1
    expect(tvDayString(0, base)).toBe("2026-07-03");
    expect(tvDayString(1, base)).toBe("2026-07-04");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @orbix/web exec vitest run src/lib/tv-time.test.ts
```

- [ ] **Step 3: Implement helpers + progress bar.**

`apps/web/src/lib/tv-time.ts`:

```ts
export interface TvNowNextSlot {
  title: string;
  start: string;
  stop: string;
}

/** Elapsed fraction of an airing slot, clamped to [0, 100]. */
export function nowProgressPercent(slot: { start: string; stop: string }, atMs: number = Date.now()): number {
  const start = Date.parse(slot.start);
  const stop = Date.parse(slot.stop);
  if (!(stop > start)) return 0;
  return Math.min(100, Math.max(0, ((atMs - start) / (stop - start)) * 100));
}

/** Localized HH:MM for schedule rows and now/next lines. */
export function formatTvTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Local calendar day as "YYYY-MM-DD" (what the Today/Tomorrow tabs send).
 * The API interprets it as a UTC day with overlap semantics — a known v1
 * approximation at extreme timezone edges.
 */
export function tvDayString(offsetDays: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offsetDays);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
```

`apps/web/src/components/tv/NowProgressBar.tsx`:

```tsx
import { nowProgressPercent } from "../../lib/tv-time";

/** Thin red elapsed-time bar under a now-playing title (guide rows, cards, OSD). */
export function NowProgressBar({ start, stop }: { start: string; stop: string }) {
  return (
    <div className="h-0.5 w-full overflow-hidden rounded-full bg-white/20" aria-hidden="true">
      <div
        className="h-full rounded-full bg-red-500"
        style={{ width: `${nowProgressPercent({ start, stop })}%` }}
      />
    </div>
  );
}
```

Run Step 1's test — expect PASS.

- [ ] **Step 4: Extend the shared TV types.** In the module that declares `TvChannelCard` (found in the locate step), add:

```ts
import type { TvNowNextSlot } from "./tv-time"; // adjust relative path
// on the card/guide-row type:
now: TvNowNextSlot | null;
next: TvNowNextSlot | null;
// on the play response type:
nowNext: { now: TvNowNextSlot | null; next: TvNowNextSlot | null };
```

- [ ] **Step 5: Bind the surfaces** (read each component first; phase 2 rendered em-dash placeholders in these slots — replace exactly those):

1. **`TvGuidePage` rows** — in the now/next cells:

```tsx
{channel.now ? (
  <div className="min-w-0">
    <div className="flex items-baseline gap-2 text-sm text-white">
      <span className="truncate">{channel.now.title}</span>
      <span className="shrink-0 text-xs text-white/50">
        {formatTvTime(channel.now.start, i18n.language)}–{formatTvTime(channel.now.stop, i18n.language)}
      </span>
    </div>
    <NowProgressBar start={channel.now.start} stop={channel.now.stop} />
  </div>
) : (
  <span className="text-sm text-white/40">{t("guide.noEpg")}</span>
)}
{channel.next && (
  <div className="truncate text-xs text-white/50">
    {t("guide.next")} · {formatTvTime(channel.next.start, i18n.language)} {channel.next.title}
  </div>
)}
```

2. **`TvHomePage` cards** — same pattern in the card hover/metadata area: now title + `NowProgressBar` when `channel.now` is set; nothing otherwise (cards stay clean without EPG).

3. **`TvChannelPage` schedule section** — replace the empty schedule block with Today/Tomorrow tabs:

```tsx
const [dayOffset, setDayOffset] = useState<0 | 1>(0);
const day = tvDayString(dayOffset);
const { data } = useQuery({
  queryKey: ["tv-programmes", id, day],
  queryFn: () => apiJson<{ programmes: TvProgramme[] }>(`/api/tv/channels/${id}/programmes?day=${day}`),
});
// tabs:
<div role="tablist" className="flex gap-2">
  <button role="tab" aria-selected={dayOffset === 0} onClick={() => setDayOffset(0)}>{t("channel.today")}</button>
  <button role="tab" aria-selected={dayOffset === 1} onClick={() => setDayOffset(1)}>{t("channel.tomorrow")}</button>
</div>
// rows (highlight the on-air one):
{data?.programmes.map((p) => {
  const onAir = Date.parse(p.start) <= now && now < Date.parse(p.stop);
  return (
    <div key={p.id} className={`flex gap-3 rounded px-3 py-2 ${onAir ? "bg-white/10 ring-1 ring-red-500/60" : ""}`}>
      <span className="w-24 shrink-0 tabular-nums text-white/60">
        {formatTvTime(p.start, i18n.language)}–{formatTvTime(p.stop, i18n.language)}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-white">{p.title}</span>
          {onAir && <span className="rounded bg-red-600 px-1.5 text-[10px] uppercase">{t("channel.onNow")}</span>}
        </div>
        {p.description && <p className="truncate text-sm text-white/50">{p.description}</p>}
      </div>
    </div>
  );
})}
{data && data.programmes.length === 0 && <p className="text-white/50">{t("channel.noSchedule")}</p>}
```

4. **`LiveTvPlayer`** — the zap OSD's empty now/next slots get the play response's `nowNext` (`now.title` + `NowProgressBar` + `next.title` prefixed `t("player.next")`); the mini-guide drawer rows reuse exactly the guide-row binding from (1) — the guide data already flows in via props, which now carry `now`/`next`.

5. **Empty-state testid** — ensure the `/tv` empty-state container (admin "Add channels" wizard / non-admin message, phase 2) carries `data-testid="tv-empty-state"`; add it if phase 2 didn't (Task 11's e2e keys on it).

- [ ] **Step 6: Component test** — add a focused render test beside the guide page (house style of `MediaRow.test.tsx`), e.g. `apps/web/src/pages/tv/TvGuideRow.test.tsx` if phase 2 extracted a row component, otherwise test `NowProgressBar` + the schedule-row markup via a small extracted component. Minimum bar: render with a `now` slot → title visible + progress div width > 0; render with `now: null` → `guide.noEpg` copy visible.

- [ ] **Step 7: Gates + commit**

```bash
pnpm --filter @orbix/web exec vitest run src/lib/tv-time.test.ts
pnpm --filter @orbix/web lint && pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web test
git add apps/web/src
git commit -m "$(cat <<'EOF'
feat(tv): now/next everywhere — guide rows, home cards, day schedule, player OSD/mini-guide

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Web — EPG sources card + channel manager on `AccountTvPage`

**Files:**
- Create: `apps/web/src/components/account/TvEpgSourcesCard.tsx`
- Create: `apps/web/src/components/account/TvChannelManagerCard.tsx`
- Modify: `apps/web/src/pages/account/AccountTvPage.tsx` (render both below the phase-2 sources card; locate with `git grep -ln "AccountTvPage" apps/web/src`)

**Interfaces:**
- Consumes: Task 7 endpoints; `apiJson`/`apiFetch` from `apps/web/src/lib/api.ts`; `useTranslation("tv")`; TanStack Query (`useQuery`/`useMutation`/`useQueryClient`) in the house style of the existing account/settings pages (read `AccountTvPage` and one settings card first, mirror their form/list markup and mutation-invalidation pattern).

- [ ] **Step 1: `TvEpgSourcesCard`** — `apps/web/src/components/account/TvEpgSourcesCard.tsx`. Full component (before pasting, align the container/heading/input class names with the phase-2 sources card on `AccountTvPage` so the page reads as one design; the logic below is complete):

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiFetch, apiJson } from "../../lib/api";

interface EpgSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  offsetMin: number;
  status: string;
  statusMessage: string | null;
  lastSyncAt: string | null;
}

export function TvEpgSourcesCard() {
  const { t, i18n } = useTranslation("tv");
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [offsets, setOffsets] = useState<Record<string, string>>({});

  const { data: sources } = useQuery({
    queryKey: ["tv-epg-sources"],
    queryFn: () => apiJson<EpgSource[]>("/api/tv/epg-sources"),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tv-epg-sources"] });

  const add = useMutation({
    mutationFn: () =>
      apiFetch("/api/tv/epg-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), url: url.trim() }),
      }),
    onSuccess: () => {
      setName("");
      setUrl("");
      setNotice(t("epg.added"));
      void invalidate();
    },
  });

  const patch = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Pick<EpgSource, "enabled" | "offsetMin">> }) =>
      apiFetch(`/api/tv/epg-sources/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => void invalidate(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/tv/epg-sources/${id}`, { method: "DELETE" }),
    onSuccess: () => void invalidate(),
  });

  const refresh = useMutation({
    mutationFn: () => apiFetch("/api/tv/epg/refresh", { method: "POST" }),
    onSuccess: () => setNotice(t("epg.refreshStarted")),
  });

  const statusLabel = (s: EpgSource) =>
    s.status === "syncing" ? t("epg.status.syncing") : s.status === "error" ? t("epg.status.error") : t("epg.status.ok");

  return (
    <section className="rounded-xl bg-white/5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">{t("epg.title")}</h2>
          <p className="mt-1 text-sm text-white/60">{t("epg.intro")}</p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
          onClick={() => refresh.mutate()}
        >
          {t("epg.refresh")}
        </button>
      </div>
      {notice && <p className="mt-2 text-sm text-emerald-400">{notice}</p>}

      <ul className="mt-4 space-y-3">
        {(sources ?? []).map((s) => (
          <li key={s.id} className="rounded-lg bg-black/20 p-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-white">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  aria-label={s.enabled ? t("epg.enabled") : t("epg.disabled")}
                  onChange={(e) => patch.mutate({ id: s.id, data: { enabled: e.target.checked } })}
                />
                <span className="font-medium">{s.name}</span>
              </label>
              <span className="min-w-0 flex-1 truncate text-xs text-white/40" title={s.url}>{s.url}</span>
              <label className="flex items-center gap-1 text-xs text-white/60">
                {t("epg.offsetMin")}
                <input
                  type="number"
                  className="w-20 rounded bg-white/10 px-2 py-1 text-white"
                  value={offsets[s.id] ?? String(s.offsetMin)}
                  onChange={(e) => setOffsets((o) => ({ ...o, [s.id]: e.target.value }))}
                />
              </label>
              <button
                type="button"
                className="rounded bg-white/10 px-2 py-1 text-xs text-white hover:bg-white/20"
                onClick={() => patch.mutate({ id: s.id, data: { offsetMin: Number.parseInt(offsets[s.id] ?? String(s.offsetMin), 10) || 0 } })}
              >
                {t("manager.save")}
              </button>
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
                onClick={() => { if (window.confirm(t("epg.deleteConfirm"))) remove.mutate(s.id); }}
              >
                {t("epg.delete")}
              </button>
            </div>
            <p className="mt-1 text-xs text-white/50">
              {statusLabel(s)}
              {s.status === "error" && s.statusMessage ? ` — ${s.statusMessage}` : ""}
              {" · "}
              {t("epg.lastSync", { when: s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString(i18n.language) : t("epg.never") })}
            </p>
          </li>
        ))}
        {sources && sources.length === 0 && <li className="text-sm text-white/50">{t("epg.empty")}</li>}
      </ul>

      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); if (name.trim() && url.trim()) add.mutate(); }}
      >
        <label className="flex flex-col gap-1 text-xs text-white/60">
          {t("epg.name")}
          <input className="rounded bg-white/10 px-2 py-1.5 text-white" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-white/60">
          {t("epg.url")}
          <input className="rounded bg-white/10 px-2 py-1.5 text-white" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <button type="submit" className="rounded bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-white/90">
          {t("epg.add")}
        </button>
      </form>
    </section>
  );
}
```

- [ ] **Step 2: `TvChannelManagerCard`** — `apps/web/src/components/account/TvChannelManagerCard.tsx`. Full component (same styling caveat; the logo `<img>` src must reuse the exact URL helper the phase-2 guide/cards use for `logoPath` — locate it with `git grep -n "logoPath" apps/web/src` and swap in below where marked):

```tsx
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiFetch, apiJson } from "../../lib/api";

interface AdminChannel {
  id: string;
  number: number;
  name: string;
  country: string | null;
  logoPath: string | null;
  hidden: boolean;
  kidsAllowed: boolean;
  epgId: string | null;
  quality: string | null;
}

const LIMIT = 50;

export function TvChannelManagerCard() {
  const { t } = useTranslation("tv");
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, { epgId?: string; number?: string }>>({});
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    const h = setTimeout(() => { setDebouncedQ(q); setPage(0); }, 300);
    return () => clearTimeout(h);
  }, [q]);

  const { data } = useQuery({
    queryKey: ["tv-admin-channels", debouncedQ, page],
    queryFn: () =>
      apiJson<{ total: number; channels: AdminChannel[] }>(
        `/api/tv/admin/channels?q=${encodeURIComponent(debouncedQ)}&offset=${page * LIMIT}&limit=${LIMIT}`,
      ),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiFetch(`/api/tv/admin/channels/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: (_res, vars) => {
      setSavedId(vars.id);
      void queryClient.invalidateQueries({ queryKey: ["tv-admin-channels"] });
    },
  });

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : page * LIMIT + 1;
  const to = Math.min(total, (page + 1) * LIMIT);

  return (
    <section className="rounded-xl bg-white/5 p-6">
      <h2 className="text-lg font-semibold text-white">{t("manager.title")}</h2>
      <p className="mt-1 text-sm text-white/60">{t("manager.intro")}</p>
      <input
        className="mt-3 w-full max-w-md rounded bg-white/10 px-3 py-2 text-white placeholder:text-white/40"
        placeholder={t("manager.search")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="text-left text-xs uppercase text-white/40">
            <tr>
              <th className="px-2 py-1">{t("manager.columns.number")}</th>
              <th className="px-2 py-1" />
              <th className="px-2 py-1">{t("manager.columns.channel")}</th>
              <th className="px-2 py-1">{t("manager.columns.country")}</th>
              <th className="px-2 py-1">{t("manager.columns.hidden")}</th>
              <th className="px-2 py-1">{t("manager.columns.kids")}</th>
              <th className="px-2 py-1">{t("manager.columns.epgId")}</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {(data?.channels ?? []).map((c) => {
              const draft = drafts[c.id] ?? {};
              return (
                <tr key={c.id} className="border-t border-white/5">
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1">
                      <input
                        type="number"
                        className="w-16 rounded bg-white/10 px-1 py-0.5 tabular-nums"
                        aria-label={t("manager.numberLabel", { name: c.name })}
                        value={draft.number ?? String(c.number)}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], number: e.target.value } }))}
                      />
                      <button
                        type="button"
                        className="rounded bg-white/10 px-1.5 py-0.5 text-xs hover:bg-white/20"
                        onClick={() => {
                          const n = Number.parseInt(draft.number ?? String(c.number), 10);
                          if (Number.isInteger(n) && n >= 1) patch.mutate({ id: c.id, body: { number: n } });
                        }}
                      >
                        {t("manager.save")}
                      </button>
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    {c.logoPath ? (
                      // Reuse the phase-2 logo URL helper here (git grep "logoPath" apps/web/src)
                      <img src={`/api/images/${c.logoPath}`} alt="" className="h-6 w-10 object-contain" />
                    ) : (
                      <span className="inline-block h-6 w-10 rounded bg-white/10" />
                    )}
                  </td>
                  <td className="max-w-56 truncate px-2 py-1.5">{c.name}</td>
                  <td className="px-2 py-1.5 text-white/60">{c.country ?? "—"}</td>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={c.hidden}
                      aria-label={t("manager.hiddenToggle", { name: c.name })}
                      onChange={(e) => patch.mutate({ id: c.id, body: { hidden: e.target.checked } })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={c.kidsAllowed}
                      aria-label={t("manager.kidsToggle", { name: c.name })}
                      onChange={(e) => patch.mutate({ id: c.id, body: { kidsAllowed: e.target.checked } })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1">
                      <input
                        className="w-40 rounded bg-white/10 px-1.5 py-0.5"
                        placeholder={t("manager.epgIdPlaceholder")}
                        value={draft.epgId ?? c.epgId ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], epgId: e.target.value } }))}
                      />
                      <button
                        type="button"
                        className="rounded bg-white/10 px-1.5 py-0.5 text-xs hover:bg-white/20"
                        onClick={() => patch.mutate({ id: c.id, body: { epgId: (draft.epgId ?? c.epgId ?? "").trim() || null } })}
                      >
                        {t("manager.save")}
                      </button>
                      {savedId === c.id && <span className="text-xs text-emerald-400">{t("manager.saved")}</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && data.channels.length === 0 && <p className="mt-3 text-sm text-white/50">{t("manager.empty")}</p>}
      </div>

      <div className="mt-3 flex items-center justify-between text-sm text-white/60">
        <span>{t("manager.pageOf", { from, to, total })}</span>
        <span className="flex gap-2">
          <button
            type="button"
            className="rounded bg-white/10 px-3 py-1 text-white disabled:opacity-40"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            {t("manager.prev")}
          </button>
          <button
            type="button"
            className="rounded bg-white/10 px-3 py-1 text-white disabled:opacity-40"
            disabled={to >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("manager.next")}
          </button>
        </span>
      </div>
    </section>
  );
}
```

If `apiFetch`'s actual signature differs (check `apps/web/src/lib/api.ts` — some house code exposes a `method/body` options wrapper), adapt the five mutation call sites accordingly; the query keys, endpoints and i18n keys are the contract.

- [ ] **Step 3: Mount both** in `AccountTvPage` below the existing sources card, in that order:

```tsx
import { TvEpgSourcesCard } from "../../components/account/TvEpgSourcesCard";
import { TvChannelManagerCard } from "../../components/account/TvChannelManagerCard";
// …after the phase-2 sources card in the JSX:
<TvEpgSourcesCard />
<TvChannelManagerCard />
```

- [ ] **Step 4: Add the en strings** these two tasks + Task 8 consume — merge the `epg`, `manager`, `guide`, `channel`, `player` blocks from Task 10's `en/tv.json` into the existing `apps/web/src/locales/en/tv.json` NOW (English only; the five translations land in Task 10 — the parity test tolerates this only if you copy the new keys into the other five locales as temporary English values in the same commit, exactly like phase 2 did; Task 10 then replaces them with real translations).

- [ ] **Step 5: Gates + commit**

```bash
pnpm --filter @orbix/web lint && pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web test
git add apps/web/src
git commit -m "$(cat <<'EOF'
feat(tv): EPG sources card + admin channel manager UI on the account TV tab

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: i18n — real translations for the `tv` namespace (es/de/pt/ru/fr)

**Files:**
- Modify: `apps/web/src/locales/en/tv.json` (merge in the authoritative blocks below)
- Replace: `apps/web/src/locales/{es,de,pt,ru,fr}/tv.json` (English placeholder copies → real translations)
- Verify: `apps/web/src/lib/i18n/index.ts` `NAMESPACES` contains `"tv"` (phase 2 added it; add if missing)

**Merge rule (parallel-authorship):** phase 1–2 authored `en/tv.json` with keys this plan cannot see. Deep-merge — plan-defined keys take these values; every pre-existing phase-1/2 key is PRESERVED and must also be translated in this task (Step 4 finds them mechanically). The result: zero English-copy values in the five locale files except deliberate cognates.

- [ ] **Step 1: Merge into `en/tv.json`** (keep existing top-level blocks; add/overwrite these):

```json
{
  "guide": {
    "now": "Now",
    "next": "Next",
    "noEpg": "No guide data",
    "schedule": "Schedule",
    "untilTime": "until {{time}}"
  },
  "channel": {
    "schedule": "Schedule",
    "today": "Today",
    "tomorrow": "Tomorrow",
    "onNow": "On now",
    "noSchedule": "No schedule available for this day.",
    "watch": "Watch"
  },
  "player": {
    "now": "Now",
    "next": "Next"
  },
  "epg": {
    "title": "EPG sources",
    "intro": "XMLTV guide feeds. Defaults are added automatically for the countries you enable.",
    "name": "Name",
    "url": "XMLTV URL (.xml or .xml.gz)",
    "add": "Add EPG source",
    "added": "EPG source added.",
    "refresh": "Refresh guide now",
    "refreshStarted": "Guide refresh started.",
    "enabled": "Enabled",
    "disabled": "Disabled",
    "offsetMin": "Time offset (minutes)",
    "offsetHint": "Use when a feed's times are consistently off.",
    "lastSync": "Last sync: {{when}}",
    "never": "never",
    "delete": "Delete",
    "deleteConfirm": "Remove this EPG source?",
    "empty": "No EPG sources yet. Enable a country or add an XMLTV URL.",
    "status": { "ok": "OK", "syncing": "Syncing…", "error": "Error" }
  },
  "manager": {
    "title": "Channel manager",
    "intro": "Search and curate every imported channel, including hidden ones.",
    "search": "Search channels…",
    "columns": { "number": "No.", "channel": "Channel", "country": "Country", "hidden": "Hidden", "kids": "Kids", "epgId": "EPG ID" },
    "hiddenToggle": "Hide {{name}}",
    "kidsToggle": "Allow {{name}} for kids",
    "epgIdPlaceholder": "XMLTV id",
    "numberLabel": "Channel number for {{name}}",
    "save": "Save",
    "saved": "Saved.",
    "empty": "No channels match.",
    "prev": "Previous",
    "next": "Next",
    "pageOf": "{{from}}–{{to}} of {{total}}"
  }
}
```

- [ ] **Step 2: Write the five locale files** — merge each block below into the corresponding `tv.json` (replacing the English placeholders for these keys; keep phase-1/2 keys in place for Step 4):

`apps/web/src/locales/es/tv.json` — plan-defined blocks:

```json
{
  "guide": {
    "now": "Ahora",
    "next": "Después",
    "noEpg": "Sin datos de guía",
    "schedule": "Programación",
    "untilTime": "hasta las {{time}}"
  },
  "channel": {
    "schedule": "Programación",
    "today": "Hoy",
    "tomorrow": "Mañana",
    "onNow": "En emisión",
    "noSchedule": "No hay programación para este día.",
    "watch": "Ver"
  },
  "player": {
    "now": "Ahora",
    "next": "Después"
  },
  "epg": {
    "title": "Fuentes de EPG",
    "intro": "Fuentes de guía XMLTV. Las predeterminadas se añaden automáticamente para los países que actives.",
    "name": "Nombre",
    "url": "URL de XMLTV (.xml o .xml.gz)",
    "add": "Añadir fuente de EPG",
    "added": "Fuente de EPG añadida.",
    "refresh": "Actualizar guía ahora",
    "refreshStarted": "Actualización de la guía iniciada.",
    "enabled": "Activada",
    "disabled": "Desactivada",
    "offsetMin": "Desfase horario (minutos)",
    "offsetHint": "Úsalo cuando los horarios de una fuente estén sistemáticamente desfasados.",
    "lastSync": "Última sincronización: {{when}}",
    "never": "nunca",
    "delete": "Eliminar",
    "deleteConfirm": "¿Quitar esta fuente de EPG?",
    "empty": "Aún no hay fuentes de EPG. Activa un país o añade una URL de XMLTV.",
    "status": { "ok": "OK", "syncing": "Sincronizando…", "error": "Error" }
  },
  "manager": {
    "title": "Gestor de canales",
    "intro": "Busca y gestiona todos los canales importados, incluidos los ocultos.",
    "search": "Buscar canales…",
    "columns": { "number": "N.º", "channel": "Canal", "country": "País", "hidden": "Oculto", "kids": "Niños", "epgId": "ID de EPG" },
    "hiddenToggle": "Ocultar {{name}}",
    "kidsToggle": "Permitir {{name}} para niños",
    "epgIdPlaceholder": "ID de XMLTV",
    "numberLabel": "Número de canal para {{name}}",
    "save": "Guardar",
    "saved": "Guardado.",
    "empty": "Ningún canal coincide.",
    "prev": "Anterior",
    "next": "Siguiente",
    "pageOf": "{{from}}–{{to}} de {{total}}"
  }
}
```

`apps/web/src/locales/de/tv.json` — plan-defined blocks:

```json
{
  "guide": {
    "now": "Jetzt",
    "next": "Danach",
    "noEpg": "Keine Programmdaten",
    "schedule": "Programm",
    "untilTime": "bis {{time}}"
  },
  "channel": {
    "schedule": "Programm",
    "today": "Heute",
    "tomorrow": "Morgen",
    "onNow": "Läuft jetzt",
    "noSchedule": "Für diesen Tag liegt kein Programm vor.",
    "watch": "Ansehen"
  },
  "player": {
    "now": "Jetzt",
    "next": "Danach"
  },
  "epg": {
    "title": "EPG-Quellen",
    "intro": "XMLTV-Programmquellen. Für aktivierte Länder werden Standardquellen automatisch hinzugefügt.",
    "name": "Name",
    "url": "XMLTV-URL (.xml oder .xml.gz)",
    "add": "EPG-Quelle hinzufügen",
    "added": "EPG-Quelle hinzugefügt.",
    "refresh": "Programm jetzt aktualisieren",
    "refreshStarted": "Programmaktualisierung gestartet.",
    "enabled": "Aktiviert",
    "disabled": "Deaktiviert",
    "offsetMin": "Zeitversatz (Minuten)",
    "offsetHint": "Verwenden, wenn die Zeiten einer Quelle durchgehend verschoben sind.",
    "lastSync": "Letzte Synchronisierung: {{when}}",
    "never": "nie",
    "delete": "Löschen",
    "deleteConfirm": "Diese EPG-Quelle entfernen?",
    "empty": "Noch keine EPG-Quellen. Aktiviere ein Land oder füge eine XMLTV-URL hinzu.",
    "status": { "ok": "OK", "syncing": "Wird synchronisiert…", "error": "Fehler" }
  },
  "manager": {
    "title": "Senderverwaltung",
    "intro": "Alle importierten Sender durchsuchen und verwalten, auch ausgeblendete.",
    "search": "Sender suchen…",
    "columns": { "number": "Nr.", "channel": "Sender", "country": "Land", "hidden": "Ausgeblendet", "kids": "Kinder", "epgId": "EPG-ID" },
    "hiddenToggle": "{{name}} ausblenden",
    "kidsToggle": "{{name}} für Kinder freigeben",
    "epgIdPlaceholder": "XMLTV-ID",
    "numberLabel": "Sendernummer für {{name}}",
    "save": "Speichern",
    "saved": "Gespeichert.",
    "empty": "Keine Sender gefunden.",
    "prev": "Zurück",
    "next": "Weiter",
    "pageOf": "{{from}}–{{to}} von {{total}}"
  }
}
```

`apps/web/src/locales/pt/tv.json` — plan-defined blocks (pt-BR, matching the existing files):

```json
{
  "guide": {
    "now": "Agora",
    "next": "A seguir",
    "noEpg": "Sem dados de guia",
    "schedule": "Programação",
    "untilTime": "até {{time}}"
  },
  "channel": {
    "schedule": "Programação",
    "today": "Hoje",
    "tomorrow": "Amanhã",
    "onNow": "No ar",
    "noSchedule": "Sem programação para este dia.",
    "watch": "Assistir"
  },
  "player": {
    "now": "Agora",
    "next": "A seguir"
  },
  "epg": {
    "title": "Fontes de EPG",
    "intro": "Fontes de guia XMLTV. As padrões são adicionadas automaticamente para os países que você ativar.",
    "name": "Nome",
    "url": "URL do XMLTV (.xml ou .xml.gz)",
    "add": "Adicionar fonte de EPG",
    "added": "Fonte de EPG adicionada.",
    "refresh": "Atualizar guia agora",
    "refreshStarted": "Atualização do guia iniciada.",
    "enabled": "Ativada",
    "disabled": "Desativada",
    "offsetMin": "Ajuste de horário (minutos)",
    "offsetHint": "Use quando os horários de uma fonte estiverem sempre defasados.",
    "lastSync": "Última sincronização: {{when}}",
    "never": "nunca",
    "delete": "Excluir",
    "deleteConfirm": "Remover esta fonte de EPG?",
    "empty": "Ainda não há fontes de EPG. Ative um país ou adicione uma URL de XMLTV.",
    "status": { "ok": "OK", "syncing": "Sincronizando…", "error": "Erro" }
  },
  "manager": {
    "title": "Gerenciador de canais",
    "intro": "Pesquise e gerencie todos os canais importados, inclusive os ocultos.",
    "search": "Pesquisar canais…",
    "columns": { "number": "N.º", "channel": "Canal", "country": "País", "hidden": "Oculto", "kids": "Infantil", "epgId": "ID de EPG" },
    "hiddenToggle": "Ocultar {{name}}",
    "kidsToggle": "Permitir {{name}} para crianças",
    "epgIdPlaceholder": "ID do XMLTV",
    "numberLabel": "Número do canal para {{name}}",
    "save": "Salvar",
    "saved": "Salvo.",
    "empty": "Nenhum canal encontrado.",
    "prev": "Anterior",
    "next": "Próxima",
    "pageOf": "{{from}}–{{to}} de {{total}}"
  }
}
```

`apps/web/src/locales/ru/tv.json` — plan-defined blocks:

```json
{
  "guide": {
    "now": "Сейчас",
    "next": "Далее",
    "noEpg": "Нет данных телепрограммы",
    "schedule": "Телепрограмма",
    "untilTime": "до {{time}}"
  },
  "channel": {
    "schedule": "Телепрограмма",
    "today": "Сегодня",
    "tomorrow": "Завтра",
    "onNow": "В эфире",
    "noSchedule": "На этот день программы нет.",
    "watch": "Смотреть"
  },
  "player": {
    "now": "Сейчас",
    "next": "Далее"
  },
  "epg": {
    "title": "Источники EPG",
    "intro": "Источники телепрограммы в формате XMLTV. Для включённых стран стандартные источники добавляются автоматически.",
    "name": "Название",
    "url": "URL XMLTV (.xml или .xml.gz)",
    "add": "Добавить источник EPG",
    "added": "Источник EPG добавлен.",
    "refresh": "Обновить телепрограмму",
    "refreshStarted": "Обновление телепрограммы запущено.",
    "enabled": "Включён",
    "disabled": "Выключен",
    "offsetMin": "Сдвиг времени (минуты)",
    "offsetHint": "Используйте, если время в источнике стабильно сдвинуто.",
    "lastSync": "Последняя синхронизация: {{when}}",
    "never": "никогда",
    "delete": "Удалить",
    "deleteConfirm": "Удалить этот источник EPG?",
    "empty": "Источников EPG пока нет. Включите страну или добавьте URL XMLTV.",
    "status": { "ok": "OK", "syncing": "Синхронизация…", "error": "Ошибка" }
  },
  "manager": {
    "title": "Менеджер каналов",
    "intro": "Поиск и настройка всех импортированных каналов, включая скрытые.",
    "search": "Поиск каналов…",
    "columns": { "number": "№", "channel": "Канал", "country": "Страна", "hidden": "Скрыт", "kids": "Детям", "epgId": "EPG ID" },
    "hiddenToggle": "Скрыть «{{name}}»",
    "kidsToggle": "Разрешить «{{name}}» для детей",
    "epgIdPlaceholder": "Идентификатор XMLTV",
    "numberLabel": "Номер канала для «{{name}}»",
    "save": "Сохранить",
    "saved": "Сохранено.",
    "empty": "Каналы не найдены.",
    "prev": "Назад",
    "next": "Вперёд",
    "pageOf": "{{from}}–{{to}} из {{total}}"
  }
}
```

`apps/web/src/locales/fr/tv.json` — plan-defined blocks:

```json
{
  "guide": {
    "now": "Maintenant",
    "next": "Ensuite",
    "noEpg": "Aucune donnée de guide",
    "schedule": "Programme",
    "untilTime": "jusqu'à {{time}}"
  },
  "channel": {
    "schedule": "Programme",
    "today": "Aujourd'hui",
    "tomorrow": "Demain",
    "onNow": "En ce moment",
    "noSchedule": "Aucun programme pour ce jour.",
    "watch": "Regarder"
  },
  "player": {
    "now": "Maintenant",
    "next": "Ensuite"
  },
  "epg": {
    "title": "Sources EPG",
    "intro": "Flux de guide XMLTV. Les sources par défaut sont ajoutées automatiquement pour les pays activés.",
    "name": "Nom",
    "url": "URL XMLTV (.xml ou .xml.gz)",
    "add": "Ajouter une source EPG",
    "added": "Source EPG ajoutée.",
    "refresh": "Actualiser le guide maintenant",
    "refreshStarted": "Actualisation du guide lancée.",
    "enabled": "Activée",
    "disabled": "Désactivée",
    "offsetMin": "Décalage horaire (minutes)",
    "offsetHint": "À utiliser quand les horaires d'un flux sont systématiquement décalés.",
    "lastSync": "Dernière synchronisation : {{when}}",
    "never": "jamais",
    "delete": "Supprimer",
    "deleteConfirm": "Supprimer cette source EPG ?",
    "empty": "Aucune source EPG pour l'instant. Activez un pays ou ajoutez une URL XMLTV.",
    "status": { "ok": "OK", "syncing": "Synchronisation…", "error": "Erreur" }
  },
  "manager": {
    "title": "Gestionnaire de chaînes",
    "intro": "Recherchez et gérez toutes les chaînes importées, y compris les chaînes masquées.",
    "search": "Rechercher des chaînes…",
    "columns": { "number": "N°", "channel": "Chaîne", "country": "Pays", "hidden": "Masquée", "kids": "Enfants", "epgId": "ID EPG" },
    "hiddenToggle": "Masquer {{name}}",
    "kidsToggle": "Autoriser {{name}} pour les enfants",
    "epgIdPlaceholder": "Identifiant XMLTV",
    "numberLabel": "Numéro de chaîne pour {{name}}",
    "save": "Enregistrer",
    "saved": "Enregistré.",
    "empty": "Aucune chaîne trouvée.",
    "prev": "Précédent",
    "next": "Suivant",
    "pageOf": "{{from}}–{{to}} sur {{total}}"
  }
}
```

- [ ] **Step 3: Verify `"tv"` is in `NAMESPACES`** in `apps/web/src/lib/i18n/index.ts`; append it if phase 2 somehow didn't (without it the parity test silently skips the namespace).

- [ ] **Step 4: Hunt down remaining English placeholders** (the phase-1/2 keys this plan couldn't pre-translate). From the repo root:

```bash
for l in es de pt ru fr; do
  node -e "
    const en = require('./apps/web/src/locales/en/tv.json');
    const x  = require('./apps/web/src/locales/$l/tv.json');
    const flat = (o, p='') => Object.entries(o).flatMap(([k,v]) => v && typeof v === 'object' ? flat(v, p+k+'.') : [[p+k, v]]);
    const fx = Object.fromEntries(flat(x));
    for (const [k, v] of flat(en)) if (fx[k] === v && String(v).length > 3) console.log('$l', k, JSON.stringify(v));
  "
done
```

Translate every listed value in place (these are phase-1/2 surface strings: home rails, guide chips, player errors, sources card, empty states, legal notice). Keep terminology consistent with Step 2's blocks — glossary: guide → *Guía / Programm / Programação / Телепрограмма / Programme (guide)*; channel → *canal / Sender / canal / канал / chaîne*; stream/source → keep the existing locale files' register (informal-imperative es/pt, formal-imperative ru with «…» quotes and ё, compound-noun de, spaced-punctuation fr). Legit cross-language cognates ("OK", "Orbix", "EPG", "M3U", "XMLTV", "iptv-org") may stay identical — review each survivor of the script deliberately.

- [ ] **Step 5: Parity + full web tests**

```bash
pnpm --filter @orbix/web exec vitest run src/locales/parity.test.ts
pnpm --filter @orbix/web lint && pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web test
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/locales apps/web/src/lib/i18n/index.ts
git commit -m "$(cat <<'EOF'
feat(tv): translate the tv namespace into es/de/pt/ru/fr (real translations, parity green)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: e2e (`tv.spec.ts`) + README/deploy docs + full gates

**Files:**
- Create: `apps/web/e2e/tv.spec.ts`
- Modify: `README.md` (Features bullet + "Live TV" subsection)
- Modify: `deploy/README.md` (Live TV connectivity note)

- [ ] **Step 1: Write the spec** — `apps/web/e2e/tv.spec.ts`. No real sync, no external network — the e2e DB has zero channels, so `/tv` shows the empty state. Serial suite (`workers: 1` global), self-cleaning like `onboarding.spec.ts`. Before writing, check `apps/web/src/pages/ProfilesPage.tsx` for the kids-profile control's accessible name and adjust the one marked selector:

```ts
import { test, expect } from "@playwright/test";

// TV phase-3 e2e: nav visibility per profile kind, /tv empty state, admin TV
// account surfaces. Runs against the throwaway e2e DB (global-setup wipes it);
// zero channels are imported so no external network is ever touched.
test.afterAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://orbix:orbix@localhost:1062/orbix";
  const { prisma } = await import("@orbix/db");
  await prisma.profile.deleteMany();
  await prisma.account.deleteMany();
  await prisma.$disconnect();
});

test("standard profile sees the TV nav and the /tv empty state", async ({ page }) => {
  await page.goto("http://localhost:1060/");
  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel("Email").fill("tv@home.lan");
  await page.getByLabel("Password").fill("longenough");
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/profiles/);
  await page.getByRole("button", { name: /add profile/i }).click();
  await page.getByLabel("Name").fill("Adult");
  await page.getByRole("button", { name: /save/i }).click();
  await page.getByText("Adult").click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole("banner").getByRole("link", { name: "TV" }).click();
  await expect(page).toHaveURL(/\/tv/);
  await expect(page.getByTestId("tv-empty-state")).toBeVisible(); // added in Task 8 Step 5.5
});

test("kids profile has no TV nav and /tv degrades gracefully", async ({ page }) => {
  // Create + select a kids profile (Adult exists from the previous test).
  await page.goto("http://localhost:1060/profiles");
  await page.getByRole("button", { name: /add profile/i }).click();
  await page.getByLabel("Name").fill("Kiddo");
  await page.getByLabel(/kids/i).check(); // ← adjust to ProfilesPage's actual control
  await page.getByRole("button", { name: /save/i }).click();
  await page.getByText("Kiddo").click();
  await expect(page).toHaveURL(/\/$/);

  // UI assertions only: no TV entry in the nav…
  await expect(page.getByRole("banner").getByRole("link", { name: "TV" })).toHaveCount(0);
  // …and direct navigation renders no TV content and no crash.
  await page.goto("http://localhost:1060/tv");
  await expect(page.getByTestId("tv-empty-state")).toHaveCount(0);
  await expect(page.locator("body")).toBeVisible();
});

test("admin account TV tab renders sources, EPG and channel-manager sections", async ({ page }) => {
  // Back to the standard (PIN-less) profile.
  await page.goto("http://localhost:1060/profiles");
  await page.getByText("Adult").click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("http://localhost:1060/account/tv");
  await expect(page.getByRole("heading", { name: "EPG sources" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Channel manager" })).toBeVisible();
  // Empty-list copy proves the queries resolved (local API only).
  await expect(page.getByText(/No EPG sources yet/i)).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e suite against a THROWAWAY DB.** Follow the house recipe (see `docs`/memory: never the populated dev DB — global-setup wipes accounts). With docker postgres/redis up and pointing `DATABASE_URL` at a scratch database:

```bash
E2E_ALLOW_DB_RESET=1 DATABASE_URL="postgresql://orbix:orbix@localhost:1062/orbix_e2e" \
  pnpm --filter @orbix/web test:e2e
```

Expected: all specs green, `tv.spec.ts` included. Afterwards reap dev servers: `pkill -f "tsx.*watch src/server.ts"; pkill -f vite`.

- [ ] **Step 3: README.** In `README.md`:

1. Add to the **Features** list (after the "Discovery" bullet):

```md
- **Live TV (optional)** — a worldwide catalog of free, publicly available live channels (opt-in iptv-org index sync and/or your own M3U playlists), always-proxied HLS playback with instant zapping and a mini-guide, XMLTV EPG with now/next and per-channel day schedules, nightly stream health checks, and an admin channel manager. Hidden from kids profiles (server-enforced).
```

2. Add a **Live TV** subsection after "Features" (before "Architecture"):

```md
## Live TV

The TV section is optional and off until an admin configures it.

- **Opt-in catalog, no bundled content** — Orbix ships **no channels and no stream URLs**. An admin may opt in, at runtime, to syncing the [iptv-org](https://github.com/iptv-org/iptv) public-domain index of publicly available broadcasts (its DMCA blocklist is honored and NSFW channels are never imported), and/or import their own M3U playlists, which remain the user's responsibility.
- **Neutral player** — stream availability varies by country and by the server's network position; Orbix never bypasses DRM, tokens, or geo measures. This follows the established community posture (the Hypnotix/Linux Mint precedent). Not legal advice.
- **Guide** — XMLTV EPG sources are seeded automatically per enabled country (iptvx.one for RU/CIS, epgshare01 country packs elsewhere) and manageable in the admin UI; now/next appears on every rail, guide row and in the player, backed by Postgres — no XML parsing at request time.
- **Offline nuance** — the channel catalog, logos and guide data are cached locally and browsable offline like the rest of Orbix, but **live playback itself requires internet**: the streams are remote by nature. Your movie/series library stays fully offline-capable either way.
```

- [ ] **Step 4: Deploy guide.** In `deploy/README.md`, add a section (after "External (SMB) Sources", matching its tone):

```md
---

## Live TV (optional)

The TV section syncs channel catalogs (iptv-org), XMLTV EPG feeds, and proxies live streams **from the internet at runtime** — unlike the VOD library, live TV needs **outbound internet access from the `api` container** (catalog sync every 24 h, EPG refresh every 12 h, a nightly stream health probe, and the stream proxy itself while watching).

- **No new containers, volumes, or ports** — the existing `api` service does all of it; channel logos live in the `orbix-metadata` volume and guide data in postgres.
- If your NAS egress is firewalled, allow outbound HTTP(S) from the api container — or simply leave the TV section unconfigured; everything else keeps working fully offline.
- Streams are fetched from the NAS's network position: channels that are geo-blocked for your server's country will show as unavailable even if they play on your phone abroad.
```

- [ ] **Step 5: Full gates (all four) + final commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all green. Fix anything surfaced (remember: lint runs per-package too), then:

```bash
git add apps/web/e2e/tv.spec.ts README.md deploy/README.md
git commit -m "$(cat <<'EOF'
docs(tv): Live TV README + deploy notes; e2e coverage for TV nav, kids exclusion, admin EPG/manager UI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification & Definition of Done

- [ ] Spec phase 7 (EPG): defaults seeded on country enable (Task 3); ingest job with gunzip + filtering + `offsetMin` + windowing + batch upserts + pruning (Task 4); matching epgId-exact then unique-name (Tasks 2, 4); now/next in API + UI and the schedule page (Tasks 5, 8); serving reads Postgres only.
- [ ] Spec phase 8: admin channel manager API + UI (Tasks 7, 9); `tv-health` nightly job with 24 h staleness, weekly dead retry, cap 500, concurrency 8, shared thresholds (Task 6).
- [ ] Spec phase 9: 6-locale `tv` namespace with real translations + parity green (Task 10); e2e for nav/kids/admin surfaces (Task 11); README legal/offline copy + deploy connectivity note (Task 11).
- [ ] Invariants hold: one grouped programme query per home/guide/play request (asserted in tests); kids 403 on every new admin route; no BigInt serialization anywhere in `Tv*`; core has no IO and its tests see no gzip; e2e ran only against a throwaway DB with `E2E_ALLOW_DB_RESET=1`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all green on the final tree.
