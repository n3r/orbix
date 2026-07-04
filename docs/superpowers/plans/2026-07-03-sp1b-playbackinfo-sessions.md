# SP1b: PlaybackInfo + Per-Session Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clients declare their playback capabilities once (`POST /api/playback/info`) and receive an explicit decision (`direct | remux | transcode`) + a server-generated `playSessionId` that isolates every viewing into its own ffmpeg session — fixing the shared-session bug (`fileId:"default"`) and enabling audio-track selection.

**Architecture:** A new pure `decidePlayback(source, capabilities)` in `packages/core` replaces the hardcoded hls.js assumptions (legacy `decideStrategy` stays until the web client flips, then dies). An in-memory `PlaySessionRegistry` maps `playSessionId → {fileId, plan, …}`; HLS routes resolve sessions through it (`404 session_expired` on unknown ids — clients renegotiate), and the `SessionManager` is keyed by `playSessionId`. The web player migrates to the new endpoint in this same plan, after which the legacy `/play/:fileId/decision` route is deleted.

**Tech Stack:** Fastify 5 + Prisma, vitest (`buildApp` + prisma stubs + `app.inject`), pure-core TDD, React/Vidstack web player.

**Spec:** `docs/superpowers/specs/2026-07-03-tv-app-and-client-server-contract-design.md` §4.2–§4.3

## Global Constraints

- Repo-local pnpm (`pnpm@10.22.0`), commands from repo root; run `pnpm --filter <pkg> lint` per task (Turbo caches hide stale lint).
- `packages/core` stays free of DB/network/ffmpeg/fs imports (`node:crypto` allowed).
- Kids filtering server-enforced on every route — the new playback route must gate exactly like the old `/decision` (404/403 semantics preserved: blocked kids requests must not learn a title exists where current routes 404).
- Every task leaves the whole repo compiling and its tests green (legacy paths are removed only in the same task that migrates their last consumer).
- **Audio index trap:** `MediaFile.audioTracks[]` stores ffprobe's ABSOLUTE stream index in `index`, but ffmpeg `-map 0:a:N` takes the AUDIO-RELATIVE position. The public API's `audioTrackIndex` is always the audio-relative position (0-based order within `audioTracks`); never pass the absolute index to `-map 0:a:`.
- Subtitle track indexes remain ABSOLUTE stream indexes (existing `/subs/:index` contract uses `-map 0:<index>`).
- Offline guarantee: no new runtime network dependencies.
- Commit after every task.

---

### Task 1: Core `decidePlayback` (capability-aware strategy)

**Files:**
- Modify: `packages/core/src/playback/strategy.ts`
- Create: `packages/core/src/playback/decide.test.ts`
(`strategy.test.ts` and the legacy `decideStrategy` remain untouched — they die in Task 6.)

**Interfaces:**
- Produces (exported from `@orbix/core` via the existing `./playback/strategy` re-export):

```ts
export interface AudioTrack { index: number; codec?: string; channels?: number; language?: string }
export interface StrategySource2 { container?: string; videoCodec?: string; audioTracks: AudioTrack[] }
export interface ClientCapabilities {
  containers: string[];       // direct-play container families, e.g. ["mp4"]
  videoCodecs: string[];      // e.g. ["h264"] (web) or ["h264","hevc"] (tvOS, SP2)
  audioCodecs: string[];      // codecs the client decodes, e.g. ["aac"] / ["aac","ac3","eac3","flac"]
  maxAudioChannels: number;   // channel ceiling for COPIED HLS audio and transcode targets
  hlsMultichannelAacBroken?: boolean; // hls.js/MSE quirk: >2ch AAC cannot be copied into HLS
}
// PlaybackPlan gains OPTIONAL fields (legacy decideStrategy results stay type-valid):
export type PlaybackPlan =
  | { mode: "direct" }
  | { mode: "remux"; audioAction: "copy" | "aac"; audioTrackIndex?: number; audioChannels?: number }
  | { mode: "transcode"; audioAction: "copy" | "aac"; audioTrackIndex?: number; audioChannels?: number };
export function decidePlayback(
  source: StrategySource2,
  caps: ClientCapabilities,
  opts?: { audioTrackIndex?: number },  // audio-RELATIVE position; default 0
): PlaybackPlan
```

**Decision rules (implement exactly):**
1. Selected track = `source.audioTracks[opts?.audioTrackIndex ?? 0]` (may be `undefined` for audio-less files).
2. **direct** — all of: `source.container` matches a capability container (reuse the substring regex idiom: a container matches when the ffprobe `format_name` contains that capability string, e.g. capability `"mp4"` matches `"mov,mp4,m4a,3gp,3g2,mj2"`; build `new RegExp(caps.containers.join("|"), "i")` — for `["mp4"]` extend to the existing MP4 family by testing `MP4_FAMILY_RE` when the list includes `"mp4"`); `source.videoCodec` ∈ `caps.videoCodecs`; selected track exists and its `codec` ∈ `caps.audioCodecs`; and `(opts?.audioTrackIndex ?? 0) === 0` (progressive playback cannot remap tracks). **No channel-count constraint on direct** — progressive `<video>`/AVPlayer decode natively; the AAC quirk is HLS-only.
3. Otherwise compute the audio action for the selected track:
   - `copy` when: track exists, `track.codec` ∈ `caps.audioCodecs`, `(track.channels ?? 2) <= caps.maxAudioChannels`, and NOT (`caps.hlsMultichannelAacBroken` && `track.codec === "aac"` && `(track.channels ?? 2) > 2`).
   - else `aac` with `audioChannels = Math.min(track?.channels ?? 2, caps.maxAudioChannels)` (minimum 1; use 2 when channels unknown).
   - For `copy`, set `audioChannels = track.channels ?? 2` (informational; ffargs ignores it on copy).
   - Always set `audioTrackIndex = opts?.audioTrackIndex ?? 0`.
4. **remux** when `source.videoCodec` ∈ `caps.videoCodecs`; else **transcode**. (Video level/HDR constraints arrive in SP1c with the probe extensions.)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/playback/decide.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decidePlayback, type ClientCapabilities } from "./strategy";

const WEB: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: ["h264"],
  audioCodecs: ["aac"],
  maxAudioChannels: 2,
  hlsMultichannelAacBroken: true,
};

const APPLE_TV: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac", "ac3", "eac3", "flac"],
  maxAudioChannels: 6,
};

const aac2 = { index: 1, codec: "aac", channels: 2, language: "en" };
const aac6 = { index: 1, codec: "aac", channels: 6, language: "en" };
const ac3 = { index: 1, codec: "ac3", channels: 6, language: "en" };
const dts = { index: 1, codec: "dts", channels: 6, language: "en" };
const commentary = { index: 2, codec: "aac", channels: 2, language: "ru" };

