# Transcode Capability Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Test encoders" button to System Settings → Transcoding that scans the server and reports which of the four encoders (software / vaapi / qsv / nvenc) actually work.

**Architecture:** Pure detection logic (parse `ffmpeg -encoders`, build per-encoder test-encode args, assemble the report) lives in `packages/core` with injected adapters. `apps/api` supplies the real ffmpeg-spawning adapters and exposes `POST /api/transcode/test` (admin-guarded). The web Settings page adds a button + a presentational results list. Layered detection: an encoder is *available* only if it is listed in `ffmpeg -encoders` **and** a tiny real test-encode exits 0.

**Tech Stack:** TypeScript, pnpm + Turborepo, Fastify, Prisma (unused here), Vitest, React + react-i18next, Tailwind, ffmpeg (spawned via `node:child_process.execFile`).

## Global Constraints

- **pnpm 10.22.0 / Node 22.** Always use the repo-local pnpm.
- **Core purity:** `packages/core` must NOT import `child_process`, network, fs, or ffmpeg. Everything is injected. Core tests must never require ffmpeg/network/DB.
- **SPA calls relative `/api/...` only** via `apiFetch`/`apiJson` (`apps/web/src/lib/api.ts`), `credentials: "include"`. Never hardcode an API origin.
- **All app routes under the `/api` prefix**; guards from `apps/api/src/lib/auth.ts` (`requireAuth`, `requireAdmin`) + `apps/api/src/lib/catalog-filter.ts` (`requireNonKids`). Admin routes use all three (see `apps/api/src/routes/refresh.ts`).
- **i18n parity is enforced** by `apps/web/src/locales/parity.test.ts`: every locale (`en/es/de/pt/ru/fr`) must have exactly the same logical key set per namespace. Adding a key to `en/settings.json` REQUIRES adding it to all five others.
- **Run lint per change** (`pnpm lint` or `pnpm --filter <pkg> lint`) — a lint-only error passes typecheck+test and hides behind Turbo's cache.
- **Gates before done:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- **Ephemeral results, advisory only:** no DB/schema change, no persistence, saving an "unavailable" encoder is not blocked.

---

### Task 1: Core — pure helpers (`parseEncoderList`, `buildEncoderTestArgs`)

**Files:**
- Modify: `packages/core/src/playback/ffargs.ts` (export `ENCODER_MAP`)
- Create: `packages/core/src/playback/capabilities.ts`
- Test: `packages/core/src/playback/capabilities.test.ts`

**Interfaces:**
- Consumes: `EncoderSetting` from `./ffargs`.
- Produces:
  - `ENCODER_MAP: Record<string, string>` (now exported from `ffargs.ts`).
  - `ENCODER_ORDER: EncoderSetting[]` = `["software","vaapi","qsv","nvenc"]`.
  - `parseEncoderList(raw: string): Set<string>`
  - `buildEncoderTestArgs(encoder: EncoderSetting, opts: { vaapiDevice: string }): string[]`

- [ ] **Step 1: Export `ENCODER_MAP` from `ffargs.ts`**

In `packages/core/src/playback/ffargs.ts`, change line 5 from `const ENCODER_MAP` to:

```typescript
/** Mapping from encoder setting value to ffmpeg codec name. */
export const ENCODER_MAP: Record<string, string> = {
  software: "libx264",
  vaapi: "h264_vaapi",
  qsv: "h264_qsv",
  nvenc: "h264_nvenc",
};
```

(Only add `export`; the rest of the file is unchanged.)

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/playback/capabilities.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseEncoderList, buildEncoderTestArgs, ENCODER_ORDER } from "./capabilities";

const SAMPLE_ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`;

describe("parseEncoderList", () => {
  it("extracts codec names after the divider and ignores headers", () => {
    const set = parseEncoderList(SAMPLE_ENCODERS);
    expect(set.has("libx264")).toBe(true);
    expect(set.has("h264_nvenc")).toBe(true);
    expect(set.has("h264_vaapi")).toBe(true);
    expect(set.has("aac")).toBe(true);
    expect(set.has("h264_qsv")).toBe(false);
    expect(set.has("Video")).toBe(false);
    expect(set.has("=")).toBe(false);
  });

  it("returns an empty set for empty input", () => {
    expect(parseEncoderList("").size).toBe(0);
  });
});

describe("buildEncoderTestArgs", () => {
  it("software uses libx264 on a lavfi testsrc to null", () => {
    const args = buildEncoderTestArgs("software", { vaapiDevice: "/dev/dri/renderD128" });
    expect(args).toContain("libx264");
    expect(args.join(" ")).toContain("-f lavfi");
    expect(args.slice(-2)).toEqual(["null", "-"]); // -f null -
    expect(args).not.toContain("-vaapi_device");
  });

  it("nvenc uses h264_nvenc without hwupload", () => {
    const args = buildEncoderTestArgs("nvenc", { vaapiDevice: "/dev/dri/renderD128" });
    expect(args).toContain("h264_nvenc");
    expect(args.join(" ")).not.toContain("hwupload");
  });

  it("vaapi sets the device and uploads frames to the GPU", () => {
    const args = buildEncoderTestArgs("vaapi", { vaapiDevice: "/dev/dri/renderD1" });
    expect(args).toContain("-vaapi_device");
    expect(args).toContain("/dev/dri/renderD1");
    expect(args.join(" ")).toContain("format=nv12,hwupload");
    expect(args).toContain("h264_vaapi");
  });

  it("qsv uploads frames to a qsv surface", () => {
    const args = buildEncoderTestArgs("qsv", { vaapiDevice: "/dev/dri/renderD128" });
    expect(args.join(" ")).toContain("hwupload=extra_hw_frames=64,format=qsv");
    expect(args).toContain("h264_qsv");
  });

  it("ENCODER_ORDER matches the settings dropdown order", () => {
    expect(ENCODER_ORDER).toEqual(["software", "vaapi", "qsv", "nvenc"]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/playback/capabilities.test.ts`
