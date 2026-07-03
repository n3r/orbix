# TV Phase 2 — Playback Proxy + Web UI + Live Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TV section watchable and browsable: a signed, SSRF-hardened HLS proxy + play + health-feedback routes on the API; a fully browsable web TV section (`/tv` rails, `/tv/guide` virtualized list, `/tv/channel/:id`) with the nav placeholder replaced by a real link (hidden for kids); a first-run wizard + `/account/tv` admin sources tab; and a `LiveTvPlayer` overlay that plays channels through the proxy with zapping, OSD, mini-guide and multi-source failover.

**Architecture:** Everything flows through a same-origin proxy under `/api/tv/proxy/*` (the empirical probe showed direct browser fetch fails for a meaningful minority of public streams: missing CORS, UA gates, redirect hops). Pure signing/rewrite logic lives in `packages/core/src/tv/proxy.ts`; `apps/api/src/lib/tv-upstream.ts` is the undici-based fetcher with a validating DNS lookup (anti-SSRF on every redirect hop); `apps/api/src/routes/tv-play.ts` glues them behind `requireAuth` + `requireTvAccess`. The web side is a dedicated `/tv` route family under `RequireProfile`, with `LiveTvOverlay` (portal, sibling of the VOD `PlayerOverlay` — no decision/subs/progress fetches) hosting `LiveTvPlayer` (Vidstack + bundled hls.js, `streamType="live"`).

**Tech Stack:** TypeScript, Fastify + Prisma, undici, node:crypto, React 19 + React Router v8, TanStack Query (+ new `@tanstack/react-virtual`), Vidstack (`@vidstack/react` as pinned) + bundled hls.js, Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-tv-live-channels-design.md` — this plan implements rollout phases **4–6** (proxy playback + web UI + live player). Phase 1–3 (schema, core parsers/planners, sync job + sources API) are delivered by the parallel Phase-1 plan and are **prerequisites** (see below). Phases 7–9 (EPG, admin channel manager, i18n sweep/e2e) are a later plan.

## Global Constraints

- Package manager: **pnpm 10.22.0** (repo-local, pinned in `packageManager`). Node 22. Turborepo.
- Gates before declaring any task done: `pnpm typecheck && pnpm lint && pnpm test`. **Run `pnpm lint` per change** — lint-only errors pass typecheck+test and hide behind Turbo's cache.
- `packages/core` stays framework-agnostic: **no DB/network/ffmpeg/fs imports**. `node:crypto` is allowed (precedent: `packages/core/src/auth/session.ts`) — it is not IO.
- The SPA calls **relative `/api/...` only** (via `apiFetch`/`apiJson` or `EventSource("/api/...")`). Never hardcode an API origin in browser code.
- **Kids exclusion is server-enforced on every `/api/tv/*` route** via the Phase-1 `requireTvAccess` preHandler (403). Nav hiding in the UI is cosmetic on top, never the mechanism.
- **Player stack stays pinned**: do not change `@vidstack/react` / `media-icons` / `hls.js` versions (`apps/web/package.json` currently resolves `@vidstack/react` 1.15.6; historically `media-icons` needed the `next` dist-tag — if you ever reinstall, preserve the resolved versions). **hls.js is bundled and imported — never CDN-loaded** (offline guarantee).
- No `Tv*` model has a `BigInt` column — nothing to `.toString()`; keep it that way.
- **No real stream URLs anywhere in the repo** (legal posture). Tests use a local fixture HLS origin spun up inside the test process.
- Docker images bake `node_modules`: this plan adds `undici` (api) and `@tanstack/react-virtual` (web) — container smokes after Tasks 2/7 need `docker compose build api web` first.
- Commit style: `feat(tv): …` (or `test(tv): …`), every commit ends with the trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Work happens on the current `features/television` branch.
- After any host-side manual smoke: `pkill -f "tsx.*watch src/server.ts"; pkill -f vite` and free ports 1060/1061.

## Phase-1 prerequisites (treat as EXISTING; verify in Task 1 Step 0)

Delivered by the parallel Phase-1 plan (schema + parsers + sync + sources/catalog API). This plan **consumes** them and must not re-implement:

- Prisma models `TvSource`/`TvChannel`/`TvStream`/`TvProgramme`/`TvEpgSource`/`TvFavorite`/`TvPlayEvent` (spec Data-model section) — client props `prisma.tvChannel`, `prisma.tvStream`, …
- `@orbix/core` exports: `parseM3u`, `cleanChannelName`, `planIptvOrgSync`, `planM3uSync`, `assignNumbers`, `classifyProtocol(url)`, and **`orderStreams<T extends {priority:number;status:string;protocol:string}>(streams: T[]): T[]`** (dead + non-hls excluded; ok>unknown>degraded, then priority asc).
- API: `plugins/tv-queue.ts` (`app.tvQueue`, `tvEvents`, `tvDoneCache`, job `"tv-sync"`), `lib/tv-access.ts` → `requireTvAccess(app)` preHandler (403 kids), `routes/tv-sources.ts` (`GET/POST/PATCH/DELETE /tv/sources`, `POST /tv/sources/:id/sync → {jobId}`, `GET /tv/sync/events?jobId=` SSE), `routes/tv-catalog.ts` (`GET /tv/home`, `GET /tv/guide`, `GET /tv/channels/:id`, `GET /tv/channels/:id/programmes`, `PUT/DELETE /tv/favorites/:channelId`, `GET /tv/favorites`, `POST /tv/events/:channelId`) — all under `/api`.

If Task 1 Step 0 finds these missing, **stop: execute the Phase-1 plan first.**

## File map

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/tv/proxy.ts` | create | signing, b64url encode/decode, playlist rewrite, private-IP predicate |
| `packages/core/src/tv/proxy.test.ts` | create | TDD for all five helpers |
| `packages/core/src/index.ts` | modify | `export * from "./tv/proxy"` |
| `apps/api/package.json` | modify | `undici` dependency |
| `apps/api/src/lib/tv-upstream.ts` | create | hardened upstream fetcher (validating lookup, manual redirects, UA/referrer) |
| `apps/api/src/lib/tv-upstream.test.ts` | create | injected-lookup fixture tests + real-guard rejection |
| `apps/api/src/routes/tv-play.ts` | create | `/tv/channels/:id/play`, `/tv/proxy/:streamId/{index.m3u8,p,s}`, `/tv/streams/:id/health` |
| `apps/api/src/routes/tv-play.test.ts` | create | fixture-origin end-to-end rewrite, sig, kids, health thresholds |
| `apps/api/src/app.ts` | modify | register `tvPlayRoute(env, {upstream})`; `tvUpstream` override on `buildApp` |
| `apps/web/src/lib/types.ts` | modify | `TvChannelCard`, `TvHome`, `TvGuideResponse`, `TvPlayResponse`, `TvSource`, `TvProgramme` |
| `apps/web/src/lib/queries.ts` | modify | `useTvHome/useTvGuide/useTvChannel/useTvFavorites/useTvProgrammes` |
| `apps/web/src/lib/tv.ts` (+ `tv.test.ts`) | create | pure helpers: `channelInitials`, `channelHue`, `regionName` (TDD) |
| `apps/web/src/lib/i18n/index.ts` | modify | add `"tv"` to `NAMESPACES` |
| `apps/web/src/locales/{en,es,de,pt,ru,fr}/tv.json` | create | `tv` namespace (en authored; other 5 = en copies for parity) |
| `apps/web/src/components/tv/LiveTvPlayer.tsx` | create | Vidstack live player: hls config, error ladder, failover, health, tune events |
| `apps/web/src/components/tv/LiveTvOverlay.tsx` | create | portal cinema: zap keys, OSD, mini-guide, offline panel |
| `apps/web/src/components/tv/ChannelCard.tsx` | create | 16:9 tile: logo/monogram, quality chip, offline dot, favorite heart |
| `apps/web/src/components/tv/ChannelRail.tsx` | create | horizontal rail (MediaRow scroller/paddle mechanics) |
| `apps/web/src/pages/TvHomePage.tsx` | create | rails + Guide button + empty state (admin wizard CTA) |
| `apps/web/src/pages/TvGuidePage.tsx` | create | chips + debounced search + virtualized offset-paged list |
| `apps/web/src/pages/TvChannelPage.tsx` | create | hero, favorite, Watch, schedule section |
| `apps/web/src/pages/account/AccountTvPage.tsx` | create | sources admin (iptv-org + M3U) + SSE progress + wizard mode |
| `apps/web/src/pages/account/AccountLayout.tsx` | modify | admin "TV" tab + deep-link guard |
| `apps/web/src/components/shell/TopNav.tsx` | modify | placeholder → real `/tv` link, hidden for kids |
| `apps/web/src/components/shell/BottomNav.tsx` | modify | same, gains `profile` prop |
| `apps/web/src/components/shell/AppShell.tsx` | modify | pass `profile` to `BottomNav` |
| `apps/web/src/router.tsx` | modify | `/tv`, `/tv/guide`, `/tv/channel/:id`, `/account/tv` |
| `apps/web/package.json` | modify | `@tanstack/react-virtual` dependency |

Task order (player is built **before** the pages so every consumer imports a real component — no interim stubs): 1 core proxy → 2 upstream fetcher → 3 play/proxy/health routes → 4 web foundations (types/queries/i18n/pure helpers) → 5 LiveTvPlayer+Overlay → 6 cards/rails/TvHomePage/nav/router → 7 TvGuidePage → 8 TvChannelPage → 9 AccountTvPage+wizard → 10 gates + manual smoke.

---

### Task 1: Core — proxy signing, playlist rewrite, private-IP predicate (TDD)

**Files:**
- Create: `packages/core/src/tv/proxy.ts`
- Create: `packages/core/src/tv/proxy.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `node:crypto` (`createHmac`, `timingSafeEqual`) only — no IO.
- Produces (fixed contract):
  ```ts
  export function signProxyPayload(secret: string, streamId: string, upstreamUrl: string): string; // b64url(hmac-sha256(secret, `${streamId}|${upstreamUrl}`)), first 32 chars
  export function verifyProxyPayload(secret: string, streamId: string, upstreamUrl: string, sig: string): boolean; // timing-safe
  export function encodeUpstream(url: string): string;            // base64url
  export function decodeUpstream(u: string): string | null;       // null on invalid/non-http(s)
  export function rewritePlaylist(text: string, finalBaseUrl: string, toProxy: (absUrl: string, kind: "playlist" | "bytes") => string): string;
  export function isPrivateHost(ip: string): boolean;             // v4+v6 loopback/RFC1918/link-local/ULA/0.0.0.0/8/::1/mapped-v4
  ```

- [ ] **Step 0: Preflight — verify Phase 1 landed**

Run:
```bash
grep -rn "orderStreams" packages/core/src/tv | head -3
test -f apps/api/src/lib/tv-access.ts && echo tv-access-ok
grep -n "model TvStream" packages/db/prisma/schema.prisma
```
Expected: all three produce output. If any is missing, STOP — execute the Phase-1 plan first.

- [ ] **Step 1: Write the failing test** — create `packages/core/src/tv/proxy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  signProxyPayload,
  verifyProxyPayload,
  encodeUpstream,
  decodeUpstream,
  rewritePlaylist,
  isPrivateHost,
} from "./proxy";

const SECRET = "s".repeat(32);

describe("signProxyPayload / verifyProxyPayload", () => {
  it("is deterministic, 32 chars, base64url-safe", () => {
    const a = signProxyPayload(SECRET, "st1", "http://a/x.m3u8");
    const b = signProxyPayload(SECRET, "st1", "http://a/x.m3u8");
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("changes when streamId or url changes", () => {
    const base = signProxyPayload(SECRET, "st1", "http://a/x.m3u8");
    expect(signProxyPayload(SECRET, "st2", "http://a/x.m3u8")).not.toBe(base);
    expect(signProxyPayload(SECRET, "st1", "http://a/y.m3u8")).not.toBe(base);
  });

  it("verifies its own signature and rejects tampering", () => {
    const sig = signProxyPayload(SECRET, "st1", "http://a/x.m3u8");
    expect(verifyProxyPayload(SECRET, "st1", "http://a/x.m3u8", sig)).toBe(true);
    expect(verifyProxyPayload(SECRET, "st2", "http://a/x.m3u8", sig)).toBe(false);
    expect(verifyProxyPayload(SECRET, "st1", "http://a/OTHER", sig)).toBe(false);
    expect(verifyProxyPayload(SECRET, "st1", "http://a/x.m3u8", "A".repeat(32))).toBe(false);
    expect(verifyProxyPayload(SECRET, "st1", "http://a/x.m3u8", "short")).toBe(false);
    expect(verifyProxyPayload(SECRET, "st1", "http://a/x.m3u8", "")).toBe(false);
  });
});

describe("encodeUpstream / decodeUpstream", () => {
  it("roundtrips http and https URLs", () => {
    for (const url of ["http://h:8080/a/b.ts?tok=1&x=ы", "https://cdn.example/seg/0001.m4s"]) {
      expect(decodeUpstream(encodeUpstream(url))).toBe(url);
    }
  });

  it("returns null for junk and non-http(s) schemes", () => {
    expect(decodeUpstream("!!!not-base64url!!!")).toBeNull();
    expect(decodeUpstream(encodeUpstream("file:///etc/passwd"))).toBeNull();
    expect(decodeUpstream(encodeUpstream("ftp://h/x"))).toBeNull();
    expect(decodeUpstream(encodeUpstream("not a url"))).toBeNull();
    expect(decodeUpstream("")).toBeNull();
  });
});

describe("rewritePlaylist", () => {
  const base = "http://origin.example/live/master.m3u8";
  const toProxy = (abs: string, kind: "playlist" | "bytes") =>
    `/api/tv/proxy/st1/${kind === "playlist" ? "p" : "s"}?u=${encodeUpstream(abs)}`;

  it("rewrites relative URI lines against the FINAL base url", () => {
    const out = rewritePlaylist("#EXTM3U\nmedia.m3u8\n", base, toProxy);
    expect(out).toContain(`/api/tv/proxy/st1/p?u=${encodeUpstream("http://origin.example/live/media.m3u8")}`);
  });

  it("routes playlists to /p and everything else to /s by extension", () => {
    const text = "#EXTM3U\nvariant.M3U8\n#EXTINF:6.0,\n../seg/00001.ts\n";
    const out = rewritePlaylist(text, base, toProxy);
    expect(out).toContain(`/p?u=${encodeUpstream("http://origin.example/live/variant.M3U8")}`);
    expect(out).toContain(`/s?u=${encodeUpstream("http://origin.example/seg/00001.ts")}`);
  });

  it("rewrites absolute URI lines untouched by the base", () => {
    const out = rewritePlaylist("#EXTM3U\nhttps://other.example/x.m3u8\n", base, toProxy);
    expect(out).toContain(`/p?u=${encodeUpstream("https://other.example/x.m3u8")}`);
  });

  it("rewrites URI attributes: KEY/MAP → bytes, MEDIA/I-FRAME → playlist", () => {
    const text = [
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0xabc',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="alt",URI="audio/alt.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="iframe.m3u8"',
    ].join("\n");
    const out = rewritePlaylist(text, base, toProxy);
    expect(out).toContain(`URI="/api/tv/proxy/st1/s?u=${encodeUpstream("http://origin.example/live/key.bin")}"`);
    expect(out).toContain(`URI="/api/tv/proxy/st1/s?u=${encodeUpstream("http://origin.example/live/init.mp4")}"`);
    expect(out).toContain(`URI="/api/tv/proxy/st1/p?u=${encodeUpstream("http://origin.example/live/audio/alt.m3u8")}"`);
    expect(out).toContain(`URI="/api/tv/proxy/st1/p?u=${encodeUpstream("http://origin.example/live/iframe.m3u8")}"`);
    // Non-URI attributes survive verbatim.
    expect(out).toContain("METHOD=AES-128");
    expect(out).toContain('BYTERANGE="720@0"');
  });

  it("tolerates CRLF input and passes comments/blank lines through", () => {
    const text = "#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n\r\nseg1.ts\r\n";
    const out = rewritePlaylist(text, base, toProxy);
    expect(out).toContain("#EXT-X-TARGETDURATION:6");
    expect(out).toContain(`/s?u=${encodeUpstream("http://origin.example/live/seg1.ts")}`);
    expect(out).not.toContain("\r");
  });
});

describe("isPrivateHost", () => {
  it.each([
    "127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.95", "169.254.10.10", "0.0.0.0", "0.1.2.3",
    "::1", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1",
  ])("blocks %s", (ip) => {
    expect(isPrivateHost(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "193.168.1.1",
    "2a00:1450:4001::1", "2001:db8::1", "::ffff:8.8.8.8",
  ])("allows %s", (ip) => {
    expect(isPrivateHost(ip)).toBe(false);
  });

  it("fails safe (true) on unparsable input", () => {
    expect(isPrivateHost("not-an-ip")).toBe(true);
    expect(isPrivateHost("1.2.3")).toBe(true);
    expect(isPrivateHost("999.1.1.1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/proxy.test.ts`
Expected: FAIL — `./proxy` module does not exist.

- [ ] **Step 3: Implement** — create `packages/core/src/tv/proxy.ts`:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signing + rewrite helpers for the TV HLS proxy.
 *
 * Pure string/crypto transforms (node:crypto only — no IO): the api layer
 * decides what to fetch; these functions only mint/verify proxy URLs and
 * rewrite playlists so every URI a client sees points back at the proxy.
 * The signature binds (streamId, absolute upstream URL) to SESSION_SECRET so
 * the proxy only ever fetches URLs the server itself minted (anti-SSRF).
 */

