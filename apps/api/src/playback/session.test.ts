import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChildProcess } from "node:child_process";
import { SessionManager, SegmentTimeoutError } from "./session";
import { decideStrategy } from "@orbix/core";
import type { SpawnFn } from "./session";

// ---------------------------------------------------------------------------
// Fake spawn factory
// ---------------------------------------------------------------------------

interface SpawnCall {
  cmd: string;
  args: string[];
  startSegment: number;
  outDir: string;
}

interface FakeProc {
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
}

function makeFakeSpawn(writeDelayMs = 50) {
  const calls: SpawnCall[] = [];
  let lastProc: FakeProc | null = null;

  const spawn = vi.fn().mockImplementation((cmd: string, args: string[]) => {
    // Parse -start_number <N>
    const snIdx = args.indexOf("-start_number");
    const startSegment = snIdx >= 0 ? parseInt(args[snIdx + 1], 10) : 0;

    // outDir is the directory portion of the last arg (index_live.m3u8)
    const lastArg = args[args.length - 1];
    const outDir = path.dirname(lastArg);

    calls.push({ cmd, args, startSegment, outDir });

    let timer: ReturnType<typeof setTimeout> | null = null;

    const proc: FakeProc = {
      kill: vi.fn().mockImplementation(() => {
        proc.killed = true;
        // Cancel the pending write so it doesn't fire after the dir is cleaned up.
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }),
      killed: false,
      on: vi.fn(),
      once: vi.fn(),
    };
    lastProc = proc;

    // Asynchronously write init.mp4 + seg<startSegment>.m4s, simulating ffmpeg output.
    // Writes are skipped if the proc was killed before the timer fires.
    timer = setTimeout(() => {
      timer = null;
      if (proc.killed) return;
      void fsp
        .writeFile(path.join(outDir, "init.mp4"), Buffer.from("init-placeholder"))
        .then(() => {
          if (proc.killed) return;
          return fsp.writeFile(
            path.join(outDir, `seg${startSegment}.m4s`),
            Buffer.from(`segment-${startSegment}-placeholder`),
          );
        });
    }, writeDelayMs);

    return proc as unknown as ChildProcess;
  }) as unknown as SpawnFn;

  return {
    spawn,
    calls,
    getLastProc: () => lastProc,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fsp.mkdtemp(path.join(os.tmpdir(), "orbix-sesman-"));
  });

  afterEach(async () => {
    await fsp.rm(testDir, { recursive: true, force: true });
  });

  it("playlist() returns a VOD playlist string and does NOT spawn ffmpeg", async () => {
    const { spawn, calls } = makeFakeSpawn();
    const manager = new SessionManager({ transcodeDir: testDir, spawn });

    const plan = decideStrategy({ container: "mkv", videoCodec: "hevc", audioCodecs: ["aac"] });
    const session = await manager.getOrCreate("file1:default", {
      inputPath: "/fake/video.mkv",
      plan,
      durationSec: 120,
      segSec: 6,
    });

    const pl = manager.playlist(session);

    expect(pl).toContain("#EXTM3U");
    expect(pl).toContain("#EXT-X-ENDLIST");
    expect(pl).toContain("seg0.m4s");
    expect(calls).toHaveLength(0); // no ffmpeg

    await manager.closeAll();
  });

  it("ensureSegment(0) spawns ffmpeg with start_number=0 and resolves to seg0 path", async () => {
    const { spawn, calls } = makeFakeSpawn();
    const manager = new SessionManager({ transcodeDir: testDir, spawn });

    const plan = decideStrategy({ container: "mkv", videoCodec: "hevc", audioCodecs: ["aac"] });
    const session = await manager.getOrCreate("file2:default", {
      inputPath: "/fake/video.mkv",
      plan,
      durationSec: 120,
      segSec: 6,
    });

    const segPath = await manager.ensureSegment(session, 0);

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("ffmpeg");
    expect(calls[0].startSegment).toBe(0);
    expect(segPath).toBe(path.join(session.dir, "seg0.m4s"));

    // File should physically exist
    const stat = await fsp.stat(segPath);
    expect(stat.size).toBeGreaterThan(0);

    await manager.closeAll();
  });

  it("ensureSegment(200) triggers kill+restart with start_number=200 (far-ahead seek)", async () => {
    const { spawn, calls } = makeFakeSpawn();
    const manager = new SessionManager({ transcodeDir: testDir, spawn });

    const plan = decideStrategy({
      container: "mkv",
      videoCodec: "hevc",
      audioCodecs: ["aac"],
    });
    const session = await manager.getOrCreate("file3:default", {
      inputPath: "/fake/video.mkv",
      plan,
      durationSec: 7200, // long enough to have seg 200
      segSec: 6,
    });

    // Start at seg 0
    await manager.ensureSegment(session, 0);
    expect(calls).toHaveLength(1);
    const firstProc = session.proc;

    // Seek far ahead — n(200) > currentStart(0) + AHEAD_WINDOW(100), file absent
    const segPath = await manager.ensureSegment(session, 200);

    expect(firstProc?.kill).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].startSegment).toBe(200);
    expect(segPath).toBe(path.join(session.dir, "seg200.m4s"));

    const stat = await fsp.stat(segPath);
    expect(stat.size).toBeGreaterThan(0);

    await manager.closeAll();
  });

  it("ensureSegment(0) after seek-to-200 triggers restart at 0 (backward seek)", async () => {
    const { spawn, calls } = makeFakeSpawn();
    const manager = new SessionManager({ transcodeDir: testDir, spawn });

    const plan = decideStrategy({
      container: "mkv",
      videoCodec: "hevc",
      audioCodecs: ["aac"],
    });
    const session = await manager.getOrCreate("file4:default", {
      inputPath: "/fake/video.mkv",
      plan,
      durationSec: 7200,
      segSec: 6,
    });

    await manager.ensureSegment(session, 0);   // spawn #1
    await manager.ensureSegment(session, 200); // spawn #2 (far-ahead seek)
    const procAt200 = session.proc;

    // Backward seek: n(0) < currentStart(200)
    await manager.ensureSegment(session, 0);   // spawn #3

    expect(procAt200?.kill).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    expect(calls[2].startSegment).toBe(0);

    await manager.closeAll();
  });

  it("SegmentTimeoutError class has the right name and message shape", () => {
    const err = new SegmentTimeoutError("seg99.m4s");
    expect(err.name).toBe("SegmentTimeoutError");
    expect(err.message).toContain("seg99.m4s");
  });

  it("ensureSegment rejects with SegmentTimeoutError AND kills proc when ffmpeg never writes", async () => {
    // Spawn that never writes any files — simulates a hung ffmpeg.
    const killFn = vi.fn().mockImplementation(function (this: { killed: boolean }) {
      this.killed = true;
    });
    const noopProc = {
      kill: killFn,
      killed: false,
      on: vi.fn(),
      once: vi.fn(),
    };
    const noopSpawn = vi.fn().mockImplementation(() => noopProc) as unknown as SpawnFn;

    // Use a very short timeoutMs so the test doesn't wait 30s.
    const manager = new SessionManager({ transcodeDir: testDir, spawn: noopSpawn, timeoutMs: 200 });

    const plan = decideStrategy({ container: "mkv", videoCodec: "hevc", audioCodecs: ["aac"] });
    const session = await manager.getOrCreate("file-timeout:default", {
      inputPath: "/fake/video.mkv",
      plan,
      durationSec: 120,
      segSec: 6,
    });

    const capturedLastAccess = session.lastAccess;

    await expect(manager.ensureSegment(session, 0)).rejects.toThrow(SegmentTimeoutError);

    // proc must have been killed so the next request triggers a fresh spawn.
    expect(noopProc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(session.proc).toBeNull();

    // lastAccess must NOT have been updated on failure — stuck session stays reapable.
    expect(session.lastAccess).toBe(capturedLastAccess);

    await manager.closeAll();
  });
});
