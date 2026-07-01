# Transcode Capability Test — Design

**Date:** 2026-07-01
**Status:** Approved, ready for planning

## Problem

System Settings → **Transcoding** offers four encoder choices (`software` /
`vaapi` / `qsv` / `nvenc`), but an admin has no way to know which of them will
actually work on their server. A hardware encoder can be compiled into ffmpeg
yet fail at runtime because the GPU, driver, or render device is missing. Today
the only way to find out is to save a setting and try to play a title that
triggers a transcode.

**Goal:** add a "Test encoders" action to the Transcoding card that scans the
server and highlights which encoder options are genuinely available.

## Approach

**Layered detection:** first parse `ffmpeg -encoders` to see what is compiled
in, then run a real, tiny **test-encode** for each encoder that is present.
An encoder is reported *available* only if it is both listed **and** its
test-encode exits 0. This avoids the common false-positive where e.g.
`h264_nvenc` is listed even with no NVIDIA GPU present.

Detection is best-effort and advisory: it does not gate what the admin may
save.

## UX

Location: the **Transcoding** `<Card>` in
`apps/web/src/pages/AdminSettingsPage.tsx`, directly below the existing encoder
`<select>`.

- A **"Test encoders"** button (styled like the existing Maintenance `ghost`
  button). While a scan is in flight the button is disabled and shows a
  "Testing…" label.
- On completion, a results list renders one row per encoder (all four, in the
  same order as the dropdown). Each row shows:
  - the encoder's human label (reuse `settings:transcode.encoders.<key>`),
  - a colored status badge — **Available** (green) / **Unavailable**
    (dim/red),
  - a short reason string on failure,
  - a `(current)` marker on the row matching the currently-saved encoder.
- A footer line reports ffmpeg/ffprobe presence and version
  (e.g. "ffmpeg 6.1 · ffprobe 6.1 · found on PATH", or a "not found" warning).
- On request error, show an inline error message (reuse the page's existing
  error styling).

Results live in React component state only. They are **ephemeral** — re-run on
demand, not persisted, gone on reload.

### Non-goals

- **No persistence** of scan results (no `Setting` row, no schema change).
- **No save-blocking / no gating.** Saving an encoder that tested as
  unavailable is still allowed — a server may gain a GPU later, and the test is
  advisory. The results list makes the tradeoff obvious; that is sufficient.
- No auto-scan on page load. The scan runs only when the admin clicks the
  button (it spawns ffmpeg processes and should be deliberate).
- No per-encoder tuning knobs in the UI.

## Architecture

Respects the repo's core/api split (`CLAUDE.md`): all pure logic — parsing,
per-encoder arg construction, result assembly — lives in `packages/core` with
injected adapters; `apps/api` supplies the real ffmpeg-spawning adapters.

### Core — `packages/core/src/playback/capabilities.ts` (new)

Pure, framework-agnostic, no `child_process`/network/fs imports.

- **`parseEncoderList(raw: string): Set<string>`** — parse `ffmpeg -encoders`
  stdout and return the set of codec names present (the encoder table lists
  each codec name in the second column after a flags column; parse those
  tokens). Reuse the existing `EncoderSetting` type / `ENCODER_MAP` from
  `ffargs.ts` to know which codec name maps to which setting key.

- **`buildEncoderTestArgs(encoder: EncoderSetting, opts?: { vaapiDevice?: string }): string[]`**
  — return the ffmpeg argument array for a tiny test-encode of that encoder.
  The generated input is a `lavfi testsrc` a fraction of a second long, muxed
  to the `null` output so nothing is written to disk. **Per-encoder recipe**
  (correctness crux — a naive `-c:v <hwcodec>` gives false negatives for
  VAAPI/QSV because the frames must be uploaded to the GPU first):
  - `libx264`:
    `-f lavfi -i testsrc=duration=0.1:size=320x240:rate=25 -frames:v 3 -c:v libx264 -preset ultrafast -f null -`
  - `h264_nvenc`: same input, `-c:v h264_nvenc -f null -` (NVENC accepts
    system-memory frames and uploads internally).
  - `h264_vaapi`:
    `-vaapi_device <vaapiDevice> -f lavfi -i testsrc=… -vf format=nv12,hwupload -c:v h264_vaapi -f null -`
    (fails correctly when the render node is absent/unusable).
  - `h264_qsv`:
    `-f lavfi -i testsrc=… -vf hwupload=extra_hw_frames=64,format=qsv -c:v h264_qsv -f null -`
    (best-effort; QSV upload semantics vary by ffmpeg build — documented as a
    known limitation, may produce a false negative on some builds).

- **`detectCapabilities(deps): Promise<CapabilityReport>`** — pure orchestrator.
  Injected adapters:
  - `runVersion(bin: "ffmpeg" | "ffprobe"): Promise<{ present: boolean; version?: string }>`
  - `runEncoderList(): Promise<string>` (stdout of `ffmpeg -encoders`)
  - `runEncodeTest(encoder: EncoderSetting): Promise<{ ok: boolean; reason?: string }>`

  Logic: probe ffmpeg/ffprobe versions; if ffmpeg absent → every encoder
  `available:false`, `reason:"ffmpeg not found"`, skip tests. Otherwise parse
  the encoder list; for each of the four settings, `listed = set.has(codec)`;
  if not listed → `available:false`, `reason:"encoder not built into ffmpeg"`;
  if listed → run the test-encode and set `available` from its `ok`, carrying
  the failure `reason` through.

- **Result type** (exported):
  ```ts
  interface EncoderCapability {
    key: EncoderSetting;      // "software" | "vaapi" | "qsv" | "nvenc"
    codec: string;            // "libx264" | "h264_vaapi" | ...
    listed: boolean;
    available: boolean;
    reason?: string;          // present when !available
  }
  interface CapabilityReport {
    ffmpeg:  { present: boolean; version?: string };
    ffprobe: { present: boolean; version?: string };
    encoders: EncoderCapability[];   // always all four, dropdown order
  }
  ```