/** b64url(HMAC-SHA256(secret, `${streamId}|${upstreamUrl}`)), first 32 chars. */
export function signProxyPayload(secret: string, streamId: string, upstreamUrl: string): string {
  return createHmac("sha256", secret)
    .update(`${streamId}|${upstreamUrl}`)
    .digest("base64url")
    .slice(0, 32);
}

/** Timing-safe check of a signProxyPayload signature. */
export function verifyProxyPayload(
  secret: string,
  streamId: string,
  upstreamUrl: string,
  sig: string,
): boolean {
  const expected = Buffer.from(signProxyPayload(secret, streamId, upstreamUrl));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(expected, given);
}

/** URL → base64url (the `u` query param of the /p and /s proxy routes). */
export function encodeUpstream(url: string): string {
  return Buffer.from(url, "utf8").toString("base64url");
}

/** base64url → URL string; null when undecodable or not http(s). */
export function decodeUpstream(u: string): string | null {
  if (u === "") return null;
  let decoded: string;
  try {
    decoded = Buffer.from(u, "base64url").toString("utf8");
  } catch {
    return null;
  }
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return decoded;
}

/** True when a URL's pathname looks like an HLS playlist (.m3u8 / .m3u). */
function isPlaylistUrl(absUrl: string): boolean {
  try {
    const p = new URL(absUrl).pathname.toLowerCase();
    return p.endsWith(".m3u8") || p.endsWith(".m3u");
  } catch {
    return false;
  }
}

// Tags whose URI="…" attribute must be rewritten, with the proxy kind of the
// referenced resource (keys/init sections are opaque bytes; alternate media
// and I-frame renditions are playlists).
const ATTR_URI_TAGS: [prefix: string, kind: "playlist" | "bytes"][] = [
  ["#EXT-X-KEY:", "bytes"],
  ["#EXT-X-MAP:", "bytes"],
  ["#EXT-X-MEDIA:", "playlist"],
  ["#EXT-X-I-FRAME-STREAM-INF:", "playlist"],
];

/**
 * Rewrite every URI in an HLS playlist to a proxy URL.
 * - Non-# lines are URIs: resolve against `finalBaseUrl` (the playlist's
 *   FINAL URL after redirects) → toProxy(abs, playlist|bytes by extension).
 * - URI="…" attributes on KEY/MAP/MEDIA/I-FRAME-STREAM-INF tags are resolved
 *   and rewritten with their tag's kind. Everything else passes through.
 * CRLF input is tolerated (output normalized to \n).
 */
export function rewritePlaylist(
  text: string,
  finalBaseUrl: string,
  toProxy: (absUrl: string, kind: "playlist" | "bytes") => string,
): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return line;
      if (trimmed.startsWith("#")) {
        const tag = ATTR_URI_TAGS.find(([prefix]) => trimmed.startsWith(prefix));
        if (!tag) return line;
        return line.replace(/URI="([^"]*)"/, (match, uri: string) => {
          let abs: string;
          try {
            abs = new URL(uri, finalBaseUrl).toString();
          } catch {
            return match; // unresolvable URI — leave untouched
          }
          return `URI="${toProxy(abs, tag[1])}"`;
        });
      }
      let abs: string;
      try {
        abs = new URL(trimmed, finalBaseUrl).toString();
      } catch {
        return line; // unresolvable URI line — leave untouched
      }
      return toProxy(abs, isPlaylistUrl(abs) ? "playlist" : "bytes");
    })
    .join("\n");
}

/**
 * True for IPs the proxy must never fetch (SSRF guard): v4 loopback /
 * RFC1918 / link-local / 0.0.0.0/8 and v6 loopback / unspecified /
 * link-local fe80::/10 / ULA fc00::/7, including v4-mapped v6.
 * Unparsable input is treated as private (fail-safe).
 */
export function isPrivateHost(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (mapped) return isPrivateHost(mapped[1]!);
  if (s.includes(":")) {
    if (s === "::" || s === "::1") return true;
    const first = Number.parseInt(s.split(":", 1)[0]!, 16);
    if (Number.isNaN(first)) return true; // "::…" shorthand / junk — fail safe
    if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local fe80::/10
    if (first >= 0xfc00 && first <= 0xfdff) return true; // ULA fc00::/7
    return false;
  }
  const parts = s.split(".");
  if (parts.length !== 4) return true;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return true;
  const [a, b] = nums as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
```

Then add the export to `packages/core/src/index.ts` after the existing `./tv/*` export lines Phase 1 added (keep alphabetical-ish grouping with them):

```typescript
export * from "./tv/proxy";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/core exec vitest run src/tv/proxy.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Package gates**

Run: `pnpm --filter @orbix/core typecheck && pnpm --filter @orbix/core lint && pnpm --filter @orbix/core test`
Expected: no errors; full core suite (incl. Phase-1 tv tests) still green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tv/proxy.ts packages/core/src/tv/proxy.test.ts packages/core/src/index.ts
git commit -m "feat(tv): core proxy signing, playlist rewrite and private-IP guard" \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 2: API — `tv-upstream.ts` hardened fetcher (undici + validating lookup)

**Files:**
- Modify: `apps/api/package.json` (add `undici`)
- Create: `apps/api/src/lib/tv-upstream.ts`
- Create: `apps/api/src/lib/tv-upstream.test.ts`

**Interfaces:**
- Consumes: `isPrivateHost` from `@orbix/core` (Task 1); `undici` `Agent`/`fetch`; `node:dns`, `node:net`.
- Produces (fixed contract, plus a `close()` for clean shutdown):
  ```ts
  export interface UpstreamResult {
    finalUrl: string;
    status: number;
    headers: Record<string, string>;
    body: ReadableStream<Uint8Array> | null;
    text?: string;
  }
  export const BROWSER_UA: string; // pinned Chrome 126 UA (default when stream.userAgent is null)
  export function makeTvUpstream(opts?: { lookup?: LookupFunction }): {
    fetchUpstream(url: string, init: { userAgent: string | null; referrer: string | null; wantText: boolean; timeoutMs?: number }): Promise<UpstreamResult>;
    close(): Promise<void>;
  };
  export type TvUpstream = ReturnType<typeof makeTvUpstream>;
  ```
- SSRF posture (all four layers): http(s) schemes only; **literal-IP hostnames pre-checked with `isPrivateHost` before any dial** (DNS lookup never runs for IP literals — this is what rejects `http://127.0.0.1/...`); DNS resolution inside the undici Agent goes through a **validating lookup that rejects private answers on every resolution** (closes rebinding); redirects followed **manually (cap 5)** so every hop re-runs both checks. The `opts.lookup` test override replaces only the DNS layer — the literal-IP pre-check always applies, so test fixtures use a fake hostname mapped to loopback by the injected lookup.

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @orbix/api add undici`
Expected: `apps/api/package.json` gains `undici` (latest v7.x), lockfile updated.

- [ ] **Step 2: Write the failing test** — create `apps/api/src/lib/tv-upstream.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFunction } from "node:net";
import { makeTvUpstream, BROWSER_UA } from "./tv-upstream";

const FIXTURE_HOST = "tv-upstream.fixture";

let origin: http.Server;
let port = 0;
let lastHeaders: http.IncomingHttpHeaders = {};

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    lastHeaders = req.headers;
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain", "x-fixture": "1" });
      res.end("hello");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      res.end();
      return;
    }
    if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  port = (origin.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

// Test-only lookup: maps the fixture hostname to loopback WITHOUT the private
// check (the real guard would rightly refuse it). Honors options.all because
// Node's happy-eyeballs connector calls lookup with { all: true }.
const fixtureLookup: LookupFunction = (hostname, options, callback) => {
  const cb = callback as (err: Error | null, address: unknown, family?: number) => void;
  if (hostname !== FIXTURE_HOST) return cb(new Error(`unexpected host ${hostname}`), null);
  if ((options as { all?: boolean }).all) return cb(null, [{ address: "127.0.0.1", family: 4 }]);
  return cb(null, "127.0.0.1", 4);
};

function fixtureUpstream() {
  return makeTvUpstream({ lookup: fixtureLookup });
}

describe("makeTvUpstream (fixture lookup)", () => {
  it("fetches text with the pinned browser UA when userAgent is null", async () => {
    const upstream = fixtureUpstream();
    const res = await upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/ok`, {
      userAgent: null,
      referrer: null,
      wantText: true,
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe("hello");
    expect(res.body).toBeNull();
    expect(res.finalUrl).toBe(`http://${FIXTURE_HOST}:${port}/ok`);
    expect(res.headers["x-fixture"]).toBe("1");
    expect(lastHeaders["user-agent"]).toBe(BROWSER_UA);
    expect(lastHeaders["referer"]).toBeUndefined();
    await upstream.close();
  });

  it("sends the stream's own userAgent and referrer when set", async () => {
    const upstream = fixtureUpstream();
    await upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/ok`, {
      userAgent: "MyPlayer/1.0",
      referrer: "http://portal.example/",
      wantText: true,
    });
    expect(lastHeaders["user-agent"]).toBe("MyPlayer/1.0");
    expect(lastHeaders["referer"]).toBe("http://portal.example/");
    await upstream.close();
  });

  it("follows redirects manually and reports the FINAL url", async () => {
    const upstream = fixtureUpstream();
    const res = await upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/redirect`, {
      userAgent: null,
      referrer: null,
      wantText: true,
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe("hello");
    expect(res.finalUrl).toBe(`http://${FIXTURE_HOST}:${port}/ok`);
    await upstream.close();
  });

  it("rejects a redirect loop after 5 hops", async () => {
    const upstream = fixtureUpstream();
    await expect(
      upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/loop`, {
        userAgent: null,
        referrer: null,
        wantText: true,
      }),
    ).rejects.toThrow(/redirect/i);
    await upstream.close();
  });

  it("returns a readable byte stream when wantText is false", async () => {
    const upstream = fixtureUpstream();
    const res = await upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/ok`, {
      userAgent: null,
      referrer: null,
      wantText: false,
    });
    expect(res.text).toBeUndefined();
    expect(res.body).not.toBeNull();
    const text = await new Response(res.body as unknown as BodyInit).text();
    expect(text).toBe("hello");
    await upstream.close();
  });

  it("rejects non-http(s) schemes", async () => {
    const upstream = fixtureUpstream();
    await expect(
      upstream.fetchUpstream("file:///etc/passwd", { userAgent: null, referrer: null, wantText: true }),
    ).rejects.toThrow();
    await upstream.close();
  });
});

describe("makeTvUpstream (REAL guard — no lookup override)", () => {
  it("blocks a literal loopback IP before any dial", async () => {
    const upstream = makeTvUpstream();
    await expect(
      upstream.fetchUpstream(`http://127.0.0.1:${port}/ok`, {
        userAgent: null,
        referrer: null,
        wantText: true,
      }),
    ).rejects.toThrow(/private/i);
    await upstream.close();
  });

  it("blocks a hostname that resolves to a private address (localhost)", async () => {
    const upstream = makeTvUpstream();
    await expect(
      upstream.fetchUpstream(`http://localhost:${port}/ok`, {
        userAgent: null,
        referrer: null,
        wantText: true,
      }),
    ).rejects.toThrow();
    await upstream.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/lib/tv-upstream.test.ts`
Expected: FAIL — `./tv-upstream` module does not exist.

- [ ] **Step 4: Implement** — create `apps/api/src/lib/tv-upstream.ts`:

```typescript
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import dns from "node:dns";
import type { LookupAddress } from "node:dns";
import type { ReadableStream } from "node:stream/web";
import { Agent, fetch as undiciFetch } from "undici";
import type { buildConnector } from "undici";
import { isPrivateHost } from "@orbix/core";

/**
 * Hardened fetcher for TV upstreams (playlists + segments).
 *
 * SSRF posture (defense in depth):
 *  - http/https URLs only;
 *  - literal-IP hosts are checked with isPrivateHost BEFORE any dial (the
 *    DNS lookup below never runs for IP literals);
 *  - DNS resolution happens inside the undici Agent via a validating lookup
 *    that rejects private/link-local/ULA answers on EVERY resolution — a
 *    hostname cannot rebind to 127.0.0.1 mid-session;
 *  - redirects are followed manually (cap 5) so every hop re-runs both checks.
 *
 * The optional `lookup` override (tests) replaces only the DNS layer; the
 * literal-IP pre-check always applies.
 */

export interface UpstreamResult {
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
  text?: string;
}

/** Pinned modern-browser UA — ZDF & friends 403 curl-ish agents (spec probe). */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** dns.lookup that fails when any resolved address is private (rebinding guard). */
const validatingLookup: LookupFunction = (hostname, options, callback) => {
  const cb = callback as (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void;
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0) {
      return cb(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), []);
    }
    for (const a of list) {
      if (isPrivateHost(a.address)) {
        return cb(
          Object.assign(new Error(`private upstream blocked: ${hostname}`), { code: "EPRIVATE" }),
          [],
        );
      }
    }
    if ((options as { all?: boolean }).all) return cb(null, list);
    return cb(null, list[0]!.address, list[0]!.family);
  });
};

export function makeTvUpstream(opts?: { lookup?: LookupFunction }) {
  const connect = {
    lookup: opts?.lookup ?? validatingLookup,
    timeout: 5_000, // connect timeout (spec: ~5 s)
  } as buildConnector.BuildOptions;
  const agent = new Agent({ connect, headersTimeout: 10_000 }); // header timeout (spec: ~10 s)

  async function fetchUpstream(
    url: string,
    init: { userAgent: string | null; referrer: string | null; wantText: boolean; timeoutMs?: number },
  ): Promise<UpstreamResult> {
    const signal = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const headers: Record<string, string> = { "user-agent": init.userAgent ?? BROWSER_UA };
    if (init.referrer) headers["referer"] = init.referrer;

    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(current); // throws on junk — caller maps to 502
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`unsupported scheme: ${parsed.protocol}`);
      }
      // Literal-IP hosts never reach the DNS lookup — check them directly.
      const bareHost = parsed.hostname.replace(/^\[|\]$/g, ""); // strip [v6] brackets
      if (isIP(bareHost) !== 0 && isPrivateHost(bareHost)) {
        throw new Error(`private upstream blocked: ${bareHost}`);
      }

      const res = await undiciFetch(current, {
        method: "GET",
        headers,
        redirect: "manual",
        dispatcher: agent,
        signal,
      });

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) throw new Error(`redirect without location from ${current}`);
        if (hop === MAX_REDIRECTS) throw new Error("too many redirects");
        current = new URL(location, current).toString();
        continue;
      }

      const headerRecord: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headerRecord[key] = value;
      });

      if (init.wantText) {
        const text = await res.text();
        return { finalUrl: current, status: res.status, headers: headerRecord, body: null, text };
      }
      return {
        finalUrl: current,
        status: res.status,
        headers: headerRecord,
        body: res.body as unknown as ReadableStream<Uint8Array> | null,
      };
    }
    throw new Error("too many redirects");
  }

  return {
    fetchUpstream,
    /** Close keep-alive sockets (app shutdown / test teardown). */
    close: () => agent.close(),
  };
}

export type TvUpstream = ReturnType<typeof makeTvUpstream>;
```

Note on types: `connect: { lookup }` is spread into `net.connect`/`tls.connect` options at runtime; the `as buildConnector.BuildOptions` cast covers undici versions whose `BuildOptions` type doesn't spell out `lookup`. If your undici version types it natively, the cast is a harmless no-op — keep it.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orbix/api exec vitest run src/lib/tv-upstream.test.ts`
Expected: PASS — all 8 tests (fixture host fetches, UA/referrer forwarding, manual redirect + final URL, loop cap, byte stream, scheme rejection, literal-IP block, localhost block).

- [ ] **Step 6: Package gates**

Run: `pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api test`
Expected: green (existing api suite unaffected).

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/lib/tv-upstream.ts apps/api/src/lib/tv-upstream.test.ts
git commit -m "feat(tv): SSRF-hardened upstream fetcher (undici agent + validating DNS lookup)" \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 3: API — play + proxy + health routes (fixture-origin tests)

**Files:**
- Create: `apps/api/src/routes/tv-play.ts`
- Create: `apps/api/src/routes/tv-play.test.ts`
- Modify: `apps/api/src/app.ts` (register route; add `tvUpstream` to `buildApp` overrides)

**Interfaces:**
- Consumes: `orderStreams`, `rewritePlaylist`, `signProxyPayload`, `verifyProxyPayload`, `encodeUpstream`, `decodeUpstream` from `@orbix/core`; `requireAuth` (`../lib/auth`); `requireTvAccess` (`../lib/tv-access`, Phase 1); `makeTvUpstream`/`TvUpstream` (Task 2); `prisma.tvChannel`/`prisma.tvStream`.
- Produces: `export default function tvPlayRoute(env: { SESSION_SECRET: string }, deps?: { upstream?: TvUpstream })` (env-factory pattern like `streamRoute(env)`), registering under the caller's `/api` prefix:
  - `GET /tv/channels/:id/play` `[requireAuth, requireTvAccess]` → 404 unknown/hidden channel; `orderStreams` over the channel's streams; 409 `{error:"no_playable_stream"}` when none; else `{ channel: {id,number,name,logo,country,quality}, nowNext: null, sources: [{streamId, src: "/api/tv/proxy/"+streamId+"/index.m3u8", quality, label}] }` (max 3 sources).
  - `GET /tv/proxy/:streamId/index.m3u8` `[same guards]` → 404 unless stream exists & channel not hidden; `fetchUpstream(stream.url, {userAgent, referrer, wantText:true})`; upstream non-200 → 502 `{error:"upstream_"+status}` + failCount bump; fetch throw (private/DNS/timeout) → 502 `{error:"upstream_unreachable"}` + bump; else `rewritePlaylist(text, finalUrl, toProxy)` where `toProxy(abs, kind) = "/api/tv/proxy/"+streamId+"/"+(kind==="playlist"?"p":"s")+"?u="+encodeUpstream(abs)+"&sig="+signProxyPayload(env.SESSION_SECRET, streamId, abs)`; reply `content-type: application/vnd.apple.mpegurl`, `cache-control: no-store`.
  - `GET /tv/proxy/:streamId/p?u&sig` `[same guards]` → decode + verify else 403 `{error:"bad_sig"}`; fetch `wantText:true`; rewrite against **its** finalUrl; no-store.
  - `GET /tv/proxy/:streamId/s?u&sig` `[same guards]` → verify else 403; fetch `wantText:false`; stream body to `reply.raw` via `Readable.fromWeb` pipe (hijack first — SSE-route pattern), forward `content-type`/`content-length` when present, no-store; upstream error → 502.
  - `POST /tv/streams/:id/health` `[requireAuth, requireTvAccess]` body `{ok: boolean, code?: string}` → `ok:true` → `{status:"ok", failCount:0, lastOkAt:now, lastCheckAt:now}`; `ok:false` → `failCount++`, `status = failCount>=8 ? "dead" : failCount>=3 ? "degraded" : previous`, `lastCheckAt:now`.