Expected: FAIL — `Cannot find module './capabilities'`.

- [ ] **Step 4: Implement the pure helpers**

Create `packages/core/src/playback/capabilities.ts`:

```typescript
import type { EncoderSetting } from "./ffargs";
import { ENCODER_MAP } from "./ffargs";

export { ENCODER_MAP };

/** Encoder settings in the same order as the Settings dropdown. */
export const ENCODER_ORDER: EncoderSetting[] = ["software", "vaapi", "qsv", "nvenc"];

/**
 * Parse the stdout of `ffmpeg -encoders` into the set of codec names present.
 * Each encoder row is `<6-char flag column> <codec name> <description>`, listed
 * after a `------` divider. We only parse rows after the divider so header lines
 * like ` V..... = Video` are ignored.
 */
export function parseEncoderList(raw: string): Set<string> {
  const lines = raw.split(/\r?\n/);
  const dividerIdx = lines.findIndex((l) => /^\s*-{4,}\s*$/.test(l));
  const body = dividerIdx >= 0 ? lines.slice(dividerIdx + 1) : lines;
  const names = new Set<string>();
  for (const line of body) {
    // 6-char flag column, whitespace, then the codec token.
    const m = line.match(/^\s*\S{6}\s+(\S+)/);
    if (m) names.add(m[1]);
  }
  return names;
}

// A fraction-of-a-second synthetic input, muxed to the null sink so nothing is
// written to disk. Placed after `-i` so `-frames:v` bounds the output.
const TEST_INPUT = [
  "-f", "lavfi",
  "-i", "testsrc=duration=0.1:size=320x240:rate=25",
  "-frames:v", "3",
];
const HEAD = ["-hide_banner", "-nostdin"];
const NULL_OUT = ["-f", "null", "-"];

/**
 * Build the ffmpeg argument list for a tiny test-encode of one encoder. The
 * hardware paths must upload frames to the GPU first (a bare `-c:v h264_vaapi`
 * on a CPU-memory input fails even when VAAPI works), so each encoder gets its
 * own recipe.
 */
export function buildEncoderTestArgs(
  encoder: EncoderSetting,
  opts: { vaapiDevice: string },
): string[] {
  switch (encoder) {
    case "software":
      return [...HEAD, ...TEST_INPUT, "-c:v", "libx264", "-preset", "ultrafast", ...NULL_OUT];
    case "nvenc":
      // NVENC accepts system-memory frames and uploads internally.
      return [...HEAD, ...TEST_INPUT, "-c:v", "h264_nvenc", ...NULL_OUT];
    case "vaapi":
      return [
        ...HEAD,
        "-vaapi_device", opts.vaapiDevice,
        ...TEST_INPUT,
        "-vf", "format=nv12,hwupload",
        "-c:v", "h264_vaapi",
        ...NULL_OUT,
      ];
    case "qsv":
      return [
        ...HEAD,
        ...TEST_INPUT,
        "-vf", "hwupload=extra_hw_frames=64,format=qsv",
        "-c:v", "h264_qsv",
        ...NULL_OUT,
      ];
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @orbix/core exec vitest run src/playback/capabilities.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/playback/ffargs.ts packages/core/src/playback/capabilities.ts packages/core/src/playback/capabilities.test.ts
git commit -m "feat(core): encoder-list parsing + per-encoder test-encode args"
```

---

### Task 2: Core — `detectCapabilities` orchestrator + report types + export

**Files:**
- Modify: `packages/core/src/playback/capabilities.ts` (add types + orchestrator)
- Modify: `packages/core/src/index.ts` (export the new module)
- Test: `packages/core/src/playback/capabilities.test.ts` (append)

**Interfaces:**
- Consumes: `parseEncoderList`, `ENCODER_ORDER`, `ENCODER_MAP` (Task 1).
- Produces:
  - `type ReasonCode = "ffmpeg_not_found" | "not_built_in" | "test_failed"`
  - `interface EncoderCapability { key: EncoderSetting; codec: string; listed: boolean; available: boolean; reason?: string; reasonCode?: ReasonCode }`
  - `interface CapabilityReport { ffmpeg: { present: boolean; version?: string }; ffprobe: { present: boolean; version?: string }; encoders: EncoderCapability[] }`
  - `interface CapabilityDeps { runVersion: (bin: "ffmpeg" | "ffprobe") => Promise<{ present: boolean; version?: string }>; runEncoderList: () => Promise<string>; runEncodeTest: (encoder: EncoderSetting) => Promise<{ ok: boolean; reason?: string }> }`
  - `detectCapabilities(deps: CapabilityDeps): Promise<CapabilityReport>`

- [ ] **Step 1: Write the failing test (append)**

Append to `packages/core/src/playback/capabilities.test.ts`:

