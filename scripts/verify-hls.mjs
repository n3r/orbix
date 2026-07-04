#!/usr/bin/env node
// scripts/verify-hls.mjs — HLS conformance verifier (SP1c definition-of-done gate).
//
// Negotiates a playback session via POST /api/playback/info, fetches the
// resulting master + media playlists, asserts the Apple-HLS tags Orbix's
// fMP4/CMAF output must carry, downloads every segment, and ffprobes each
// one's REAL duration against its declared EXTINF — the playlist can *say*
// anything, only decoding the bytes proves it's true.
//
// fMP4 mechanics: a standalone .m4s segment has no moov box, so ffprobe
// can't open it alone — each segment's bytes are prepended with the init
// segment (moov) bytes before probing (see the per-segment loop below).
//
// Usage:
//   node scripts/verify-hls.mjs <baseUrl> <fileId> <cookie:VALUE|token:VALUE> [--caps apple]
//
// Exit 0 = conformant (or a direct-play decision, nothing to verify).
// Exit 1 = any tag assertion or duration comparison failed.
//
// Note: termination always goes through `process.exitCode` + a natural
// return/throw, never a bare `process.exit()` — that call skips pending
// `finally` blocks (our temp-dir cleanup) and can truncate buffered stdout
// when piped. `ReportedError` marks a failure already printed so the outer
// catch doesn't double-print it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Mirrors WEB_CAPABILITIES in apps/web/src/components/Player.tsx verbatim.
const WEB_CAPS = {
  containers: ["mp4"],
  videoCodecs: ["h264"],
  audioCodecs: ["aac"],
  maxAudioChannels: 2,
  hlsMultichannelAacBroken: true,
};

// Apple-grade profile (AVPlayer-class client): broader codec support, no
// HLS/MSE multichannel-AAC quirk (that's a browser/MSE-specific bug).
const APPLE_CAPS = {
  containers: ["mp4"],
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac", "ac3", "eac3", "flac"],
  maxAudioChannels: 6,
};

const SEGMENT_TOLERANCE_SEC = 0.5;
const TOTAL_TOLERANCE_SEC = 1.0;
// Segment downloads run in bounded batches, not one unbounded Promise.all:
// a full-length asset can have hundreds of segments, and holding all of
// their bytes in memory (or opening that many sockets) at once would be
// unreasonable. A modest batch size still keeps the whole download pass
// close to one tight burst per batch.
const DOWNLOAD_CONCURRENCY = 8;

/** Marks an error whose message was already printed, so the outer catch stays silent. */
class ReportedError extends Error {}

function parseArgs(argv) {
  const args = [...argv];

  let capsName = "web";
  const capsIdx = args.indexOf("--caps");
  if (capsIdx !== -1) {
    capsName = args[capsIdx + 1];
    args.splice(capsIdx, 2);
  }
  if (capsName !== "web" && capsName !== "apple") {
    console.error(`FATAL: --caps must be "apple" (or omitted for the default web profile), got: ${capsName}`);
    throw new ReportedError("bad --caps");
  }

  const [baseUrl, fileId, credential] = args;
  if (!baseUrl || !fileId || !credential) {
    console.error("FATAL: usage: node scripts/verify-hls.mjs <baseUrl> <fileId> <cookie:VALUE|token:VALUE> [--caps apple]");
    throw new ReportedError("bad usage");
  }

  const m = /^(cookie|token):(.+)$/.exec(credential);
  if (!m) {
    console.error(`FATAL: credential must be "cookie:<value>" or "token:<value>", got: ${credential}`);
    throw new ReportedError("bad credential");
  }
  const [, credKind, credValue] = m;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    fileId,
    credKind,
    credValue,
    capsName,
    capabilities: capsName === "apple" ? APPLE_CAPS : WEB_CAPS,
  };
}

/** Auth header(s) for the /api/playback/info negotiation POST. */
function negotiationHeaders(cred) {
  return cred.credKind === "cookie"
    ? { Cookie: `orbix_session=${cred.credValue}` }
    : { Authorization: `Bearer ${cred.credValue}` };
}