- `buildApp(env, overrides?)` gains `tvUpstream?: TvUpstream` beside the existing `mountRuntime` override so tests can inject the fixture lookup.

- [ ] **Step 1: Write the failing tests** — create `apps/api/src/routes/tv-play.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFunction } from "node:net";
import { buildApp } from "../app";
import { makeTvUpstream, BROWSER_UA } from "../lib/tv-upstream";
import { encodeUpstream, signProxyPayload } from "@orbix/core";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const FIXTURE_HOST = "tv-origin.fixture";
const SEGMENT_BYTES = Buffer.from("fake-ts-segment-bytes");

let origin: http.Server;
let port = 0;
const seenHeaders: Record<string, http.IncomingHttpHeaders> = {};

// CRLF like real iptv-org playlists; master references a variant + alt audio.
const master = () =>
  [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="alt",URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aud"',
    "media.m3u8",
    "",
  ].join("\r\n");

const media = () =>
  [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:6",
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0',
    "#EXTINF:6.0,",
    "segment.ts",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    seenHeaders[req.url ?? ""] = req.headers;
    if (req.url === "/master.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end(master());
    } else if (req.url === "/media.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end(media());
    } else if (req.url === "/segment.ts") {
      res.writeHead(200, { "content-type": "video/mp2t", "content-length": String(SEGMENT_BYTES.length) });
      res.end(SEGMENT_BYTES);
    } else if (req.url === "/key.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from("0123456789abcdef"));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  port = (origin.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

const fixtureLookup: LookupFunction = (hostname, options, callback) => {
  const cb = callback as (err: Error | null, address: unknown, family?: number) => void;
  if (hostname !== FIXTURE_HOST) return cb(new Error(`unexpected host ${hostname}`), null);
  if ((options as { all?: boolean }).all) return cb(null, [{ address: "127.0.0.1", family: 4 }]);
  return cb(null, "127.0.0.1", 4);
};

const cookies = { orbix_session: "s1", orbix_profile: "p1" };
const standardProfile = { id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null, language: "en" };
const kidsProfile = { id: "p1", name: "K", avatar: null, kind: "kids", maturityCap: 0, language: "en" };

function streamRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "st1",
    url: `http://${FIXTURE_HOST}:${port}/master.m3u8`,
    referrer: null,
    userAgent: null,
    status: "unknown",
    failCount: 0,
    channel: { hidden: false },
    ...overrides,
  };
}

async function buildTvApp(profile: unknown = standardProfile, withFixtureUpstream = true) {
  const app = await buildApp(
    env,
    withFixtureUpstream ? { tvUpstream: makeTvUpstream({ lookup: fixtureLookup }) } : undefined,
  );
  (app as any).prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  (app as any).prisma.profile = { findUnique: async () => profile };
  return app;
}