```typescript
import { detectCapabilities, type CapabilityDeps } from "./capabilities";

function deps(over: Partial<CapabilityDeps> = {}): CapabilityDeps {
  return {
    runVersion: async (bin) => ({ present: true, version: bin === "ffmpeg" ? "6.1" : "6.1" }),
    runEncoderList: async () => "Encoders:\n ------\n V....D libx264 x\n V....D h264_nvenc x\n",
    runEncodeTest: async () => ({ ok: true }),
    ...over,
  };
}

describe("detectCapabilities", () => {
  it("marks ffmpeg/ffprobe absent and skips all encoders when ffmpeg is missing", async () => {
    const report = await detectCapabilities(
      deps({ runVersion: async (bin) => ({ present: bin === "ffprobe" }) }),
    );
    expect(report.ffmpeg.present).toBe(false);
    expect(report.encoders).toHaveLength(4);
    for (const e of report.encoders) {
      expect(e.available).toBe(false);
      expect(e.listed).toBe(false);
      expect(e.reasonCode).toBe("ffmpeg_not_found");
    }
  });

  it("reports a listed encoder that passes its test as available", async () => {
    const report = await detectCapabilities(deps());
    const sw = report.encoders.find((e) => e.key === "software")!;
    expect(sw.listed).toBe(true);
    expect(sw.available).toBe(true);
    expect(sw.reasonCode).toBeUndefined();
  });

  it("reports an unlisted encoder as not_built_in without running a test", async () => {
    let tested = false;
    const report = await detectCapabilities(
      deps({ runEncodeTest: async () => { tested = true; return { ok: true }; } }),
    );
    const qsv = report.encoders.find((e) => e.key === "qsv")!; // not in the sample list
    expect(qsv.listed).toBe(false);
    expect(qsv.available).toBe(false);
    expect(qsv.reasonCode).toBe("not_built_in");
    // software+nvenc are listed → tested; qsv/vaapi are not → the flag proves
    // at least the listed ones ran, and unlisted ones are skipped by branch.
    expect(tested).toBe(true);
  });

  it("carries the failure reason through when a listed encoder's test fails", async () => {
    const report = await detectCapabilities(
      deps({ runEncodeTest: async () => ({ ok: false, reason: "device not found" }) }),
    );
    const nvenc = report.encoders.find((e) => e.key === "nvenc")!;
    expect(nvenc.listed).toBe(true);
    expect(nvenc.available).toBe(false);
    expect(nvenc.reasonCode).toBe("test_failed");
    expect(nvenc.reason).toBe("device not found");
  });

  it("always returns encoders in ENCODER_ORDER", async () => {
    const report = await detectCapabilities(deps());
    expect(report.encoders.map((e) => e.key)).toEqual(["software", "vaapi", "qsv", "nvenc"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orbix/core exec vitest run src/playback/capabilities.test.ts`
Expected: FAIL — `detectCapabilities is not a function` / not exported.

- [ ] **Step 3: Implement the orchestrator (append to `capabilities.ts`)**

Append to `packages/core/src/playback/capabilities.ts`:

```typescript
export type ReasonCode = "ffmpeg_not_found" | "not_built_in" | "test_failed";

export interface EncoderCapability {
  key: EncoderSetting;
  codec: string;
  listed: boolean;
  available: boolean;
  reason?: string;       // English/stderr detail (not localized)
  reasonCode?: ReasonCode; // present when !available; frontend localizes
}

export interface CapabilityReport {
  ffmpeg: { present: boolean; version?: string };
  ffprobe: { present: boolean; version?: string };
  encoders: EncoderCapability[];
}

export interface CapabilityDeps {
  runVersion: (bin: "ffmpeg" | "ffprobe") => Promise<{ present: boolean; version?: string }>;
  runEncoderList: () => Promise<string>;
  runEncodeTest: (encoder: EncoderSetting) => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Layered detection: probe ffmpeg/ffprobe; if ffmpeg is present, parse its
 * encoder list, then real-test-encode each listed encoder. An encoder is
 * `available` only when listed AND its test-encode succeeds.
 */
export async function detectCapabilities(deps: CapabilityDeps): Promise<CapabilityReport> {
  const [ffmpeg, ffprobe] = await Promise.all([
    deps.runVersion("ffmpeg"),
    deps.runVersion("ffprobe"),
  ]);

  const encoders: EncoderCapability[] = [];

  if (!ffmpeg.present) {
    for (const key of ENCODER_ORDER) {
      encoders.push({
        key, codec: ENCODER_MAP[key], listed: false, available: false,
        reasonCode: "ffmpeg_not_found",
      });
    }
    return { ffmpeg, ffprobe, encoders };
  }

  const listed = parseEncoderList(await deps.runEncoderList());

  for (const key of ENCODER_ORDER) {
    const codec = ENCODER_MAP[key];
    if (!listed.has(codec)) {
      encoders.push({ key, codec, listed: false, available: false, reasonCode: "not_built_in" });
      continue;
    }
    const test = await deps.runEncodeTest(key);
    encoders.push({
      key, codec, listed: true, available: test.ok,
      ...(test.ok ? {} : { reasonCode: "test_failed" as const, reason: test.reason }),
    });
  }

  return { ffmpeg, ffprobe, encoders };
}
```

- [ ] **Step 4: Export the module from the core barrel**

In `packages/core/src/index.ts`, add after line 21 (`export * from "./playback/ffargs";`):

```typescript
export * from "./playback/capabilities";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @orbix/core exec vitest run src/playback/capabilities.test.ts`
Expected: PASS (all Task 1 + Task 2 cases).

- [ ] **Step 6: Typecheck core and commit**

Run: `pnpm --filter @orbix/core typecheck`
Expected: no errors.

```bash
git add packages/core/src/playback/capabilities.ts packages/core/src/playback/capabilities.test.ts packages/core/src/index.ts
git commit -m "feat(core): detectCapabilities orchestrator + report types"
```

---

### Task 3: API adapter — `scanTranscodeCapabilities`

**Files:**
- Create: `apps/api/src/lib/transcode-capabilities.ts`
- Test: `apps/api/src/lib/transcode-capabilities.test.ts`

