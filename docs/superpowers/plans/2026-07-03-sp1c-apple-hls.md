# SP1c: Apple-Grade HLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The HLS the server emits satisfies Apple's authoring rules so AVPlayer plays it natively: spec-complete multivariant playlists (`CODECS`/`RESOLUTION`/`FRAME-RATE`/`BANDWIDTH`/`VIDEO-RANGE`), **keyframe-accurate media playlists** (declared `EXTINF`s match real segment content — the deepest AVPlayer risk), in-manifest WebVTT subtitle renditions (native track picker works), and an automated conformance verifier.

**Architecture:** A `keyframes` BullMQ job (mirroring `translate-metadata`) runs an ffprobe packet scan per file and stores keyframe timestamps on `MediaFile.keyframes`. Pure core code **simulates ffmpeg's hls-muxer cut rule** (next cut = first keyframe ≥ target) over that index to produce segment boundaries whose `EXTINF`s are true by construction; remux sessions carry boundaries end-to-end (playlist generation AND seek restarts use the same numbers). Files without an index yet get **transcode with `-force_key_frames`** (fixed `EXTINF`s true by construction) and the index job enqueued — correctness never depends on luck. Master playlists become session-aware multivariant documents with codec strings built from new probe fields; subtitles get rendition playlists pointing at the existing VTT extraction (+`X-TIMESTAMP-MAP` injection). A repo script fetches a served session and ffprobes every segment against its declared duration.

**Tech Stack:** ffprobe packet scan (`-show_entries packet=pts_time,flags`), BullMQ, pure-core playlist/boundary math with vitest, Fastify routes, Node conformance script.

**Spec:** `docs/superpowers/specs/2026-07-03-tv-app-and-client-server-contract-design.md` §4.4

## Global Constraints

- Repo-local pnpm (`pnpm@10.22.0`), commands from repo root; `pnpm --filter <pkg> lint` per task.
- `packages/core` purity: no DB/network/ffmpeg/fs imports — parsers/builders take strings/arrays; the api injects runners (the `probeFile`/`run` pattern).
- Kids filtering stays enforced per-request on every route (SP1b restored this — do not regress it; new subtitle-rendition routes gate identically).
- Web playback must keep working unchanged at every task boundary (hls.js tolerates the richer playlists; web ignores subtitle renditions — it uses sidecar `<track>`).
- Every task leaves the repo compiling and tests green.
- Apple HLS rules this plan implements (from the authoring spec): fMP4 (already true); `EXT-X-VERSION:7`; `EXT-X-INDEPENDENT-SEGMENTS`; multivariant `CODECS` (MUST) + `RESOLUTION`+`FRAME-RATE` (MUST for video) + `BANDWIDTH`+`AVERAGE-BANDWIDTH` (MUST) + `VIDEO-RANGE` when HDR; subtitle renditions as `EXT-X-MEDIA:TYPE=SUBTITLES` with full-duration WebVTT playlists carrying `X-TIMESTAMP-MAP`; `EXTINF` sums matching real durations.
- Offline guarantee: no new runtime network dependencies.
- Commit after every task.

---

### Task 1: Probe extensions (profile/level/color/frame-rate)

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (MediaFile: add `videoProfile String?`, `videoLevel Int?`, `colorTransfer String?`, `frameRate Float?`, `keyframes Json?`)
- Create: migration via `prisma migrate dev --name media_file_hls_fields`
- Modify: `packages/core/src/scanner/probe.ts` (+ its interface)
- Modify: `packages/core/src/scanner/probe.test.ts` (append cases)
- Modify: `apps/api/src/plugins/queue.ts` (the `fileData` object at ~line 213 gains the four probe fields — `keyframes` is NOT written by scan; the job owns it)

**Interfaces:**
- `MediaFileTechnical` gains `videoProfile?: string` (ffprobe stream `profile`, e.g. `"High"`, `"Main 10"`), `videoLevel?: number` (stream `level`, e.g. `41`), `colorTransfer?: string` (stream `color_transfer`, e.g. `"smpte2084"`), `frameRate?: number` (parsed from `r_frame_rate` `"25/1"` → 25; `"24000/1001"` → 23.976 rounded to 3 decimals; malformed/zero-denominator → undefined).
- `FfprobeStream` gains `profile?: string; level?: number; color_transfer?: string; r_frame_rate?: string`.

- [ ] **Step 1: Append failing probe tests**

Append to `packages/core/src/scanner/probe.test.ts` (mirror the file's existing fake-`run` fixture style):

```ts
describe("HLS metadata fields", () => {
  it("captures profile, level, color transfer, and frame rate from the video stream", async () => {
    const raw = JSON.stringify({
      streams: [{
        index: 0, codec_type: "video", codec_name: "hevc", width: 3840, height: 2160,
        profile: "Main 10", level: 153, color_transfer: "smpte2084", r_frame_rate: "24000/1001",
      }],
      format: { format_name: "matroska,webm", duration: "100.0" },
    });
    const tech = await probeFile("/x.mkv", { run: async () => raw });
    expect(tech.videoProfile).toBe("Main 10");
    expect(tech.videoLevel).toBe(153);
    expect(tech.colorTransfer).toBe("smpte2084");
    expect(tech.frameRate).toBe(23.976);
  });

  it("tolerates missing/malformed frame rate", async () => {
    const raw = JSON.stringify({
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", r_frame_rate: "0/0" },
      ],
      format: {},
    });
    const tech = await probeFile("/x.mkv", { run: async () => raw });
    expect(tech.frameRate).toBeUndefined();
    expect(tech.videoProfile).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @orbix/core exec vitest run src/scanner/probe.test.ts
```

Expected: new cases FAIL (fields undefined vs expected).

- [ ] **Step 3: Implement**

In `probe.ts`: extend the interfaces as above; in the video-stream branch (only the FIRST video stream, matching the existing `videoCodec === undefined` guard) capture:

```ts
      if (stream.profile !== undefined) videoProfile = stream.profile;
      const lvl = stream.level !== undefined ? Number(stream.level) : NaN;
      if (!Number.isNaN(lvl)) videoLevel = lvl;
      if (stream.color_transfer !== undefined) colorTransfer = stream.color_transfer;
      if (stream.r_frame_rate) {
        const m = /^(\d+)\/(\d+)$/.exec(stream.r_frame_rate);
        if (m && Number(m[2]) > 0) {
          const fr = Math.round((Number(m[1]) / Number(m[2])) * 1000) / 1000;
          if (fr > 0) frameRate = fr;
        }
      }
```

(declare the four locals beside `videoCodec`; add them to the result-object conditional assignments at the bottom, same style as `width`).

Schema: add to `MediaFile` after `bitrate Int?`:

```prisma
  videoProfile  String?
  videoLevel    Int?
  colorTransfer String?
  frameRate     Float?
  keyframes     Json? // keyframe pts seconds (asc); written by the keyframes job, not scan
```

Migrate + generate:

```bash
pnpm --filter @orbix/db exec prisma migrate dev --name media_file_hls_fields
pnpm db:generate
```

In `apps/api/src/plugins/queue.ts`, add to the `fileData` object (after `bitrate`):

```ts
          videoProfile: input.tech.videoProfile,
          videoLevel: input.tech.videoLevel,
          colorTransfer: input.tech.colorTransfer,
          frameRate: input.tech.frameRate,
```

(Existing rows fill on their next library scan; the codec-string builder in Task 3 has fallbacks for null fields.)

- [ ] **Step 4: Run to verify pass + typechecks**

```bash
pnpm --filter @orbix/core test && pnpm --filter @orbix/core lint && pnpm --filter @orbix/db build && pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma packages/core/src/scanner apps/api/src/plugins/queue.ts
git commit -m "feat(scan): probe video profile/level/color-transfer/frame-rate + keyframes column"
```

---

### Task 2: Core keyframe parsing + boundary simulation

**Files:**
- Create: `packages/core/src/playback/keyframes.ts`
- Create: `packages/core/src/playback/keyframes.test.ts`
- Modify: `packages/core/src/index.ts` (export line next to the other `./playback/*` exports)

**Interfaces (exported from `@orbix/core`):**

```ts
/** Parse `ffprobe -show_entries packet=pts_time,flags -of csv=p=0` output → ascending keyframe pts seconds. */
export function parseKeyframePackets(csv: string): number[]
export interface SegmentBoundary { start: number; duration: number }
/**
 * Simulate ffmpeg's hls-muxer cut rule over a keyframe index: a segment ends at
 * the first keyframe whose pts >= segStart + targetSec; the last segment ends at
 * durationSec. Returns null when keyframes is empty (caller falls back).
 */
export function computeSegmentBoundaries(keyframes: number[], durationSec: number, targetSec?: number): SegmentBoundary[] | null
```

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/playback/keyframes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseKeyframePackets, computeSegmentBoundaries } from "./keyframes";