### API — adapters + route

- **`apps/api/src/lib/transcode-capabilities.ts` (new)** — supplies the real
  adapters over `execFile` and wires them into `detectCapabilities`:
  - version probes: `ffmpeg -version` / `ffprobe -version`, parse the first
    line for a version token; `present:false` if the binary is missing (ENOENT).
  - encoder list: `ffmpeg -hide_banner -encoders`.
  - test-encode: run `ffmpeg` with `buildEncoderTestArgs(...)`; `ok` = exit 0;
    on failure, `reason` = trimmed tail of stderr (last ~1–2 lines / capped
    length).
  - **Hard timeout + kill** on every ffmpeg call (tests are sub-second; the
    timeout guards a hung GPU driver). Encoder tests run **sequentially** to
    avoid GPU contention / interfering with each other.
  - VAAPI device: default `/dev/dri/renderD128`, overridable via an optional
    `VAAPI_DEVICE` env var (added to the `packages/config` zod schema as an
    optional string with that default).

- **`apps/api/src/routes/transcode.ts` (new)** — a **route factory**
  (`transcodeRoute(env)`, mirroring `imagesRoute(env)`) exposing
  **`POST /api/transcode/test`**. Guards: `requireAuth(app)`,
  `requireAdmin(app)`, `requireNonKids(app)` — identical to `settings.ts`.
  Returns the `CapabilityReport` JSON. The factory accepts an optional injected
  detector (defaulting to the real `apps/api/src/lib/transcode-capabilities.ts`
  entry point) so the route is unit-testable without spawning ffmpeg.
  Registered under the `/api` prefix in `apps/api/src/app.ts` alongside the
  other feature routes.

  `POST` (not `GET`) because the scan has side effects (spawns processes) and
  must never be cached.

### Frontend — `apps/web/src/pages/AdminSettingsPage.tsx`

- Add state: `testing` (bool), `capabilities` (`CapabilityReport | null`),
  `testError` (string | null).
- Add a `handleTestEncoders` handler that POSTs to `/api/transcode/test` via
  the existing `apiJson` helper (`apps/web/src/lib/api.ts`), sets results into
  state.
- Render the button + results list beneath the encoder `<select>` inside the
  existing Transcoding `<Card>`. The `(current)` marker compares each row's
  `key` against the page's `encoder` state.

### i18n

Add a `transcode.capabilities` block to all six locale files
(`apps/web/src/locales/{en,es,de,pt,ru,fr}/settings.json`):
button label, testing state, `Available` / `Unavailable` badge text, reason
labels (not-built-in, ffmpeg-not-found, generic), `current` marker, and the
ffmpeg/ffprobe footer strings. English is authoritative; other locales
translated.

## Data flow

```
[Test encoders] click
  → POST /api/transcode/test        (admin + non-kids guard)
    → transcode-capabilities.ts (api adapters: execFile ffmpeg/ffprobe)
      → core detectCapabilities()
          runVersion(ffmpeg), runVersion(ffprobe)
          runEncoderList()  → parseEncoderList()
          for each encoder present: runEncodeTest() → buildEncoderTestArgs()
      ← CapabilityReport
  ← JSON
  → results list rendered in Transcoding card
```

## Error handling

- Missing ffmpeg/ffprobe → `present:false` + version-line warning; encoder
  tests skipped, all `available:false`.
- Test-encode non-zero exit → `available:false` with stderr-tail reason.
- Per-call timeout → treated as failure with a "timed out" reason; the child
  process is killed.
- Route-level failure → non-2xx; frontend shows an inline error message.

## Testing

- **core** `packages/core/src/playback/capabilities.test.ts` (pure, no ffmpeg):
  - `parseEncoderList` extracts codec names from representative
    `ffmpeg -encoders` output (and ignores the header/flag columns).
  - `buildEncoderTestArgs` produces the expected args per encoder, including the
    VAAPI device + `hwupload` filter and the QSV `hwupload` filter.
  - `detectCapabilities` maps injected adapter results to the correct
    `CapabilityReport` for the cases: ffmpeg absent; encoder not listed; listed
    + test passes; listed + test fails (reason carried through).
- **api** `apps/api/src/routes/transcode.test.ts`:
  - `POST /api/transcode/test` returns the report shape using an injected fake
    detector (no real ffmpeg), following the fake-injection style of
    `apps/api/src/playback/session.test.ts`.
  - Guard enforcement: unauthenticated / non-admin / kids profile are rejected
    (follow the guard-test patterns in `settings`/`auth` tests).
- **Gates:** `pnpm typecheck && pnpm lint && pnpm test` — run `pnpm lint`
  explicitly (per `CLAUDE.md`, lint-only errors hide behind Turbo's cache).

## Files touched

**New**
- `packages/core/src/playback/capabilities.ts`
- `packages/core/src/playback/capabilities.test.ts`
- `apps/api/src/lib/transcode-capabilities.ts`
- `apps/api/src/routes/transcode.ts`
- `apps/api/src/routes/transcode.test.ts`

**Modified**
- `packages/core/src/index.ts` (export the new capabilities API)
- `apps/api/src/app.ts` (register `transcodeRoute(env)` under `/api`)
- `packages/config/src/env.ts` (optional `VAAPI_DEVICE`, default
  `/dev/dri/renderD128`)
- `apps/web/src/pages/AdminSettingsPage.tsx` (button + results list)
- `apps/web/src/locales/{en,es,de,pt,ru,fr}/settings.json`
  (`transcode.capabilities` block)