**Interfaces:**
- Consumes: `detectCapabilities`, `buildEncoderTestArgs`, `CapabilityReport`, `EncoderSetting` from `@orbix/core`.
- Produces:
  - `interface ExecOutcome { code: number | "ENOENT"; stdout: string; stderr: string }`
  - `type ExecFileImpl = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecOutcome>`
  - `tailReason(stderr: string): string`
  - `scanTranscodeCapabilities(opts?: { vaapiDevice?: string; exec?: ExecFileImpl; timeoutMs?: number }): Promise<CapabilityReport>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/transcode-capabilities.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scanTranscodeCapabilities, tailReason, type ExecOutcome } from "./transcode-capabilities";

const ENCODER_STDOUT =
  "Encoders:\n ------\n V....D libx264 x\n V....D h264_nvenc x\n V....D h264_vaapi x\n V....D h264_qsv x\n";

/** Build a fake exec that branches on the ffmpeg invocation. */
function fakeExec(opts: {
  ffmpegPresent?: boolean;
  ffprobePresent?: boolean;
  failEncoders?: EncoderKey[];
}) {
  const fail = new Set(opts.failEncoders ?? []);
  return async (cmd: string, args: string[]): Promise<ExecOutcome> => {
    if (args.includes("-version")) {
      const present = cmd === "ffmpeg" ? opts.ffmpegPresent ?? true : opts.ffprobePresent ?? true;
      return present
        ? { code: 0, stdout: `${cmd} version 6.1 Copyright`, stderr: "" }
        : { code: "ENOENT", stdout: "", stderr: "" };
    }
    if (args.includes("-encoders")) {
      return { code: 0, stdout: ENCODER_STDOUT, stderr: "" };
    }
    // a test-encode: identify the codec from -c:v
    const codec = args[args.indexOf("-c:v") + 1];
    const codecToKey: Record<string, EncoderKey> = {
      libx264: "software", h264_vaapi: "vaapi", h264_qsv: "qsv", h264_nvenc: "nvenc",
    };
    const key = codecToKey[codec];
    return fail.has(key)
      ? { code: 1, stdout: "", stderr: `line1\nError: ${key} device missing\n` }
      : { code: 0, stdout: "", stderr: "" };
  };
}
type EncoderKey = "software" | "vaapi" | "qsv" | "nvenc";

describe("tailReason", () => {
  it("keeps the last non-empty lines and caps length", () => {
    expect(tailReason("a\nb\nError: boom\n")).toBe("b Error: boom");
    expect(tailReason("")).toBe("");
    expect(tailReason("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe("scanTranscodeCapabilities", () => {
  it("reports every listed encoder that passes as available", async () => {
    const report = await scanTranscodeCapabilities({ exec: fakeExec({}) });
    expect(report.ffmpeg).toEqual({ present: true, version: "6.1" });
    expect(report.encoders.every((e) => e.available)).toBe(true);
  });

  it("marks a failing encoder unavailable with a stderr-tail reason", async () => {
    const report = await scanTranscodeCapabilities({ exec: fakeExec({ failEncoders: ["vaapi"] }) });
    const vaapi = report.encoders.find((e) => e.key === "vaapi")!;
    expect(vaapi.available).toBe(false);
    expect(vaapi.reasonCode).toBe("test_failed");
    expect(vaapi.reason).toContain("device missing");
    expect(report.encoders.find((e) => e.key === "software")!.available).toBe(true);
  });

  it("reports ffmpeg absent and no available encoders when the binary is missing", async () => {
    const report = await scanTranscodeCapabilities({ exec: fakeExec({ ffmpegPresent: false }) });
    expect(report.ffmpeg.present).toBe(false);
    expect(report.encoders.some((e) => e.available)).toBe(false);
  });

  it("passes the vaapi device into the test-encode args", async () => {
    let sawDevice = "";
    const exec = async (cmd: string, args: string[]): Promise<ExecOutcome> => {
      if (args.includes("-vaapi_device")) sawDevice = args[args.indexOf("-vaapi_device") + 1];
      if (args.includes("-version")) return { code: 0, stdout: "v 6.1", stderr: "" };
      if (args.includes("-encoders")) return { code: 0, stdout: ENCODER_STDOUT, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await scanTranscodeCapabilities({ exec, vaapiDevice: "/dev/dri/renderD42" });
    expect(sawDevice).toBe("/dev/dri/renderD42");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/lib/transcode-capabilities.test.ts`
Expected: FAIL — `Cannot find module './transcode-capabilities'`.

- [ ] **Step 3: Implement the adapter**