describe("decidePlayback — web profile parity", () => {
  it("direct: mp4 + h264 + first-track aac", () => {
    expect(decidePlayback({ container: "mov,mp4,m4a,3gp,3g2,mj2", videoCodec: "h264", audioTracks: [aac2] }, WEB))
      .toEqual({ mode: "direct" });
  });

  it("direct is NOT blocked by 5.1 AAC (progressive decode is native)", () => {
    expect(decidePlayback({ container: "mp4", videoCodec: "h264", audioTracks: [aac6] }, WEB))
      .toEqual({ mode: "direct" });
  });

  it("remux + audio copy: mkv + h264 + stereo aac", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [aac2] }, WEB))
      .toEqual({ mode: "remux", audioAction: "copy", audioTrackIndex: 0, audioChannels: 2 });
  });

  it("remux + aac transcode: mkv + h264 + ac3 (downmix to caps ceiling)", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [ac3] }, WEB))
      .toEqual({ mode: "remux", audioAction: "aac", audioTrackIndex: 0, audioChannels: 2 });
  });

  it("multichannel AAC over HLS is transcoded for web (hls.js MSE quirk)", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [aac6] }, WEB))
      .toEqual({ mode: "remux", audioAction: "aac", audioTrackIndex: 0, audioChannels: 2 });
  });

  it("transcode: hevc for a h264-only client", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "hevc", audioTracks: [aac2] }, WEB))
      .toEqual({ mode: "transcode", audioAction: "copy", audioTrackIndex: 0, audioChannels: 2 });
  });

  it("no audio track: aac action with stereo default", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [] }, WEB))
      .toEqual({ mode: "remux", audioAction: "aac", audioTrackIndex: 0, audioChannels: 2 });
  });
});

describe("decidePlayback — Apple TV profile", () => {
  it("remux (not transcode) for HEVC in MKV", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "hevc", audioTracks: [aac2] }, APPLE_TV))
      .toEqual({ mode: "remux", audioAction: "copy", audioTrackIndex: 0, audioChannels: 2 });
  });

  it("AC-3 5.1 passes through", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "hevc", audioTracks: [ac3] }, APPLE_TV))
      .toEqual({ mode: "remux", audioAction: "copy", audioTrackIndex: 0, audioChannels: 6 });
  });

  it("DTS is transcoded to multichannel AAC", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "hevc", audioTracks: [dts] }, APPLE_TV))
      .toEqual({ mode: "remux", audioAction: "aac", audioTrackIndex: 0, audioChannels: 6 });
  });

  it("multichannel AAC copies for clients without the MSE quirk", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [aac6] }, APPLE_TV))
      .toEqual({ mode: "remux", audioAction: "copy", audioTrackIndex: 0, audioChannels: 6 });
  });
});