describe("GET /tv/channels/:id/play", () => {
  it("orders sources ok>unknown>degraded, skips dead/non-hls, caps at 3", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvChannel = {
      findUnique: async () => ({
        id: "ch1", number: 5, name: "One", logoPath: "channel/one.png", country: "RU", quality: "1080p", hidden: false,
        streams: [
          { id: "dead", quality: null, label: null, priority: 0, protocol: "hls", status: "dead" },
          { id: "dash", quality: null, label: null, priority: 0, protocol: "dash", status: "ok" },
          { id: "deg", quality: null, label: null, priority: 0, protocol: "hls", status: "degraded" },
          { id: "unk", quality: null, label: "Not 24/7", priority: 1, protocol: "hls", status: "unknown" },
          { id: "ok2", quality: "720p", label: null, priority: 2, protocol: "hls", status: "ok" },
          { id: "ok1", quality: "1080p", label: null, priority: 1, protocol: "hls", status: "ok" },
        ],
      }),
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.channel).toMatchObject({ id: "ch1", number: 5, name: "One", logo: "channel/one.png", country: "RU", quality: "1080p" });
    expect(body.nowNext).toBeNull();
    expect(body.sources.map((s: any) => s.streamId)).toEqual(["ok1", "ok2", "unk"]);
    expect(body.sources[0]).toMatchObject({ src: "/api/tv/proxy/ok1/index.m3u8", quality: "1080p", label: null });
    await app.close();
  });

  it("409s with no_playable_stream when nothing is playable", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvChannel = {
      findUnique: async () => ({
        id: "ch1", number: 5, name: "One", logoPath: null, country: null, quality: null, hidden: false,
        streams: [
          { id: "dead", quality: null, label: null, priority: 0, protocol: "hls", status: "dead" },
          { id: "dash", quality: null, label: null, priority: 0, protocol: "dash", status: "ok" },
        ],
      }),
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_playable_stream");
    await app.close();
  });

  it("404s unknown and hidden channels", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvChannel = { findUnique: async () => null };
    expect((await app.inject({ method: "GET", url: "/api/tv/channels/nope/play", cookies })).statusCode).toBe(404);
    (app as any).prisma.tvChannel = {
      findUnique: async () => ({ id: "ch1", number: 1, name: "H", logoPath: null, country: null, quality: null, hidden: true, streams: [] }),
    };
    expect((await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies })).statusCode).toBe(404);
    await app.close();
  });

  it("403s kids profiles (server-side, before any lookup)", async () => {
    const app = await buildTvApp(kidsProfile);
    expect((await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8", cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/tv/streams/st1/health", cookies, payload: { ok: true } })).statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /tv/proxy/* (fixture HLS origin end-to-end)", () => {
  it("rewrites master → media → segment through /p and /s with valid sigs", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvStream = {
      findUnique: async () => streamRow(),
      update: async () => ({}),
    };

    // 1) Entry playlist.
    const res1 = await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8", cookies });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers["content-type"]).toContain("mpegurl");
    expect(res1.headers["cache-control"]).toBe("no-store");
    expect(seenHeaders["/master.m3u8"]?.["user-agent"]).toBe(BROWSER_UA); // null userAgent → pinned browser UA
    const masterOut = res1.body;
    expect(masterOut).toMatch(/#EXT-X-MEDIA:[^\n]*URI="\/api\/tv\/proxy\/st1\/p\?u=/); // alt audio → /p
    const pLine = masterOut.split("\n").find((l) => l.startsWith("/api/tv/proxy/st1/p?"));
    expect(pLine).toBeTruthy(); // variant URI line → /p

    // 2) Nested playlist through /p.
    const res2 = await app.inject({ method: "GET", url: pLine!, cookies });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers["cache-control"]).toBe("no-store");
    const mediaOut = res2.body;
    expect(mediaOut).toMatch(/#EXT-X-KEY:[^\n]*URI="\/api\/tv\/proxy\/st1\/s\?u=/); // key → /s
    const sLine = mediaOut.split("\n").find((l) => l.startsWith("/api/tv/proxy/st1/s?"));
    expect(sLine).toBeTruthy(); // segment → /s

    // 3) Opaque bytes through /s.
    const res3 = await app.inject({ method: "GET", url: sLine!, cookies });
    expect(res3.statusCode).toBe(200);
    expect(res3.rawPayload.equals(SEGMENT_BYTES)).toBe(true);
    expect(res3.headers["content-type"]).toBe("video/mp2t");
    expect(res3.headers["content-length"]).toBe(String(SEGMENT_BYTES.length));
    expect(res3.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("403s a bad signature and a signature minted for another stream", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvStream = { findUnique: async () => streamRow(), update: async () => ({}) };
    const target = `http://${FIXTURE_HOST}:${port}/media.m3u8`;
    const u = encodeUpstream(target);

    const bad = await app.inject({ method: "GET", url: `/api/tv/proxy/st1/p?u=${u}&sig=${"A".repeat(32)}`, cookies });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toBe("bad_sig");

    const foreignSig = signProxyPayload(env.SESSION_SECRET, "other-stream", target);
    const foreign = await app.inject({ method: "GET", url: `/api/tv/proxy/st1/s?u=${u}&sig=${foreignSig}`, cookies });
    expect(foreign.statusCode).toBe(403);

    const missing = await app.inject({ method: "GET", url: `/api/tv/proxy/st1/p?u=${u}`, cookies });
    expect(missing.statusCode).toBe(403);
    await app.close();
  });

  it("502s upstream_404 and bumps failCount on upstream error status", async () => {
    const app = await buildTvApp();
    let captured: { data?: Record<string, unknown> } = {};
    (app as any).prisma.tvStream = {
      findUnique: async () => streamRow({ url: `http://${FIXTURE_HOST}:${port}/missing.m3u8` }),
      update: async (args: { data: Record<string, unknown> }) => { captured = args; return {}; },
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8", cookies });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_404");
    expect(captured.data).toMatchObject({ failCount: 1, status: "unknown" });
    await app.close();
  });

  it("rejects a private upstream with 502 through the REAL lookup path", async () => {
    const app = await buildTvApp(standardProfile, false); // NO tvUpstream override
    (app as any).prisma.tvStream = {
      findUnique: async () => streamRow({ url: `http://127.0.0.1:${port}/master.m3u8` }),
      update: async () => ({}),
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8", cookies });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unreachable");
    await app.close();
  });

  it("404s a stream whose channel is hidden", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvStream = {
      findUnique: async () => streamRow({ channel: { hidden: true } }),
      update: async () => ({}),
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8", cookies });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /tv/streams/:id/health", () => {
  async function bump(failCount: number, status: string, ok: boolean) {
    const app = await buildTvApp();
    let captured: { data?: Record<string, unknown> } = {};
    (app as any).prisma.tvStream = {
      findUnique: async () => ({ id: "st1", status, failCount }),
      update: async (args: { data: Record<string, unknown> }) => { captured = args; return {}; },
    };
    const res = await app.inject({
      method: "POST", url: "/api/tv/streams/st1/health", cookies,
      payload: ok ? { ok: true } : { ok: false, code: "fragLoadError" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
    return captured.data!;
  }

  it("ok:false keeps previous status below 3 failures", async () => {
    expect(await bump(1, "unknown", false)).toMatchObject({ failCount: 2, status: "unknown" });
  });
  it("ok:false escalates to degraded at 3", async () => {
    expect(await bump(2, "unknown", false)).toMatchObject({ failCount: 3, status: "degraded" });
  });
  it("ok:false escalates to dead at 8", async () => {
    expect(await bump(7, "degraded", false)).toMatchObject({ failCount: 8, status: "dead" });
  });
  it("ok:true resets to ok with failCount 0 and stamps lastOkAt", async () => {
    const data = await bump(5, "degraded", true);
    expect(data).toMatchObject({ status: "ok", failCount: 0 });
    expect(data.lastOkAt).toBeInstanceOf(Date);
    expect(data.lastCheckAt).toBeInstanceOf(Date);
  });
  it("404s an unknown stream", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvStream = { findUnique: async () => null, update: async () => ({}) };
    const res = await app.inject({ method: "POST", url: "/api/tv/streams/nope/health", cookies, payload: { ok: true } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/tv-play.test.ts`
Expected: FAIL — `tv-play` route module missing / `buildApp` has no `tvUpstream` override / all routes 404.

- [ ] **Step 3a: Implement the route** — create `apps/api/src/routes/tv-play.ts`:

```typescript
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  orderStreams,
  rewritePlaylist,
  signProxyPayload,
  verifyProxyPayload,
  encodeUpstream,
  decodeUpstream,
} from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { requireTvAccess } from "../lib/tv-access";
import { makeTvUpstream, type TvUpstream, type UpstreamResult } from "../lib/tv-upstream";

const MAX_SOURCES = 3;
const DEGRADED_AT = 3;
const DEAD_AT = 8;

interface StreamRow {
  id: string;
  url: string;
  referrer: string | null;
  userAgent: string | null;
  status: string;
  failCount: number;
}

/**
 * Live-TV playback: tune endpoint + signed HLS proxy + player health feedback.
 * Every route sits behind requireAuth + requireTvAccess (kids → 403, spec §Kids).
 * The proxy only fetches URLs the server itself minted while rewriting
 * playlists (HMAC over streamId|url with SESSION_SECRET) — see core tv/proxy.
 */
export default function tvPlayRoute(
  env: { SESSION_SECRET: string },
  deps?: { upstream?: TvUpstream },
) {
  return async function (app: FastifyInstance) {
    const upstream = deps?.upstream ?? makeTvUpstream();
    app.addHook("onClose", async () => {
      await upstream.close();
    });

    const guards = { preHandler: [requireAuth(app), requireTvAccess(app)] };

    const toProxy = (streamId: string) => (absUrl: string, kind: "playlist" | "bytes") =>
      `/api/tv/proxy/${streamId}/${kind === "playlist" ? "p" : "s"}` +
      `?u=${encodeUpstream(absUrl)}&sig=${signProxyPayload(env.SESSION_SECRET, streamId, absUrl)}`;

    /** Load a proxyable stream row; sends 404 and returns null when absent/hidden. */
    async function loadStream(streamId: string, reply: FastifyReply): Promise<StreamRow | null> {
      const stream = await app.prisma.tvStream.findUnique({
        where: { id: streamId },
        select: {
          id: true,
          url: true,
          referrer: true,
          userAgent: true,
          status: true,
          failCount: true,
          channel: { select: { hidden: true } },
        },
      });
      if (!stream || stream.channel.hidden) {
        void reply.code(404).send({ error: "not_found" });
        return null;
      }
      return stream;
    }

    /** failCount++ with degraded/dead thresholds (proxy-side upstream failures). */
    async function bumpFailure(stream: { id: string; failCount: number; status: string }) {
      const failCount = stream.failCount + 1;
      const status = failCount >= DEAD_AT ? "dead" : failCount >= DEGRADED_AT ? "degraded" : stream.status;
      await app.prisma.tvStream.update({
        where: { id: stream.id },
        data: { failCount, status, lastCheckAt: new Date() },
      });
    }

    /** Verify the u/sig pair for a stream; sends 403 and returns null on failure. */
    function verifiedTarget(
      streamId: string,
      query: { u?: string; sig?: string },
      reply: FastifyReply,
    ): string | null {
      const target = query.u ? decodeUpstream(query.u) : null;
      if (!target || !query.sig || !verifyProxyPayload(env.SESSION_SECRET, streamId, target, query.sig)) {
        void reply.code(403).send({ error: "bad_sig" });
        return null;
      }
      return target;
    }

    // ------------------------------------------------------------------
    // GET /tv/channels/:id/play — ordered proxied sources for a channel
    // ------------------------------------------------------------------
    app.get<{ Params: { id: string } }>("/tv/channels/:id/play", guards, async (req, reply) => {
      const channel = await app.prisma.tvChannel.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          number: true,
          name: true,
          logoPath: true,
          country: true,
          quality: true,
          hidden: true,
          streams: {
            select: { id: true, quality: true, label: true, priority: true, protocol: true, status: true },
          },
        },
      });
      if (!channel || channel.hidden) return reply.code(404).send({ error: "not_found" });

      const ordered = orderStreams(channel.streams);
      if (ordered.length === 0) return reply.code(409).send({ error: "no_playable_stream" });

      return {
        channel: {
          id: channel.id,
          number: channel.number,
          name: channel.name,
          logo: channel.logoPath,
          country: channel.country,
          quality: channel.quality,
        },
        nowNext: null, // phase 3 (EPG) fills this
        sources: ordered.slice(0, MAX_SOURCES).map((s) => ({
          streamId: s.id,
          src: `/api/tv/proxy/${s.id}/index.m3u8`,
          quality: s.quality,
          label: s.label,
        })),
      };
    });

    // ------------------------------------------------------------------
    // GET /tv/proxy/:streamId/index.m3u8 — entry playlist (stream's own URL)
    // ------------------------------------------------------------------
    app.get<{ Params: { streamId: string } }>(
      "/tv/proxy/:streamId/index.m3u8",
      guards,
      async (req, reply) => {
        const stream = await loadStream(req.params.streamId, reply);
        if (!stream) return;

        let result: UpstreamResult;
        try {
          result = await upstream.fetchUpstream(stream.url, {
            userAgent: stream.userAgent,
            referrer: stream.referrer,
            wantText: true,
          });
        } catch {
          await bumpFailure(stream);
          return reply.code(502).send({ error: "upstream_unreachable" });
        }
        if (result.status !== 200) {
          await bumpFailure(stream);
          return reply.code(502).send({ error: `upstream_${result.status}` });
        }

        const rewritten = rewritePlaylist(result.text ?? "", result.finalUrl, toProxy(stream.id));
        return reply
          .code(200)
          .header("content-type", "application/vnd.apple.mpegurl")
          .header("cache-control", "no-store")
          .send(rewritten);
      },
    );

    // ------------------------------------------------------------------
    // GET /tv/proxy/:streamId/p — nested playlists (variants, alt media)
    // ------------------------------------------------------------------
    app.get<{ Params: { streamId: string }; Querystring: { u?: string; sig?: string } }>(
      "/tv/proxy/:streamId/p",
      guards,
      async (req, reply) => {
        const stream = await loadStream(req.params.streamId, reply);
        if (!stream) return;
        const target = verifiedTarget(stream.id, req.query, reply);
        if (!target) return;

        let result: UpstreamResult;
        try {
          result = await upstream.fetchUpstream(target, {
            userAgent: stream.userAgent,
            referrer: stream.referrer,
            wantText: true,
          });
        } catch {
          return reply.code(502).send({ error: "upstream_unreachable" });
        }
        if (result.status !== 200) return reply.code(502).send({ error: `upstream_${result.status}` });

        // Rewrite against THIS playlist's final URL (redirect-hop safe).
        const rewritten = rewritePlaylist(result.text ?? "", result.finalUrl, toProxy(stream.id));
        return reply
          .code(200)
          .header("content-type", "application/vnd.apple.mpegurl")
          .header("cache-control", "no-store")
          .send(rewritten);
      },
    );

    // ------------------------------------------------------------------
    // GET /tv/proxy/:streamId/s — opaque bytes: segments, init sections, keys
    // ------------------------------------------------------------------
    app.get<{ Params: { streamId: string }; Querystring: { u?: string; sig?: string } }>(
      "/tv/proxy/:streamId/s",
      guards,
      async (req, reply) => {
        const stream = await loadStream(req.params.streamId, reply);
        if (!stream) return;
        const target = verifiedTarget(stream.id, req.query, reply);
        if (!target) return;

        let result: UpstreamResult;
        try {
          result = await upstream.fetchUpstream(target, {
            userAgent: stream.userAgent,
            referrer: stream.referrer,
            wantText: false,
          });
        } catch {
          return reply.code(502).send({ error: "upstream_unreachable" });
        }
        if (result.status !== 200 || !result.body) {
          return reply.code(502).send({ error: `upstream_${result.status}` });
        }

        // Pure pass-through (Threadfin lesson: never buffer in-process).
        // Hijack so Fastify leaves the raw response to us (SSE-route pattern).
        reply.hijack();
        const raw = reply.raw;
        const headers: Record<string, string> = { "cache-control": "no-store" };
        const ct = result.headers["content-type"];
        if (ct) headers["content-type"] = ct;
        const cl = result.headers["content-length"];
        if (cl) headers["content-length"] = cl;
        raw.writeHead(200, headers);

        const body = Readable.fromWeb(result.body as NodeWebReadableStream<Uint8Array>);
        body.pipe(raw); // backpressure via the pipe
        body.on("error", () => raw.destroy());
        raw.on("close", () => body.destroy());
      },
    );

    // ------------------------------------------------------------------
    // POST /tv/streams/:id/health — player health feedback
    // ------------------------------------------------------------------
    app.post<{ Params: { id: string }; Body: { ok?: boolean; code?: string } | null }>(
      "/tv/streams/:id/health",
      guards,
      async (req, reply) => {
        const stream = await app.prisma.tvStream.findUnique({
          where: { id: req.params.id },
          select: { id: true, status: true, failCount: true },
        });
        if (!stream) return reply.code(404).send({ error: "not_found" });

        const now = new Date();
        if (req.body?.ok === true) {
          await app.prisma.tvStream.update({
            where: { id: stream.id },
            data: { status: "ok", failCount: 0, lastOkAt: now, lastCheckAt: now },
          });
        } else {
          if (req.body?.code) req.log.info({ streamId: stream.id, code: req.body.code }, "tv stream failure reported");
          const failCount = stream.failCount + 1;
          const status = failCount >= DEAD_AT ? "dead" : failCount >= DEGRADED_AT ? "degraded" : stream.status;
          await app.prisma.tvStream.update({
            where: { id: stream.id },
            data: { failCount, status, lastCheckAt: now },
          });
        }
        return { ok: true };
      },
    );
  };
}
```

- [ ] **Step 3b: Wire into `app.ts`** — three edits to `apps/api/src/app.ts` (Phase 1 already added its own tv imports/registrations; anchor on what exists after it):

1. Add imports beside the other route imports:
```typescript
import tvPlayRoute from "./routes/tv-play";
import type { TvUpstream } from "./lib/tv-upstream";
```
2. Widen the `buildApp` overrides parameter (currently `{ mountRuntime?: MountRuntime }`):
```typescript
export async function buildApp(
  env: Env,
  overrides?: { mountRuntime?: MountRuntime; tvUpstream?: TvUpstream },
): Promise<FastifyInstance> {
```
3. Register the route **immediately after the Phase-1 `/api`-prefixed TV route registrations** (tv-sources / tv-catalog), before the metadata-refresh interval block:
```typescript
  await app.register(tvPlayRoute(env, { upstream: overrides?.tvUpstream }), { prefix: "/api" });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/tv-play.test.ts`
Expected: PASS — 14 tests: play ordering/409/404/kids-403s, master→media→segment end-to-end rewrite (UA asserted), bad/foreign/missing sig 403s, upstream_404 + failCount bump, real-guard private rejection, hidden-channel 404, health threshold table, health 404.

- [ ] **Step 5: Package gates**

Run: `pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/tv-play.ts apps/api/src/routes/tv-play.test.ts apps/api/src/app.ts
git commit -m "feat(tv): signed HLS proxy, tune endpoint and stream health feedback" \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 4: Web foundations — TV types, query hooks, pure helpers (TDD), `tv` i18n namespace

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/queries.ts`
- Create: `apps/web/src/lib/tv.ts`
- Create: `apps/web/src/lib/tv.test.ts`
- Modify: `apps/web/src/lib/i18n/index.ts`
- Create: `apps/web/src/locales/en/tv.json` (+ byte-copies for `es de pt ru fr`)

**Interfaces:**
- Consumes: API shapes from Phase 1 (`/tv/home`, `/tv/guide`, `/tv/channels/:id`, `/tv/favorites`, `/tv/channels/:id/programmes`) and Task 3 (`/tv/channels/:id/play`).
- Produces:
  - Types: `TvProgrammeSlot`, `TvChannelCard`, `TvHome`, `TvGuideResponse`, `TvPlaySource`, `TvPlayResponse`, `TvProgramme`, `TvSource`.
  - Hooks: `useTvHome()`, `useTvGuide(params)` (infinite, offset paging), `useTvChannel(id)`, `useTvFavorites()`, `useTvProgrammes(id)`.
  - Pure helpers: `channelInitials(name): string`, `channelHue(seed): number` (0–359 deterministic), `regionName(code, locale): string | null` (Intl.DisplayNames, iptv-org `UK`→ISO `GB`).
  - i18n: `"tv"` appended to `NAMESPACES`; `tv.json` in all 6 locales (non-en start as English copies — the parity test only compares key sets; the Phase-3 plan owns real translations).

- [ ] **Step 1: Write the failing helper test** — create `apps/web/src/lib/tv.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { channelInitials, channelHue, regionName } from "./tv";

describe("channelInitials", () => {
  it("takes the first letters of up to two words, uppercased", () => {
    expect(channelInitials("Первый канал")).toBe("ПК");
    expect(channelInitials("  bbc  one ")).toBe("BO");
    expect(channelInitials("ARD")).toBe("A");
  });
  it("falls back to ? for empty names", () => {
    expect(channelInitials("")).toBe("?");
    expect(channelInitials("   ")).toBe("?");
  });
});

describe("channelHue", () => {
  it("is deterministic with known values", () => {
    expect(channelHue("a")).toBe(97);
    expect(channelHue("b")).toBe(98);
    expect(channelHue("ab")).toBe(225);
    expect(channelHue("")).toBe(0);
  });
  it("always lands in 0..359", () => {
    for (const seed of ["cmb1x2y3", "ChannelOne.ru", "x".repeat(200), "☃"]) {
      const h = channelHue(seed);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe("regionName", () => {
  it("maps iptv-org UK to the ISO GB display name", () => {
    expect(regionName("UK", "en")).toBe("United Kingdom");
    expect(regionName("uk", "en")).toBe("United Kingdom");
  });
  it("resolves normal codes in the given locale", () => {
    expect(regionName("RU", "en")).toBe("Russia");
    expect(regionName("DE", "en")).toBe("Germany");
  });
  it("returns null for null/undefined and echoes junk codes", () => {
    expect(regionName(null, "en")).toBeNull();
    expect(regionName(undefined, "en")).toBeNull();
    expect(regionName("ZZZZ", "en")).toBe("ZZZZ");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orbix/web test src/lib/tv.test.ts`
Expected: FAIL — `./tv` module does not exist.

- [ ] **Step 3a: Create the helpers** — `apps/web/src/lib/tv.ts`:

```typescript
// Pure TV display helpers (unit-tested; no fetch/DOM).

/** Up to two initials from a channel name ("Первый канал" → "ПК"). */
export function channelInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

/** Deterministic hue (0..359) from a stable channel key — monogram tiles. */
export function channelHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Localized region display name; iptv-org uses "UK" where ISO says "GB". */
export function regionName(code: string | null | undefined, locale: string): string | null {
  if (!code) return null;
  const iso = code.toUpperCase() === "UK" ? "GB" : code.toUpperCase();
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(iso) ?? code;
  } catch {
    return code; // invalid code for Intl — echo it (guide chips still render)
  }
}
```

- [ ] **Step 3b: Add the TV types** — append to `apps/web/src/lib/types.ts` (end of file):

```typescript
/* ── TV — live channels (mirrors /api/tv/* shapes) ─────────────────────── */

/** One programme slot for now/next display (phase 3 EPG fills these). */
export interface TvProgrammeSlot {
  title: string;
  start: string;
  stop: string;
}

/** Channel card shared by /tv/home rails, /tv/guide rows and /tv/channels/:id. */
export interface TvChannelCard {
  id: string;
  number: number;
  name: string;
  country: string | null;
  categories: string[];
  quality: string | null;
  logo: string | null;
  healthy: boolean;
  favorite: boolean;
  /** Present on guide rows (null until the EPG phase lands). */
  now?: TvProgrammeSlot | null;
  next?: TvProgrammeSlot | null;
}

export interface TvHome {
  recents: TvChannelCard[];
  favorites: TvChannelCard[];
  countries: { code: string; channels: TvChannelCard[] }[];
  categories: { id: string; channels: TvChannelCard[] }[];
}

/** Windowed guide page (offset paging — never the whole catalog). */
export interface TvGuideResponse {
  total: number;
  channels: TvChannelCard[];
}

export interface TvPlaySource {
  streamId: string;
  src: string; // "/api/tv/proxy/<streamId>/index.m3u8"
  quality: string | null;
  label: string | null;
}

export interface TvPlayResponse {
  channel: {
    id: string;
    number: number;
    name: string;
    logo: string | null;
    country: string | null;
    quality: string | null;
  };
  nowNext: null;
  sources: TvPlaySource[];
}

/** One entry of a channel's day schedule. */
export interface TvProgramme {
  id: string;
  start: string;
  stop: string;
  title: string;
  description: string | null;
  category: string | null;
}

/** Admin: one configured TV source (iptv-org catalog or an M3U playlist). */
export interface TvSource {
  id: string;
  kind: "iptv-org" | "m3u";
  name: string;
  url: string | null;
  countries: string[];
  epgUrl: string | null;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  lastSyncAt: string | null;
}
```

- [ ] **Step 3c: Add the query hooks** — in `apps/web/src/lib/queries.ts`:

Change the first two import lines to:

```typescript
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { apiJson, apiFetch, ApiError } from "./api";
import type {
  AuthMe, HomeRow, MediaCard, MenuConfig, MenuItem, Profile, TitleDetail,
  TvChannelCard, TvGuideResponse, TvHome, TvProgramme,
} from "./types";
```

Append at the end of the file:

```typescript
/* ── TV — live channels ────────────────────────────────────────────────── */

export function useTvHome() {
  return useQuery({ queryKey: ["tv-home"], queryFn: () => apiJson<TvHome>("/tv/home") });
}

export interface TvGuideParams {
  country?: string;
  category?: string;
  favorites?: boolean;
  q?: string;
  limit?: number;
}

/** Windowed guide list: pages of `limit` (default 100) via offset paging. */
export function useTvGuide(params: TvGuideParams) {
  const limit = params.limit ?? 100;
  return useInfiniteQuery({
    queryKey: ["tv-guide", params],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (params.country) qs.set("country", params.country);
      if (params.category) qs.set("category", params.category);
      if (params.favorites) qs.set("favorites", "1");
      if (params.q) qs.set("q", params.q);
      qs.set("offset", String(pageParam));
      qs.set("limit", String(limit));
      return apiJson<TvGuideResponse>(`/tv/guide?${qs}`);
    },
    getNextPageParam: (last: TvGuideResponse, all: TvGuideResponse[]) => {
      const loaded = all.reduce((n, p) => n + p.channels.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
}

export function useTvChannel(id: string | undefined) {
  return useQuery({
    queryKey: ["tv-channel", id],
    enabled: !!id,
    queryFn: () => apiJson<TvChannelCard>(`/tv/channels/${id}`),
  });
}

export function useTvFavorites() {
  return useQuery({ queryKey: ["tv-favorites"], queryFn: () => apiJson<TvChannelCard[]>("/tv/favorites") });
}

/** Day schedule for the channel page (empty until the EPG phase). */
export function useTvProgrammes(id: string | undefined) {
  return useQuery({
    queryKey: ["tv-programmes", id],
    enabled: !!id,
    queryFn: () => apiJson<{ programmes: TvProgramme[] }>(`/tv/channels/${id}/programmes`),
  });
}
```

(Play/health/tune-event calls stay imperative `apiFetch`/`apiJson` inside the player components — they are actions, not cacheable queries.)

- [ ] **Step 3d: Create the `tv` namespace** — `apps/web/src/locales/en/tv.json`:

```json
{
  "title": "TV",
  "guide": "Guide",
  "rails": {
    "recents": "Recently watched",
    "favorites": "Favorites"
  },
  "empty": {
    "title": "No channels yet",
    "adminBody": "Sync the worldwide catalog or import an M3U playlist to start watching live TV.",
    "adminCta": "Add channels",
    "memberBody": "Ask your admin to add TV channels."
  },
  "badges": {
    "offline": "Offline"
  },
  "card": {
    "play": "Watch {{name}}",
    "favorite": "Add to favorites",
    "unfavorite": "Remove from favorites"
  },
  "guidePage": {
    "title": "TV Guide",
    "searchPlaceholder": "Search channels",
    "all": "All",
    "favorites": "Favorites",
    "channelCount_one": "{{count}} channel",
    "channelCount_other": "{{count}} channels",
    "empty": "No channels match.",
    "play": "Watch {{name}}",
    "schedule": "Channel details"
  },
  "channel": {
    "number": "Channel {{number}}",
    "watch": "Watch",
    "schedule": "Today's schedule",
    "scheduleEmpty": "No guide data for this channel yet.",
    "notFound": "Channel not found."
  },
  "player": {
    "loading": "Tuning…",
    "close": "Close player",
    "offline": "Channel appears offline",
    "nextChannel": "Next channel",
    "reconnecting": "Reconnecting…",
    "tryingSource": "Trying next source ({{n}}/{{total}})…",
    "source": "Source {{n}}/{{total}}",
    "miniGuide": "Channels"
  },
  "admin": {
    "title": "Live TV",
    "loadFailed": "Could not load TV sources.",
    "saveFailed": "Could not save changes.",
    "iptv": {
      "heading": "Worldwide catalog (iptv-org)",
      "description": "Opt-in sync of the iptv-org public-domain index of free, publicly available broadcasts. Pick the countries to import.",
      "enable": "Enable worldwide catalog",
      "countries": "Countries",
      "addCountryPlaceholder": "Other code (e.g. JP)",
      "addCountry": "Add"
    },
    "m3u": {
      "heading": "M3U playlists",
      "namePlaceholder": "Name (optional)",
      "urlPlaceholder": "https://example.com/playlist.m3u8",
      "addByUrl": "Add URL",
      "orFile": "…or upload a playlist file (max 5 MB):",
      "fileTooLarge": "File is larger than 5 MB.",
      "empty": "No playlists added yet."
    },
    "source": {
      "enabled": "Enabled",
      "syncNow": "Sync now",
      "syncing": "Syncing…",
      "lastSync": "Last sync: {{when}}",
      "never": "never"
    },
    "sync": {
      "progress": "{{phase}} — {{processed}}/{{total}}",
      "done": "Sync complete.",
      "error": "Sync failed: {{message}}",
      "streamError": "Lost the sync progress stream."
    },
    "legal": "Orbix ships no channels and no stream URLs. The worldwide catalog is an opt-in, at-runtime sync of the iptv-org public-domain index of publicly available broadcasts (DMCA blocklist honored, NSFW excluded). Imported playlists are your responsibility. Stream availability varies by country and network position; Orbix never bypasses DRM, tokens, or geo measures."
  },
  "wizard": {
    "title": "Add channels",
    "stepCountries": "1 · Pick countries",
    "stepM3u": "2 · Add a playlist (optional)",
    "stepSummary": "3 · Sync",
    "next": "Next",
    "skip": "Skip",
    "finish": "Go to TV",
    "summary": "Ready: {{countries}} countries enabled, {{sources}} M3U playlists."
  }
}
```

Copy it to the other 5 locales (temporary English values — the parity test only checks key sets; phase 3 translates):

```bash
for l in es de pt ru fr; do
  cp apps/web/src/locales/en/tv.json apps/web/src/locales/$l/tv.json
done
```

- [ ] **Step 3e: Register the namespace** — in `apps/web/src/lib/i18n/index.ts`, add `"tv"` to `NAMESPACES` (after `"errors"`):

```typescript
export const NAMESPACES = [
  "common",
  "auth",
  "profiles",
  "nav",
  "account",
  "settings",
  "libraries",
  "fix",
  "catalog",
  "search",
  "title",
  "player",
  "errors",
  "tv",
] as const;
```

- [ ] **Step 4: Run tests to verify green**

Run: `pnpm --filter @orbix/web test src/lib/tv.test.ts` → PASS.
Run: `pnpm --filter @orbix/web test src/locales/parity.test.ts` → PASS (the 5 copied `tv.json` files cover exactly the en key set).

- [ ] **Step 5: Package gates**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test`
Expected: green (existing web suite unaffected).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/queries.ts apps/web/src/lib/tv.ts apps/web/src/lib/tv.test.ts \
  apps/web/src/lib/i18n/index.ts apps/web/src/locales/en/tv.json apps/web/src/locales/es/tv.json \
  apps/web/src/locales/de/tv.json apps/web/src/locales/pt/tv.json apps/web/src/locales/ru/tv.json apps/web/src/locales/fr/tv.json
git commit -m "feat(tv): web TV types, query hooks, pure display helpers and tv i18n namespace" \
  -m "Non-en tv.json bundles are temporary English copies; the phase-3 plan translates them." \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 5: Web — `LiveTvPlayer` + `LiveTvOverlay` (failover, health, OSD, mini-guide, keys)

Built **before** the pages so Tasks 6–8 import a finished component (no interim wiring). Not routed yet — nothing renders it until Task 6; gates only need it to compile and lint.

**Files:**
- Create: `apps/web/src/components/tv/LiveTvPlayer.tsx`
- Create: `apps/web/src/components/tv/LiveTvOverlay.tsx`

**Interfaces:**
- Consumes: `apiFetch`/`apiJson`; `TvChannelCard`, `TvPlayResponse` (Task 4); `channelHue`/`channelInitials` (Task 4); Vidstack `MediaPlayer`/`MediaProvider`/`isHLSProvider` + `DefaultVideoLayout` and its two style imports (copied from `Player.tsx`); bundled `hls.js`.
- Produces:
  - `LiveTvPlayer(props: { channelId: string; attempt: number; onInfo(info: { play: TvPlayResponse; sourceIndex: number }): void; onControls(controls: { seekToLiveEdge(): void }): void; onSourcesExhausted(): void })` — a SIBLING of the VOD `Player`: **no decision/subs/progress fetches**. Fetches `/tv/channels/:id/play`, fires `POST /tv/events/:channelId` per tune (fire-and-forget), tries sources in order with the hls.js error ladder, reports health.
  - `LiveTvOverlay(props: { channels: TvChannelCard[]; initialId: string; onClose(): void })` — portal cinema (PlayerOverlay pattern): zap keys, OSD (auto-hide 4 s), `g` mini-guide drawer, Backspace last-channel, offline panel with Retry/Next.
- Division of labor: the **player** owns vidstack/hls wiring, source failover, health posts and the live-edge nudge; the **overlay** owns channel state (zap context = the `channels` prop, i.e. the exact list the opener was showing), keyboard surface, OSD and drawer. Retry after exhaustion = overlay bumps `attempt`, which re-tunes from source 0 (also the `key` of `MediaPlayer`, forcing a clean provider teardown per source/attempt).

- [ ] **Step 1: Create `apps/web/src/components/tv/LiveTvPlayer.tsx`:**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MediaPlayer,
  MediaProvider,
  isHLSProvider,
  type MediaPlayerInstance,
  type MediaProviderAdapter,
} from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import Hls from "hls.js";
import type { ErrorData } from "hls.js";
import { apiFetch, apiJson } from "@/lib/api";
import type { TvPlayResponse } from "@/lib/types";

/**
 * hls.js live tuning (spec §Player): tight manifest policy so a dead channel
 * fails within seconds (zap UX); patient fragment policy so a flaky-but-alive
 * origin gets retries; small live sync window with mild catch-up.
 */
const HLS_LIVE_CONFIG = {
  liveSyncDurationCount: 4,
  liveMaxLatencyDurationCount: 12,
  maxLiveSyncPlaybackRate: 1.2,
  manifestLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 8000,
      maxLoadTimeMs: 20000,
      timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
    },
  },
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 10000,
      maxLoadTimeMs: 60000,
      timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 8, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
    },
  },
};

const HEALTH_OK_AFTER_MS = 30_000;
const TOAST_MS = 4_000;

interface Props {
  channelId: string;
  /** Bump to re-tune the same channel from source 0 (offline-panel Retry). */
  attempt: number;
  /** Channel meta + active source index, for the overlay's OSD. */
  onInfo: (info: { play: TvPlayResponse; sourceIndex: number }) => void;
  /** Imperative surface for the overlay ("l" key → live edge). */
  onControls: (controls: { seekToLiveEdge: () => void }) => void;
  /** Every source failed (or no playable stream) — overlay shows the offline panel. */
  onSourcesExhausted: () => void;
}

/**
 * Live-TV player — sibling of the VOD Player sharing the Vidstack layout, not
 * its VOD logic: no decision endpoint, no subtitle fetch, no progress PUTs.
 * Sources come pre-ordered from /tv/channels/:id/play and are tried in order.
 */
export default function LiveTvPlayer({ channelId, attempt, onInfo, onControls, onSourcesExhausted }: Props) {
  const { t } = useTranslation();
  const [play, setPlay] = useState<TvPlayResponse | null>(null);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const playerRef = useRef<MediaPlayerInstance>(null);
  const hlsRef = useRef<Hls | null>(null);
  const retriedNetworkRef = useRef(false);
  const recoveredMediaRef = useRef(false);
  const healthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportedOkRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const source = play?.sources[sourceIndex] ?? null;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const postHealth = useCallback((streamId: string, ok: boolean, code?: string) => {
    void apiFetch(`/tv/streams/${streamId}/health`, {
      method: "POST",
      body: JSON.stringify(code ? { ok, code } : { ok }),
    }).catch(() => {});
  }, []);

  // ── Tune: log the play event (recents) and fetch the ordered sources ────
  useEffect(() => {
    let cancelled = false;
    setPlay(null);
    setSourceIndex(0);
    void apiFetch(`/tv/events/${channelId}`, { method: "POST" }).catch(() => {});
    apiJson<TvPlayResponse>(`/tv/channels/${channelId}/play`)
      .then((p) => {
        if (cancelled) return;
        if (p.sources.length === 0) onSourcesExhausted();
        else setPlay(p);
      })
      .catch(() => {
        // 409 no_playable_stream, 404, network — all land on the offline panel.
        if (!cancelled) onSourcesExhausted();
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, attempt, onSourcesExhausted]);

  // Surface channel meta + active source to the overlay OSD.
  useEffect(() => {
    if (play) onInfo({ play, sourceIndex });
  }, [play, sourceIndex, onInfo]);

  // Imperative live-edge control for the overlay's "l" key.
  useEffect(() => {
    onControls({
      seekToLiveEdge: () => {
        const player = playerRef.current;
        if (!player) return;
        const end = player.state.seekableEnd;
        if (Number.isFinite(end) && end > 1) player.currentTime = end - 1;
      },
    });
  }, [onControls]);

  // Reset the per-source error ladder + health state on source change.
  useEffect(() => {
    retriedNetworkRef.current = false;
    recoveredMediaRef.current = false;
    reportedOkRef.current = false;
    return () => {
      if (healthTimerRef.current) {
        clearTimeout(healthTimerRef.current);
        healthTimerRef.current = null;
      }
    };
  }, [source?.streamId, attempt]);

  const advanceSource = useCallback(
    (code: string) => {
      if (!play || !source) return;
      postHealth(source.streamId, false, code); // every failed source bumps failCount
      if (healthTimerRef.current) {
        clearTimeout(healthTimerRef.current);
        healthTimerRef.current = null;
      }
      const next = sourceIndex + 1;
      if (next < play.sources.length) {
        showToast(t("tv:player.tryingSource", { n: next + 1, total: play.sources.length }));
        setSourceIndex(next);
      } else {
        onSourcesExhausted();
      }
    },
    [play, source, sourceIndex, postHealth, showToast, onSourcesExhausted, t],
  );

  // Error ladder (spec §Player): fatal NETWORK → one startLoad() retry → next
  // source; fatal MEDIA → one recoverMediaError() → next source; anything
  // else fatal → next source. Never silent: toasts accompany every rung.
  const onHlsError = useCallback(
    (data: ErrorData) => {
      if (!data.fatal) return;
      const hls = hlsRef.current;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && hls && !retriedNetworkRef.current) {
        retriedNetworkRef.current = true;
        showToast(t("tv:player.reconnecting"));
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hls && !recoveredMediaRef.current) {
        recoveredMediaRef.current = true;
        showToast(t("tv:player.reconnecting"));
        hls.recoverMediaError();
        return;
      }
      advanceSource(data.details);
    },
    [advanceSource, showToast, t],
  );

  // ≥30 s of successful playback → report the stream healthy, once per tune.
  const onPlaying = useCallback(() => {
    if (reportedOkRef.current || healthTimerRef.current || !source) return;
    const streamId = source.streamId;
    healthTimerRef.current = setTimeout(() => {
      healthTimerRef.current = null;
      reportedOkRef.current = true;
      postHealth(streamId, true);
    }, HEALTH_OK_AFTER_MS);
  }, [source, postHealth]);

  // Pause→resume on live parks behind the window (vidstack #1623): nudge the
  // player instance back to the live edge whenever play resumes off-edge.
  const onPlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const { liveEdge, seekableEnd } = player.state;
    if (!liveEdge && Number.isFinite(seekableEnd) && seekableEnd > 1) {
      player.currentTime = seekableEnd - 1;
    }
  }, []);

  // Wire the BUNDLED hls.js (offline guarantee — never the CDN default) and
  // the live load policies before the provider loads. Mirrors Player.tsx.
  const onProviderChange = useCallback((provider: MediaProviderAdapter | null) => {
    if (provider && isHLSProvider(provider)) {
      provider.library = Hls;
      provider.config = HLS_LIVE_CONFIG;
    }
  }, []);

  if (!play || !source) {
    return (
      <div className="grid h-full w-full place-items-center text-sm text-[var(--text-dim)]">
        {t("tv:player.loading")}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <MediaPlayer
        key={`${source.streamId}:${attempt}`}
        ref={playerRef}
        title={play.channel.name}
        src={{ src: source.src, type: "application/x-mpegurl" }}
        streamType="live"
        className="h-full w-full bg-black"
        style={{ "--media-brand": "var(--accent)" }}
        autoPlay
        playsInline
        keyTarget="document"
        onProviderChange={onProviderChange}
        onHlsInstance={(hls) => {
          hlsRef.current = hls;
        }}
        onHlsError={onHlsError}
        onPlaying={onPlaying}
        onPlay={onPlay}
      >
        <MediaProvider />
        <DefaultVideoLayout icons={defaultLayoutIcons} colorScheme="dark" />
      </MediaPlayer>

      {toast && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded bg-black/70 px-3 py-1.5 text-sm text-white">
          {toast}
        </div>
      )}
    </div>
  );
}
```

Implementation notes (read before typechecking):
- `onHlsInstance`/`onHlsError` are the Vidstack React mappings of the HLS provider's `hls-instance`/`hls-error` events. If this pinned Vidstack version does not expose them as `MediaPlayer` props (typecheck will say so), capture the instance in `onProviderSetup` instead and subscribe directly — functionally identical:
  ```tsx
  onProviderSetup={(provider) => {
    if (isHLSProvider(provider) && provider.instance) {
      hlsRef.current = provider.instance;
      provider.instance.on(Hls.Events.ERROR, (_evt, data) => onHlsErrorRef.current(data));
    }
  }}
  ```
  (keep the handler in a ref so the subscription survives re-renders). Do NOT loosen types with `any`.
- The DefaultVideoLayout renders the stock LIVE pill for `streamType="live"` (click = live edge) and the stock audio/subtitle menus — HLS alt-audio matters on intl channels. No custom layout work here.
- `keyTarget="document"` matches the VOD player; Vidstack's own `l` (seek +10 s) coexists with the overlay's `l` (exact live-edge seek) — both move toward the edge, ours lands exactly on it.

- [ ] **Step 2: Create `apps/web/src/components/tv/LiveTvOverlay.tsx`:**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button, cn } from "@orbix/ui";
import type { TvChannelCard, TvPlayResponse } from "@/lib/types";
import LiveTvPlayer from "./LiveTvPlayer";
import { channelHue, channelInitials } from "@/lib/tv";
import { ChevronDownIcon } from "@/components/shell/icons";

const OSD_MS = 4_000;

interface Props {
  /** Zap context: the exact channel list the opener was showing, in order. */
  channels: TvChannelCard[];
  initialId: string;
  onClose: () => void;
}

/**
 * Full-page live-TV cinema — portal over the app shell like PlayerOverlay.
 * Hosts LiveTvPlayer plus: zap OSD (auto-hide 4 s), "g" mini-guide drawer,
 * offline panel, and the keyboard surface:
 *   PageUp/PageDown & Shift+↑/↓  zap within the passed channel list
 *   Backspace                    last-channel toggle
 *   g                            mini-guide (↑/↓ move, Enter tunes in place, Esc closes)
 *   l                            seek to live edge
 *   i                            re-show the OSD
 *   Esc                          close drawer, else close overlay (fullscreen exits first)
 */
export default function LiveTvOverlay({ channels, initialId, onClose }: Props) {
  const { t } = useTranslation();
  const [currentId, setCurrentId] = useState(initialId);
  const [attempt, setAttempt] = useState(0);
  const [offline, setOffline] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideIndex, setGuideIndex] = useState(0);
  const [osdVisible, setOsdVisible] = useState(true);
  const [info, setInfo] = useState<{ play: TvPlayResponse; sourceIndex: number } | null>(null);

  const prevIdRef = useRef<string | null>(null);
  const controlsRef = useRef<{ seekToLiveEdge: () => void } | null>(null);
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const guideRowRef = useRef<HTMLButtonElement | null>(null);

  const current = channels.find((c) => c.id === currentId) ?? channels[0] ?? null;

  // ── OSD: shown on every tune and on "i", auto-hides after 4 s ───────────
  const showOsd = useCallback(() => {
    setOsdVisible(true);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setOsdVisible(false), OSD_MS);
  }, []);
  useEffect(() => {
    showOsd(); // fires on mount and on every channel change
  }, [currentId, showOsd]);
  useEffect(
    () => () => {
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    },
    [],
  );

  const tune = useCallback((id: string) => {
    setCurrentId((prev) => {
      if (prev !== id) prevIdRef.current = prev; // Backspace target
      return id;
    });
    setOffline(false);
    setAttempt(0);
    setInfo(null);
  }, []);

  const zap = useCallback(
    (delta: number) => {
      if (channels.length === 0) return;
      const idx = channels.findIndex((c) => c.id === currentId);
      const next = ((idx < 0 ? 0 : idx) + delta + channels.length) % channels.length;
      tune(channels[next]!.id);
    },
    [channels, currentId, tune],
  );

  // Lock background scroll while the overlay is open (PlayerOverlay pattern).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // ── Keyboard surface (all listeners removed on unmount) ─────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;

      if (e.key === "Escape") {
        if (document.fullscreenElement) return; // first Esc exits fullscreen
        e.preventDefault();
        if (guideOpen) setGuideOpen(false);
        else onClose();
        return;
      }
      if (e.key === "PageUp" || (e.shiftKey && e.key === "ArrowUp")) {
        e.preventDefault();
        zap(-1);
        return;
      }
      if (e.key === "PageDown" || (e.shiftKey && e.key === "ArrowDown")) {
        e.preventDefault();
        zap(1);
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        if (prevIdRef.current) tune(prevIdRef.current);
        return;
      }
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        if (guideOpen) {
          setGuideOpen(false);
        } else {
          setGuideIndex(Math.max(0, channels.findIndex((c) => c.id === currentId)));
          setGuideOpen(true);
        }
        return;
      }
      if (e.key === "l" || e.key === "L") {
        controlsRef.current?.seekToLiveEdge();
        return;
      }
      if (e.key === "i" || e.key === "I") {
        showOsd();
        return;
      }
      if (guideOpen) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setGuideIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setGuideIndex((i) => Math.min(channels.length - 1, i + 1));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const c = channels[guideIndex];
          if (c) tune(c.id); // tunes in place; the drawer stays open
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [channels, currentId, guideIndex, guideOpen, onClose, showOsd, tune, zap]);

  // Keep the focused mini-guide row in view.
  useEffect(() => {
    if (guideOpen) guideRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [guideIndex, guideOpen]);

  const handleInfo = useCallback((next: { play: TvPlayResponse; sourceIndex: number }) => {
    setInfo(next);
  }, []);
  const handleControls = useCallback((c: { seekToLiveEdge: () => void }) => {
    controlsRef.current = c;
  }, []);
  const handleExhausted = useCallback(() => {
    setOffline(true);
  }, []);

  if (!current) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black">
      {!offline && (
        <LiveTvPlayer
          channelId={current.id}
          attempt={attempt}
          onInfo={handleInfo}
          onControls={handleControls}
          onSourcesExhausted={handleExhausted}
        />
      )}

      {/* Offline panel — every source failed (health already reported by the player). */}
      {offline && (
        <div className="grid h-full w-full place-items-center">
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="text-lg font-medium text-white">{t("tv:player.offline")}</p>
            <div className="flex gap-3">
              <Button
                onClick={() => {
                  setOffline(false);
                  setAttempt((a) => a + 1);
                }}
              >
                {t("common:actions.retry")}
              </Button>
              <Button variant="ghost" onClick={() => zap(1)}>
                {t("tv:player.nextChannel")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Zap OSD: number · logo · name · quality · source indicator */}
      {osdVisible && (
        <div className="pointer-events-none absolute left-4 top-14 z-10 flex items-center gap-3 rounded-lg bg-black/70 px-4 py-3 backdrop-blur">
          <span className="text-2xl font-bold tabular-nums text-white/80">{current.number}</span>
          <span className="grid h-10 w-14 place-items-center overflow-hidden rounded bg-white/10">
            {current.logo ? (
              <img src={`/api/images/${current.logo}`} alt="" className="max-h-8 max-w-12 object-contain" />
            ) : (
              <span
                aria-hidden
                className="grid h-full w-full place-items-center text-sm font-bold text-white"
                style={{ backgroundColor: `hsl(${channelHue(current.id)} 45% 28%)` }}
              >
                {channelInitials(current.name)}
              </span>
            )}
          </span>
          <span className="flex flex-col">
            <span className="text-base font-semibold text-white">{current.name}</span>
            <span className="flex items-center gap-2 text-xs text-white/60">
              {current.quality && (
                <span className="rounded-sm bg-white/15 px-1 py-0.5 font-semibold">{current.quality}</span>
              )}
              {info && info.sourceIndex > 0 && (
                <span>{t("tv:player.source", { n: info.sourceIndex + 1, total: info.play.sources.length })}</span>
              )}
            </span>
          </span>
        </div>
      )}

      {/* Mini-guide drawer ("g"): the zap context's channels, Enter tunes in place */}
      {guideOpen && (
        <div
          role="dialog"
          aria-label={t("tv:player.miniGuide")}
          className="absolute inset-y-0 left-0 z-20 flex w-80 max-w-[80vw] flex-col border-r border-white/10 bg-black/85 backdrop-blur"
        >
          <p className="px-4 pb-2 pt-4 text-xs uppercase tracking-wide text-white/50">
            {t("tv:player.miniGuide")}
          </p>
          <div className="flex-1 overflow-y-auto pb-4">
            {channels.map((c, i) => (
              <button
                key={c.id}
                ref={i === guideIndex ? guideRowRef : undefined}
                type="button"
                onClick={() => tune(c.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2 text-left",
                  c.id === currentId ? "bg-[var(--accent)]/20 text-white" : "text-white/80 hover:bg-white/10",
                  i === guideIndex && "ring-1 ring-inset ring-[var(--accent)]",
                )}
              >
                <span className="w-8 shrink-0 text-right text-xs tabular-nums text-white/50">{c.number}</span>
                <span className="line-clamp-1 flex-1 text-sm">{c.name}</span>
                {c.quality && <span className="shrink-0 text-[10px] text-white/40">{c.quality}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Close affordance — top-left, above everything (PlayerOverlay pattern). */}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("tv:player.close")}
        className="absolute left-3 top-3 z-30 grid h-10 w-10 place-items-center rounded-full bg-black/40 text-white/90 transition-colors hover:bg-black/70 hover:text-white"
      >
        <ChevronDownIcon className="h-6 w-6" />
      </button>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 3: Package gates**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test`
Expected: green. If `onHlsInstance`/`onHlsError` fail typecheck, apply the `onProviderSetup` fallback from the Step-1 notes and re-run.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tv/LiveTvPlayer.tsx apps/web/src/components/tv/LiveTvOverlay.tsx
git commit -m "feat(tv): LiveTvPlayer + LiveTvOverlay (failover ladder, health, OSD, mini-guide, zap keys)" \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 6: Web — `ChannelCard` + `ChannelRail` + `TvHomePage` + nav link + `/tv` route

**Files:**
- Create: `apps/web/src/components/tv/ChannelCard.tsx`
- Create: `apps/web/src/components/tv/ChannelRail.tsx`
- Create: `apps/web/src/pages/TvHomePage.tsx`
- Modify: `apps/web/src/router.tsx` (add `/tv`)
- Modify: `apps/web/src/components/shell/TopNav.tsx` (placeholder → real link)
- Modify: `apps/web/src/components/shell/BottomNav.tsx` (gains `profile` prop, real link)
- Modify: `apps/web/src/components/shell/AppShell.tsx` (pass `profile` to BottomNav)

**Interfaces:**
- Consumes: `TvChannelCard`/`TvHome` types, `useTvHome`/`useAuthMe` hooks, `channelHue`/`channelInitials`/`regionName`, `LiveTvOverlay` (Task 5), `cn`/`Button` from `@orbix/ui`, shell icons.
- Produces:
  - `ChannelCard({ channel, onPlay, className })` — 16:9 tile; whole tile = play button; hover favorite heart (PUT/DELETE `/tv/favorites/:channelId` + query invalidation via `useQueryClient`); no nested interactive elements (heart is a positioned sibling above the tile button).
  - `ChannelRail({ title, channels, onPlay })` — `onPlay(channel, context)` passes the rail's own list as the zap context; scroller/paddle mechanics copied from `MediaRow`.
  - `TvHomePage` — rails (Recents → Favorites → per-country → per-category), "Guide" header button, empty state (admin wizard CTA → `/account/tv?wizard=1`, member "ask your admin"), overlay opened via component state (not a route — matches VOD).
- Notes: the Guide button (`/tv/guide`) and the wizard CTA (`/account/tv`) point at routes landing in Tasks 7/9 — dead links for one task each; gates are unaffected. `TopNav`'s `Placeholder` helper stays (still used by "My list").

- [ ] **Step 1: Create `apps/web/src/components/tv/ChannelCard.tsx`:**

```tsx
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import type { TvChannelCard } from "@/lib/types";
import { channelHue, channelInitials } from "@/lib/tv";
import { HeartIcon } from "@/components/shell/icons";

/**
 * 16:9 channel tile: cached logo centered on a dark surface (deterministic
 * hue-hashed monogram fallback), number + name scrim, quality chip, grey
 * offline dot, hover favorite heart. The whole tile is the play button; the
 * heart is a positioned sibling painted above it (no nested buttons).
 */
export default function ChannelCard({
  channel,
  onPlay,
  className,
}: {
  channel: TvChannelCard;
  onPlay: (channel: TvChannelCard) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const toggleFavorite = async () => {
    try {
      await apiFetch(`/tv/favorites/${channel.id}`, { method: channel.favorite ? "DELETE" : "PUT" });
    } catch {
      return; // network hiccup — leave state untouched
    }
    void queryClient.invalidateQueries({ queryKey: ["tv-home"] });
    void queryClient.invalidateQueries({ queryKey: ["tv-guide"] });
    void queryClient.invalidateQueries({ queryKey: ["tv-favorites"] });
    void queryClient.invalidateQueries({ queryKey: ["tv-channel", channel.id] });
  };

  return (
    <div
      className={cn(
        "group relative block shrink-0 snap-start overflow-hidden rounded-md bg-[var(--surface)]",
        "transition-transform delay-75 duration-200 hover:z-10 hover:scale-[1.06] hover:shadow-xl hover:shadow-black/50",
        "motion-reduce:transition-none motion-reduce:hover:transform-none",
        className,
      )}
    >
      <div className="grid aspect-video w-full place-items-center">
        {channel.logo ? (
          <img
            src={`/api/images/${channel.logo}`}
            alt=""
            loading="lazy"
            className="max-h-[55%] max-w-[70%] object-contain"
          />
        ) : (
          <div
            aria-hidden
            className="grid h-full w-full place-items-center text-2xl font-bold text-white/90"
            style={{ backgroundColor: `hsl(${channelHue(channel.id)} 45% 28%)` }}
          >
            {channelInitials(channel.name)}
          </div>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2.5 pb-2 pt-6">
        <span className="text-[11px] tabular-nums text-white/60">{channel.number}</span>
        <span className="line-clamp-1 flex-1 text-[13px] font-medium leading-tight text-white">
          {channel.name}
        </span>
        {channel.quality && (
          <span className="rounded-sm bg-white/15 px-1 py-0.5 text-[10px] font-semibold leading-none text-white/90">
            {channel.quality}
          </span>
        )}
      </div>

      {!channel.healthy && (
        <span
          title={t("tv:badges.offline")}
          aria-label={t("tv:badges.offline")}
          className="absolute left-1.5 top-1.5 h-2 w-2 rounded-full bg-zinc-500"
        />
      )}

      {/* Primary action: the whole tile tunes the channel. */}
      <button
        type="button"
        onClick={() => onPlay(channel)}
        aria-label={t("tv:card.play", { name: channel.name })}
        className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      />

      {/* Favorite heart — painted above the play hit-area (later sibling). */}
      <button
        type="button"
        onClick={() => void toggleFavorite()}
        aria-label={channel.favorite ? t("tv:card.unfavorite") : t("tv:card.favorite")}
        className={cn(
          "absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/50 text-white",
          "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
          channel.favorite && "opacity-100 text-[var(--accent)]",
        )}
      >
        <HeartIcon className={cn("h-4 w-4", channel.favorite && "fill-current")} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create `apps/web/src/components/tv/ChannelRail.tsx`** (scroller + paddles copied from `MediaRow`):

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@orbix/ui";
import type { TvChannelCard } from "@/lib/types";
import ChannelCard from "./ChannelCard";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/shell/icons";

/**
 * Horizontal channel rail — the home MediaRow's scroller/paddle mechanics
 * (snap strip, hidden scrollbar, gutter chevrons on row hover) with
 * ChannelCards. onPlay receives the rail's own list as the zap context.
 */
export default function ChannelRail({
  title,
  channels,
  onPlay,
}: {
  title: string;
  channels: TvChannelCard[];
  onPlay: (channel: TvChannelCard, context: TvChannelCard[]) => void;
}) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setCanScroll({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [update, channels.length]);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: "smooth" });
  };

  if (channels.length === 0) return null;

  const paddle =
    "absolute inset-y-0 z-20 flex w-[4vw] min-w-8 items-center justify-center bg-[var(--bg)]/50 text-white opacity-0 transition-opacity hover:bg-[var(--bg)]/75 focus-visible:opacity-100 focus-visible:outline-none group-hover/row:opacity-100";

  return (
    <section className="group/row w-full">
      <h2 className="mb-2 px-[4vw] text-base font-semibold text-[var(--text)] md:text-xl">{title}</h2>
      <div className="relative">
        <div
          ref={scroller}
          onScroll={update}
          className="scrollbar-none flex snap-x gap-2 overflow-x-auto scroll-smooth scroll-pl-[4vw] px-[4vw] py-2"
        >
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              onPlay={(ch) => onPlay(ch, channels)}
              className="w-[44vw] sm:w-[30vw] md:w-[23.5vw] lg:w-[19vw] xl:w-[15.5vw]"
            />
          ))}
        </div>
        {canScroll.left && (
          <button type="button" aria-label={t("catalog:rows.scrollLeft")} onClick={() => page(-1)} className={cn(paddle, "left-0")}>
            <ChevronLeftIcon className="h-8 w-8" />
          </button>
        )}
        {canScroll.right && (
          <button type="button" aria-label={t("catalog:rows.scrollRight")} onClick={() => page(1)} className={cn(paddle, "right-0")}>
            <ChevronRightIcon className="h-8 w-8" />
          </button>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Create `apps/web/src/pages/TvHomePage.tsx`:**

```tsx
import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@orbix/ui";
import { useAuthMe, useTvHome } from "@/lib/queries";
import type { TvChannelCard } from "@/lib/types";
import ChannelRail from "@/components/tv/ChannelRail";
import LiveTvOverlay from "@/components/tv/LiveTvOverlay";
import { regionName } from "@/lib/tv";
import { TvIcon } from "@/components/shell/icons";

/** Category ids are lowercase data values ("news") — display-capitalize only. */
function categoryLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function EmptyState({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-24 text-center">
      <TvIcon className="h-12 w-12 text-[var(--text-dim)]" />
      <h2 className="text-xl font-semibold text-[var(--text)]">{t("tv:empty.title")}</h2>
      {isAdmin ? (
        <>
          <p className="text-sm text-[var(--text-dim)]">{t("tv:empty.adminBody")}</p>
          <Link to="/account/tv?wizard=1">
            <Button>{t("tv:empty.adminCta")}</Button>
          </Link>
        </>
      ) : (
        <p className="text-sm text-[var(--text-dim)]">{t("tv:empty.memberBody")}</p>
      )}
    </div>
  );
}

export default function TvHomePage() {
  const { t, i18n } = useTranslation();
  const { data, isLoading } = useTvHome();
  const me = useAuthMe();
  const [playing, setPlaying] = useState<{ channels: TvChannelCard[]; id: string } | null>(null);

  const openPlayer = (channel: TvChannelCard, context: TvChannelCard[]) =>
    setPlaying({ channels: context, id: channel.id });

  if (isLoading)
    return <div className="p-8 text-[var(--text-dim)]">{t("common:status.loading")}</div>;

  const home = data ?? { recents: [], favorites: [], countries: [], categories: [] };
  const empty =
    home.recents.length === 0 &&
    home.favorites.length === 0 &&
    home.countries.every((c) => c.channels.length === 0) &&
    home.categories.every((c) => c.channels.length === 0);

  return (
    <div className="flex flex-col gap-6 pb-12 md:gap-9">
      <div className="flex items-center justify-between px-[4vw] pt-4">
        <h1 className="text-2xl font-bold text-[var(--text)]">{t("tv:title")}</h1>
        {/* Visible Guide affordance — the Hulu lesson (spec §Web UI). */}
        <Link to="/tv/guide">
          <Button variant="ghost">{t("tv:guide")}</Button>
        </Link>
      </div>

      {empty ? (
        <EmptyState isAdmin={me.data?.isAdmin ?? false} />
      ) : (
        <>
          {home.recents.length > 0 && (
            <ChannelRail title={t("tv:rails.recents")} channels={home.recents} onPlay={openPlayer} />
          )}
          {home.favorites.length > 0 && (
            <ChannelRail title={t("tv:rails.favorites")} channels={home.favorites} onPlay={openPlayer} />
          )}
          {home.countries.map((c) =>
            c.channels.length > 0 ? (
              <ChannelRail
                key={c.code}
                title={regionName(c.code, i18n.language) ?? c.code}
                channels={c.channels}
                onPlay={openPlayer}
              />
            ) : null,
          )}
          {home.categories.map((c) =>
            c.channels.length > 0 ? (
              <ChannelRail
                key={c.id}
                title={categoryLabel(c.id)}
                channels={c.channels}
                onPlay={openPlayer}
              />
            ) : null,
          )}
        </>
      )}

      {playing && (
        <LiveTvOverlay
          channels={playing.channels}
          initialId={playing.id}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Route it** — in `apps/web/src/router.tsx`, add the import and the child route right after the `/` HomePage entry:

```tsx
import TvHomePage from "./pages/TvHomePage";
```
```tsx
      { path: "/", element: <HomePage /> },
      { path: "/tv", element: <TvHomePage /> },
```

- [ ] **Step 5: Replace the TV nav placeholder (hidden for kids).**

`apps/web/src/components/shell/TopNav.tsx` — replace the line
```tsx
            <Placeholder label={t("nav:tv")} comingSoon={t("nav:comingSoon")}><TvIcon className="h-4 w-4" /> {t("nav:tv")}</Placeholder>
```
with
```tsx
            {profile?.kind !== "kids" && (
              <Link
                to="/tv"
                aria-current={pathname.startsWith("/tv") ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 text-sm transition-colors",
                  pathname.startsWith("/tv")
                    ? "text-[var(--text)] font-medium"
                    : "text-[var(--text-dim)] hover:text-[var(--text)]",
                )}
              >
                <TvIcon className="h-4 w-4" /> {t("nav:tv")}
              </Link>
            )}
```
(Keep the `Placeholder` component — the "My list" heart still uses it.)

`apps/web/src/components/shell/BottomNav.tsx` — add the profile prop and swap the inert tab. Change the imports/signature:
```tsx
import type { Profile } from "@/lib/types";

export default function BottomNav({ profile }: { profile: Profile | null }) {
```
and replace
```tsx
        <Tab label={t("nav:tv")}><TvIcon className="h-5 w-5 opacity-60" /></Tab>
```
with
```tsx
        {profile?.kind !== "kids" && (
          <Tab to="/tv" label={t("nav:tv")} active={pathname.startsWith("/tv")}>
            <TvIcon className="h-5 w-5" />
          </Tab>
        )}
```

`apps/web/src/components/shell/AppShell.tsx` — pass the profile through:
```tsx
      <BottomNav profile={profile} />
```

- [ ] **Step 6: Package gates**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/tv/ChannelCard.tsx apps/web/src/components/tv/ChannelRail.tsx \
  apps/web/src/pages/TvHomePage.tsx apps/web/src/router.tsx \
  apps/web/src/components/shell/TopNav.tsx apps/web/src/components/shell/BottomNav.tsx apps/web/src/components/shell/AppShell.tsx
git commit -m "feat(tv): /tv home rails, channel cards and live nav link (hidden for kids)" \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Web — `TvGuidePage` (chips + debounced search + virtualized list)

**Files:**
- Modify: `apps/web/package.json` (add `@tanstack/react-virtual`)
- Create: `apps/web/src/pages/TvGuidePage.tsx`
- Modify: `apps/web/src/router.tsx` (add `/tv/guide`)

**Interfaces:**
- Consumes: `useTvGuide` (Task 4, infinite offset paging, pages of 100), `LiveTvOverlay`, `channelHue`/`channelInitials`/`regionName`, `Input`/`cn` from `@orbix/ui`, `useVirtualizer` from `@tanstack/react-virtual`.
- Produces: `TvGuidePage` — chips row (All | Favorites | country codes | categories; facets derived client-side from the **unfiltered** first page, which is the default query and therefore already cached), 300 ms-debounced search, `@tanstack/react-virtual` vertical list (64 px rows) that fetches the next page as the viewport nears the loaded end; row = number + logo + name + quality with now/next rendered as an em-dash until phase 3; row click tunes (zap context = all loaded rows); a small info affordance per row links to the channel page (spec's "Schedule" affordance — the route lands in Task 8).

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @orbix/web add @tanstack/react-virtual`
Expected: `apps/web/package.json` gains `@tanstack/react-virtual` (v3.x), lockfile updated.

- [ ] **Step 2: Create `apps/web/src/pages/TvGuidePage.tsx`:**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, Input } from "@orbix/ui";
import { useTvGuide } from "@/lib/queries";
import type { TvChannelCard } from "@/lib/types";
import LiveTvOverlay from "@/components/tv/LiveTvOverlay";
import { channelHue, channelInitials, regionName } from "@/lib/tv";
import { InfoIcon } from "@/components/shell/icons";

type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "country"; code: string }
  | { kind: "category"; id: string };

const ROW_HEIGHT = 64;

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-3 py-1 text-sm transition-colors",
        active
          ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]"
          : "border-[var(--surface-2)] text-[var(--text-dim)] hover:text-[var(--text)]",
      )}
    >
      {children}
    </button>
  );
}

export default function TvGuidePage() {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [playing, setPlaying] = useState<{ channels: TvChannelCard[]; id: string } | null>(null);

  // 300 ms search debounce.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const params = useMemo(
    () => ({
      country: filter.kind === "country" ? filter.code : undefined,
      category: filter.kind === "category" ? filter.id : undefined,
      favorites: filter.kind === "favorites" ? true : undefined,
      q: debouncedQ || undefined,
    }),
    [filter, debouncedQ],
  );
  const guide = useTvGuide(params);
  const channels = useMemo(
    () => (guide.data?.pages ?? []).flatMap((p) => p.channels),
    [guide.data],
  );
  const total = guide.data?.pages[0]?.total ?? 0;

  // v1 facets: derived client-side from the UNFILTERED first page (that IS the
  // default query, so it's cached the moment the page loads — no extra fetch).
  const base = useTvGuide({});
  const chips = useMemo(() => {
    const rows = base.data?.pages[0]?.channels ?? [];
    const countries = new Set<string>();
    const categories = new Set<string>();
    for (const c of rows) {
      if (c.country) countries.add(c.country);
      for (const cat of c.categories) categories.add(cat);
    }
    return { countries: [...countries].sort(), categories: [...categories].sort() };
  }, [base.data]);

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  // Offset paging: pull the next 100 as the list nears its loaded end.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = guide;
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= channels.length - 20 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [virtualItems, channels.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-[var(--text)]">{t("tv:guidePage.title")}</h1>
        <span className="text-sm text-[var(--text-dim)]">
          {t("tv:guidePage.channelCount", { count: total })}
        </span>
      </div>

      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("tv:guidePage.searchPlaceholder")}
        aria-label={t("tv:guidePage.searchPlaceholder")}
      />

      <div className="scrollbar-none flex gap-2 overflow-x-auto py-1">
        <Chip active={filter.kind === "all"} onClick={() => setFilter({ kind: "all" })}>
          {t("tv:guidePage.all")}
        </Chip>
        <Chip active={filter.kind === "favorites"} onClick={() => setFilter({ kind: "favorites" })}>
          {t("tv:guidePage.favorites")}
        </Chip>
        {chips.countries.map((code) => (
          <Chip
            key={code}
            active={filter.kind === "country" && filter.code === code}
            onClick={() => setFilter({ kind: "country", code })}
          >
            {regionName(code, i18n.language) ?? code}
          </Chip>
        ))}
        {chips.categories.map((cat) => (
          <Chip
            key={cat}
            active={filter.kind === "category" && filter.id === cat}
            onClick={() => setFilter({ kind: "category", id: cat })}
          >
            {cat.charAt(0).toUpperCase() + cat.slice(1)}
          </Chip>
        ))}
      </div>

      {guide.isLoading ? (
        <p className="p-4 text-[var(--text-dim)]">{t("common:status.loading")}</p>
      ) : channels.length === 0 ? (
        <p className="p-4 text-[var(--text-dim)]">{t("tv:guidePage.empty")}</p>
      ) : (
        <div
          ref={parentRef}
          className="h-[calc(100vh-260px)] overflow-y-auto rounded-[var(--radius)] border border-[var(--surface-2)]"
        >
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((vi) => {
              const c = channels[vi.index]!;
              return (
                <div
                  key={c.id}
                  className="group absolute left-0 top-0 flex w-full items-center gap-3 border-b border-[var(--surface)] px-3"
                  style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
                >
                  <span className="w-10 shrink-0 text-right text-sm tabular-nums text-[var(--text-dim)]">
                    {c.number}
                  </span>
                  <span className="grid h-9 w-14 shrink-0 place-items-center overflow-hidden rounded bg-[var(--surface)]">
                    {c.logo ? (
                      <img
                        src={`/api/images/${c.logo}`}
                        alt=""
                        loading="lazy"
                        className="max-h-7 max-w-11 object-contain"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="grid h-full w-full place-items-center text-xs font-bold text-white/90"
                        style={{ backgroundColor: `hsl(${channelHue(c.id)} 45% 28%)` }}
                      >
                        {channelInitials(c.name)}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--text)]">{c.name}</span>
                    {/* now/next slots — em-dash until the EPG phase fills them */}
                    <span className="block truncate text-xs text-[var(--text-dim)]">
                      {c.now?.title ?? "—"}
                      {c.next?.title ? ` · ${c.next.title}` : ""}
                    </span>
                  </span>
                  {c.quality && (
                    <span className="shrink-0 rounded-sm bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-dim)]">
                      {c.quality}
                    </span>
                  )}

                  {/* Whole row tunes (painted above the cells — later sibling). */}
                  <button
                    type="button"
                    onClick={() => setPlaying({ channels, id: c.id })}
                    aria-label={t("tv:guidePage.play", { name: c.name })}
                    className="absolute inset-0 hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none"
                  />
                  {/* Channel-details affordance, painted above the row button. */}
                  <Link
                    to={`/tv/channel/${c.id}`}
                    aria-label={t("tv:guidePage.schedule")}
                    className="relative shrink-0 rounded p-1 text-[var(--text-dim)] opacity-0 transition-opacity hover:text-[var(--text)] focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <InfoIcon className="h-4 w-4" />
                  </Link>
                </div>
              );
            })}
          </div>
          {isFetchingNextPage && (
            <p className="p-3 text-center text-sm text-[var(--text-dim)]">{t("common:status.loading")}</p>
          )}
        </div>
      )}

      {playing && (
        <LiveTvOverlay
          channels={playing.channels}
          initialId={playing.id}
          onClose={() => setPlaying(null)}
        />
      )}
    </main>
  );
}
```

- [ ] **Step 3: Route it** — in `apps/web/src/router.tsx`:

```tsx
import TvGuidePage from "./pages/TvGuidePage";
```
```tsx
      { path: "/tv", element: <TvHomePage /> },
      { path: "/tv/guide", element: <TvGuidePage /> },
```

- [ ] **Step 4: Package gates**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/pages/TvGuidePage.tsx apps/web/src/router.tsx
git commit -m "feat(tv): virtualized TV guide with chips, debounced search and offset paging" \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 8: Web — `TvChannelPage` (hero + favorite + Watch + schedule)

**Files:**
- Create: `apps/web/src/pages/TvChannelPage.tsx`
- Modify: `apps/web/src/router.tsx` (add `/tv/channel/:id`)

**Interfaces:**
- Consumes: `useTvChannel`/`useTvProgrammes` (Task 4), `LiveTvOverlay`, `channelHue`/`channelInitials`/`regionName`, `apiFetch`, `Button`/`cn`, shell icons.
- Produces: `TvChannelPage` — logo hero (monogram fallback), number/name/badges (region, categories, quality, offline), favorite toggle, Watch button → overlay with a single-channel zap context, "Today's schedule" list from `GET /tv/channels/:id/programmes` (renders the empty-state copy until phase 3 fills the EPG).

- [ ] **Step 1: Create `apps/web/src/pages/TvChannelPage.tsx`:**

```tsx
import { useState } from "react";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button, cn } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import { useTvChannel, useTvProgrammes } from "@/lib/queries";
import LiveTvOverlay from "@/components/tv/LiveTvOverlay";
import { channelHue, channelInitials, regionName } from "@/lib/tv";
import { HeartIcon, PlayIcon } from "@/components/shell/icons";

/** Channel detail: hero, badges, favorite toggle, Watch CTA, day schedule. */
export default function TvChannelPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const channel = useTvChannel(id);
  const programmes = useTvProgrammes(id);
  const [watching, setWatching] = useState(false);

  if (channel.isLoading)
    return <div className="p-8 text-[var(--text-dim)]">{t("common:status.loading")}</div>;

  const c = channel.data;
  if (!c) return <div className="p-8 text-[var(--text-dim)]">{t("tv:channel.notFound")}</div>;

  const toggleFavorite = async () => {
    try {
      await apiFetch(`/tv/favorites/${c.id}`, { method: c.favorite ? "DELETE" : "PUT" });
    } catch {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["tv-channel", c.id] });
    void queryClient.invalidateQueries({ queryKey: ["tv-home"] });
    void queryClient.invalidateQueries({ queryKey: ["tv-favorites"] });
  };

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });

  const badges = [
    regionName(c.country, i18n.language),
    ...c.categories.map((cat) => cat.charAt(0).toUpperCase() + cat.slice(1)),
  ].filter((x): x is string => Boolean(x));

  const schedule = programmes.data?.programmes ?? [];

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 md:px-8">
      <div className="flex items-center gap-5">
        <span className="grid h-24 w-40 shrink-0 place-items-center overflow-hidden rounded-[var(--radius)] bg-[var(--surface)]">
          {c.logo ? (
            <img src={`/api/images/${c.logo}`} alt="" className="max-h-16 max-w-32 object-contain" />
          ) : (
            <span
              aria-hidden
              className="grid h-full w-full place-items-center text-3xl font-bold text-white/90"
              style={{ backgroundColor: `hsl(${channelHue(c.id)} 45% 28%)` }}
            >
              {channelInitials(c.name)}
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--text-dim)]">{t("tv:channel.number", { number: c.number })}</p>
          <h1 className="truncate text-3xl font-bold text-[var(--text)]">{c.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-dim)]">
            {c.quality && (
              <span className="rounded-sm bg-white/10 px-1.5 py-0.5 font-semibold text-[var(--text)]">
                {c.quality}
              </span>
            )}
            {badges.map((b) => (
              <span key={b} className="rounded-full border border-[var(--surface-2)] px-2 py-0.5">
                {b}
              </span>
            ))}
            {!c.healthy && <span className="text-zinc-500">● {t("tv:badges.offline")}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void toggleFavorite()}
          aria-label={c.favorite ? t("tv:card.unfavorite") : t("tv:card.favorite")}
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[var(--surface-2)] transition-colors",
            c.favorite ? "text-[var(--accent)]" : "text-[var(--text-dim)] hover:text-[var(--text)]",
          )}
        >
          <HeartIcon className={cn("h-5 w-5", c.favorite && "fill-current")} />
        </button>
      </div>

      <div>
        <Button onClick={() => setWatching(true)}>
          <PlayIcon className="mr-1 h-4 w-4" /> {t("tv:channel.watch")}
        </Button>
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-[var(--text)]">{t("tv:channel.schedule")}</h2>
        {schedule.length === 0 ? (
          <p className="text-sm text-[var(--text-dim)]">{t("tv:channel.scheduleEmpty")}</p>
        ) : (
          <ul className="flex flex-col">
            {schedule.map((p) => (
              <li key={p.id} className="flex gap-4 border-b border-[var(--surface)] py-2 text-sm">
                <span className="w-28 shrink-0 tabular-nums text-[var(--text-dim)]">
                  {time(p.start)}–{time(p.stop)}
                </span>
                <span className="min-w-0">
                  <span className="block font-medium text-[var(--text)]">{p.title}</span>
                  {p.description && (
                    <span className="line-clamp-2 block text-xs text-[var(--text-dim)]">{p.description}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {watching && (
        <LiveTvOverlay channels={[c]} initialId={c.id} onClose={() => setWatching(false)} />
      )}
    </main>
  );
}
```

- [ ] **Step 2: Route it** — in `apps/web/src/router.tsx`:

```tsx
import TvChannelPage from "./pages/TvChannelPage";
```
```tsx
      { path: "/tv/guide", element: <TvGuidePage /> },
      { path: "/tv/channel/:id", element: <TvChannelPage /> },
```

- [ ] **Step 3: Package gates**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/TvChannelPage.tsx apps/web/src/router.tsx
git commit -m "feat(tv): channel detail page with favorite toggle, Watch CTA and schedule shell" \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Web — `/account/tv` admin sources tab + first-run wizard

**Files:**
- Create: `apps/web/src/pages/account/AccountTvPage.tsx`
- Modify: `apps/web/src/pages/account/AccountLayout.tsx` (tab + guard)
- Modify: `apps/web/src/router.tsx` (add `/account/tv`)

**Interfaces:**
- Consumes: Phase-1 sources API (`GET/POST/PATCH/DELETE /tv/sources`, `POST /tv/sources/:id/sync → {jobId}`, SSE `GET /api/tv/sync/events?jobId=`), `TvSource` type (Task 4), `regionName`, `Button`/`Card`/`Input` from `@orbix/ui`. Imperative `apiFetch` + `EventSource` state management copied from `AdminLibrariesPage` (its scan-progress idiom).
- Produces: `AccountTvPage` with two modes on one route:
  - **Sources mode** (default): iptv-org card (create-if-missing via `POST {kind:"iptv-org"}`; country checkboxes from a ~30-code constant + free-text add, saved via `PATCH {countries}`; enable toggle; Sync now + SSE progress line; last-sync/status line) and M3U card (list + add by URL or file — `FileReader` → `fileContent` POST field with a 5 MB guard; per-source enable/sync/delete). Legal notice at the bottom (spec §Legal).
  - **Wizard mode** (`?wizard=1`): 3-step stepper (Countries → optional M3U → Sync summary) reusing the same primitives; finish links to `/tv`.
- `AccountLayout`: admin-only "TV" tab (label `t("nav:tv")`) + `/account/tv` added to the deep-link guard.

- [ ] **Step 1: Create `apps/web/src/pages/account/AccountTvPage.tsx`:**

```tsx
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Card, Input } from "@orbix/ui";
import { apiFetch } from "@/lib/api";
import type { TvSource } from "@/lib/types";
import { regionName } from "@/lib/tv";

/** iptv-org country codes offered as checkboxes (their codes — UK, not GB). */
const TV_COUNTRIES = [
  "RU", "UK", "US", "DE", "FR", "ES", "PT", "IT", "NL", "BE", "CH", "AT",
  "PL", "CZ", "SK", "HU", "RO", "BG", "RS", "GR", "TR", "UA", "BY", "KZ",
  "SE", "NO", "FI", "DK", "BR", "MX", "AR", "CA",
] as const;

const MAX_M3U_FILE_BYTES = 5 * 1024 * 1024;

interface SyncState {
  phase: string;
  processed?: number;
  total?: number;
  message?: string;
}

/**
 * Admin TV sources: the iptv-org worldwide catalog (opt-in, country-scoped)
 * and user M3U playlists, with per-source sync + SSE progress — the
 * AdminLibrariesPage scan idiom applied to the tv-sync queue. `?wizard=1`
 * renders the same primitives as a 3-step first-run stepper.
 */
export default function AccountTvPage() {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const wizard = searchParams.get("wizard") === "1";
  const [wizardStep, setWizardStep] = useState(0);

  const [sources, setSources] = useState<TvSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [m3uName, setM3uName] = useState("");
  const [m3uUrl, setM3uUrl] = useState("");
  const [m3uError, setM3uError] = useState<string | null>(null);
  const [m3uSaving, setM3uSaving] = useState(false);

  const [countryDraft, setCountryDraft] = useState("");

  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({});
  const [syncLoading, setSyncLoading] = useState<Record<string, boolean>>({});
  const esRef = useRef<Map<string, EventSource>>(new Map());

  useEffect(() => {
    const streams = esRef.current;
    return () => {
      streams.forEach((es) => es.close());
      streams.clear();
    };
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(): Promise<TvSource[]> {
    try {
      const res = await apiFetch("/tv/sources");
      if (!res.ok) {
        setError(t("tv:admin.loadFailed"));
        return [];
      }
      const list = (await res.json()) as TvSource[];
      setSources(list);
      setError(null);
      return list;
    } catch {
      setError(t("errors:network"));
      return [];
    } finally {
      setLoading(false);
    }
  }

  const iptv = sources.find((s) => s.kind === "iptv-org") ?? null;
  const m3uSources = sources.filter((s) => s.kind === "m3u");

  /** The single iptv-org row — created on first use (max one, per spec). */
  async function ensureIptv(): Promise<TvSource | null> {
    if (iptv) return iptv;
    const res = await apiFetch("/tv/sources", {
      method: "POST",
      body: JSON.stringify({ kind: "iptv-org" }),
    });
    if (!res.ok) {
      setError(t("tv:admin.saveFailed"));
      return null;
    }
    const list = await load();
    return list.find((s) => s.kind === "iptv-org") ?? null;
  }

  async function patchSource(id: string, patch: Record<string, unknown>) {
    const res = await apiFetch(`/tv/sources/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (!res.ok) setError(t("tv:admin.saveFailed"));
    await load();
  }

  async function toggleCountry(code: string) {
    const src = await ensureIptv();
    if (!src) return;
    const next = src.countries.includes(code)
      ? src.countries.filter((c) => c !== code)
      : [...src.countries, code];
    await patchSource(src.id, { countries: next });
  }

  async function addCountry() {
    const code = countryDraft.trim().toUpperCase();
    setCountryDraft("");
    if (!code) return;
    const src = await ensureIptv();
    if (!src || src.countries.includes(code)) return;
    await patchSource(src.id, { countries: [...src.countries, code] });
  }

  async function deleteSource(id: string) {
    await apiFetch(`/tv/sources/${id}`, { method: "DELETE" });
    await load();
  }

  async function addM3uByUrl(e: React.FormEvent) {
    e.preventDefault();
    setM3uError(null);
    setM3uSaving(true);
    try {
      const res = await apiFetch("/tv/sources", {
        method: "POST",
        body: JSON.stringify({ kind: "m3u", name: m3uName || m3uUrl, url: m3uUrl }),
      });
      if (!res.ok) {
        setM3uError(t("tv:admin.saveFailed"));
        return;
      }
      setM3uName("");
      setM3uUrl("");
      await load();
    } catch {
      setM3uError(t("errors:network"));
    } finally {
      setM3uSaving(false);
    }
  }

  function addM3uFile(file: File) {
    setM3uError(null);
    if (file.size > MAX_M3U_FILE_BYTES) {
      setM3uError(t("tv:admin.m3u.fileTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      void (async () => {
        try {
          const res = await apiFetch("/tv/sources", {
            method: "POST",
            body: JSON.stringify({
              kind: "m3u",
              name: m3uName || file.name,
              fileContent: String(reader.result ?? ""),
            }),
          });
          if (!res.ok) {
            setM3uError(t("tv:admin.saveFailed"));
            return;
          }
          setM3uName("");
          await load();
        } catch {
          setM3uError(t("errors:network"));
        }
      })();
    };
    reader.readAsText(file);
  }

  async function syncNow(id: string) {
    setSyncLoading((s) => ({ ...s, [id]: true }));
    setSyncStates((s) => ({ ...s, [id]: { phase: t("tv:admin.source.syncing") } }));
    try {
      const res = await apiFetch(`/tv/sources/${id}/sync`, { method: "POST" });
      if (!res.ok) {
        setSyncStates((s) => ({ ...s, [id]: { phase: t("tv:admin.sync.error", { message: String(res.status) }) } }));
        setSyncLoading((s) => ({ ...s, [id]: false }));
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      esRef.current.get(id)?.close();
      const es = new EventSource(`/api/tv/sync/events?jobId=${jobId}`);
      esRef.current.set(id, es);
      es.onmessage = (event: MessageEvent<string>) => {
        const data = JSON.parse(event.data) as SyncState;
        setSyncStates((s) => ({ ...s, [id]: data }));
        if (data.phase === "done" || data.phase === "error") {
          es.close();
          esRef.current.delete(id);
          setSyncLoading((s) => ({ ...s, [id]: false }));
          if (data.phase === "done") void load();
        }
      };
      es.onerror = () => {
        setSyncStates((s) => ({ ...s, [id]: { phase: t("tv:admin.sync.streamError") } }));
        es.close();
        esRef.current.delete(id);
        setSyncLoading((s) => ({ ...s, [id]: false }));
      };
    } catch {
      setSyncStates((s) => ({ ...s, [id]: { phase: t("errors:network") } }));
      setSyncLoading((s) => ({ ...s, [id]: false }));
    }
  }

  function syncLine(state: SyncState | undefined): string | null {
    if (!state) return null;
    if (state.phase === "done") return t("tv:admin.sync.done");
    if (state.phase === "error") return t("tv:admin.sync.error", { message: state.message ?? "" });
    if (state.processed !== undefined && state.total !== undefined) {
      return t("tv:admin.sync.progress", { phase: state.phase, processed: state.processed, total: state.total });
    }
    return state.phase;
  }

  const countryPicker = (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-[var(--text)]">{t("tv:admin.iptv.countries")}</p>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
        {TV_COUNTRIES.map((code) => (
          <label
            key={code}
            className="flex items-center gap-2 rounded px-1.5 py-1 text-sm text-[var(--text-dim)] hover:bg-[var(--surface-2)]"
          >
            <input
              type="checkbox"
              checked={iptv?.countries.includes(code) ?? false}
              onChange={() => void toggleCountry(code)}
            />
            <span className="truncate">{regionName(code, i18n.language) ?? code}</span>
          </label>
        ))}
      </div>
      {iptv && iptv.countries.some((c) => !(TV_COUNTRIES as readonly string[]).includes(c)) && (
        <p className="text-xs text-[var(--text-dim)]">
          + {iptv.countries.filter((c) => !(TV_COUNTRIES as readonly string[]).includes(c)).join(", ")}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void addCountry();
        }}
        className="flex gap-2"
      >
        <Input
          value={countryDraft}
          onChange={(e) => setCountryDraft(e.target.value)}
          placeholder={t("tv:admin.iptv.addCountryPlaceholder")}
        />
        <Button type="submit" variant="ghost">
          {t("tv:admin.iptv.addCountry")}
        </Button>
      </form>
    </div>
  );

  const m3uAdd = (
    <div className="flex flex-col gap-2">
      <form onSubmit={(e) => void addM3uByUrl(e)} className="flex flex-col gap-2 sm:flex-row">
        <Input value={m3uName} onChange={(e) => setM3uName(e.target.value)} placeholder={t("tv:admin.m3u.namePlaceholder")} />
        <Input value={m3uUrl} onChange={(e) => setM3uUrl(e.target.value)} placeholder={t("tv:admin.m3u.urlPlaceholder")} required />
        <Button type="submit" disabled={m3uSaving}>{t("tv:admin.m3u.addByUrl")}</Button>
      </form>
      <label className="text-xs text-[var(--text-dim)]">
        {t("tv:admin.m3u.orFile")}{" "}
        <input
          type="file"
          accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) addM3uFile(file);
            e.target.value = "";
          }}
          className="text-xs"
        />
      </label>
      {m3uError && <p className="text-sm text-red-400">{m3uError}</p>}
    </div>
  );

  const sourceRow = (s: TvSource) => (
    <div key={s.id} className="flex flex-col gap-1 border-t border-[var(--surface-2)] py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--text)]">{s.name}</span>
          <span className="block truncate text-xs text-[var(--text-dim)]">
            {t("tv:admin.source.lastSync", {
              when: s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString(i18n.language) : t("tv:admin.source.never"),
            })}
            {s.status === "error" && s.statusMessage && (
              <span className="text-red-400"> — {s.statusMessage}</span>
            )}
          </span>
        </span>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-dim)]">
          <input type="checkbox" checked={s.enabled} onChange={() => void patchSource(s.id, { enabled: !s.enabled })} />
          {t("tv:admin.source.enabled")}
        </label>
        <Button variant="ghost" onClick={() => void syncNow(s.id)} disabled={syncLoading[s.id]}>
          {syncLoading[s.id] ? t("tv:admin.source.syncing") : t("tv:admin.source.syncNow")}
        </Button>
        <Button variant="ghost" onClick={() => void deleteSource(s.id)}>
          {t("common:actions.delete")}
        </Button>
      </div>
      {syncLine(syncStates[s.id]) && (
        <p className="text-xs text-[var(--text-dim)]">{syncLine(syncStates[s.id])}</p>
      )}
    </div>
  );

  if (loading) {
    return (
      <main className="p-8">
        <p className="text-[var(--text-dim)]">{t("common:status.loading")}</p>
      </main>
    );
  }

  if (wizard) {
    return (
      <main className="flex flex-col gap-6">
        <h2 className="text-2xl font-bold text-[var(--text)]">{t("tv:wizard.title")}</h2>
        {error && <p className="text-sm text-red-400">{error}</p>}

        <Card>
          {wizardStep === 0 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-lg font-semibold text-[var(--text)]">{t("tv:wizard.stepCountries")}</h3>
              {countryPicker}
              <div className="flex justify-end">
                <Button onClick={() => setWizardStep(1)}>{t("tv:wizard.next")}</Button>
              </div>
            </div>
          )}
          {wizardStep === 1 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-lg font-semibold text-[var(--text)]">{t("tv:wizard.stepM3u")}</h3>
              {m3uAdd}
              {m3uSources.length > 0 && <div>{m3uSources.map(sourceRow)}</div>}
              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => setWizardStep(0)}>{t("common:actions.back")}</Button>
                <Button onClick={() => setWizardStep(2)}>
                  {m3uSources.length > 0 ? t("tv:wizard.next") : t("tv:wizard.skip")}
                </Button>
              </div>
            </div>
          )}
          {wizardStep === 2 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-lg font-semibold text-[var(--text)]">{t("tv:wizard.stepSummary")}</h3>
              <p className="text-sm text-[var(--text-dim)]">
                {t("tv:wizard.summary", { countries: iptv?.countries.length ?? 0, sources: m3uSources.length })}
              </p>
              <div>{sources.map(sourceRow)}</div>
              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => setWizardStep(1)}>{t("common:actions.back")}</Button>
                <Link to="/tv">
                  <Button>{t("tv:wizard.finish")}</Button>
                </Link>
              </div>
            </div>
          )}
        </Card>

        <p className="text-xs text-[var(--text-dim)]">{t("tv:admin.legal")}</p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold text-[var(--text)]">{t("tv:admin.title")}</h2>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <Card>
        <h3 className="mb-1 text-lg font-semibold text-[var(--text)]">{t("tv:admin.iptv.heading")}</h3>
        <p className="mb-4 text-xs text-[var(--text-dim)]">{t("tv:admin.iptv.description")}</p>
        {iptv ? (
          <div className="flex flex-col gap-4">
            {countryPicker}
            {sourceRow(iptv)}
          </div>
        ) : (
          <Button onClick={() => void ensureIptv()}>{t("tv:admin.iptv.enable")}</Button>
        )}
      </Card>

      <Card>
        <h3 className="mb-4 text-lg font-semibold text-[var(--text)]">{t("tv:admin.m3u.heading")}</h3>
        {m3uSources.length === 0 ? (
          <p className="mb-3 text-sm text-[var(--text-dim)]">{t("tv:admin.m3u.empty")}</p>
        ) : (
          <div className="mb-3">{m3uSources.map(sourceRow)}</div>
        )}
        {m3uAdd}
      </Card>

      <p className="text-xs text-[var(--text-dim)]">{t("tv:admin.legal")}</p>
    </main>
  );
}
```

- [ ] **Step 2: Add the admin tab + guard** — in `apps/web/src/pages/account/AccountLayout.tsx`:

Extend the deep-link guard:
```tsx
  const onAdminTab =
    pathname.startsWith("/account/library") ||
    pathname.startsWith("/account/settings") ||
    pathname.startsWith("/account/tv");
```
Add the tab beside Library/Settings:
```tsx
        {isAdmin && <NavLink to="/account/tv" className={tab}>{t("nav:tv")}</NavLink>}
        {isAdmin && <NavLink to="/account/library" className={tab}>{t("nav:library")}</NavLink>}
        {isAdmin && <NavLink to="/account/settings" className={tab}>{t("nav:settings")}</NavLink>}
```

- [ ] **Step 3: Route it** — in `apps/web/src/router.tsx`:

```tsx
import AccountTvPage from "./pages/account/AccountTvPage";
```
```tsx
          { index: true, element: <AccountOverview /> },
          { path: "menu", element: <AccountMenuPage /> },
          { path: "tv", element: <AccountTvPage /> },
          { path: "library", element: <AdminLibrariesPage /> },
          { path: "settings", element: <AdminSettingsPage /> },
```

- [ ] **Step 4: Package gates**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/account/AccountTvPage.tsx apps/web/src/pages/account/AccountLayout.tsx apps/web/src/router.tsx
git commit -m "feat(tv): /account/tv sources admin (iptv-org countries + M3U) with SSE sync progress and first-run wizard" \
  -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 10: Full gates + manual smoke + wrap-up

**Files:** none new — verification only.

- [ ] **Step 1: Full repo gates**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: every package green (core incl. proxy tests, api incl. tv-upstream + tv-play, web incl. tv helpers + locale parity).

Run: `pnpm build`
Expected: turbo build green (db prisma generate, web vite build — confirms the new pages/deps tree-shake and bundle).

- [ ] **Step 2: Manual smoke (dockerized stack)**

Dependencies changed (api: `undici`; web: `@tanstack/react-virtual`) and images bake `node_modules`:

```bash
docker compose build api web
docker compose up -d
```

Then, in a browser at `http://localhost:1060` (exact clicks):

1. Log in → pick a **standard** profile. The top nav now shows **TV** between Home and the catalog categories (mobile: TV tab in the bottom bar).
2. Click **TV** → the empty state appears with **Add channels** (you are the admin). Click it → lands on `/account/tv?wizard=1`.
3. Wizard step 1: check **Russia** and **Germany** → **Next**. Step 2: **Skip** (or add a small M3U URL you trust). Step 3: click **Sync now** on the iptv-org row → a progress line streams (phase — n/m) and ends with "Sync complete." Click **Go to TV**.
4. `/tv` now shows rails (per-country at minimum). Hover a card → the favorite heart appears; click the heart → it fills; the **Favorites** rail appears after the queries refetch.
5. Click a channel tile → the full-screen player opens, the zap OSD (number · logo · name · quality) shows and auto-hides after ~4 s. Wait ~30 s of playback → `TvStream.status` flips to `ok` (verify later via psql if desired).
6. Keys: **PageDown**/**PageUp** zap within the rail; **Backspace** returns to the previous channel; **i** re-shows the OSD; **g** opens the mini-guide (↑/↓ move, **Enter** tunes in place, **Esc** closes it); **l** snaps to the live edge; pause → play returns you to the live edge (no stuck-behind-live).
7. Pick a channel that is known-dead (grey dot) → sources are tried in order with "Trying next source (2/3)…" toasts, ending in "Channel appears offline" with **Retry** / **Next channel** buttons.
8. Click **Guide** on `/tv` → `/tv/guide`: type in the search box (results update after the 300 ms debounce), click a country chip, scroll fast to the bottom → the next page of 100 loads seamlessly (virtualized, no jank). Hover a row → the info icon appears; click it → the channel page with hero, badges, **Watch** and the "No guide data" schedule copy. **Watch** plays.
9. `/account/tv` (Sources mode): toggle a source off/on, add + delete an M3U by URL, upload a small `.m3u` file (and confirm a >5 MB file is rejected client-side).
10. Kids check: switch to a **kids** profile → TV is absent from both navs; `curl -i` any `/api/tv/*` route with that profile's cookies → **403**. Deep-linking `/tv` shows the shell but every fetch 403s (server-enforced).
11. Offline check: with channels synced, disconnect WAN briefly → `/tv` still browses (logos served from the disk cache via `/api/images/*`); only playback of remote streams needs the network.

Reap anything host-side if you smoked outside docker: `pkill -f "tsx.*watch src/server.ts"; pkill -f vite`.

- [ ] **Step 3: Confirm clean tree + push-readiness**

Run: `git status` → clean (every task committed). Do **not** push/PR unless asked — finishing is a separate decision (`superpowers:finishing-a-development-branch`).

## Self-Review (done at plan-writing time; re-verify after execution)

- **Spec phase 4 (proxy + play + health):** Task 1 (rewrite/signing/private-IP), Task 2 (browser-UA default, per-stream header overrides, manual redirects w/ per-hop validation, connect ~5 s / header ~10 s timeouts), Task 3 (entry//p//s routes, `no-store`, segment pass-through with no in-process buffering, 409 `no_playable_stream`, health thresholds 3→degraded / 8→dead, proxy-side bumps, kids 403, fixture-origin end-to-end test incl. real-guard 127.0.0.1 rejection). ✓
- **Spec phase 5 (web section):** Task 4 (types/hooks/i18n), Task 6 (`/tv` rails: recents → favorites → countries → categories; card = logo/monogram + quality + offline dot + hover heart; Guide affordance; empty state admin/member; nav placeholder → live link, kids-hidden in both navs), Task 7 (guide: chips/search/virtualized windowed list, em-dash now/next), Task 8 (channel page: hero/favorite/Watch/schedule shell), Task 9 (`/account/tv` sources + SSE + wizard + legal copy). ✓
- **Spec phase 6 (player):** Task 5 — `streamType="live"` explicit, bundled hls.js via `provider.library`, live config incl. exact manifest/frag load policies, NETWORK→startLoad / MEDIA→recoverMediaError ladder then source advance, exhaustion → offline panel + health `ok:false` per failed source, ≥30 s → `ok:true` once, tune event POST, #1623 resume nudge via `seekableEnd`, OSD 4 s, mini-guide with in-place tuning, PageUp/PageDown + Shift+arrows + Backspace + g/l/i keys, all listeners cleaned up. ✓
- **Placeholder scan:** no TBD/TODO/"similar to Task N"; every component/test step carries complete code; the only forward references are two links whose routes land one task later (called out inline).
- **Type consistency:** `TvChannelCard`/`TvPlayResponse` (Task 4) match Task 3's route output (`logo` ← `logoPath`, `nowNext: null`, ≤3 sources) and Phase-1's card contract; `useTvGuide` pages match `TvGuideResponse`; `LiveTvOverlay` props match all three page call sites; `orderStreams` generic satisfied by the play route's select set; health update objects match the test assertions field-for-field.
- **Known deviations from the fixed contract** (all additive/forced, none behavioral): task order puts the player (5) before the pages (6–8) so no interim stubs; `makeTvUpstream` also returns `close()`; literal-IP pre-check applies even with an injected lookup (hence fixture hostnames); proxy fetch *exceptions* map to 502 `upstream_unreachable` (non-200s keep the contractual `upstream_<status>`); health `ok:true` also stamps `lastCheckAt`; monogram hue is seeded from `channel.id` (the card contract carries no `extId`); guide rows add a spec-mandated channel-details affordance; `useTvProgrammes` added as a 5th hook; `buildApp` gains a `tvUpstream` override (mirrors `mountRuntime`).