Create `apps/api/src/lib/transcode-capabilities.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  detectCapabilities,
  buildEncoderTestArgs,
  type CapabilityReport,
  type EncoderSetting,
} from "@orbix/core";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
// Default VAAPI render node; override with the VAAPI_DEVICE env var. This is an
// optional operational knob, not part of the validated boot Env.
const DEFAULT_VAAPI_DEVICE = process.env.VAAPI_DEVICE || "/dev/dri/renderD128";

export interface ExecOutcome {
  code: number | "ENOENT";
  stdout: string;
  stderr: string;
}

export type ExecFileImpl = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<ExecOutcome>;

/** Real ffmpeg/ffprobe runner. Never throws — maps failures to an ExecOutcome. */
const realExec: ExecFileImpl = async (cmd, args, timeoutMs) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string; stderr?: string; killed?: boolean;
    };
    if (e.code === "ENOENT") return { code: "ENOENT", stdout: "", stderr: "" };
    const stderr = e.killed ? "timed out" : e.stderr ?? "";
    return { code: 1, stdout: e.stdout ?? "", stderr };
  }
};

/** Last one or two non-empty stderr lines, capped, for a compact failure reason. */
export function tailReason(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-2).join(" ");
  return tail.length > 200 ? tail.slice(-200) : tail;
}

function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/version\s+(\S+)/i);
  return m?.[1];
}

/**
 * Scan this server's ffmpeg for encoder availability. Wires real execFile-based
 * adapters into the pure core detector; encoder tests run sequentially (core
 * awaits each) to avoid GPU contention.
 */
export async function scanTranscodeCapabilities(opts: {
  vaapiDevice?: string;
  exec?: ExecFileImpl;
  timeoutMs?: number;
} = {}): Promise<CapabilityReport> {
  const exec = opts.exec ?? realExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const vaapiDevice = opts.vaapiDevice ?? DEFAULT_VAAPI_DEVICE;

  return detectCapabilities({
    runVersion: async (bin) => {
      const out = await exec(bin, ["-version"], timeoutMs);
      if (out.code === "ENOENT") return { present: false };
      return { present: out.code === 0, version: parseVersion(out.stdout) };
    },
    runEncoderList: async () => {
      const out = await exec("ffmpeg", ["-hide_banner", "-encoders"], timeoutMs);
      return out.code === 0 ? out.stdout : "";
    },
    runEncodeTest: async (encoder: EncoderSetting) => {
      const args = buildEncoderTestArgs(encoder, { vaapiDevice });
      const out = await exec("ffmpeg", args, timeoutMs);
      if (out.code === 0) return { ok: true };
      return { ok: false, reason: tailReason(out.stderr) || "test failed" };
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @orbix/api exec vitest run src/lib/transcode-capabilities.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/transcode-capabilities.ts apps/api/src/lib/transcode-capabilities.test.ts
git commit -m "feat(api): ffmpeg-backed transcode capability scan adapter"
```

---

### Task 4: API route — `POST /api/transcode/test`

**Files:**
- Create: `apps/api/src/routes/transcode.ts`
- Modify: `apps/api/src/app.ts` (import + register)
- Test: `apps/api/src/routes/transcode.test.ts`

**Interfaces:**
- Consumes: `scanTranscodeCapabilities` (Task 3); `requireAuth`, `requireAdmin` (`../lib/auth`); `requireNonKids` (`../lib/catalog-filter`).
- Produces: default-export Fastify plugin `transcodeRoute`; route `POST /transcode/test` → `CapabilityReport` JSON.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/transcode.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildApp } from "../app";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