describe("decidePlayback — audio track selection", () => {
  it("selecting a non-default track forces non-direct and maps the relative index", () => {
    const src = { container: "mp4", videoCodec: "h264", audioTracks: [ac3, commentary] };
    expect(decidePlayback(src, APPLE_TV, { audioTrackIndex: 1 }))
      .toEqual({ mode: "remux", audioAction: "copy", audioTrackIndex: 1, audioChannels: 2 });
  });

  it("out-of-range track index falls back to aac/stereo defaults", () => {
    const src = { container: "matroska,webm", videoCodec: "h264", audioTracks: [aac2] };
    expect(decidePlayback(src, WEB, { audioTrackIndex: 5 }))
      .toEqual({ mode: "remux", audioAction: "aac", audioTrackIndex: 5, audioChannels: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @orbix/core exec vitest run src/playback/decide.test.ts
```

Expected: FAIL — `decidePlayback` is not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/playback/strategy.ts`, keep everything that exists (including `decideStrategy`) and append:

```ts
export interface AudioTrack {
  index: number; // ffprobe ABSOLUTE stream index (as stored in MediaFile.audioTracks)
  codec?: string;
  channels?: number;
  language?: string;
}

export interface StrategySource2 {
  container?: string;
  videoCodec?: string;
  audioTracks: AudioTrack[];
}

export interface ClientCapabilities {
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  maxAudioChannels: number;
  hlsMultichannelAacBroken?: boolean;
}

function containerMatches(container: string | undefined, caps: string[]): boolean {
  if (!container) return false;
  // "mp4" implies the whole MP4 family (ffprobe reports "mov,mp4,m4a,3gp,3g2,mj2").
  if (caps.includes("mp4") && MP4_FAMILY_RE.test(container)) return true;
  return caps.some((c) => container.toLowerCase().includes(c.toLowerCase()));
}

/**
 * Capability-aware playback decision. `opts.audioTrackIndex` is the
 * audio-RELATIVE position within source.audioTracks (what ffmpeg -map 0:a:N
 * takes) — NOT the absolute stream index stored in each track's `index`.
 */
export function decidePlayback(
  source: StrategySource2,
  caps: ClientCapabilities,
  opts?: { audioTrackIndex?: number },
): PlaybackPlan {
  const audioTrackIndex = opts?.audioTrackIndex ?? 0;
  const track = source.audioTracks[audioTrackIndex];
  const videoOk = source.videoCodec !== undefined && caps.videoCodecs.includes(source.videoCodec);

  if (
    audioTrackIndex === 0 &&
    videoOk &&
    containerMatches(source.container, caps.containers) &&
    track?.codec !== undefined &&
    caps.audioCodecs.includes(track.codec)
    // No channel constraint here: progressive playback decodes natively; the
    // multichannel-AAC quirk below is HLS/MSE-specific.
  ) {
    return { mode: "direct" };
  }

  const channels = track?.channels ?? 2;
  const copyOk =
    track?.codec !== undefined &&
    caps.audioCodecs.includes(track.codec) &&
    channels <= caps.maxAudioChannels &&
    !(caps.hlsMultichannelAacBroken && track.codec === "aac" && channels > 2);

  const audio = copyOk
    ? { audioAction: "copy" as const, audioChannels: channels }
    : { audioAction: "aac" as const, audioChannels: Math.max(1, Math.min(channels, caps.maxAudioChannels)) };

  const mode = videoOk ? ("remux" as const) : ("transcode" as const);
  return { mode, ...audio, audioTrackIndex };
}
```

And widen `PlaybackPlan` (replace the existing type declaration only):

```ts
export type PlaybackPlan =
  | { mode: "direct" }
  | { mode: "remux"; audioAction: "copy" | "aac"; audioTrackIndex?: number; audioChannels?: number }
  | { mode: "transcode"; audioAction: "copy" | "aac"; audioTrackIndex?: number; audioChannels?: number };
```

- [ ] **Step 4: Run tests — new file AND the untouched legacy suite**

```bash
pnpm --filter @orbix/core exec vitest run src/playback/decide.test.ts src/playback/strategy.test.ts
```

Expected: PASS (all; legacy `decideStrategy` behavior unchanged).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck
git add packages/core/src/playback/strategy.ts packages/core/src/playback/decide.test.ts
git commit -m "feat(core): capability-aware decidePlayback with audio-track selection"
```

---

### Task 2: Core ffargs + playlist query propagation

**Files:**
- Modify: `packages/core/src/playback/ffargs.ts`
- Modify: `packages/core/src/playback/playlist.ts`
- Modify: `packages/core/src/playback/ffargs.test.ts` (append cases)
- Modify: `packages/core/src/playback/playlist.test.ts` (append cases)

**Interfaces:**
- `HlsArgsOpts` gains `audioTrackIndex?: number` (audio-relative; default 0) and `audioChannels?: number` (default 2; used only when `audioAction === "aac"`).
- `buildHlsArgs` emits `-map 0:a:<audioTrackIndex>?` and `-ac <audioChannels>`.
- `buildVodPlaylist(durationSec, segSec = 6, query?: string)` — when `query` is a non-empty string, every URI line (`init.mp4` in `EXT-X-MAP` and each `seg<N>.m4s`) gets `?<query>` appended. `query` is passed WITHOUT a leading `?`.

- [ ] **Step 1: Append failing tests**

Append to `packages/core/src/playback/ffargs.test.ts`:

```ts
describe("audio track selection args", () => {
  it("maps the requested audio-relative track index", () => {
    const args = buildHlsArgs({
      input: "/m.mkv", startSegment: 0, segSec: 6, outDir: "/out",
      mode: "remux", audioAction: "copy", audioTrackIndex: 2,
    });
    expect(args).toContain("0:a:2?");
    expect(args).not.toContain("0:a:0?");
  });

  it("uses audioChannels for the aac encode branch", () => {
    const args = buildHlsArgs({
      input: "/m.mkv", startSegment: 0, segSec: 6, outDir: "/out",
      mode: "remux", audioAction: "aac", audioChannels: 6,
    });
    const i = args.indexOf("-ac");
    expect(args[i + 1]).toBe("6");
  });

  it("defaults: first audio track, stereo", () => {
    const args = buildHlsArgs({
      input: "/m.mkv", startSegment: 0, segSec: 6, outDir: "/out",
      mode: "remux", audioAction: "aac",
    });
    expect(args).toContain("0:a:0?");
    const i = args.indexOf("-ac");
    expect(args[i + 1]).toBe("2");
  });
});
```

Append to `packages/core/src/playback/playlist.test.ts`:

```ts
describe("query propagation", () => {
  it("appends the query to init and every segment URI", () => {
    const p = buildVodPlaylist(13, 6, "playSessionId=abc&token=orb_x");
    expect(p).toContain('#EXT-X-MAP:URI="init.mp4?playSessionId=abc&token=orb_x"');
    expect(p).toContain("seg0.m4s?playSessionId=abc&token=orb_x");
    expect(p).toContain("seg2.m4s?playSessionId=abc&token=orb_x");
  });

  it("emits bare URIs when no query is given", () => {
    const p = buildVodPlaylist(12, 6);
    expect(p).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(p).toContain("seg1.m4s");
    expect(p).not.toContain("?");
  });
});
```

- [ ] **Step 2: Run to verify failures**

```bash
pnpm --filter @orbix/core exec vitest run src/playback/ffargs.test.ts src/playback/playlist.test.ts
```

Expected: new cases FAIL (unknown options ignored / no query support).

- [ ] **Step 3: Implement**

In `ffargs.ts`: add to `HlsArgsOpts`:

```ts
  /** Audio-RELATIVE track position for -map 0:a:N (default 0). */
  audioTrackIndex?: number;
  /** Target channel count when audioAction === "aac" (default 2). */
  audioChannels?: number;
```

Change the stream-mapping line (step 3 of the builder) to:

```ts
  args.push("-map", "0:v:0", "-map", `0:a:${opts.audioTrackIndex ?? 0}?`);
```

Change the audio branch (step 5) to:

```ts
  if (audioAction === "copy") {
    args.push("-c:a", "copy");
  } else {
    const ac = opts.audioChannels ?? 2;
    args.push("-c:a", "aac", "-b:a", ac > 2 ? "384k" : "192k", "-ac", String(ac));
  }
```

(Keep the existing comment about the hls.js stereo rationale, updating it to note the channel count now comes from the capability decision.)

In `playlist.ts`: change the signature to `buildVodPlaylist(durationSec: number, segSec = 6, query?: string)`, compute `const suffix = query ? `?${query}` : "";`, use `#EXT-X-MAP:URI="init.mp4${suffix}"` and `seg${segIndex}.m4s${suffix}` for every segment line. Update the doc comment.

- [ ] **Step 4: Run to verify pass (full core suite — PlaybackPlan consumers)**

```bash
pnpm --filter @orbix/core test
```

Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck && pnpm --filter @orbix/api typecheck
git add packages/core/src/playback/ffargs.ts packages/core/src/playback/playlist.ts packages/core/src/playback/ffargs.test.ts packages/core/src/playback/playlist.test.ts
git commit -m "feat(core): audio-track/channel args + playlist query propagation"
```

---

### Task 3: PlaySessionRegistry

**Files:**
- Create: `apps/api/src/playback/registry.ts`
- Create: `apps/api/src/playback/registry.test.ts`

**Interfaces:**
- Consumes: `PlaybackPlan` from `@orbix/core`.
- Produces:

```ts
export interface PlaySessionEntry {
  playSessionId: string;
  fileId: string;
  inputPath: string;
  durationSec: number;
  plan: PlaybackPlan;
  createdAtMs: number;
  lastAccessMs: number;
}
export class PlaySessionRegistry {
  constructor(opts?: { now?: () => number; ttlMs?: number; max?: number }) // defaults: Date.now, 24h, 200
  create(input: { fileId: string; inputPath: string; durationSec: number; plan: PlaybackPlan }): PlaySessionEntry // randomUUID id
  get(id: string): PlaySessionEntry | null   // touches lastAccessMs; expired/unknown → null
  delete(id: string): boolean
  size(): number
}
```
- Expiry: entries idle past `ttlMs` are swept on every `create`/`get`. Past `max` entries, `create` evicts the least-recently-accessed entry first (registry entries are tiny; this only bounds memory).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/playback/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PlaySessionRegistry } from "./registry";

const plan = { mode: "remux", audioAction: "copy" } as const;
const input = { fileId: "f1", inputPath: "/m.mkv", durationSec: 100, plan };

function makeReg(opts: { ttlMs?: number; max?: number } = {}) {
  let nowMs = 1_000_000;
  const reg = new PlaySessionRegistry({ now: () => nowMs, ...opts });
  return { reg, advance: (ms: number) => { nowMs += ms; } };
}

describe("PlaySessionRegistry", () => {
  it("creates entries with unique ids and returns them by id", () => {
    const { reg } = makeReg();
    const a = reg.create(input);
    const b = reg.create(input);
    expect(a.playSessionId).not.toBe(b.playSessionId);
    expect(reg.get(a.playSessionId)?.fileId).toBe("f1");
    expect(reg.get("nope")).toBeNull();
  });

  it("expires idle entries after the TTL and refreshes on access", () => {
    const { reg, advance } = makeReg({ ttlMs: 1000 });
    const a = reg.create(input);
    advance(600);
    expect(reg.get(a.playSessionId)).not.toBeNull(); // touch refreshes
    advance(600);
    expect(reg.get(a.playSessionId)).not.toBeNull();
    advance(1001);
    expect(reg.get(a.playSessionId)).toBeNull();
  });

  it("evicts the least-recently-accessed entry past the cap", () => {
    const { reg, advance } = makeReg({ max: 2 });
    const a = reg.create(input);
    advance(10);
    const b = reg.create(input);
    advance(10);
    reg.get(a.playSessionId); // a is now fresher than b
    advance(10);
    const c = reg.create(input); // evicts b
    expect(reg.get(a.playSessionId)).not.toBeNull();
    expect(reg.get(b.playSessionId)).toBeNull();
    expect(reg.get(c.playSessionId)).not.toBeNull();
    expect(reg.size()).toBe(2);
  });

  it("delete removes the entry", () => {
    const { reg } = makeReg();
    const a = reg.create(input);
    expect(reg.delete(a.playSessionId)).toBe(true);
    expect(reg.get(a.playSessionId)).toBeNull();
    expect(reg.delete(a.playSessionId)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @orbix/api exec vitest run src/playback/registry.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `apps/api/src/playback/registry.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { PlaybackPlan } from "@orbix/core";

export interface PlaySessionEntry {
  playSessionId: string;
  fileId: string;
  inputPath: string;
  durationSec: number;
  plan: PlaybackPlan;
  createdAtMs: number;
  lastAccessMs: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX = 200;

/**
 * In-memory play-session registry: PlaybackInfo creates an entry, HLS routes
 * resolve it by playSessionId, stop/expiry delete it. Unknown ids surface as
 * 404 session_expired so clients renegotiate via /playback/info — sessions
 * deliberately do not survive server restarts.
 */
export class PlaySessionRegistry {
  private entries = new Map<string, PlaySessionEntry>();
  private now: () => number;
  private ttlMs: number;
  private max: number;

  constructor(opts?: { now?: () => number; ttlMs?: number; max?: number }) {
    this.now = opts?.now ?? Date.now;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.max = opts?.max ?? DEFAULT_MAX;
  }

  private sweep(): void {
    const nowMs = this.now();
    for (const [id, e] of this.entries) {
      if (nowMs - e.lastAccessMs > this.ttlMs) this.entries.delete(id);
    }
  }

  create(input: { fileId: string; inputPath: string; durationSec: number; plan: PlaybackPlan }): PlaySessionEntry {
    this.sweep();
    while (this.entries.size >= this.max) {
      let lruId: string | undefined;
      let lru = Infinity;
      for (const [id, e] of this.entries) {
        if (e.lastAccessMs < lru) { lru = e.lastAccessMs; lruId = id; }
      }
      if (lruId === undefined) break;
      this.entries.delete(lruId);
    }
    const nowMs = this.now();
    const entry: PlaySessionEntry = {
      playSessionId: randomUUID(),
      ...input,
      createdAtMs: nowMs,
      lastAccessMs: nowMs,
    };
    this.entries.set(entry.playSessionId, entry);
    return entry;
  }

  get(id: string): PlaySessionEntry | null {
    this.sweep();
    const e = this.entries.get(id);
    if (!e) return null;
    e.lastAccessMs = this.now();
    return e;
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  size(): number {
    this.sweep();
    return this.entries.size;
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter @orbix/api exec vitest run src/playback/registry.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck
git add apps/api/src/playback/registry.ts apps/api/src/playback/registry.test.ts
git commit -m "feat(api): in-memory PlaySessionRegistry with TTL + LRU cap"
```

---

### Task 4: `POST /api/playback/info`

**Files:**
- Create: `apps/api/src/routes/playback.ts`
- Create: `apps/api/src/routes/playback.test.ts`
- Modify: `apps/api/src/app.ts` (import + register after `streamRoute`; the route factory RECEIVES the registry + manager created in stream.ts — see wiring note)
- Modify: `apps/api/src/routes/stream.ts` (export its `SessionManager` + a shared `PlaySessionRegistry` via a small refactor — see wiring note)

**Wiring note (do this first):** `streamRoute(env)` currently creates its `SessionManager` privately. Both the playback route and the stream routes need the same registry+manager pair. Refactor minimally: in `apps/api/src/app.ts`, create the pair once and pass to both factories:

```ts
// app.ts (imports)
import { SessionManager } from "./playback/session";
import { PlaySessionRegistry } from "./playback/registry";
import playbackRoute from "./routes/playback";
import { getSetting } from "@orbix/core";
// app.ts (before route registrations, after plugins)
  const sessionManager = new SessionManager({
    transcodeDir: env.TRANSCODE_DIR,
    maxSessions: env.MAX_TRANSCODE_SESSIONS,
    getEncoder: () =>
      getSetting<string>("encoder", {
        fallback: "software",
        read: (k) => app.prisma.setting.findUnique({ where: { key: k } }),
      }),
  });
  const playRegistry = new PlaySessionRegistry();
  app.addHook("onClose", async () => { await sessionManager.closeAll(); });
```

`streamRoute` becomes `streamRoute(env, { manager: sessionManager, registry: playRegistry })` (its internal `new SessionManager` + its own `onClose` hook are removed; `getSetting` import moves to app.ts if no longer used in stream.ts). `playbackRoute({ registry: playRegistry })` is registered under `/api` after `streamRoute`. Keep `TmdbClient, getSetting` imports in app.ts consistent (getSetting is already imported there).

**Interfaces:**
- Consumes: `decidePlayback`, `ClientCapabilities`, `AudioTrack` (Task 1), `PlaySessionRegistry` (Task 3), `activeProfile`/`profileAllowsItem` from `lib/catalog-filter`, `requireAuth`, and the same `IMAGE_CODECS` notion as subtitles (duplicate the small set locally is NOT allowed — export `IMAGE_CODECS` from `apps/api/src/routes/subtitles.ts` and import it).
- Produces: `POST /api/playback/info` (session or bearer):
  - Body: `{ fileId: string, capabilities: ClientCapabilities, audioTrackIndex?: number }` → 400 `{error:"invalid"}` when fileId isn't a string, capabilities is missing `containers`/`videoCodecs`/`audioCodecs` arrays or a numeric `maxAudioChannels`, or audioTrackIndex isn't a non-negative integer.
  - 404 `{error:"not_found"}` unknown file (and for kids-blocked titles — existence must not leak; NOTE this differs from the old /decision's 403: use 404 here per spec §7 convention).
  - 409 `{error:"not_probed"}` when `durationSec` is null AND the decided mode isn't `direct`.
  - 200 response:

```jsonc
{
  "playSessionId": "…",
  "mode": "remux",
  "streamUrl": "/api/play/<fileId>/master.m3u8?playSessionId=<id>",   // direct → "/api/play/<fileId>/direct"
  "videoCodec": "hevc",
  "container": "matroska,webm",
  "audioTracks": [ { "index": 0, "codec": "ac3", "channels": 6, "language": "ru", "selected": true } ],
  "subtitleTracks": [ { "index": 2, "codec": "subrip", "language": "en", "available": true },
                       { "index": 3, "codec": "hdmv_pgs_subtitle", "language": "ru", "available": false, "reason": "image_based" } ]
}
```
  - `audioTracks[].index` is the audio-RELATIVE position (array order), `selected` marks the decided track. `subtitleTracks[].index` stays the ABSOLUTE stream index (matches `/subs/:index`). A registry entry is created for every mode (direct included — uniform stop/heartbeat).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/playback.test.ts`:

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

const WEB_CAPS = {
  containers: ["mp4"], videoCodecs: ["h264"], audioCodecs: ["aac"],
  maxAudioChannels: 2, hlsMultichannelAacBroken: true,
};

function stubAuth(app: unknown, profile: Record<string, unknown> | null = null) {
  (app as any).prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }), findFirst: async () => ({ id: "a1" }) };
  (app as any).prisma.profile = { findUnique: async () => profile };
}

function stubFile(app: unknown, overrides: Record<string, unknown> = {}) {
  (app as any).prisma.mediaFile = {
    findUnique: async () => ({
      id: "f1", path: "/media/movie.mkv", container: "matroska,webm", videoCodec: "h264",
      audioCodecs: ["ac3"], durationSec: 120,
      audioTracks: [{ index: 1, codec: "ac3", channels: 6, language: "ru" }],
      subtitleTracks: [
        { index: 2, codec: "subrip", language: "en" },
        { index: 3, codec: "hdmv_pgs_subtitle", language: "ru" },
      ],
      mediaItem: { rating: "PG-13" },
      ...overrides,
    }),
  };
}

const cookies = { orbix_session: "s1" };

describe("POST /api/playback/info", () => {
  it("returns a session, decision, and track lists", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app);
    const res = await app.inject({
      method: "POST", url: "/api/playback/info", cookies,
      payload: { fileId: "f1", capabilities: WEB_CAPS },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("remux");
    expect(body.playSessionId).toMatch(/[0-9a-f-]{36}/);
    expect(body.streamUrl).toBe(`/api/play/f1/master.m3u8?playSessionId=${body.playSessionId}`);
    expect(body.audioTracks).toEqual([
      { index: 0, codec: "ac3", channels: 6, language: "ru", selected: true },
    ]);
    expect(body.subtitleTracks).toEqual([
      { index: 2, codec: "subrip", language: "en", available: true },
      { index: 3, codec: "hdmv_pgs_subtitle", language: "ru", available: false, reason: "image_based" },
    ]);
    await app.close();
  });

  it("direct mode returns the direct URL", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app, {
      container: "mov,mp4,m4a,3gp,3g2,mj2", videoCodec: "h264",
      audioTracks: [{ index: 1, codec: "aac", channels: 2 }],
    });
    const res = await app.inject({
      method: "POST", url: "/api/playback/info", cookies,
      payload: { fileId: "f1", capabilities: WEB_CAPS },
    });
    expect(res.json().mode).toBe("direct");
    expect(res.json().streamUrl).toBe("/api/play/f1/direct");
    await app.close();
  });

  it("404s kids-blocked titles without leaking existence", async () => {
    const app = await buildApp(env);
    stubAuth(app, { id: "p_kid", name: "Kid", avatar: null, kind: "kids", maturityCap: 0, language: "en" });
    stubFile(app, { mediaItem: { rating: "R" } });
    const res = await app.inject({
      method: "POST", url: "/api/playback/info",
      cookies: { ...cookies, orbix_profile: "p_kid" },
      payload: { fileId: "f1", capabilities: WEB_CAPS },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    await app.close();
  });

  it("409s unprobed files for non-direct modes", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app, { durationSec: null });
    const res = await app.inject({
      method: "POST", url: "/api/playback/info", cookies,
      payload: { fileId: "f1", capabilities: WEB_CAPS },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("400s invalid bodies", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app);
    for (const payload of [
      {},
      { fileId: "f1" },
      { fileId: "f1", capabilities: { containers: "mp4" } },
      { fileId: "f1", capabilities: WEB_CAPS, audioTrackIndex: -1 },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/playback/info", cookies, payload });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("401s without credentials", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app);
    const res = await app.inject({
      method: "POST", url: "/api/playback/info",
      payload: { fileId: "f1", capabilities: WEB_CAPS },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/playback.test.ts
```

Expected: FAIL — route not registered.

- [ ] **Step 3: Implement**

First, in `apps/api/src/routes/subtitles.ts`, change `const IMAGE_CODECS` to `export const IMAGE_CODECS` (no other change).

Create `apps/api/src/routes/playback.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { decidePlayback, type AudioTrack, type ClientCapabilities } from "@orbix/core";
import { requireAuth } from "../lib/auth";
import { activeProfile, profileAllowsItem } from "../lib/catalog-filter";
import { IMAGE_CODECS } from "./subtitles";
import type { PlaySessionRegistry } from "../playback/registry";

interface SubTrackJson { index: number; codec?: string; language?: string }

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseCapabilities(v: unknown): ClientCapabilities | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isStringArray(o.containers) || !isStringArray(o.videoCodecs) || !isStringArray(o.audioCodecs)) return null;
  if (typeof o.maxAudioChannels !== "number" || o.maxAudioChannels < 1) return null;
  return {
    containers: o.containers,
    videoCodecs: o.videoCodecs,
    audioCodecs: o.audioCodecs,
    maxAudioChannels: o.maxAudioChannels,
    hlsMultichannelAacBroken: o.hlsMultichannelAacBroken === true,
  };
}

export default function playbackRoute(deps: { registry: PlaySessionRegistry }) {
  return async function (app: FastifyInstance) {
    app.post<{ Body: { fileId?: unknown; capabilities?: unknown; audioTrackIndex?: unknown } }>(
      "/playback/info",
      { preHandler: requireAuth(app) },
      async (req, reply) => {
        const fileId = req.body?.fileId;
        const caps = parseCapabilities(req.body?.capabilities);
        const rawIdx = req.body?.audioTrackIndex;
        const audioTrackIndex =
          rawIdx === undefined ? 0 : typeof rawIdx === "number" && Number.isInteger(rawIdx) && rawIdx >= 0 ? rawIdx : null;
        if (typeof fileId !== "string" || !caps || audioTrackIndex === null) {
          return reply.code(400).send({ error: "invalid" });
        }

        const [file, profile] = await Promise.all([
          app.prisma.mediaFile.findUnique({
            where: { id: fileId },
            select: {
              id: true, path: true, container: true, videoCodec: true,
              durationSec: true, audioTracks: true, subtitleTracks: true,
              mediaItem: { select: { rating: true } },
            },
          }),
          activeProfile(app, req),
        ]);

        if (!file) return reply.code(404).send({ error: "not_found" });
        // Kids gate: 404 (not 403) so blocked titles don't leak existence.
        if (!profileAllowsItem(profile, { rating: file.mediaItem.rating })) {
          return reply.code(404).send({ error: "not_found" });
        }

        const audioTracks = ((file.audioTracks as AudioTrack[] | null) ?? []);
        const plan = decidePlayback(
          { container: file.container ?? undefined, videoCodec: file.videoCodec ?? undefined, audioTracks },
          caps,
          { audioTrackIndex },
        );

        if (plan.mode !== "direct" && !file.durationSec) {
          return reply.code(409).send({ error: "not_probed" });
        }

        const entry = deps.registry.create({
          fileId: file.id,
          inputPath: file.path,
          durationSec: file.durationSec ?? 0,
          plan,
        });

        const streamUrl =
          plan.mode === "direct"
            ? `/api/play/${file.id}/direct`
            : `/api/play/${file.id}/master.m3u8?playSessionId=${entry.playSessionId}`;

        const subs = ((file.subtitleTracks as SubTrackJson[] | null) ?? []).map((t) => {
          const available = !IMAGE_CODECS.has(t.codec ?? "");
          return {
            index: t.index,
            codec: t.codec,
            language: t.language,
            available,
            ...(available ? {} : { reason: "image_based" as const }),
          };
        });

        return {
          playSessionId: entry.playSessionId,
          mode: plan.mode,
          streamUrl,
          container: file.container,
          videoCodec: file.videoCodec,
          audioTracks: audioTracks.map((t, i) => ({
            index: i,
            codec: t.codec,
            channels: t.channels,
            language: t.language,
            selected: i === audioTrackIndex,
          })),
          subtitleTracks: subs,
        };
      },
    );
  };
}
```

Apply the **wiring note** refactor in `app.ts` and `stream.ts` (manager+registry created in app.ts, passed to both factories; `streamRoute(env, deps)` signature change; remove stream.ts's internal manager construction and onClose hook). In stream.ts the `deps.registry` is UNUSED for now (Task 5 consumes it) — accept it in the signature but don't reference it yet if the linter complains, prefix with underscore destructure: `{ manager, registry: _registry }`.

Register in app.ts after streamRoute:

```ts
  await app.register(playbackRoute({ registry: playRegistry }), { prefix: "/api" });
```

- [ ] **Step 4: Run to verify pass + full api suite**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/playback.test.ts && pnpm --filter @orbix/api test
```

Expected: PASS; the existing stream/session tests still green after the wiring refactor.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck
git add apps/api/src/routes/playback.ts apps/api/src/routes/playback.test.ts apps/api/src/routes/subtitles.ts apps/api/src/routes/stream.ts apps/api/src/app.ts
git commit -m "feat(api): POST /playback/info — capability-negotiated decisions + play sessions"
```

---

### Task 5: Session-aware HLS routes, stop endpoint, progress heartbeat

**Files:**
- Modify: `apps/api/src/routes/stream.ts` (resolveSession + master/index/init/seg; keep legacy fallback)
- Modify: `apps/api/src/playback/session.ts` (public `remove(key)`; plumb `audioTrackIndex`/`audioChannels` into `buildHlsArgs`)
- Modify: `apps/api/src/routes/playback.ts` (add `POST /playback/:playSessionId/stop`)
- Modify: `apps/api/src/routes/playstate.ts` (optional `playSessionId` heartbeat on progress PUT)
- Create: `apps/api/src/routes/stream.session.test.ts`

**Interfaces:**
- Consumes: `PlaySessionRegistry` (`deps.registry` now used in stream.ts), `queryTokenAuth` (SP1a), `buildVodPlaylist(duration, segSec, query)` (Task 2).
- Produces:
  - `GET /play/:fileId/master.m3u8?playSessionId=` — when the param is present: registry lookup → 404 `{error:"session_expired"}` if unknown/mismatched fileId; else body references `index.m3u8?playSessionId=<id>` (+`&token=<raw>` echoed when the request authenticated via `?token=`). Without the param: legacy behavior unchanged.
  - `GET /play/:fileId/index.m3u8?playSessionId=` — same lookup; playlist built with the same query suffix so init/seg URIs carry it. Legacy param-less behavior unchanged.
  - `GET /play/:fileId/init.mp4?playSessionId=` and `/:seg?playSessionId=` — resolve the manager session keyed by `playSessionId` (falls back to legacy `fileId:default` key without the param).
  - `POST /playback/:playSessionId/stop` (queryTokenAuth + requireAuth; accepts empty body — `navigator.sendBeacon` sends none) → `{ok:true}` always (idempotent).
  - `PUT /items/:id/progress` accepts optional `playSessionId` (string) in the body: after the upsert, `registry.get(playSessionId)` to touch liveness. Invalid/unknown ids are ignored (progress must never fail on session state).
  - `SessionManager.remove(key: string): Promise<void>` — public teardown by key (kills ffmpeg, removes dir; no-op when absent).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/stream.session.test.ts`:

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

const WEB_CAPS = {
  containers: ["mp4"], videoCodecs: ["h264"], audioCodecs: ["aac"],
  maxAudioChannels: 2, hlsMultichannelAacBroken: true,
};
const cookies = { orbix_session: "s1" };

function stubAll(app: unknown) {
  (app as any).prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  (app as any).prisma.account = { findUnique: async () => ({ isAdmin: true }), findFirst: async () => ({ id: "a1" }) };
  (app as any).prisma.profile = { findUnique: async () => null };
  (app as any).prisma.mediaFile = {
    findUnique: async () => ({
      id: "f1", path: "/media/movie.mkv", container: "matroska,webm", videoCodec: "h264",
      audioCodecs: ["aac"], durationSec: 30,
      audioTracks: [{ index: 1, codec: "aac", channels: 2 }],
      subtitleTracks: [],
      mediaItem: { rating: "PG-13" },
    }),
  };
}

async function negotiate(app: any): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/playback/info", cookies,
    payload: { fileId: "f1", capabilities: WEB_CAPS },
  });
  return res.json().playSessionId as string;
}

describe("session-aware HLS routes", () => {
  it("master echoes the playSessionId into index.m3u8", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const sid = await negotiate(app);
    const res = await app.inject({ method: "GET", url: `/api/play/f1/master.m3u8?playSessionId=${sid}`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`index.m3u8?playSessionId=${sid}`);
    await app.close();
  });

  it("index playlist URIs carry the playSessionId query", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const sid = await negotiate(app);
    const res = await app.inject({ method: "GET", url: `/api/play/f1/index.m3u8?playSessionId=${sid}`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`init.mp4?playSessionId=${sid}`);
    expect(res.body).toContain(`seg0.m4s?playSessionId=${sid}`);
    await app.close();
  });

  it("unknown playSessionId → 404 session_expired", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const res = await app.inject({
      method: "GET", url: "/api/play/f1/master.m3u8?playSessionId=00000000-0000-0000-0000-000000000000", cookies,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "session_expired" });
    await app.close();
  });

  it("legacy param-less master keeps working (pre-migration web)", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const res = await app.inject({ method: "GET", url: "/api/play/f1/master.m3u8", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("index.m3u8");
    expect(res.body).not.toContain("playSessionId");
    await app.close();
  });

  it("stop is idempotent and tears the session down", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const sid = await negotiate(app);
    const stop1 = await app.inject({ method: "POST", url: `/api/playback/${sid}/stop`, cookies });
    expect(stop1.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/play/f1/master.m3u8?playSessionId=${sid}`, cookies });
    expect(after.statusCode).toBe(404);
    const stop2 = await app.inject({ method: "POST", url: `/api/playback/${sid}/stop`, cookies });
    expect(stop2.statusCode).toBe(200);
    await app.close();
  });

  it("progress PUT with playSessionId succeeds and ignores unknown ids", async () => {
    const app = await buildApp(env);
    stubAll(app);
    (app as any).prisma.mediaItem = { findUnique: async () => ({ rating: "PG-13" }) };
    (app as any).prisma.playbackState = { upsert: async ({ create }: any) => create };
    (app as any).prisma.playEvent = { findFirst: async () => ({ id: "r" }), create: async () => ({}) };
    const sid = await negotiate(app);
    for (const playSessionId of [sid, "unknown-id"]) {
      const res = await app.inject({
        method: "PUT", url: "/api/items/m1/progress",
        cookies: { ...cookies, orbix_profile: "p1" },
        payload: { positionSec: 5, durationSec: 30, playSessionId },
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });
});
```

Note: the progress test stubs `prisma.profile.findUnique` to `null`; with SP1a's Task 6 merged, `activeProfileId` resolves from the cookie value `p1` directly — the upsert stub accepts it.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/stream.session.test.ts
```

Expected: FAIL — no session awareness yet.

- [ ] **Step 3: Implement**

In `apps/api/src/playback/session.ts`:
- Add a public method after `closeAll()`:

```ts
  /** Tear down one session by its manager key (kills ffmpeg, removes dir). */
  async remove(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (session) await this.removeSession(key, session);
  }
```

- In `spawnFfmpeg`, pass the plan's audio selection through to `buildHlsArgs` (after the existing `audioAction` line):

```ts
    const audioTrackIndex = "audioTrackIndex" in session.plan ? session.plan.audioTrackIndex : undefined;
    const audioChannels = "audioChannels" in session.plan ? session.plan.audioChannels : undefined;
```

and add `audioTrackIndex, audioChannels,` to the `buildHlsArgs({...})` call.

In `apps/api/src/routes/stream.ts`:
- The factory is now `streamRoute(env, deps: { manager: SessionManager; registry: PlaySessionRegistry })` (from Task 4's wiring). Use `deps.registry` for session resolution.
- Add a helper near `resolveSession`:

```ts
/** Echo the auth token query (if the request used one) into child playlist URIs. */
function tokenSuffix(req: FastifyRequest): string {
  const token = (req.query as { token?: unknown } | undefined)?.token;
  return typeof token === "string" && token.length > 0 ? `&token=${encodeURIComponent(token)}` : "";
}
```

- New session resolution used by index/init/seg (and master for validation):

```ts
async function resolveByPlaySession(
  app: FastifyInstance,
  deps: { manager: SessionManager; registry: PlaySessionRegistry },
  fileId: string,
  playSessionId: string,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  const entry = deps.registry.get(playSessionId);
  if (!entry || entry.fileId !== fileId) {
    reply.code(404).send({ error: "session_expired" });
    return null;
  }
  return deps.manager.getOrCreate(playSessionId, {
    inputPath: entry.inputPath,
    plan: entry.plan,
    durationSec: entry.durationSec,
    segSec: DEFAULT_SEG_SEC,
  });
}
```

- Each of master/index/init/seg reads `const playSessionId = (req.query as { playSessionId?: string }).playSessionId;` and branches:
  - **master**: with param → kids gate (`assertFileAllowed` as today) + registry validation via `deps.registry.get` (404 `session_expired` on miss/mismatch) + body `["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=2000000", `index.m3u8?playSessionId=${playSessionId}${tokenSuffix(req)}`].join("\n")`. Without → existing legacy body.
  - **index**: with param → `resolveByPlaySession` then `reply.send(buildVodPlaylist(session.durationSec, session.segSec, `playSessionId=${playSessionId}${tokenSuffix(req)}`))`. (Import `buildVodPlaylist` from `@orbix/core`; the manager's `playlist()` helper stays for the legacy branch.) Without → legacy `resolveSession` path.
  - **init/seg**: with param → `resolveByPlaySession`; without → legacy `resolveSession`. The rest of each handler (ensureInit/ensureSegment/timeout mapping) is shared and unchanged.

In `apps/api/src/routes/playback.ts`, add inside the plugin (after the info route), with `deps` widened to `{ registry: PlaySessionRegistry; manager: SessionManager }` (update the Task 4 registration in app.ts to pass both):

```ts
    app.post<{ Params: { playSessionId: string } }>(
      "/playback/:playSessionId/stop",
      { preHandler: [queryTokenAuth(app), requireAuth(app)] },
      async (req) => {
        const { playSessionId } = req.params;
        deps.registry.delete(playSessionId);
        await deps.manager.remove(playSessionId);
        return { ok: true };
      },
    );
```

(`import { queryTokenAuth } from "../lib/device-auth";` and `import type { SessionManager } from "../playback/session";`.)

In `apps/api/src/routes/playstate.ts` PUT handler, after the `playbackState.upsert`, add:

```ts
      // Liveness heartbeat: progress reports keep the play session (and its
      // ffmpeg) from idle-reaping. Unknown/missing ids are fine — progress
      // must never fail on session state.
      if (typeof body.playSessionId === "string") {
        app.playSessions?.get(body.playSessionId);
      }
```

To make the registry reachable there, decorate it in app.ts right after creation:

```ts
  app.decorate("playSessions", playRegistry);
```

with the module augmentation (bottom of `apps/api/src/playback/registry.ts`):

```ts
declare module "fastify" {
  interface FastifyInstance { playSessions?: PlaySessionRegistry }
}
```

- [ ] **Step 4: Run to verify pass + full api suite**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/stream.session.test.ts && pnpm --filter @orbix/api test
```

Expected: PASS; legacy stream tests still green.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck
git add apps/api/src/routes/stream.ts apps/api/src/routes/playback.ts apps/api/src/routes/playstate.ts apps/api/src/playback/session.ts apps/api/src/playback/registry.ts apps/api/src/app.ts apps/api/src/routes/stream.session.test.ts
git commit -m "feat(api): per-playSessionId HLS sessions, stop endpoint, progress heartbeat"
```

---

### Task 6: Web player migration + legacy removal

**Files:**
- Modify: `apps/web/src/components/Player.tsx`
- Modify: `apps/api/src/routes/stream.ts` (delete `/play/:fileId/decision`, `resolveSession`, `DEFAULT_PROFILE`, and the legacy param-less branches — `playSessionId` becomes REQUIRED on master/index/init/seg)
- Modify: `apps/api/src/routes/stream.token.test.ts` and any stream tests exercising the legacy paths (update to negotiate first)
- Delete: legacy `/decision` coverage inside `apps/api/src/routes/*` tests if any assert it

**Interfaces:**
- Consumes: `POST /api/playback/info` (Task 4), stop endpoint (Task 5).
- Produces: the web player negotiates via PlaybackInfo. After this task the ONLY playback entry point is `POST /api/playback/info`; `GET /play/:fileId/decision` is gone and HLS routes 400 `{error:"missing_session"}` without `playSessionId`. (`/play/:fileId/direct` remains parameter-free plus optional `?token=`.)

- [ ] **Step 1: Migrate `Player.tsx`**

Replace the `Decision` interface and the mount effect:

```tsx
interface PlaybackInfo {
  playSessionId: string;
  mode: string;
  streamUrl: string;
  audioTracks: { index: number; codec?: string; channels?: number; language?: string; selected: boolean }[];
  subtitleTracks: { index: number; codec?: string; language?: string; available: boolean; reason?: string }[];
}

const WEB_CAPABILITIES = {
  containers: ["mp4"],
  videoCodecs: ["h264"],
  audioCodecs: ["aac"],
  maxAudioChannels: 2,
  hlsMultichannelAacBroken: true,
};
```

State: `const [info, setInfo] = useState<PlaybackInfo | null>(null);` replaces `decision`/`subs` state. Mount effect fetches two things in parallel (playback info + progress):

```tsx
  useEffect(() => {
    void (async () => {
      try {
        const [infoRes, progressRes] = await Promise.all([
          apiFetch("/playback/info", {
            method: "POST",
            body: JSON.stringify({ fileId, capabilities: WEB_CAPABILITIES }),
          }),
          apiFetch(`/items/${mediaItemId}/progress${progressQuery}`),
        ]);
        if (!infoRes.ok) {
          setError(t("player:error.decision"));
          return;
        }
        setInfo((await infoRes.json()) as PlaybackInfo);
        if (progressRes.ok) setResume((await progressRes.json()) as Progress);
      } catch {
        setError(t("player:error.network"));
      } finally {
        setLoading(false);
      }
    })();
  }, [fileId, mediaItemId, progressQuery, t]);
```

`saveProgress` includes the session heartbeat:

```tsx
      await apiFetch(`/items/${mediaItemId}/progress`, {
        method: "PUT",
        body: JSON.stringify({ positionSec: pos, durationSec: dur, episodeId, playSessionId: infoRef.current?.playSessionId }),
      });
```

(keep a `const infoRef = useRef<PlaybackInfo | null>(null);` updated whenever `setInfo` runs, so the callback needn't re-bind).

Stop on teardown — extend the existing unmount/visibility effect:

```tsx
  useEffect(() => {
    const stop = () => {
      const id = infoRef.current?.playSessionId;
      if (id) navigator.sendBeacon(`/api/playback/${id}/stop`);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") void saveProgress();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", stop);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", stop);
      void saveProgress();
      stop();
    };
  }, [saveProgress]);
```

Rendering: `src={{ src: info.streamUrl, type: info.mode === "direct" ? "video/mp4" : "application/x-mpegurl" }}`; tracks come from `info.subtitleTracks.filter((s) => s.available)` with the same `/api/play/${fileId}/subs/${track.index}.vtt` URL. All `decision`-named locals become `info` (loading/error rendering unchanged).

- [ ] **Step 2: Remove the legacy API paths**

In `apps/api/src/routes/stream.ts`: delete the `/play/:fileId/decision` route, the `resolveSession` helper, the `DEFAULT_PROFILE` constant, and the legacy branches in master/index/init/seg — the absence of `playSessionId` is now `400 {error:"missing_session"}` on all four. Remove the now-unused `decideStrategy` import; `packages/core`'s legacy `decideStrategy` + `StrategyInput` + `strategy.test.ts` legacy describe blocks are deleted in the same commit (`decide.test.ts` is the coverage now; delete `strategy.test.ts` only if nothing else remains in it).

- [ ] **Step 3: Update affected tests**

- `apps/api/src/routes/stream.token.test.ts`: the direct-play cases are unaffected (`/direct` keeps working without a session). Any case that hits master/index/seg must negotiate via `/playback/info` first (use the `negotiate()` helper pattern from `stream.session.test.ts`, passing `?token=` on the follow-up requests).
- `apps/api/src/routes/stream.session.test.ts`: delete the "legacy param-less master keeps working" case; replace with one asserting `400 {error:"missing_session"}` without the param.
- Search for `/decision` across `apps/` tests and remove/replace those expectations:

```bash
grep -rn "play/.*/decision\|DEFAULT_PROFILE" apps/ --include="*.ts" --include="*.tsx"
```

Expected after this task: zero hits outside git history.

- [ ] **Step 4: Run web + api suites, typecheck, lint**

```bash
pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test
pnpm --filter @orbix/api test && pnpm --filter @orbix/api lint
pnpm --filter @orbix/core test && pnpm --filter @orbix/core lint
```

Expected: all green.

- [ ] **Step 5: Manual smoke (dev stack)**

With `docker compose up -d`: play a title at http://localhost:1060 — verify network tab shows `POST /api/playback/info` → master/index/segments all carrying `?playSessionId=`, subtitles selectable, resume works, and closing the player fires `/stop` (beacon). Two-tabs check: play the SAME title in two tabs and seek in one — the other must keep playing undisturbed (per-session isolation, the SP1b acceptance test).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/Player.tsx apps/api/src/routes/stream.ts apps/api/src/routes/stream.token.test.ts apps/api/src/routes/stream.session.test.ts packages/core/src/playback/strategy.ts packages/core/src/playback/strategy.test.ts
git commit -m "feat(web+api): migrate playback to PlaybackInfo; delete legacy decision route"
```

---

### Task 7: Gates + docs

**Files:**
- Modify: `CLAUDE.md` (playback bullet)

- [ ] **Step 1: Full gates**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all green.

- [ ] **Step 2: Update CLAUDE.md**

In the Architecture section, extend the scanning/persistence area with a playback bullet (add after the "Scanning is async" bullet):

```markdown
- Playback is capability-negotiated: clients POST their profile (containers/codecs/channels) to `/api/playback/info` and get an explicit `direct|remux|transcode` decision + `playSessionId`; HLS routes require `?playSessionId=` (per-viewing ffmpeg isolation in `apps/api/src/playback/{registry,session}.ts`), progress PUTs double as heartbeats, `POST /api/playback/:id/stop` tears down eagerly. The pure decision lives in `packages/core/src/playback/strategy.ts` (`decidePlayback`).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: capability-negotiated playback in CLAUDE.md"
```

---

## Self-review notes

- **Spec coverage (§4.2–4.3):** capability object + explicit decision ✓ (T1/T4); audio-track selection with `-map 0:a:N` ✓ (T1/T2/T5); per-device/viewing session isolation ✓ (T3/T5); stop + heartbeat ✓ (T5); web migrates & legacy `/decision` deleted ✓ (T6). Deferred to SP1c per spec: CODECS/RESOLUTION attributes, keyframe-accurate playlists, subtitle renditions, level/HDR capability constraints — the master playlist stays minimal here.
- **Deliberate behavior changes** (document in PR): multichannel-AAC sources now transcode to stereo for web over HLS (was: silent hls.js failure per the old ffargs comment); direct-play now requires the FIRST audio track to be client-compatible (was: any track).
- **Type consistency:** `PlaybackPlan` optional fields keep legacy `decideStrategy` results valid until T6 deletes it; `deps` shape `{manager, registry}` consistent across T4/T5; `playSessions` decoration declared once (registry.ts) and used in playstate.ts.
- **Kids-gate semantics:** playback/info uses 404-not-403 (spec §7); stream routes keep their existing `assertFileAllowed` 403 behavior — unchanged surface.