/**
 * Headers for every follow-up GET (master/media playlist, init, segments).
 * Cookie clients have no cookie jar in this script, so the Cookie header is
 * attached by hand on every request. Token clients instead rely on the
 * `?token=` query param carried in streamUrl and every child playlist URI
 * (see ensureTokenParam below) — this mirrors a real native player, which
 * cannot send custom headers at all.
 */
function followHeaders(cred) {
  return cred.credKind === "cookie" ? { Cookie: `orbix_session=${cred.credValue}` } : {};
}

/** Appends `&token=` to streamUrl for token credentials, unless already embedded by the server. */
function ensureTokenParam(streamUrl, cred) {
  if (cred.credKind !== "token") return streamUrl;
  if (/[?&]token=/.test(streamUrl)) return streamUrl;
  const sep = streamUrl.includes("?") ? "&" : "?";
  return `${streamUrl}${sep}token=${encodeURIComponent(cred.credValue)}`;
}

async function main() {
  const cred = parseArgs(process.argv.slice(2));
  console.log(`verify-hls: baseUrl=${cred.baseUrl} fileId=${cred.fileId} caps=${cred.capsName} auth=${cred.credKind}`);

  const failures = [];
  const warnings = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };
  const warn = (msg) => { warnings.push(msg); console.warn(`WARN: ${msg}`); };
  // Structural blockers (can't locate/reach the next thing to fetch): print
  // whatever tag failures are already collected alongside the blocker, then
  // throw (never process.exit — a throw unwinds through any open `finally`,
  // e.g. the temp-dir cleanup below, before the process actually exits).
  const abort = (msg) => {
    console.error(`FAIL:\n - ${[msg, ...failures].join("\n - ")}`);
    process.exitCode = 1;
    throw new ReportedError(msg);
  };

  // ── Negotiate ──────────────────────────────────────────────────────────
  const infoRes = await fetch(`${cred.baseUrl}/api/playback/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...negotiationHeaders(cred) },
    body: JSON.stringify({ fileId: cred.fileId, capabilities: cred.capabilities }),
  });
  if (infoRes.status !== 200) abort(`POST /api/playback/info -> ${infoRes.status}: ${await infoRes.text()}`);
  const info = await infoRes.json();
  console.log(`negotiated: mode=${info.mode} streamUrl=${info.streamUrl}`);

  if (info.mode === "direct") {
    console.log("direct-play decision — nothing to verify");
    return;
  }

  const masterUrl = new URL(ensureTokenParam(info.streamUrl, cred), `${cred.baseUrl}/`).toString();

  // ── Master (multivariant) playlist ────────────────────────────────────
  const masterRes = await fetch(masterUrl, { headers: followHeaders(cred) });
  if (masterRes.status !== 200) abort(`GET master playlist -> ${masterRes.status} (${masterUrl})`);
  const masterLines = (await masterRes.text()).split("\n").map((l) => l.trimEnd());

  check(masterLines[0] === "#EXTM3U", "master: first line must be #EXTM3U");
  check(masterLines.some((l) => l.startsWith("#EXT-X-VERSION:")), "master: missing #EXT-X-VERSION");
  check(masterLines.some((l) => l === "#EXT-X-INDEPENDENT-SEGMENTS"), "master: missing #EXT-X-INDEPENDENT-SEGMENTS");

  const streamInfLines = masterLines.filter((l) => l.startsWith("#EXT-X-STREAM-INF:"));
  check(streamInfLines.length === 1, `master: expected exactly one #EXT-X-STREAM-INF, found ${streamInfLines.length}`);
  const streamInf = streamInfLines[0] ?? "";
  check(/(?<!AVERAGE-)BANDWIDTH=\d+/.test(streamInf), "master: #EXT-X-STREAM-INF missing BANDWIDTH=");
  check(/AVERAGE-BANDWIDTH=\d+/.test(streamInf), "master: #EXT-X-STREAM-INF missing AVERAGE-BANDWIDTH=");
  if (!/CODECS="/.test(streamInf)) warn("master: #EXT-X-STREAM-INF missing CODECS= (non-fatal)");

  // The media playlist URI is the first non-comment line after EXT-X-STREAM-INF.
  const streamInfIdx = masterLines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF:"));
  const mediaUriLine = streamInfIdx !== -1 ? masterLines[streamInfIdx + 1] : undefined;
  if (!mediaUriLine || mediaUriLine.startsWith("#")) abort("master: no media playlist URI found after #EXT-X-STREAM-INF");

  // ── Media (index) playlist ─────────────────────────────────────────────
  const indexUrl = new URL(mediaUriLine, masterUrl).toString();
  const indexRes = await fetch(indexUrl, { headers: followHeaders(cred) });
  if (indexRes.status !== 200) abort(`GET media playlist -> ${indexRes.status} (${indexUrl})`);
  const indexLines = (await indexRes.text()).split("\n").map((l) => l.trimEnd());

  check(indexLines[0] === "#EXTM3U", "media: first line must be #EXTM3U");
  check(indexLines.some((l) => l.startsWith("#EXT-X-VERSION:")), "media: missing #EXT-X-VERSION");
  check(indexLines.some((l) => l === "#EXT-X-PLAYLIST-TYPE:VOD"), "media: missing #EXT-X-PLAYLIST-TYPE:VOD");
  check(indexLines.some((l) => l === "#EXT-X-ENDLIST"), "media: missing #EXT-X-ENDLIST");

  const targetLine = indexLines.find((l) => l.startsWith("#EXT-X-TARGETDURATION:"));
  check(!!targetLine, "media: missing #EXT-X-TARGETDURATION");
  const targetDuration = targetLine ? Number(targetLine.slice("#EXT-X-TARGETDURATION:".length)) : NaN;

  const mapLine = indexLines.find((l) => l.startsWith("#EXT-X-MAP:"));
  check(!!mapLine, "media: missing #EXT-X-MAP");
  const mapUriMatch = /URI="([^"]+)"/.exec(mapLine ?? "");
  if (!mapLine || !mapUriMatch) abort("media: #EXT-X-MAP has no URI attribute — cannot locate init segment");

  // ── Parse EXTINF / segment URI pairs ───────────────────────────────────
  const segments = [];
  for (let i = 0; i < indexLines.length; i++) {
    const line = indexLines[i];
    if (line.startsWith("#EXTINF:")) {
      const declared = Number(line.slice("#EXTINF:".length).split(",")[0]);
      const uri = indexLines[i + 1];
      if (uri && !uri.startsWith("#")) segments.push({ declared, uri });
    }
  }
  if (segments.length === 0) abort("media: no EXTINF/segment URI pairs found");

  const maxExtinf = Math.max(...segments.map((s) => s.declared));
  check(
    Number.isFinite(targetDuration) && targetDuration >= Math.ceil(maxExtinf),
    `media: TARGETDURATION (${targetDuration}) must be >= ceil(max EXTINF) (${Math.ceil(maxExtinf)})`,
  );

  // ── Download init + every segment, THEN ffprobe the concatenated bytes ──
  // Segment downloads all fire concurrently (no ordering dependency between
  // independently-checked segments) so the whole download pass lands in one
  // tight burst rather than serialized behind each one's own network
  // round-trip — and ffprobe (a subprocess spawn per segment) never runs
  // interleaved with a pending fetch.
  const initUrl = new URL(mapUriMatch[1], indexUrl).toString();
  const tmpDir = await mkdtemp(path.join(tmpdir(), "verify-hls-"));
  const table = [];

  try {
    const initRes = await fetch(initUrl, { headers: followHeaders(cred) });
    if (initRes.status !== 200) abort(`GET init segment -> ${initRes.status} (${initUrl})`);
    const initBytes = Buffer.from(await initRes.arrayBuffer());

    const probePaths = [];
    for (let start = 0; start < segments.length; start += DOWNLOAD_CONCURRENCY) {
      const batch = segments.slice(start, start + DOWNLOAD_CONCURRENCY);
      const batchPaths = await Promise.all(
        batch.map(async ({ uri }, j) => {
          const i = start + j;
          const segUrl = new URL(uri, indexUrl).toString();
          const segRes = await fetch(segUrl, { headers: followHeaders(cred) });
          if (segRes.status !== 200) abort(`GET segment ${i} -> ${segRes.status} (${segUrl})`);
          const segBytes = Buffer.from(await segRes.arrayBuffer());

          // Standalone .m4s has no moov box — prepend the init segment so ffprobe can open it.
          const probePath = path.join(tmpDir, `probe${i}.mp4`);
          await writeFile(probePath, Buffer.concat([initBytes, segBytes]));
          return probePath;
        }),
      );
      probePaths.push(...batchPaths);
    }

    let declaredSum = 0;
    let realSum = 0;

    for (let i = 0; i < segments.length; i++) {
      const { declared } = segments[i];
      let real = NaN;
      try {
        // fMP4 fragments carry ABSOLUTE tfdt-based timestamps (not zero-based
        // per fragment), so on a truncated [init, fragment N] file ffprobe's
        // format=duration reports the cumulative end time since stream start
        // (e.g. ~12s for segment 1 of a 6s-cadence stream), not this
        // fragment's own ~6s span. format=start_time correctly reports the
        // fragment's absolute start, so the real per-segment span is their
        // difference — confirmed empirically against a real ffmpeg fmp4-hls
        // remux (see task-9-report.md for the concatenated-probe walkthrough).
        const { stdout } = await execFileAsync("ffprobe", [
          "-v", "error",
          "-show_entries", "format=start_time,duration",
          "-of", "csv=p=0",
          probePaths[i],
        ]);
        const [startTime, duration] = stdout.trim().split(",").map(Number);
        real = duration - startTime;
      } catch (err) {
        failures.push(`segment ${i}: ffprobe failed — ${err.message}`);
      }

      const delta = real - declared;
      const pass = Number.isFinite(real) && Math.abs(delta) <= SEGMENT_TOLERANCE_SEC;
      if (!pass) {
        failures.push(
          `segment ${i}: declared=${declared.toFixed(3)}s real=${Number.isFinite(real) ? real.toFixed(3) : "N/A"}s ` +
          `delta=${Number.isFinite(delta) ? delta.toFixed(3) : "N/A"}s (tolerance ${SEGMENT_TOLERANCE_SEC}s)`,
        );
      }
      table.push({ index: i, declared, real, delta, pass });

      declaredSum += declared;
      if (Number.isFinite(real)) realSum += real;
    }

    const totalDelta = Math.abs(realSum - declaredSum);
    check(
      totalDelta <= TOTAL_TOLERANCE_SEC,
      `total duration drift ${totalDelta.toFixed(3)}s exceeds ${TOTAL_TOLERANCE_SEC}s (declared sum=${declaredSum.toFixed(3)}s, real sum=${realSum.toFixed(3)}s)`,
    );

    // ── Report ─────────────────────────────────────────────────────────
    console.log("\nPer-segment duration check:");
    console.log("idx | declared  | real      | delta    | result");
    console.log("----|-----------|-----------|----------|-------");
    for (const row of table) {
      const realStr = Number.isFinite(row.real) ? row.real.toFixed(3) : "N/A";
      const deltaStr = Number.isFinite(row.delta) ? `${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(3)}` : "N/A";
      console.log(
        `${String(row.index).padStart(3)} | ${row.declared.toFixed(3).padStart(9)} | ${realStr.padStart(9)} | ${deltaStr.padStart(8)} | ${row.pass ? "PASS" : "FAIL"}`,
      );
    }
    console.log(`\ndeclared total=${declaredSum.toFixed(3)}s  real total=${realSum.toFixed(3)}s  drift=${totalDelta.toFixed(3)}s`);

    if (warnings.length > 0) {
      console.log("\nWarnings:");
      for (const w of warnings) console.log(` - ${w}`);
    }

    if (failures.length > 0) {
      console.error("\nFAIL:");
      for (const f of failures) console.error(` - ${f}`);
      process.exitCode = 1;
    } else {
      console.log("\nALL PASS");
    }
  } finally {
    // Always runs — even when a check above threw — because this is a real
    // `throw`/unwind, not a process.exit() (see the ReportedError note up top).
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  if (!(err instanceof ReportedError)) console.error("FATAL:", err?.stack ?? err);
  process.exitCode = 1;
});