describe("POST /api/transcode/test", () => {
  it("rejects unauthenticated requests with 401 (and never spawns ffmpeg)", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "POST", url: "/api/transcode/test" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthenticated" });
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/transcode.test.ts`
Expected: FAIL — 404 (route not registered) instead of 401.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/transcode.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { requireAuth, requireAdmin } from "../lib/auth";
import { requireNonKids } from "../lib/catalog-filter";
import { scanTranscodeCapabilities } from "../lib/transcode-capabilities";

/**
 * POST /transcode/test — admin-only. Scans this server's ffmpeg for encoder
 * availability (see scanTranscodeCapabilities) and returns a CapabilityReport.
 * Results are advisory and not persisted.
 */
export default async function transcodeRoute(app: FastifyInstance) {
  app.post(
    "/transcode/test",
    { preHandler: [requireAuth(app), requireAdmin(app), requireNonKids(app)] },
    async (_req, reply) => {
      const report = await scanTranscodeCapabilities();
      return reply.send(report);
    },
  );
}
```

- [ ] **Step 4: Register the route in `app.ts`**

In `apps/api/src/app.ts`, add the import after line 15 (`import settingsRoute from "./routes/settings";`):

```typescript
import transcodeRoute from "./routes/transcode";
```

And register it after line 49 (`await app.register(settingsRoute, { prefix: "/api" });`):

```typescript
  await app.register(transcodeRoute, { prefix: "/api" });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @orbix/api exec vitest run src/routes/transcode.test.ts`
Expected: PASS (401 unauthenticated). The success-path report shape is covered by Task 3's adapter test.

- [ ] **Step 6: Typecheck api and commit**

Run: `pnpm --filter @orbix/api typecheck`
Expected: no errors.

```bash
git add apps/api/src/routes/transcode.ts apps/api/src/app.ts apps/api/src/routes/transcode.test.ts
git commit -m "feat(api): POST /api/transcode/test route (admin-guarded)"
```

---

### Task 5: Web — `EncoderCapabilityList` component + English i18n

**Files:**
- Modify: `apps/web/src/locales/en/settings.json` (add full `transcode.capabilities` block)
- Create: `apps/web/src/components/settings/EncoderCapabilityList.tsx`
- Test: `apps/web/src/components/settings/EncoderCapabilityList.test.tsx`

**Interfaces:**
- Consumes: `CapabilityReport`, `EncoderCapability` types from `@orbix/core` (type-only import); `useTranslation` from `react-i18next`.
- Produces: default-export `EncoderCapabilityList` — props `{ report: CapabilityReport; current: string }`.

- [ ] **Step 1: Add the English i18n block**

In `apps/web/src/locales/en/settings.json`, replace the `transcode` block (lines 29–39) so it includes a `capabilities` child (keep the existing `heading`/`encoderLabel`/`encoderHelp`/`encoders`):

```json
  "transcode": {
    "heading": "Transcoding",
    "encoderLabel": "Video Encoder",
    "encoderHelp": "Choose the hardware or software encoder used when transcoding. Software (libx264) always works; hardware encoders require the corresponding GPU driver/VAAPI/NVENC support on the server.",
    "encoders": {
      "software": "Software (libx264)",
      "vaapi": "VA-API (h264_vaapi)",
      "qsv": "Intel QSV (h264_qsv)",
      "nvenc": "NVIDIA NVENC (h264_nvenc)"
    },
    "capabilities": {
      "testButton": "Test encoders",
      "testing": "Testing…",
      "available": "Available",
      "unavailable": "Unavailable",
      "current": "current",
      "toolsFound": "ffmpeg {{ffmpeg}} · ffprobe {{ffprobe}} · found on PATH",
      "toolsMissing": "ffmpeg or ffprobe was not found on the server PATH.",
      "error": "Could not run the encoder test.",
      "reasons": {
        "not_built_in": "Not built into ffmpeg on this server",
        "test_failed": "Test encode failed",
        "ffmpeg_not_found": "ffmpeg not found"
      }
    }
  },
```

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/components/settings/EncoderCapabilityList.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import EncoderCapabilityList from "./EncoderCapabilityList";
import type { CapabilityReport } from "@orbix/core";

const report: CapabilityReport = {
  ffmpeg: { present: true, version: "6.1" },
  ffprobe: { present: true, version: "6.1" },
  encoders: [
    { key: "software", codec: "libx264", listed: true, available: true },
    { key: "vaapi", codec: "h264_vaapi", listed: false, available: false, reasonCode: "not_built_in" },
    { key: "qsv", codec: "h264_qsv", listed: true, available: false, reasonCode: "test_failed", reason: "qsv device missing" },
    { key: "nvenc", codec: "h264_nvenc", listed: true, available: true },
  ],
};

describe("EncoderCapabilityList", () => {
  it("renders a status for every encoder and marks the current one", () => {
    render(<EncoderCapabilityList report={report} current="nvenc" />);
    expect(screen.getByText("Software (libx264)")).toBeInTheDocument();
    // two available, two unavailable
    expect(screen.getAllByText("Available")).toHaveLength(2);
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    // current marker appears once, on the nvenc row
    expect(screen.getByText(/current/)).toBeInTheDocument();
  });

  it("shows the localized reason and the stderr detail on failures", () => {
    render(<EncoderCapabilityList report={report} current="software" />);
    expect(screen.getByText("Not built into ffmpeg on this server")).toBeInTheDocument();
    expect(screen.getByText(/qsv device missing/)).toBeInTheDocument();
  });

  it("shows the ffmpeg/ffprobe footer when both are present", () => {
    render(<EncoderCapabilityList report={report} current="software" />);
    expect(screen.getByText(/ffmpeg 6\.1/)).toBeInTheDocument();
  });

  it("warns when ffmpeg is missing", () => {
    const missing: CapabilityReport = {
      ffmpeg: { present: false }, ffprobe: { present: false },
      encoders: report.encoders.map((e) => ({ ...e, available: false, listed: false, reasonCode: "ffmpeg_not_found" as const })),
    };
    render(<EncoderCapabilityList report={missing} current="software" />);
    expect(screen.getByText(/was not found on the server PATH/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @orbix/web exec vitest run src/components/settings/EncoderCapabilityList.test.tsx`
Expected: FAIL — `Cannot find module './EncoderCapabilityList'`.

- [ ] **Step 4: Implement the component**

Create `apps/web/src/components/settings/EncoderCapabilityList.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import type { CapabilityReport, EncoderCapability } from "@orbix/core";

function Badge({ available }: { available: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={
        "rounded px-2 py-0.5 text-xs font-medium " +
        (available
          ? "bg-green-500/15 text-green-400"
          : "bg-red-500/10 text-red-400")
      }
    >
      {available
        ? t("settings:transcode.capabilities.available")
        : t("settings:transcode.capabilities.unavailable")}
    </span>
  );
}

function Row({ enc, current }: { enc: EncoderCapability; current: string }) {
  const { t } = useTranslation();
  const localizedReason = enc.reasonCode
    ? t(`settings:transcode.capabilities.reasons.${enc.reasonCode}`)
    : null;
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <span className="text-sm text-[var(--text)]">
          {t(`settings:transcode.encoders.${enc.key}`)}
        </span>
        {enc.key === current && (
          <span className="ml-2 text-xs text-[var(--text-dim)]">
            ({t("settings:transcode.capabilities.current")})
          </span>
        )}
        {!enc.available && localizedReason && (
          <p className="mt-0.5 text-xs text-[var(--text-dim)]">
            {localizedReason}
            {enc.reason ? ` — ${enc.reason}` : ""}
          </p>
        )}
      </div>
      <Badge available={enc.available} />
    </div>
  );
}

export default function EncoderCapabilityList({
  report,
  current,
}: {
  report: CapabilityReport;
  current: string;
}) {
  const { t } = useTranslation();
  const toolsOk = report.ffmpeg.present && report.ffprobe.present;
  return (
    <div className="mt-3 rounded border border-[var(--border,#333)] p-3">
      <div className="divide-y divide-[var(--border,#333)]">
        {report.encoders.map((enc) => (
          <Row key={enc.key} enc={enc} current={current} />
        ))}
      </div>
      <p className="mt-3 text-xs text-[var(--text-dim)]">
        {toolsOk
          ? t("settings:transcode.capabilities.toolsFound", {
              ffmpeg: report.ffmpeg.version ?? "?",
              ffprobe: report.ffprobe.version ?? "?",
            })
          : t("settings:transcode.capabilities.toolsMissing")}
      </p>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @orbix/web exec vitest run src/components/settings/EncoderCapabilityList.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/locales/en/settings.json apps/web/src/components/settings/EncoderCapabilityList.tsx apps/web/src/components/settings/EncoderCapabilityList.test.tsx
git commit -m "feat(web): EncoderCapabilityList results component + en strings"
```

---

### Task 6: Web — wire the button into `AdminSettingsPage`

**Files:**
- Modify: `apps/web/src/pages/AdminSettingsPage.tsx`

**Interfaces:**
- Consumes: `EncoderCapabilityList` (Task 5); `CapabilityReport` type from `@orbix/core`; `apiFetch` from `@/lib/api`.
- Produces: no new exports (page-internal state + handler + render).

- [ ] **Step 1: Add the type import and component import**

In `apps/web/src/pages/AdminSettingsPage.tsx`, update the imports at the top. After line 6 (`import { errorMessage } from "@/lib/i18n/tError";`) add:

```typescript
import type { CapabilityReport } from "@orbix/core";
import EncoderCapabilityList from "@/components/settings/EncoderCapabilityList";
```

- [ ] **Step 2: Add component state**

In `apps/web/src/pages/AdminSettingsPage.tsx`, after line 41 (`const [rebuildMsg, setRebuildMsg] = useState<string | null>(null);`) add:

```typescript
  // Encoder capability test (independent of the settings form)
  const [testing, setTesting] = useState(false);
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
```

- [ ] **Step 3: Add the handler**

In `apps/web/src/pages/AdminSettingsPage.tsx`, after the `handleRebuild` function (ends at line 130 with its closing `}`), add:

```typescript
  async function handleTestEncoders() {
    setTesting(true);
    setTestError(null);
    try {
      const res = await apiFetch("/transcode/test", { method: "POST" });
      if (!res.ok) {
        setTestError(t("settings:transcode.capabilities.error"));
        return;
      }
      setCapabilities((await res.json()) as CapabilityReport);
    } catch {
      setTestError(t("errors:network"));
    } finally {
      setTesting(false);
    }
  }
```

- [ ] **Step 4: Render the button + results inside the Transcode Card**

In `apps/web/src/pages/AdminSettingsPage.tsx`, inside the Transcode `<Card>`, after the closing `</div>` of the encoder `<select>` block and before the card's closing `</Card>` (the `</Card>` currently at line 246), add:

```tsx
          <div className="mt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={handleTestEncoders}
              disabled={testing}
            >
              {testing
                ? t("settings:transcode.capabilities.testing")
                : t("settings:transcode.capabilities.testButton")}
            </Button>
            {testError && <p className="mt-2 text-sm text-red-400">{testError}</p>}
            {capabilities && (
              <EncoderCapabilityList report={capabilities} current={encoder} />
            )}
          </div>
```

- [ ] **Step 5: Typecheck web and verify build**

Run: `pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web build`
Expected: no type errors; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/AdminSettingsPage.tsx
git commit -m "feat(web): Test encoders button in Transcoding settings"
```

---

### Task 7: Web — translations for es / de / pt / ru / fr

**Files:**
- Modify: `apps/web/src/locales/es/settings.json`
- Modify: `apps/web/src/locales/de/settings.json`
- Modify: `apps/web/src/locales/pt/settings.json`
- Modify: `apps/web/src/locales/ru/settings.json`
- Modify: `apps/web/src/locales/fr/settings.json`
- Test: `apps/web/src/locales/parity.test.ts` (existing — must pass)

**Interfaces:** none (JSON only). The `transcode.capabilities` key set must exactly match `en`.

- [ ] **Step 1: Add the `capabilities` block to each locale**

In each file, add a `capabilities` child inside the existing `transcode` object (immediately after that object's `encoders` block, mirroring the en structure). Use these translations:

**es** (`apps/web/src/locales/es/settings.json`):

```json
    "capabilities": {
      "testButton": "Probar codificadores",
      "testing": "Probando…",
      "available": "Disponible",
      "unavailable": "No disponible",
      "current": "actual",
      "toolsFound": "ffmpeg {{ffmpeg}} · ffprobe {{ffprobe}} · encontrados en PATH",
      "toolsMissing": "No se encontró ffmpeg o ffprobe en el PATH del servidor.",
      "error": "No se pudo ejecutar la prueba de codificadores.",
      "reasons": {
        "not_built_in": "No está compilado en ffmpeg en este servidor",
        "test_failed": "La prueba de codificación falló",
        "ffmpeg_not_found": "No se encontró ffmpeg"
      }
    }
```

**de** (`apps/web/src/locales/de/settings.json`):

```json
    "capabilities": {
      "testButton": "Encoder testen",
      "testing": "Test läuft…",
      "available": "Verfügbar",
      "unavailable": "Nicht verfügbar",
      "current": "aktuell",
      "toolsFound": "ffmpeg {{ffmpeg}} · ffprobe {{ffprobe}} · im PATH gefunden",
      "toolsMissing": "ffmpeg oder ffprobe wurde im PATH des Servers nicht gefunden.",
      "error": "Der Encoder-Test konnte nicht ausgeführt werden.",
      "reasons": {
        "not_built_in": "Auf diesem Server nicht in ffmpeg einkompiliert",
        "test_failed": "Test-Encoding fehlgeschlagen",
        "ffmpeg_not_found": "ffmpeg nicht gefunden"
      }
    }
```

**pt** (`apps/web/src/locales/pt/settings.json`):

```json
    "capabilities": {
      "testButton": "Testar codificadores",
      "testing": "Testando…",
      "available": "Disponível",
      "unavailable": "Indisponível",
      "current": "atual",
      "toolsFound": "ffmpeg {{ffmpeg}} · ffprobe {{ffprobe}} · encontrados no PATH",
      "toolsMissing": "ffmpeg ou ffprobe não foi encontrado no PATH do servidor.",
      "error": "Não foi possível executar o teste de codificadores.",
      "reasons": {
        "not_built_in": "Não compilado no ffmpeg neste servidor",
        "test_failed": "Falha no teste de codificação",
        "ffmpeg_not_found": "ffmpeg não encontrado"
      }
    }
```

**ru** (`apps/web/src/locales/ru/settings.json`):

```json
    "capabilities": {
      "testButton": "Проверить кодировщики",
      "testing": "Проверка…",
      "available": "Доступен",
      "unavailable": "Недоступен",
      "current": "текущий",
      "toolsFound": "ffmpeg {{ffmpeg}} · ffprobe {{ffprobe}} · найдены в PATH",
      "toolsMissing": "ffmpeg или ffprobe не найдены в PATH сервера.",
      "error": "Не удалось выполнить проверку кодировщиков.",
      "reasons": {
        "not_built_in": "Не включён в сборку ffmpeg на этом сервере",
        "test_failed": "Тестовое кодирование не удалось",
        "ffmpeg_not_found": "ffmpeg не найден"
      }
    }
```

**fr** (`apps/web/src/locales/fr/settings.json`):

```json
    "capabilities": {
      "testButton": "Tester les encodeurs",
      "testing": "Test en cours…",
      "available": "Disponible",
      "unavailable": "Indisponible",
      "current": "actuel",
      "toolsFound": "ffmpeg {{ffmpeg}} · ffprobe {{ffprobe}} · trouvés dans le PATH",
      "toolsMissing": "ffmpeg ou ffprobe est introuvable dans le PATH du serveur.",
      "error": "Impossible d'exécuter le test des encodeurs.",
      "reasons": {
        "not_built_in": "Non compilé dans ffmpeg sur ce serveur",
        "test_failed": "Échec de l'encodage de test",
        "ffmpeg_not_found": "ffmpeg introuvable"
      }
    }
```

> Note: in each file the `transcode.encoders` object needs a trailing comma after its closing `}` so the new `capabilities` sibling is valid JSON. Verify each file parses.

- [ ] **Step 2: Run the parity test to verify it passes**

Run: `pnpm --filter @orbix/web exec vitest run src/locales/parity.test.ts`
Expected: PASS — every locale's `settings` namespace covers exactly the en key set.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/locales/es/settings.json apps/web/src/locales/de/settings.json apps/web/src/locales/pt/settings.json apps/web/src/locales/ru/settings.json apps/web/src/locales/fr/settings.json
git commit -m "i18n: translate transcode capability test strings (es/de/pt/ru/fr)"
```

---

### Task 8: Full gates + manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all pass. If `pnpm lint` flags anything (e.g. `no-useless-escape` in the regex), fix it and re-run before proceeding.

- [ ] **Step 2: Manual smoke (optional but recommended)**

With the stack up (`docker compose up -d`) and signed in as the admin, open Settings → Transcoding, click **Test encoders**, and confirm: the button shows "Testing…", then a results list renders with a badge per encoder, the saved encoder is marked `(current)`, and the ffmpeg/ffprobe footer appears. On a machine with no GPU, `software` should be Available and the hardware encoders Unavailable with a reason.

> Per CLAUDE.md: after any host-side smoke, reap dev servers — `pkill -f "tsx.*watch src/server.ts"; pkill -f vite` — and free ports 1060/1061.

- [ ] **Step 3: Final commit (only if Step 1 required fixes)**

```bash
git add -A
git commit -m "chore: satisfy lint/typecheck for transcode capability test"
```

---

## Self-Review

**Spec coverage:**
- Layered detection (list → test-encode) → Task 1 (`buildEncoderTestArgs`, `parseEncoderList`) + Task 2 (`detectCapabilities`). ✓
- Results list under the dropdown, badges + reasons + `(current)` + ffmpeg/ffprobe footer → Task 5 (component) + Task 6 (wiring). ✓
- Ephemeral, no persistence, no save-blocking → no schema/settings changes anywhere; results live in React state (Task 6). ✓
- Pure core / api-adapter split → Task 1–2 pure (no `child_process`); Task 3 supplies real `execFile` adapters. ✓
- Per-encoder recipes (vaapi device + hwupload, qsv hwupload, nvenc internal upload) → Task 1 `buildEncoderTestArgs` + tests. ✓
- Admin/kids guard, `/api` prefix, POST → Task 4. ✓
- Timeout + kill, sequential tests, stderr-tail reason → Task 3 (`realExec` timeout, `tailReason`, core awaits sequentially). ✓
- i18n across 6 locales + parity → Task 5 (en) + Task 7 (5 locales) + parity test. ✓
- Gates incl. `pnpm lint` → Task 8. ✓

**Deviation from spec (intentional, noted):** VAAPI device comes from `process.env.VAAPI_DEVICE` (default `/dev/dri/renderD128`) read in the api adapter, NOT added to the validated boot `Env`. This keeps the change self-contained and avoids editing 11 unrelated test files that construct a literal `Env`. The route is a plain Fastify plugin (like `settingsRoute`), not an `env`-factory, since it needs no `Env`.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every command has an expected result. ✓

**Type consistency:** `CapabilityReport` / `EncoderCapability` / `ReasonCode` defined in Task 2 are consumed unchanged in Tasks 3 (`@orbix/core` import), 5, 6. `ExecOutcome` / `ExecFileImpl` / `scanTranscodeCapabilities` defined in Task 3 are consumed in Task 4. `buildEncoderTestArgs(encoder, { vaapiDevice })` signature identical across Tasks 1 and 3. Reason codes (`ffmpeg_not_found`, `not_built_in`, `test_failed`) match between core (Task 2), adapter (Task 3), and i18n keys (Tasks 5 & 7). ✓
