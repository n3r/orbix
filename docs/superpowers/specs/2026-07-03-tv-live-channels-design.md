# TV — Worldwide Live Channels (design)

**Date:** 2026-07-03 · **Branch:** `features/television` · **Status:** approved under AFK autonomy grant — see [Adopted assumptions](#adopted-assumptions-to-re-confirm)

Orbix gains a top-level **TV** section: a browsable worldwide catalog of free, publicly available live TV channels with in-browser playback, favorites, recents, and a program guide — for a household that lives across several countries. The existing "TV — Coming soon" nav placeholder becomes real.

## Goals

1. **Worldwide catalog**: browse ~10k free channels by country/category, synced from the iptv-org public-domain index; import your own M3U playlists for anything it misses.
2. **Watch in the browser**: click a channel → it plays, through the same cinematic player shell as movies. Resilient to the reality of public IPTV (dead streams, geo-blocks, flaky origins).
3. **Guide**: now/next everywhere EPG data exists; per-channel day schedule; schema ready for a full grid later.
4. **Best-in-class feel**: instant zapping, mini-guide during playback, favorites/recents, cached logos, honest health states — the TiviMate lessons inside Orbix's Netflix-style UI.

## Non-goals (v1)

DVR/recording · catch-up archive ("смотреть с начала") · full time×channel EPG grid (v1.5; schema supports it) · picture-in-guide channel preview · number-entry zap · ffmpeg live-remux of non-HLS streams (~4% of catalog; marked unplayable) · DASH/DRM · Xtream-codes login · feed-level regional variants · kids whitelist UI (schema flag ships, UI later) · per-profile country preferences · direct-play (no-proxy) optimization.

## Research grounding (2026-07-03)

- **iptv-org** (all Unlicense/public domain, measured live): 40,394 channels / 10,030 with ≥1 stream / 16,675 streams; **96% HLS**; 6.3% need Referer/UA; JSON API rebuilt daily ~00:32 UTC, ETag + gzip (~5 MB for the big files); `blocklist.json` (1,574 DMCA/NSFW entries) already excluded from streams; `closed`/`replaced_by` lifecycle fields; **`UK` not `GB`** (their `countries.json` is authoritative); logos 59% imgur / 24% wikimedia → must disk-cache; feeds = channel variants, exactly one `is_main` per channel.
- **EPG**: iptv-org publishes only site *mappings* (guides.json), no hosted XMLTV (a 2-channel pilot exists — ignore). Practical sources: **iptvx.one** (RU/CIS workhorse, `epg.xml.gz` variants incl. LITE), **epgshare01.online** (`epg_ripper_<CC>1.xml.gz` country packs, no RU), **epg.pw** (~20 countries incl. RU). XMLTV channel-id convention `Channel.id@FeedId`.
- **Empirical probe** (24 RU/DE streams from here): 17 alive; most send permissive CORS **but not all** (`bl.rutube.ru` = none) and redirect hops lose it; **ZDF 403s curl's UA but 200s a browser UA**; iptv-org playlists are **CRLF** — hence: server proxy is mandatory, browser-like UA default, per-stream header overrides, CRLF-safe parsing.
- **Prior art**: IPTVnator proxies playlists but not segments → breaks on non-CORS origins (validates full proxy). Threadfin dropped its custom byte-buffer ("ffmpeg/VLC always better") → pass bytes through, never buffer ourselves. Jellyfin's guide fetches everything at once (1.27 MB / 9–10 s at 867 channels) → our guide API is windowed by contract. Vidstack: set `streamType` explicitly; pause/resume live-edge bug #1623 needs a nudge workaround; hls.js v1.5 load policies are the retry knobs.
- **Legal posture** (community norm, not legal advice): neutral player; no stream URLs in the repo; opt-in runtime sync of iptv-org's DMCA-respecting public index (the Hypnotix/Linux Mint precedent); user playlists are the user's responsibility; RU federal channels are officially web-only via Vitrina TV (anti-embedding by design) so RU coverage comes from the index + user playlists; never touch DRM.

## Architecture

A **dedicated TV domain** parallel to the VOD catalog — no `MediaItem` reuse (the VOD path is duration-coupled end-to-end: stream route 409s unprobed files, session manager builds fixed-length playlists, kids logic keys on TMDB certs). Pure logic in `packages/core/src/tv/`, adapters + routes in `apps/api`, pages in `apps/web`.

**Naming discipline**: API under `/api/tv/*`; models `Tv*`; web route `/tv`. Avoids everything claimed by the parallel `features/tv-app` effort (`/api/pair/*`, `/api/devices`, `/api/playback/info`, `DeviceToken`) — there, "TV" means Apple TV; here it means television. The web nav placeholder is unclaimed by that effort and becomes ours.

```
iptv-org API ──┐                       ┌─ /tv (rails) ── /tv/guide ── /tv/channel/:id
user M3U ──────┼─ tv-sync job ─→ Tv* tables ─→ /api/tv/* ──┤
XMLTV sources ─┘   (BullMQ)        ↑                       └─ LiveTvPlayer ← /api/tv/proxy/*
                                   └─ tv-epg / tv-health jobs
```

## Data model (Prisma)

String-enum + comment style, cuid ids, Cascade deletes — house conventions. Migration `20260703xxxxxx_add_tv_live_channels`.

```prisma
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

**Feed flattening**: one `TvChannel` per iptv-org *channel*; all feeds' streams attach to it, main feed at `priority 0`. `epgId` defaults to `extId@<mainFeedId>` falling back to `extId`. Regional-feed granularity is deferred.

**Numbering**: first import assigns sequential numbers (countries alphabetical, channels alphabetical within country); later imports append after the current max. Numbers are never reused or auto-renumbered — numeric sort everywhere (`ORDER BY number`, not string sort). Provider `tvg-chno` is parsed but ignored (provider numbers are junk — TiviMate practice); admin can renumber manually.

## Catalog sync (`tv-sync` job)

New BullMQ queue `tv` (worker in `queue.ts` following the scan/translate pattern, `NODE_ENV=test` stubbed, SSE progress via a `tvEvents` emitter + done-cache replayed to late subscribers on `GET /api/tv/sync/events`).

**iptv-org source** (max one row, `kind="iptv-org"`): fetch `channels/feeds/streams/logos/blocklist(.json)` with `If-None-Match` (daily upstream rebuild; 304 short-circuits). Core pure planner `planCatalogSync({api, existing, countries})` returns `{channelUpserts, streamUpserts, removals, renames}`:

- Import only channels of enabled `countries` that have ≥1 stream; **skip** `closed != null`, `is_nsfw`, blocklisted ids (belt and braces — upstream already excludes).
- Follow `replaced_by` renames by re-pointing the existing row's `extId` (favorites/recents/programmes survive via unchanged `TvChannel.id`).
- Channels that vanish upstream are kept but `hidden` (favorites keep working if a stream still plays); their streams marked `dead` if gone.
- Streams: dedupe by URL, priority = main feed first then quality desc; `protocol` classified from URL (`.m3u8` → hls, `.mpd` → dash, else other).
- Logos: for new/changed `logoUrl`, download via `cacheImageFromUrl(url, "channel", io)` (new `ImageKind "channel"`), store `logoPath`; failures leave `logoPath` null (UI monogram fallback). Existing `/api/images/*` serves them — offline browsing holds.

**M3U sources** (`kind="m3u"`, N rows; URL or uploaded file): core `parseM3u(text)` — **CRLF-safe**, `#EXTINF` attrs (`tvg-id`, `tvg-name`, `tvg-logo`, `tvg-shift`, `tvg-chno`, `group-title` incl. `;`-multi), `#EXTVLCOPT:http-referrer/http-user-agent/http-origin`, `#KODIPROP` ignored-but-tolerated, `URL|Header=Value` pipe suffix, `url-tvg` header → `epgUrl`. `extId` = `tvg-id` if present else stable hash of (name,url). `cleanChannelName(raw)` strips `CC|` prefixes and quality/status suffixes into `quality`/`label`, keeps `rawName`. Import summary surfaced to the UI ("612 channels · 14 groups · logos 87% · EPG URL detected").

**Scheduling**: unref'd `setInterval`s in `app.ts` beside the metadata-refresh one — `tv-sync` every 24 h, `tv-epg` every 12 h, `tv-health` nightly. Each is a cheap enqueue; the worker no-ops cleanly when nothing is configured.

## Playback: always-proxy, HLS-only

The probe proved direct browser fetch fails for a meaningful minority (missing CORS, UA gates, redirect hops, http-on-https). Everything flows through a same-origin proxy; VOD's `SessionManager` is untouched.

**Tune flow**: `GET /api/tv/channels/:id/play` → orders playable streams (`protocol=hls`, `status != dead` first by `status(ok>unknown>degraded) then priority`), 409 `no_playable_stream` when empty, else:

```json
{ "channel": {…}, "nowNext": {…}, "sources": [
  { "streamId": "…", "src": "/api/tv/proxy/<streamId>/index.m3u8", "quality": "1080p", "label": null }
]}
```

Client tries sources in order — failover without extra round-trips.

**Proxy routes** (session + profile guarded like every content route):

- `GET /api/tv/proxy/:streamId/index.m3u8` — entry; fetches the stream's own URL.
- `GET /api/tv/proxy/:streamId/p?u=<b64url>&sig=<hmac>` — nested playlists (variants, alt-media).
- `GET /api/tv/proxy/:streamId/s?u=<b64url>&sig=<hmac>` — opaque bytes: segments, init sections (`EXT-X-MAP`), keys (`EXT-X-KEY`).

Mechanics:

- **Headers out**: stream's `userAgent` else a pinned modern-browser UA (ZDF lesson); stream's `referrer` when set. Timeouts: connect ~5 s, header ~10 s.
- **Redirects**: manual follow (cap 5), each hop re-validated; segment/child URIs resolve against the **final** URL of the playlist that referenced them (`u` is always absolute by construction).
- **Rewrite** (core-pure `rewritePlaylist(text, finalBaseUrl, makeProxyUrl)`): line-based m3u8 transform covering URI lines, `EXT-X-KEY:…URI="…"`, `EXT-X-MAP`, `EXT-X-MEDIA`, `EXT-X-I-FRAME-STREAM-INF`; playlists → `/p`, everything else → `/s`. Responses `cache-control: no-store`.
- **Anti-SSRF**: `u` accepted only with `sig = HMAC-SHA256(SESSION_SECRET, streamId + "|" + u)` — only URLs the server itself minted while rewriting proxy. http(s) schemes only. Upstream fetches go through an undici Agent with a **validating DNS lookup** (rejects loopback/RFC1918/link-local/ULA on every resolution — closes rebinding, not just first-hop), applied to every redirect hop.
- **Segments**: `undici` response body piped to `reply.raw` — pure pass-through, no in-process buffering (Threadfin lesson), backpressure via the pipe.
- **Health feedback**: `POST /api/tv/streams/:id/health {ok, code?}` from the player — `ok:false` bumps `failCount` (→ `degraded` at 3, `dead` at 8, sticky until a later success or probe); `ok:true` after ≥30 s of playback resets to `ok`. Proxy-side upstream 4xx/5xx also bump.

**`tv-health` job**: nightly, for streams not checked in 24 h (sample cap ~500/night, concurrency 8): GET playlist with the stream's headers, then first segment's first bytes; verdict updates status. Geo-blocks from the NAS are honest `dead-from-here` — which is what the household actually experiences (the NAS fetches everything).

## Player (web)

`LiveTvPlayer` — a sibling of the VOD `Player` sharing the overlay/portal pattern and Vidstack layout styling, not its VOD logic (no decision endpoint, no progress PUTs, no resume):

- `streamType="live"` set **explicitly** (Vidstack inference is unreliable per its own docs); `provider.library = Hls` (bundled — never the CDN default).
- hls.js: `liveSyncDurationCount: 4`, `liveMaxLatencyDurationCount: 12`, `maxLiveSyncPlaybackRate: 1.2`, `manifestLoadPolicy` tight (dead channel fails in a few seconds — zap UX), `fragLoadPolicy.errorRetry.maxNumRetry: 8`.
- Error ladder: fatal NETWORK → one `startLoad()` retry → next source; fatal MEDIA → one `recoverMediaError()` → next source; sources exhausted → offline state `Channel appears offline [Retry] [Next channel]` + health report. Toasts: `Reconnecting…`, `Trying next source (2/3)…` — never silent.
- Pause/resume: nudge `currentTime` to `seekableEnd` on resume (vidstack #1623 workaround). LIVE pill (red at edge / grey `-00:42` behind, click = live edge).
- **Zap OSD** on every tune (auto-hide 4 s): number, logo, name, now-title + progress, next-title, quality badge, source indicator when failed-over.
- **Mini-guide drawer** (`g` or controls button): channel list with now/next scoped to the tune context (rail/filter you came from), ←/→ switches group (Favorites ⇄ Recents ⇄ categories), Enter tunes without closing playback, Esc closes.
- Keys: `PageUp/PageDown` (and `Shift+↑/↓`) zap · `Backspace` last channel · `g` guide · `l` live edge · `i` re-show OSD. Existing Vidstack keys (space/k/f/m/c, ↑↓ volume) unchanged. Audio/subtitle menus = stock Vidstack (HLS alt-audio matters on intl channels).
- Tune logs `TvPlayEvent` (fire-and-forget) → recents.

## EPG pipeline (`tv-epg` job)

- **Seeding**: enabling iptv-org countries auto-creates default `TvEpgSource` rows — RU/CIS → `https://epg.iptvx.one/EPG_LITE.xml.gz`; DE/FR/ES/IT/PT/UK/US/TR/RS/NL → `https://epgshare01.online/epgshare01/epg_ripper_<CC>1.xml.gz`; admin can add/remove/disable any XMLTV URL (epg.pw as documented alternative). M3U `url-tvg` auto-adds one per source.
- **Ingest**: api streams the download through gunzip into a core incremental SAX collector (`saxes`; pure — bytes in, rows out) that **filters to tracked `epgId`s only** (a 78 MB national feed must not become 1M rows), applies `offsetMin`, windows to now−6 h … now+48 h, batch-upserts on `(channelId, start)`, prunes `stop < now−6h`.
- **Matching** (core-pure, tested): exact `epgId` match against XMLTV channel ids; else normalized-name match within the same country (NFC, lowercase, strip quality suffixes/diacritics); unmatched channels simply have no guide (UI degrades per design). Admin remap = editing `TvChannel.epgId`.
- **Serving**: guide/now-next reads Postgres only — no XML parsing on any request path.

## API surface (all under `/api`, session-guarded; kids profiles → 403/404 in v1)

| Route | Purpose |
|---|---|
| `GET /tv/home` | rails: recents, favorites (with now), on-now per category, per-country slices |
| `GET /tv/guide?country&category&favorites&q&offset&limit` | **windowed** channel list with now/next — never the whole catalog |
| `GET /tv/channels/:id` | channel detail |
| `GET /tv/channels/:id/programmes?day=` | full-day schedule (single channel only) |
| `GET /tv/channels/:id/play` | ordered proxied sources + now/next |

All non-admin routes above sit behind `requireAuth` + a shared `requireTvAccess` guard (403 for kids profiles in v1).
| `GET /tv/proxy/:streamId/{index.m3u8, p, s}` | HLS proxy (signed) |
| `POST /tv/streams/:id/health` | player health feedback |
| `PUT/DELETE /tv/favorites/:channelId` · `GET /tv/favorites` | per-profile favorites |
| `POST /tv/events/:channelId` | tune event (recents) |
| Admin (`requireAuth+requireAdmin+requireNonKids`): `GET/POST/PATCH/DELETE /tv/sources`, `POST /tv/sources/:id/sync`, `GET/POST/PATCH/DELETE /tv/epg-sources`, `POST /tv/epg/refresh`, `GET /tv/admin/channels?q&offset&limit`, `PATCH /tv/admin/channels/:id` (hidden/kidsAllowed/epgId/number), `GET /tv/sync/events` (SSE) | management |

Serialization note: no BigInt in `Tv*` models — nothing to `.toString()`, keep it that way.

## Web UI

- **`/tv`** (`TvHomePage`): rails — Continue watching (recents) → Favorites → On now per category (only categories with EPG) → per-country rails (enabled countries, channel-count desc) → remaining groups. `ChannelCard`: 16:9 dark tile, cached logo or monogram (initials on hue-hashed gradient), quality badge, offline dot, hover = now/next + progress. Click = instant tune (overlay opens; no interstitial). Header "Guide" button — visible affordance (the Hulu lesson).
- **`/tv/guide`** (`TvGuidePage`): sticky chips (All / Favorites / countries / categories / search) over a virtualized (`@tanstack/react-virtual`, new dep) now/next row list; no-EPG channels render compact name-only rows below EPG-bearing ones per group. Row click tunes; "Schedule" affordance → channel page.
- **`/tv/channel/:id`** (`TvChannelPage`): logo hero, favorite toggle, badges, today's schedule list (RU телепрограмма pattern), Watch CTA.
- **Empty state** on `/tv`: admin → "Add channels" wizard (country picker seeded from profile language + optional M3U add + import summary); non-admin → "Ask your admin".
- **`/account/tv`** (new admin tab "TV"): Sources card (iptv-org toggle + country multi-select; M3U add URL/file), EPG sources card, Channel manager (search/filter table: hide, kidsAllowed, epgId, number), Sync now + SSE progress line, and the legal notice copy.
- **Nav**: `TopNav`/`BottomNav` placeholder → `<Link to="/tv">`, hidden for kids profiles.
- **i18n**: new `tv` namespace across all 6 locales (parity test enforces); reuse `nav:tv`.
- Router: all under `RequireProfile`; player overlay is component-state, not a route (matches VOD).

## Kids & auth

v1: TV is **absent for kids profiles** — nav hidden and every `/api/tv/*` route returns 403 for kids profiles server-side (a shared `requireTvAccess` preHandler), consistent with "unrated = excluded" fail-safe. NSFW channels are never imported at all. `kidsAllowed` exists in schema so the later whitelist mode is a pure flip (kids see exactly the flagged set), not a migration.

## Legal posture (product copy + README)

Orbix ships **no channels and no stream URLs**. The worldwide catalog is an **opt-in, at-runtime sync** of the iptv-org public-domain index of publicly available broadcasts (DMCA blocklist honored; NSFW excluded; the Hypnotix precedent). User-imported playlists are the user's responsibility. Streams' availability varies by country and by the server's network position; Orbix never bypasses DRM, tokens, or geo measures. Settings shows a short version of this; README the fuller one. Not legal advice.

## Testing

- **core** (pure, injected, no IO): `parseM3u` (CRLF, EXTVLCOPT, pipe-suffix, url-tvg, attr edge cases), `cleanChannelName`, `planCatalogSync` (closed/nsfw/blocklist/replaced_by/UK-code cases), `assignNumbers` stability, `rewritePlaylist` (relative/absolute, KEY/MAP/MEDIA/I-FRAME, redirect base), signing helpers, `pickStream` ordering, XMLTV collector (filtering, offset, windowing), EPG name-matching.
- **api** (`app.inject` + prisma monkey-patch, house style): guide windowing & filters, play ordering + `no_playable_stream`, kids 403s on every route, favorites, **proxy: bad/missing sig 403, private-IP upstream rejected, playlist rewrite end-to-end against a local fixture origin served by the test**, health thresholds.
- **e2e** (throwaway DB): TV nav visible/absent (standard/kids), `/tv` empty state, admin adds an M3U (fixture file) → channels appear.
- Gates per change: `pnpm typecheck && pnpm lint && pnpm test`; `pnpm build` before merge.

## Rollout phases (→ implementation plan)

1. Schema + migration + core domain types.
2. Core parsers/planners (m3u, clean-name, sync planner, numbering) — TDD.
3. iptv-org sync job + logo caching + sources/admin API + SSE.
4. Proxy + play + health (core rewriter/signing + api routes + fixture-origin tests).
5. Web: nav + `/tv` + guide + channel page + wizard/empty state.
6. LiveTvPlayer (zap, OSD, mini-guide, failover, keys).
7. EPG (sources seeding, ingest job, matching, now/next in API+UI, schedule page).
8. Admin channel manager + `tv-health` job.
9. i18n sweep (6 locales), e2e, README/deploy docs, polish.

## Adopted assumptions (to re-confirm)

User was AFK for all clarifying questions (60 s timeouts); recommended options adopted per the session's autonomy grant. Any can be reversed cheaply before phase 9:

1. **Sources**: hybrid — iptv-org catalog **and** own M3U import, both v1.
2. **First-class countries**: RU (deepest) + DE/FR/ES/PT/UK + US; all others browsable.
3. **EPG depth v1**: now/next + mini-guide + per-channel schedule; grid v1.5.
4. **Kids**: TV hidden for kids profiles v1; whitelist later; NSFW never imported.
5. **Approach**: dedicated TV domain, always-proxy, HLS-only v1 (A over B/C).
6. **Design approval**: presented in-session, adopted on timeout.