describe("parseKeyframePackets", () => {
  it("extracts only K-flagged packet pts, sorted ascending", () => {
    const csv = [
      "0.000000,K__",
      "0.040000,___",
      "2.000000,K__",
      "1.960000,___",
      "4.000000,K__",
      "", // trailing blank
    ].join("\n");
    expect(parseKeyframePackets(csv)).toEqual([0, 2, 4]);
  });

  it("tolerates side_data noise lines and dedupes", () => {
    const csv = "0.000000,K__\nunknown,garbage\n0.000000,K__\n6.006000,K_F\n";
    expect(parseKeyframePackets(csv)).toEqual([0, 6.006]);
  });

  it("returns [] for empty/garbage input", () => {
    expect(parseKeyframePackets("")).toEqual([]);
    expect(parseKeyframePackets("N/A,___\n")).toEqual([]);
  });
});

describe("computeSegmentBoundaries", () => {
  it("cuts at the first keyframe >= target (hls muxer rule)", () => {
    // keyframes every 2s, 6s target → cuts at 6, 12; total 15s
    const kf = [0, 2, 4, 6, 8, 10, 12, 14];
    expect(computeSegmentBoundaries(kf, 15, 6)).toEqual([
      { start: 0, duration: 6 },
      { start: 6, duration: 6 },
      { start: 12, duration: 3 },
    ]);
  });

  it("handles keyframe gaps longer than the target (long segments)", () => {
    // GOP of 10s > 6s target → segments cut at each keyframe
    const kf = [0, 10, 20];
    expect(computeSegmentBoundaries(kf, 25, 6)).toEqual([
      { start: 0, duration: 10 },
      { start: 10, duration: 10 },
      { start: 20, duration: 5 },
    ]);
  });

  it("ignores a non-zero first keyframe offset by starting at it", () => {
    const kf = [0.033, 6.033, 12.033];
    const b = computeSegmentBoundaries(kf, 14, 6)!;
    expect(b[0].start).toBe(0.033);
    expect(b[0].duration).toBeCloseTo(6, 3);
    expect(b[2]).toEqual({ start: 12.033, duration: expect.closeTo(1.967, 3) as unknown as number });
  });

  it("returns null for an empty index and a single full-length segment when only one keyframe exists", () => {
    expect(computeSegmentBoundaries([], 100, 6)).toBeNull();
    expect(computeSegmentBoundaries([0], 100, 6)).toEqual([{ start: 0, duration: 100 }]);
  });

  it("drops zero/negative-duration tails (duration <= keyframe start)", () => {
    expect(computeSegmentBoundaries([0, 6], 6, 6)).toEqual([{ start: 0, duration: 6 }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @orbix/core exec vitest run src/playback/keyframes.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `packages/core/src/playback/keyframes.ts`:

```ts
/** Parse `ffprobe -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0` output. */
export function parseKeyframePackets(csv: string): number[] {
  const out: number[] = [];
  for (const line of csv.split("\n")) {
    const [pts, flags] = line.split(",");
    if (!pts || !flags || !flags.includes("K")) continue;
    const t = Number(pts);
    if (!Number.isFinite(t) || t < 0) continue;
    out.push(Math.round(t * 1000) / 1000);
  }
  out.sort((a, b) => a - b);
  return out.filter((t, i) => i === 0 || t !== out[i - 1]);
}

export interface SegmentBoundary {
  start: number;
  duration: number;
}

/**
 * Simulate ffmpeg's hls-muxer cut rule over a keyframe index: a segment ends
 * at the first keyframe whose pts >= segStart + targetSec (segments can run
 * long when GOPs exceed the target — never short); the final segment ends at
 * durationSec. The playlist built from these boundaries declares EXTINFs that
 * match what ffmpeg actually produces, which AVPlayer requires.
 */
export function computeSegmentBoundaries(
  keyframes: number[],
  durationSec: number,
  targetSec = 6,
): SegmentBoundary[] | null {
  if (keyframes.length === 0) return null;
  const out: SegmentBoundary[] = [];
  let start = keyframes[0];
  let i = 1;
  while (start < durationSec) {
    while (i < keyframes.length && keyframes[i] < start + targetSec) i++;
    const end = i < keyframes.length ? keyframes[i] : durationSec;
    const duration = Math.round((Math.min(end, durationSec) - start) * 1000) / 1000;
    if (duration > 0.001) out.push({ start, duration });
    if (i >= keyframes.length) break;
    start = keyframes[i];
    i++;
  }
  return out.length > 0 ? out : null;
}
```

Add `export * from "./playback/keyframes";` to `packages/core/src/index.ts` beside the other playback exports.

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter @orbix/core exec vitest run src/playback/keyframes.test.ts && pnpm --filter @orbix/core test
```

Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck
git add packages/core/src/playback/keyframes.ts packages/core/src/playback/keyframes.test.ts packages/core/src/index.ts
git commit -m "feat(core): keyframe packet parser + hls-muxer boundary simulation"
```

---

### Task 3: Core codec strings + VIDEO-RANGE

**Files:**
- Create: `packages/core/src/playback/codec-string.ts`
- Create: `packages/core/src/playback/codec-string.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces (exported):**

```ts
export function videoCodecString(codec: string | undefined, profile?: string, level?: number): string | null
// h264: avc1.{PP}00{LL} — PP from profile (Baseline 42, Main 4D, High 64; default 64 High), LL = level hex (41 → "29"); level default 41.
// hevc/h265: hvc1.{P}.4.L{level}.B0 — P=1 for Main, 2 for Main 10 (default 2 — conservative for 10-bit content); level default 120 (L4.0), pass through when provided (e.g. 153 → L153).
// anything else → null (caller omits CODECS rather than lying).
export function audioCodecString(codec: string | undefined): string | null
// aac → "mp4a.40.2"; ac3 → "ac-3"; eac3 → "ec-3"; flac → "fLaC"; else null.
export function videoRange(colorTransfer: string | undefined): "SDR" | "PQ" | "HLG"
// smpte2084 → PQ; arib-std-b67 → HLG; else SDR.
```

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/playback/codec-string.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { videoCodecString, audioCodecString, videoRange } from "./codec-string";

describe("videoCodecString", () => {
  it("builds avc1 from h264 profile+level", () => {
    expect(videoCodecString("h264", "High", 41)).toBe("avc1.640029");
    expect(videoCodecString("h264", "Main", 40)).toBe("avc1.4D0028");
    expect(videoCodecString("h264", "Baseline", 30)).toBe("avc1.42001E");
  });
  it("defaults h264 to High@4.1 when fields are missing", () => {
    expect(videoCodecString("h264")).toBe("avc1.640029");
  });
  it("builds hvc1 from hevc profile+level", () => {
    expect(videoCodecString("hevc", "Main 10", 153)).toBe("hvc1.2.4.L153.B0");
    expect(videoCodecString("hevc", "Main", 120)).toBe("hvc1.1.6.L120.B0");
  });
  it("defaults hevc to Main10@L120 when fields are missing", () => {
    expect(videoCodecString("hevc")).toBe("hvc1.2.4.L120.B0");
  });
  it("returns null for unknown codecs", () => {
    expect(videoCodecString("vp9")).toBeNull();
    expect(videoCodecString(undefined)).toBeNull();
  });
});

describe("audioCodecString", () => {
  it("maps the supported set", () => {
    expect(audioCodecString("aac")).toBe("mp4a.40.2");
    expect(audioCodecString("ac3")).toBe("ac-3");
    expect(audioCodecString("eac3")).toBe("ec-3");
    expect(audioCodecString("flac")).toBe("fLaC");
    expect(audioCodecString("dts")).toBeNull();
    expect(audioCodecString(undefined)).toBeNull();
  });
});

describe("videoRange", () => {
  it("maps transfer characteristics", () => {
    expect(videoRange("smpte2084")).toBe("PQ");
    expect(videoRange("arib-std-b67")).toBe("HLG");
    expect(videoRange("bt709")).toBe("SDR");
    expect(videoRange(undefined)).toBe("SDR");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @orbix/core exec vitest run src/playback/codec-string.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/core/src/playback/codec-string.ts`:

```ts
const H264_PROFILES: Record<string, string> = {
  baseline: "42",
  "constrained baseline": "42",
  main: "4D",
  high: "64",
  "high 10": "6E",
};

/** RFC 6381 codec string for the CODECS attribute; null = unknown (omit rather than lie). */
export function videoCodecString(codec: string | undefined, profile?: string, level?: number): string | null {
  if (codec === "h264") {
    const pp = H264_PROFILES[(profile ?? "high").toLowerCase()] ?? "64";
    const ll = (level && level > 0 ? level : 41).toString(16).toUpperCase().padStart(2, "0");
    return `avc1.${pp}00${ll}`;
  }
  if (codec === "hevc" || codec === "h265") {
    const p = (profile ?? "").toLowerCase();
    const isMain10 = p === "" || p.includes("10"); // default Main10: safe for 10-bit content
    const lvl = level && level > 0 ? level : 120;
    return isMain10 ? `hvc1.2.4.L${lvl}.B0` : `hvc1.1.6.L${lvl}.B0`;
  }
  return null;
}

export function audioCodecString(codec: string | undefined): string | null {
  switch (codec) {
    case "aac": return "mp4a.40.2";
    case "ac3": return "ac-3";
    case "eac3": return "ec-3";
    case "flac": return "fLaC";
    default: return null;
  }
}

/** HLS VIDEO-RANGE from ffprobe color_transfer. */
export function videoRange(colorTransfer: string | undefined): "SDR" | "PQ" | "HLG" {
  if (colorTransfer === "smpte2084") return "PQ";
  if (colorTransfer === "arib-std-b67") return "HLG";
  return "SDR";
}
```

Export from `packages/core/src/index.ts`.

- [ ] **Step 4: Run to verify pass; lint; typecheck**

```bash
pnpm --filter @orbix/core exec vitest run src/playback/codec-string.test.ts && pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/playback/codec-string.ts packages/core/src/playback/codec-string.test.ts packages/core/src/index.ts
git commit -m "feat(core): RFC6381 codec strings + VIDEO-RANGE mapping"
```

---

### Task 4: Core Apple playlist builders

**Files:**
- Create: `packages/core/src/playback/apple-playlist.ts`
- Create: `packages/core/src/playback/apple-playlist.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces (exported):**

```ts
export interface MultivariantOpts {
  mediaUri: string;                    // e.g. `index.m3u8?playSessionId=..&token=..`
  bandwidth: number;                   // peak bits/sec (probe bitrate or fallback)
  averageBandwidth?: number;           // defaults to bandwidth
  codecs: string[];                    // non-null codec strings; [] → omit CODECS
  resolution?: { width: number; height: number };
  frameRate?: number;
  videoRange?: "SDR" | "PQ" | "HLG";   // omit attribute when "SDR"/undefined
  subtitles?: { name: string; language?: string; uri: string; autoselect?: boolean }[]; // EXT-X-MEDIA entries, GROUP-ID="subs"
}
export function buildMultivariantPlaylist(opts: MultivariantOpts): string
export function buildMediaPlaylistFromBoundaries(boundaries: SegmentBoundary[], query?: string): string
export function buildSubtitleMediaPlaylist(durationSec: number, vttUri: string): string
```

Rules: multivariant = `#EXTM3U` / `#EXT-X-VERSION:7` / `#EXT-X-INDEPENDENT-SEGMENTS` / (subtitle `EXT-X-MEDIA` lines) / one `#EXT-X-STREAM-INF` (attrs in order: `BANDWIDTH`, `AVERAGE-BANDWIDTH`, `CODECS` (comma-joined, quoted), `RESOLUTION` (`WxH`), `FRAME-RATE` (3dp trimmed), `VIDEO-RANGE` (only PQ/HLG), `SUBTITLES="subs"` only when subtitles present) / mediaUri. Media-from-boundaries = `#EXTM3U`/`VERSION:7`/`EXT-X-PLAYLIST-TYPE:VOD`/`EXT-X-TARGETDURATION:<ceil(max duration)>`/`EXT-X-INDEPENDENT-SEGMENTS`/`#EXT-X-MAP:URI="init.mp4<?query>"` then per boundary `#EXTINF:<duration 3dp>,` + `seg<N>.m4s<?query>` and `#EXT-X-ENDLIST`. Subtitle playlist = `#EXTM3U`/`VERSION:7`/`EXT-X-PLAYLIST-TYPE:VOD`/`EXT-X-TARGETDURATION:<ceil(duration)>`/`#EXTINF:<duration 3dp>,`/`<vttUri>`/`#EXT-X-ENDLIST` (single full-duration segment; vttUri is passed through verbatim — the route supplies an absolute path with query).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/playback/apple-playlist.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildMultivariantPlaylist,
  buildMediaPlaylistFromBoundaries,
  buildSubtitleMediaPlaylist,
} from "./apple-playlist";

describe("buildMultivariantPlaylist", () => {
  it("emits all MUST attributes and subtitle groups", () => {
    const m = buildMultivariantPlaylist({
      mediaUri: "index.m3u8?playSessionId=S&token=T",
      bandwidth: 8_000_000,
      codecs: ["hvc1.2.4.L153.B0", "ec-3"],
      resolution: { width: 3840, height: 2160 },
      frameRate: 23.976,
      videoRange: "PQ",
      subtitles: [
        { name: "English", language: "en", uri: "subs/2/index.m3u8?playSessionId=S&token=T" },
        { name: "Русский", language: "ru", uri: "subs/3/index.m3u8?playSessionId=S&token=T", autoselect: false },
      ],
    });
    const lines = m.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(m).toContain("#EXT-X-VERSION:7");
    expect(m).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    expect(m).toContain(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="subs/2/index.m3u8?playSessionId=S&token=T"',
    );
    expect(m).toContain('NAME="Русский",LANGUAGE="ru",AUTOSELECT=NO');
    const streamInf = lines.find((l) => l.startsWith("#EXT-X-STREAM-INF:"))!;
    expect(streamInf).toBe(
      '#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=8000000,CODECS="hvc1.2.4.L153.B0,ec-3",RESOLUTION=3840x2160,FRAME-RATE=23.976,VIDEO-RANGE=PQ,SUBTITLES="subs"',
    );
    expect(lines[lines.indexOf(streamInf) + 1]).toBe("index.m3u8?playSessionId=S&token=T");
  });

  it("omits optional attributes cleanly (SDR, no codecs, no subs)", () => {
    const m = buildMultivariantPlaylist({ mediaUri: "index.m3u8?x=1", bandwidth: 2_000_000, codecs: [] });
    const streamInf = m.split("\n").find((l) => l.startsWith("#EXT-X-STREAM-INF:"))!;
    expect(streamInf).toBe("#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=2000000");
    expect(m).not.toContain("EXT-X-MEDIA");
    expect(m).not.toContain("VIDEO-RANGE");
  });
});

describe("buildMediaPlaylistFromBoundaries", () => {
  it("declares real EXTINFs and a correct TARGETDURATION", () => {
    const p = buildMediaPlaylistFromBoundaries(
      [
        { start: 0, duration: 6.006 },
        { start: 6.006, duration: 10.01 },
        { start: 16.016, duration: 2.5 },
      ],
      "playSessionId=S",
    );
    expect(p).toContain("#EXT-X-VERSION:7");
    expect(p).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(p).toContain("#EXT-X-TARGETDURATION:11"); // ceil(10.01)
    expect(p).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    expect(p).toContain('#EXT-X-MAP:URI="init.mp4?playSessionId=S"');
    expect(p).toContain("#EXTINF:6.006,\nseg0.m4s?playSessionId=S");
    expect(p).toContain("#EXTINF:10.010,\nseg1.m4s?playSessionId=S");
    expect(p).toContain("#EXTINF:2.500,\nseg2.m4s?playSessionId=S");
    expect(p.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });
});

describe("buildSubtitleMediaPlaylist", () => {
  it("emits one full-duration VTT segment", () => {
    const p = buildSubtitleMediaPlaylist(5400.5, "/api/play/f1/subs/2.vtt?hls=1&token=T");
    expect(p).toContain("#EXT-X-TARGETDURATION:5401");
    expect(p).toContain("#EXTINF:5400.500,\n/api/play/f1/subs/2.vtt?hls=1&token=T");
    expect(p).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(p.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @orbix/core exec vitest run src/playback/apple-playlist.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/core/src/playback/apple-playlist.ts`:

```ts
import type { SegmentBoundary } from "./keyframes";

export interface MultivariantOpts {
  mediaUri: string;
  bandwidth: number;
  averageBandwidth?: number;
  codecs: string[];
  resolution?: { width: number; height: number };
  frameRate?: number;
  videoRange?: "SDR" | "PQ" | "HLG";
  subtitles?: { name: string; language?: string; uri: string; autoselect?: boolean }[];
}

/** Apple-spec multivariant playlist: one variant + optional subtitle renditions. */
export function buildMultivariantPlaylist(opts: MultivariantOpts): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];

  for (const s of opts.subtitles ?? []) {
    const attrs = [
      "TYPE=SUBTITLES",
      'GROUP-ID="subs"',
      `NAME="${s.name}"`,
      ...(s.language ? [`LANGUAGE="${s.language}"`] : []),
      `AUTOSELECT=${s.autoselect === false ? "NO" : "YES"}`,
      `URI="${s.uri}"`,
    ];
    lines.push(`#EXT-X-MEDIA:${attrs.join(",")}`);
  }

  const attrs = [
    `BANDWIDTH=${Math.round(opts.bandwidth)}`,
    `AVERAGE-BANDWIDTH=${Math.round(opts.averageBandwidth ?? opts.bandwidth)}`,
  ];
  if (opts.codecs.length > 0) attrs.push(`CODECS="${opts.codecs.join(",")}"`);
  if (opts.resolution) attrs.push(`RESOLUTION=${opts.resolution.width}x${opts.resolution.height}`);
  if (opts.frameRate) attrs.push(`FRAME-RATE=${trimFixed(opts.frameRate)}`);
  if (opts.videoRange === "PQ" || opts.videoRange === "HLG") attrs.push(`VIDEO-RANGE=${opts.videoRange}`);
  if ((opts.subtitles ?? []).length > 0) attrs.push('SUBTITLES="subs"');

  lines.push(`#EXT-X-STREAM-INF:${attrs.join(",")}`, opts.mediaUri);
  return lines.join("\n");
}

/** Media playlist whose EXTINFs come from real keyframe-derived boundaries. */
export function buildMediaPlaylistFromBoundaries(boundaries: SegmentBoundary[], query?: string): string {
  const suffix = query ? `?${query}` : "";
  const target = Math.ceil(Math.max(...boundaries.map((b) => b.duration)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="init.mp4${suffix}"`,
  ];
  boundaries.forEach((b, i) => {
    lines.push(`#EXTINF:${b.duration.toFixed(3)},`, `seg${i}.m4s${suffix}`);
  });
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

/** Full-duration single-segment WebVTT rendition playlist (Apple rule 5.5). */
export function buildSubtitleMediaPlaylist(durationSec: number, vttUri: string): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${Math.ceil(durationSec)}`,
    `#EXTINF:${durationSec.toFixed(3)},`,
    vttUri,
    "#EXT-X-ENDLIST",
  ].join("\n");
}

function trimFixed(n: number): string {
  return n.toFixed(3).replace(/\.?0+$/, "");
}
```

Export from `packages/core/src/index.ts`.

- [ ] **Step 4: Run to verify pass; lint; typecheck**

```bash
pnpm --filter @orbix/core exec vitest run src/playback/apple-playlist.test.ts && pnpm --filter @orbix/core lint && pnpm --filter @orbix/core typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/playback/apple-playlist.ts packages/core/src/playback/apple-playlist.test.ts packages/core/src/index.ts
git commit -m "feat(core): Apple multivariant/media/subtitle playlist builders"
```

---

### Task 5: ffargs — forced keyframes + boundary-accurate seek

**Files:**
- Modify: `packages/core/src/playback/ffargs.ts`
- Modify: `packages/core/src/playback/ffargs.test.ts` (append)

**Interfaces:**
- `HlsArgsOpts` gains `startTimeSec?: number` (exact seek pts for restarts — overrides the `startSegment * segSec` arithmetic when provided) and `forceKeyframes?: boolean` (transcode only: emit `-force_key_frames expr:gte(t,n_forced*<segSec>)` right after the video-codec args so fixed EXTINFs are true by construction).

- [ ] **Step 1: Append failing tests**

```ts
describe("boundary-accurate seek + forced keyframes", () => {
  it("uses startTimeSec verbatim for -ss when provided", () => {
    const args = buildHlsArgs({
      input: "/m.mkv", startSegment: 3, segSec: 6, outDir: "/out",
      mode: "remux", audioAction: "copy", startTimeSec: 17.351,
    });
    const i = args.indexOf("-ss");
    expect(args[i + 1]).toBe("17.351");
  });

  it("falls back to startSegment*segSec without startTimeSec", () => {
    const args = buildHlsArgs({
      input: "/m.mkv", startSegment: 3, segSec: 6, outDir: "/out",
      mode: "remux", audioAction: "copy",
    });
    const i = args.indexOf("-ss");
    expect(args[i + 1]).toBe("18");
  });

  it("emits -force_key_frames for transcode when forceKeyframes is set", () => {
    const args = buildHlsArgs({
      input: "/m.mkv", startSegment: 0, segSec: 6, outDir: "/out",
      mode: "transcode", audioAction: "aac", forceKeyframes: true,
    });
    const i = args.indexOf("-force_key_frames");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("expr:gte(t,n_forced*6)");
  });

  it("never emits -force_key_frames on remux (copy cannot re-place keyframes)", () => {
    const args = buildHlsArgs({
      input: "/m.mkv", startSegment: 0, segSec: 6, outDir: "/out",
      mode: "remux", audioAction: "copy", forceKeyframes: true,
    });
    expect(args).not.toContain("-force_key_frames");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @orbix/core exec vitest run src/playback/ffargs.test.ts
```

- [ ] **Step 3: Implement**

In `HlsArgsOpts` add:

```ts
  /** Exact seek pts (seconds) for restarts; overrides startSegment*segSec arithmetic. */
  startTimeSec?: number;
  /** Transcode only: force keyframes at the segment cadence so fixed EXTINFs are exact. */
  forceKeyframes?: boolean;
```

Seek block becomes:

```ts
  if (startSegment > 0 || (opts.startTimeSec !== undefined && opts.startTimeSec > 0)) {
    args.push("-ss", String(opts.startTimeSec !== undefined ? opts.startTimeSec : startSegment * segSec));
  }
```

After the transcode video-codec switch (inside the `else` branch, after the encoder args are pushed), add:

```ts
    if (opts.forceKeyframes) {
      args.push("-force_key_frames", `expr:gte(t,n_forced*${segSec})`);
    }
```

- [ ] **Step 4: Full core suite; lint; api typecheck**

```bash
pnpm --filter @orbix/core test && pnpm --filter @orbix/core lint && pnpm --filter @orbix/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/playback/ffargs.ts packages/core/src/playback/ffargs.test.ts
git commit -m "feat(core): exact-seek + forced-keyframe ffmpeg args"
```

---

### Task 6: Keyframes BullMQ job + enqueue points

**Files:**
- Modify: `apps/api/src/plugins/queue.ts` (new `keyframes` queue + worker + test-mode stub, mirroring `translate-metadata`; enqueue after scan upsert for probed video files without an index)
- Create: `apps/api/src/jobs/extract-keyframes.ts`
- Create: `apps/api/src/jobs/extract-keyframes.test.ts`

**Interfaces:**
- `apps/api/src/jobs/extract-keyframes.ts`:

```ts
export interface KeyframeJobDeps {
  run: (path: string) => Promise<string>; // ffprobe packet scan runner (injected)
  prisma: { mediaFile: { findUnique: Function; update: Function } };
}
export async function extractKeyframes(fileId: string, deps: KeyframeJobDeps): Promise<{ count: number } | { skipped: string }>
// loads the file (path, keyframes); skips when already indexed or missing; runs the scan,
// parseKeyframePackets, stores the array as MediaFile.keyframes (Json), returns count.
export function keyframeProbeRunner(path: string): Promise<string>
// execFile ffprobe ["-v","error","-select_streams","v:0","-show_entries","packet=pts_time,flags","-of","csv=p=0", path]
// with maxBuffer 64MB (packet CSV for long films is large).
```
- `queue.ts`: `KeyframesJobData = { fileId: string }`; queue name `"keyframes"`; `app.keyframesQueue` decoration (+ test-mode stub `{add,close}` like the others); worker concurrency 1 (I/O heavy full-file read); enqueue in the scan processor after each file upsert when `tech.probedOk && tech.videoCodec && existing keyframes empty` — add idempotently (job id = fileId dedupes: `queue.add("keyframes", {fileId}, {jobId: fileId})`).
- `POST /api/playback/info` (Task 7) will call `app.keyframesQueue?.add(...)` — the decoration must be optional-safe in test mode like `translateQueue`.

- [ ] **Step 1: Write the failing job test**

Create `apps/api/src/jobs/extract-keyframes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractKeyframes } from "./extract-keyframes";

const CSV = "0.000000,K__\n0.040000,___\n6.006000,K__\n12.012000,K__\n";

function deps(overrides: Record<string, unknown> = {}) {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    deps: {
      run: async () => CSV,
      prisma: {
        mediaFile: {
          findUnique: async () => ({ id: "f1", path: "/m.mkv", keyframes: null, ...overrides }),
          update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return {}; },
        },
      },
    },
  };
}

describe("extractKeyframes", () => {
  it("scans, parses, and stores the keyframe index", async () => {
    const { deps: d, updates } = deps();
    const res = await extractKeyframes("f1", d as never);
    expect(res).toEqual({ count: 3 });
    expect(updates[0]).toEqual({ keyframes: [0, 6.006, 12.012] });
  });

  it("skips already-indexed files", async () => {
    const { deps: d, updates } = deps({ keyframes: [0, 6] });
    expect(await extractKeyframes("f1", d as never)).toEqual({ skipped: "already_indexed" });
    expect(updates).toHaveLength(0);
  });

  it("skips missing files", async () => {
    const d = {
      run: async () => CSV,
      prisma: { mediaFile: { findUnique: async () => null, update: async () => ({}) } },
    };
    expect(await extractKeyframes("f1", d as never)).toEqual({ skipped: "not_found" });
  });

  it("stores nothing when the scan yields no keyframes", async () => {
    const { deps: d, updates } = deps();
    (d as { run: () => Promise<string> }).run = async () => "0.0,___\n";
    expect(await extractKeyframes("f1", d as never)).toEqual({ skipped: "no_keyframes" });
    expect(updates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @orbix/api exec vitest run src/jobs/extract-keyframes.test.ts
```

- [ ] **Step 3: Implement**

Create `apps/api/src/jobs/extract-keyframes.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseKeyframePackets } from "@orbix/core";

const execFileAsync = promisify(execFile);

export interface KeyframeJobDeps {
  run: (path: string) => Promise<string>;
  prisma: {
    mediaFile: {
      findUnique: (args: unknown) => Promise<{ id: string; path: string; keyframes: unknown } | null>;
      update: (args: unknown) => Promise<unknown>;
    };
  };
}

/**
 * Extract the keyframe index for one MediaFile (full-file ffprobe packet scan
 * — minutes for large files, which is why this is a queue job). Remux HLS
 * playlists are built from this index; files without it transcode instead.
 */
export async function extractKeyframes(
  fileId: string,
  deps: KeyframeJobDeps,
): Promise<{ count: number } | { skipped: string }> {
  const file = await deps.prisma.mediaFile.findUnique({
    where: { id: fileId },
    select: { id: true, path: true, keyframes: true },
  });
  if (!file) return { skipped: "not_found" };
  if (Array.isArray(file.keyframes) && file.keyframes.length > 0) return { skipped: "already_indexed" };

  const csv = await deps.run(file.path);
  const keyframes = parseKeyframePackets(csv);
  if (keyframes.length === 0) return { skipped: "no_keyframes" };

  await deps.prisma.mediaFile.update({ where: { id: fileId }, data: { keyframes } });
  return { count: keyframes.length };
}

/** Real ffprobe packet-scan runner (video stream only, CSV of pts+flags). */
export function keyframeProbeRunner(path: string): Promise<string> {
  return execFileAsync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path],
    { maxBuffer: 64 * 1024 * 1024 },
  ).then(({ stdout }) => stdout);
}
```

In `apps/api/src/plugins/queue.ts`, mirror the `translate-metadata` pattern exactly:
- Type: `export interface KeyframesJobData { fileId: string }`.
- Test-mode branch: `app.decorate("keyframesQueue", stub as unknown as Queue<KeyframesJobData>);` beside the other two stubs.
- Production: `const keyframesQueue = new Queue<KeyframesJobData>("keyframes", { connection });` + worker:

```ts
    const keyframesWorker = new Worker<KeyframesJobData, void>(
      "keyframes",
      async (job) => {
        const res = await extractKeyframes(job.data.fileId, {
          run: keyframeProbeRunner,
          prisma: app.prisma as never,
        });
        app.log.info({ fileId: job.data.fileId, res }, "keyframe extraction done");
      },
      { connection, concurrency: 1 },
    );
    keyframesWorker.on("error", (err) => app.log.error({ err }, "keyframes worker error"));
    app.decorate("keyframesQueue", keyframesQueue);
```
  plus `await keyframesWorker.close(); await keyframesQueue.close();` in the existing onClose block, and the fastify augmentation entry `keyframesQueue: Queue<KeyframesJobData>` beside the existing ones.
- Enqueue at scan: in the scan processor, right after the per-file upsert resolves (where `input.tech` is in scope and the upsert returned the file id — the upsert helper returns `{itemId}`; use the `prisma.mediaFile.findUnique({where:{path}})` id you already have or re-select minimal), add best-effort:

```ts
        if (tech.probedOk && tech.videoCodec) {
          try {
            const f = await prisma.mediaFile.findUnique({ where: { path: file.path }, select: { id: true, keyframes: true } });
            if (f && !(Array.isArray(f.keyframes) && f.keyframes.length > 0)) {
              await app.keyframesQueue.add("keyframes", { fileId: f.id }, { jobId: f.id });
            }
          } catch (err) {
            app.log.warn({ err }, "keyframes enqueue failed");
          }
        }
```
  (Place it where the scan loop processes each file's probe result — adapt to the actual local variable names in the processor; keep it non-fatal.)

- [ ] **Step 4: Run tests, lint, typecheck**

```bash
pnpm --filter @orbix/api exec vitest run src/jobs/extract-keyframes.test.ts && pnpm --filter @orbix/api test && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/extract-keyframes.ts apps/api/src/jobs/extract-keyframes.test.ts apps/api/src/plugins/queue.ts
git commit -m "feat(api): keyframe-extraction queue job + scan-time enqueue"
```

---

### Task 7: PlaybackInfo keyframe-awareness + boundary-carrying sessions

**Files:**
- Modify: `apps/api/src/routes/playback.ts`
- Modify: `apps/api/src/playback/registry.ts` (entry gains `boundaries` + `forceKeyframes`)
- Modify: `apps/api/src/playback/session.ts` (Session carries `boundaries`; spawn uses exact `startTimeSec` + `forceKeyframes`)
- Modify: `apps/api/src/routes/playback.test.ts` (append cases)

**Interfaces:**
- `PlaySessionEntry` gains `boundaries: SegmentBoundary[] | null` and `forceKeyframes: boolean` (import `SegmentBoundary` from `@orbix/core`); `create()` input includes them.
- Decision augmentation in the route (AFTER `decidePlayback`, core stays pure):
  - `plan.mode === "remux"`: load `file.keyframes`; when a non-empty array → `boundaries = computeSegmentBoundaries(file.keyframes as number[], file.durationSec, 6)`; when null/absent → **downgrade `plan` to `{ mode: "transcode", audioAction: plan.audioAction, audioTrackIndex: plan.audioTrackIndex, audioChannels: plan.audioChannels }`**, set `forceKeyframes = true`, and best-effort enqueue `app.keyframesQueue?.add("keyframes", { fileId }, { jobId: fileId }).catch(...)` so the NEXT play remuxes.
  - `plan.mode === "transcode"` (natively): `forceKeyframes = true`, `boundaries = null` (fixed EXTINFs are exact under forced keyframes).
  - `plan.mode === "direct"`: untouched.
- The prisma select in the route adds `keyframes: true, width: true, height: true, bitrate: true, videoProfile: true, videoLevel: true, colorTransfer: true, frameRate: true` (Task 8's master route needs these via the registry — store them on the entry too: add `media: { width, height, bitrate, videoProfile, videoLevel, colorTransfer, frameRate, videoCodec, container } | null` to `PlaySessionEntry`; populate at create).
- `SessionManager`: `getOrCreate` opts + `Session` gain `boundaries?: SegmentBoundary[] | null` and `forceKeyframes?: boolean`; `spawnFfmpeg(session, startSegment)` passes `startTimeSec: session.boundaries?.[startSegment]?.start` (undefined → legacy arithmetic) and `forceKeyframes: session.forceKeyframes`. `resolveByPlaySession` in stream.ts forwards both from the entry (Task 8 wires it).
- Response shape: UNCHANGED (mode reflects any downgrade — the client sees `"transcode"`).

- [ ] **Step 1: Append failing route tests**

Append to `apps/api/src/routes/playback.test.ts` (reuse the file's `stubAuth`/`stubFile` helpers; extend `stubFile` defaults with `keyframes: null, width: 1920, height: 1080, bitrate: 5_000_000, videoProfile: null, videoLevel: null, colorTransfer: null, frameRate: 25` — matching the widened select):

```ts
describe("keyframe-aware decisions", () => {
  const APPLE_CAPS = {
    containers: ["mp4"], videoCodecs: ["h264", "hevc"],
    audioCodecs: ["aac", "ac3", "eac3", "flac"], maxAudioChannels: 6,
  };

  it("remux-eligible file WITHOUT a keyframe index downgrades to transcode and enqueues extraction", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app, { keyframes: null });
    const added: unknown[] = [];
    (app as any).keyframesQueue = { add: async (...a: unknown[]) => { added.push(a); } };
    const res = await app.inject({
      method: "POST", url: "/api/playback/info", cookies,
      payload: { fileId: "f1", capabilities: APPLE_CAPS },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("transcode");
    expect(added).toHaveLength(1);
    await app.close();
  });

  it("remux-eligible file WITH a keyframe index stays remux", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app, { keyframes: [0, 6.006, 12.012] });
    const res = await app.inject({
      method: "POST", url: "/api/playback/info", cookies,
      payload: { fileId: "f1", capabilities: APPLE_CAPS },
    });
    expect(res.json().mode).toBe("remux");
    await app.close();
  });

  it("native transcode does not enqueue keyframe extraction", async () => {
    const app = await buildApp(env);
    stubAuth(app);
    stubFile(app, { videoCodec: "vp9", keyframes: null });
    const added: unknown[] = [];
    (app as any).keyframesQueue = { add: async (...a: unknown[]) => { added.push(a); } };
    const res = await app.inject({
      method: "POST", url: "/api/playback/info", cookies,
      payload: { fileId: "f1", capabilities: APPLE_CAPS },
    });
    expect(res.json().mode).toBe("transcode");
    expect(added).toHaveLength(0);
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @orbix/api exec vitest run src/routes/playback.test.ts
```

- [ ] **Step 3: Implement** per the Interfaces block: registry entry fields (+`media`), route augmentation (downgrade + enqueue + boundaries + media snapshot), SessionManager plumbing. Keep the registry's `create` signature additive (`boundaries`, `forceKeyframes`, `media` required in the input type — update the two `create` call sites: the route, and none else). Update `registry.test.ts`'s `input` fixture with `boundaries: null, forceKeyframes: false, media: null`.

- [ ] **Step 4: Full api suite, lint, typecheck**

```bash
pnpm --filter @orbix/api test && pnpm --filter @orbix/api lint && pnpm --filter @orbix/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/playback.ts apps/api/src/routes/playback.test.ts apps/api/src/playback/registry.ts apps/api/src/playback/registry.test.ts apps/api/src/playback/session.ts
git commit -m "feat(api): keyframe-aware playback decisions; sessions carry boundaries"
```

---

### Task 8: Apple playlists served from the session routes

**Files:**
- Modify: `apps/api/src/routes/stream.ts` (master → multivariant; index → boundaries-based when present)
- Modify: `apps/api/src/routes/stream.session.test.ts` (append/adjust)

**Interfaces:**
- **master.m3u8** (session branch): after the kids-gate + registry validation, build via `buildMultivariantPlaylist`:
  - `mediaUri = index.m3u8?playSessionId=<id><tokenSuffix>`
  - `bandwidth = entry.media?.bitrate ?? 8_000_000`
  - `codecs`: for remux → `videoCodecString(entry.media?.videoCodec, entry.media?.videoProfile, entry.media?.videoLevel)`; for transcode → `videoCodecString("h264", "High", 41)` (the encoder's output). Audio: `plan.audioAction === "copy"` → `audioCodecString(<selected track codec from entry.plan/audio metadata>)`; else `audioCodecString("aac")`. Simplification: store `audioCodec: string | undefined` (the SELECTED track's codec) on `entry.media` at create time in Task 7 — then here: `plan.audioAction === "copy" ? audioCodecString(entry.media?.audioCodec) : audioCodecString("aac")`. Filter nulls.
  - `resolution` from `entry.media` width/height when both present; `frameRate` from `entry.media`; `videoRange` = remux ? `videoRange(entry.media?.colorTransfer)` : "SDR" (transcode output is SDR H.264 today).
  - `subtitles`: from the file's `subtitleTracks` (available text tracks only — reuse `IMAGE_CODECS`): `{ name: language ?? "Track <index>", language, uri: "subs/<absIndex>/index.m3u8?playSessionId=<id><tokenSuffix>" }`. Requires the subtitle list on the entry: add `subtitleTracks: {index:number; codec?:string; language?:string}[]` to `entry.media` in Task 7's create (from the route's existing select).
- **index.m3u8** (session branch): `entry.boundaries ? buildMediaPlaylistFromBoundaries(entry.boundaries, q) : buildVodPlaylist(session.durationSec, session.segSec, q)` where `q = "playSessionId=<id><tokenSuffix>"` — transcode stays on fixed EXTINF (true under forced keyframes).
- **NEW route** `GET /play/:fileId/subs/:index/index.m3u8` (`[queryTokenAuth, requireAuth]` + `assertFileAllowed`): loads the file's `durationSec` + validates the track exists and is text-based (reuse the patterns from `subtitles.ts`); serves `buildSubtitleMediaPlaylist(durationSec, "/api/play/<fileId>/subs/<index>.vtt?hls=1<&token echo>")` with `application/vnd.apple.mpegurl`. NOTE route ordering: register BEFORE the generic `/play/:fileId/:seg` catch-all in stream.ts, or in subtitles.ts where the `/subs` prefix routes already live (preferred — put it in subtitles.ts; Fastify static-over-param priority handles the rest).
- **X-TIMESTAMP-MAP**: in `subtitles.ts`'s VTT handler, when `req.query.hls === "1"`, inject after the `WEBVTT` header line: `X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0` (exact transform: replace first line `WEBVTT` with `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0`).

- [ ] **Step 1: Append failing tests** to `stream.session.test.ts` (extend the `stubAll` mediaFile with the Task 7 fields + `keyframes: [0, 6.006, 12.012]`, `width/height/bitrate/frameRate`, one subrip + one PGS subtitle track):

```ts
describe("Apple-grade playlists", () => {
  it("master is a spec-complete multivariant with subtitle renditions", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const sid = await negotiate(app);
    const res = await app.inject({ method: "GET", url: `/api/play/f1/master.m3u8?playSessionId=${sid}`, cookies });
    const body = res.body;
    expect(body).toContain("#EXT-X-VERSION:7");
    expect(body).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    expect(body).toMatch(/#EXT-X-STREAM-INF:BANDWIDTH=\d+,AVERAGE-BANDWIDTH=\d+,CODECS="/);
    expect(body).toContain("RESOLUTION=");
    expect(body).toContain("FRAME-RATE=");
    expect(body).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES');
    expect(body).toContain(`subs/2/index.m3u8?playSessionId=${sid}`);
    expect(body).not.toContain("subs/3/"); // PGS track excluded
    await app.close();
  });

  it("index EXTINFs come from keyframe boundaries", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const sid = await negotiate(app);
    const res = await app.inject({ method: "GET", url: `/api/play/f1/index.m3u8?playSessionId=${sid}`, cookies });
    expect(res.body).toContain("#EXTINF:6.006,");
    expect(res.body).toContain(`seg0.m4s?playSessionId=${sid}`);
    expect(res.body).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    await app.close();
  });

  it("subtitle rendition playlist serves a full-duration VTT segment", async () => {
    const app = await buildApp(env);
    stubAll(app);
    const sid = await negotiate(app);
    const res = await app.inject({ method: "GET", url: `/api/play/f1/subs/2/index.m3u8?playSessionId=${sid}`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("mpegurl");
    expect(res.body).toContain("/api/play/f1/subs/2.vtt?hls=1");
    expect(res.body).toContain("#EXT-X-ENDLIST");
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** per Interfaces (master/index rewrites in the session branches ONLY — 400 missing_session behavior unchanged; the subtitle rendition route in subtitles.ts + the `hls=1` VTT header injection with a small unit-style test if convenient), **Step 4: Full api suite + lint + typecheck**, **Step 5: Commit**:

```bash
git add apps/api/src/routes/stream.ts apps/api/src/routes/subtitles.ts apps/api/src/routes/stream.session.test.ts
git commit -m "feat(api): Apple multivariant/media playlists + subtitle renditions"
```

---

### Task 9: HLS conformance verifier script

**Files:**
- Create: `scripts/verify-hls.mjs`

**Interfaces:** `node scripts/verify-hls.mjs <baseUrl> <fileId> <cookieOrToken>` — negotiates via `/api/playback/info` (WEB caps by default, `--caps apple` flag for the Apple profile), fetches master + media playlists, asserts required tags (`VERSION`, `INDEPENDENT-SEGMENTS`, `STREAM-INF` with `BANDWIDTH`/`CODECS`, `TARGETDURATION >= max EXTINF`, `ENDLIST`), downloads init + every segment, ffprobes each segment's real duration (`ffprobe -show_entries format=duration`), and FAILS (exit 1) when any segment's real duration deviates from its declared `EXTINF` by more than 0.5s or when `TARGETDURATION < ceil(max real duration)`. Prints a per-segment table. This is the definition-of-done gate for SP1c and runs inside the acceptance smoke (real ffmpeg, throwaway stack).

- [ ] **Step 1: Implement the script** (~150 lines; plain Node 22, no deps — `fetch`, `node:child_process` execFile for ffprobe, temp dir via `node:fs/promises` + `os.tmpdir()`). Structure: `parseArgs → negotiate → getMaster → assert tags → getIndex → parse EXTINF list → for each segment: download to temp (init.mp4 concatenated? NO — fMP4 segments need the init prepended for ffprobe: write `init.mp4` once, then per segment write `cat(init, seg)` to a temp file and ffprobe THAT) → compare durations → report`. Exit non-zero on any failure; always clean the temp dir.

- [ ] **Step 2: Verify against a live throwaway stack** (the SP1c acceptance smoke pattern: throwaway pg + seeded clip + test-mode api — the controller runs this at plan completion; for THIS task, verify the script's failure mode too: run it against a deliberately-mismatched playlist by pointing it at a transcode session with forceKeyframes disabled via a temporary local hack, confirm it exits 1, then revert the hack — document the check in the commit message body).

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-hls.mjs
git commit -m "feat(scripts): HLS conformance verifier (EXTINF vs real segment durations)"
```

---

### Task 10: Gates + docs

- [ ] **Step 1:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all green.
- [ ] **Step 2:** CLAUDE.md — extend the playback bullet's last sentence with: `HLS output is Apple-spec (multivariant CODECS/RESOLUTION/FRAME-RATE, keyframe-accurate EXTINFs via MediaFile.keyframes + the keyframes queue job, WebVTT subtitle renditions); scripts/verify-hls.mjs is the conformance gate.`
- [ ] **Step 3:** Commit: `docs: Apple-grade HLS in CLAUDE.md`.

---

## Self-review notes

- **Spec §4.4 coverage:** multivariant MUST attrs ✓ (T3/T4/T8); keyframe index + exact EXTINF ✓ (T2/T6/T7/T8); transcode-with-forced-keyframes fallback ✓ (T5/T7); subtitle renditions + X-TIMESTAMP-MAP ✓ (T4/T8); probe/schema extensions ✓ (T1); validation harness ✓ (T9 — ffprobe-based since mediastreamvalidator isn't installed; it runs on Linux CI too).
- **Deliberate simplifications:** single variant (no ABR); `AVERAGE-BANDWIDTH = BANDWIDTH` (legal for VOD single-variant); transcode CODECS hardcoded to the encoder's true output (H.264 High); DV verification deferred (HDR10/HLG via VIDEO-RANGE only); forced-subtitle folding deferred (no forced-flag data in probe yet).
- **Web unaffected:** hls.js consumes the richer playlists fine; sidecar `<track>` path untouched; `hls=1` header injection is opt-in by query param.
- **Type consistency:** `SegmentBoundary` defined once (T2) and imported by T4/T7; `entry.media` shape defined in T7 and consumed in T8; `keyframesQueue` decoration matches the existing queue augmentation pattern.
