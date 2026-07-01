import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { buildVodPlaylist, buildHlsArgs } from "@orbix/core";
import type { PlaybackPlan } from "@orbix/core";

export type { PlaybackPlan };

/** How many segments ahead of currentStart ffmpeg may run before we restart. */
const AHEAD_WINDOW = 100;
const POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const REAP_INTERVAL_MS = 60_000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_SESSIONS = 4; // cap concurrent ffmpeg transcode sessions

export class SegmentTimeoutError extends Error {
  constructor(seg: string) {
    super(`Timeout waiting for segment: ${seg}`);
    this.name = "SegmentTimeoutError";
  }
}

export interface Session {
  id: string;
  dir: string;
  proc: ChildProcess | null;
  currentStart: number;
  segSec: number;
  durationSec: number;
  plan: PlaybackPlan;
  inputPath: string;
  lastAccess: number;
}

/**
 * Minimal typed interface that node:child_process.spawn satisfies.
 * Using a loose signature lets tests inject a fake without casting gymnastics.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SpawnFn = (command: string, args: readonly string[], options?: any) => ChildProcess;

export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Per-session spawn-decision mutex tail (keyed by session id). */
  private locks = new Map<string, Promise<void>>();
  private transcodeDir: string;
  private spawnFn: SpawnFn;
  private reapTimer: ReturnType<typeof setInterval>;
  private timeoutMs: number;
  private maxSessions: number;
  private getEncoder: (() => Promise<string>) | undefined;

  constructor({
    transcodeDir,
    spawn,
    timeoutMs,
    maxSessions,
    getEncoder,
  }: {
    transcodeDir: string;
    spawn?: SpawnFn;
    /** Override the segment wait timeout (ms). Useful for fast-failing tests. */
    timeoutMs?: number;
    /** Cap on concurrent transcode sessions (LRU-evicted past the cap). */
    maxSessions?: number;
    /**
     * Optional async getter for the current encoder setting (e.g. reads from
     * the DB). Returns a value like `"software"`, `"vaapi"`, `"qsv"`, or
     * `"nvenc"`. Defaults to `"software"` (libx264) when absent or the
     * returned value is unrecognised.
     */
    getEncoder?: () => Promise<string>;
  }) {
    this.transcodeDir = transcodeDir;
    this.spawnFn = spawn ?? (nodeSpawn as SpawnFn);
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxSessions = maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.getEncoder = getEncoder;
    this.reapTimer = setInterval(() => {
      void this.reap();
    }, REAP_INTERVAL_MS);
    this.reapTimer.unref();
  }

  /** Number of live sessions (observability + cap enforcement). */
  activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Run `fn` exclusively per session id: the spawn-decision critical region
   * (stat → decide restart → spawn) must not interleave or two concurrent
   * callers can both spawn ffmpeg for the same session.
   */
  private runExclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // Tail never rejects, so the next waiter always proceeds.
    this.locks.set(id, result.then(() => {}, () => {}));
    return result;
  }

  /** Deterministic, filesystem-safe session id derived from the key. */
  private sessionId(key: string): string {
    return crypto.createHash("sha1").update(key).digest("hex").slice(0, 24);
  }

  /** Return existing session or create a new one (mkdir recursive; does NOT spawn ffmpeg). */
  async getOrCreate(
    key: string,
    opts: { inputPath: string; plan: PlaybackPlan; durationSec: number; segSec: number },
  ): Promise<Session> {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing;
    }
    // Enforce the concurrent-session cap: evict the least-recently-accessed
    // session(s) before admitting a new one, killing their ffmpeg + temp dir.
    while (this.sessions.size >= this.maxSessions) {
      let lruKey: string | undefined;
      let lruAccess = Infinity;
      for (const [k, s] of this.sessions) {
        if (s.lastAccess < lruAccess) {
          lruAccess = s.lastAccess;
          lruKey = k;
        }
      }
      if (lruKey === undefined) break;
      await this.removeSession(lruKey, this.sessions.get(lruKey)!);
    }
    const id = this.sessionId(key);
    const dir = path.join(this.transcodeDir, id);
    await fs.promises.mkdir(dir, { recursive: true });
    const session: Session = {
      id,
      dir,
      proc: null,
      currentStart: 0,
      segSec: opts.segSec,
      durationSec: opts.durationSec,
      plan: opts.plan,
      inputPath: opts.inputPath,
      lastAccess: Date.now(),
    };
    this.sessions.set(key, session);
    return session;
  }

  /** Build and return the complete VOD playlist. No ffmpeg required. */
  playlist(session: Session): string {
    return buildVodPlaylist(session.durationSec, session.segSec);
  }

  private isProcAlive(session: Session): boolean {
    const p = session.proc;
    // exitCode/signalCode become non-null the instant the process exits — check
    // them too so we don't treat a just-exited proc (before its "exit" event
    // fires) as alive and skip a needed respawn.
    return p !== null && !p.killed && p.exitCode === null && p.signalCode === null;
  }

  private killProc(session: Session): void {
    if (session.proc && !session.proc.killed) {
      try {
        session.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    session.proc = null;
  }

  private async spawnFfmpeg(session: Session, startSegment: number): Promise<void> {
    this.killProc(session);

    const mode: "remux" | "transcode" =
      session.plan.mode === "transcode" ? "transcode" : "remux";
    const audioAction: "copy" | "aac" =
      "audioAction" in session.plan ? session.plan.audioAction : "aac";

    // Read the encoder setting for transcode mode; fall back to "software" on
    // any error or unknown value so existing playback is never broken.
    let encoder: string | undefined;
    if (mode === "transcode" && this.getEncoder) {
      try {
        encoder = await this.getEncoder();
      } catch {
        encoder = "software";
      }
      // Guard: unknown / empty value → software
      if (!encoder) encoder = "software";
    }

    const args = buildHlsArgs({
      input: session.inputPath,
      startSegment,
      segSec: session.segSec,
      outDir: session.dir,
      mode,
      audioAction,
      encoder: encoder as "software" | "vaapi" | "qsv" | "nvenc" | undefined,
      vaapiDevice: process.env.VAAPI_DEVICE || "/dev/dri/renderD128",
    });

    const proc = this.spawnFn("ffmpeg", args, { stdio: "ignore" });
    session.proc = proc;
    session.currentStart = startSegment;

    // Clear proc reference when ffmpeg exits naturally.
    proc.once("exit", () => {
      if (session.proc === proc) {
        session.proc = null;
      }
    });
  }

  private async waitForFile(filePath: string): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size > 0) return filePath;
      } catch {
        /* not present yet */
      }
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new SegmentTimeoutError(path.basename(filePath));
  }

  /**
   * Guarantees seg<n>.m4s exists and returns its absolute path.
   *
   * Restart rule: kill ffmpeg and restart at n when:
   *   - proc is dead/null, OR
   *   - n < currentStart (backward seek), OR
   *   - n > currentStart + AHEAD_WINDOW and the file is not already present (far-forward seek).
   *
   * lastAccess is only updated on a SUCCESSFUL segment return so that a stuck
   * session (ffmpeg hung) is still eligible for reaping by the idle reaper.
   * On timeout, the hung ffmpeg is killed so the next request triggers a fresh spawn.
   */
  async ensureSegment(session: Session, n: number): Promise<string> {
    const segPath = path.join(session.dir, `seg${n}.m4s`);

    // Spawn decision is serialized per session so two concurrent callers can't
    // both restart ffmpeg. The (slow) waitForFile below runs outside the lock.
    await this.runExclusive(session.id, async () => {
      let alreadyPresent = false;
      try {
        const stat = await fs.promises.stat(segPath);
        alreadyPresent = stat.size > 0;
      } catch {
        /* not present */
      }

      const needsRestart =
        !this.isProcAlive(session) ||
        n < session.currentStart ||
        (n > session.currentStart + AHEAD_WINDOW && !alreadyPresent);

      if (needsRestart) {
        await this.spawnFfmpeg(session, n);
      }
    });

    try {
      const result = await this.waitForFile(segPath);
      // Only update lastAccess on success so a stuck session can be reaped.
      session.lastAccess = Date.now();
      return result;
    } catch (err) {
      if (err instanceof SegmentTimeoutError) {
        // Kill the hung ffmpeg so the next ensureSegment sees a dead proc and restarts.
        this.killProc(session);
      }
      throw err;
    }
  }

  /**
   * Ensures ffmpeg has been started and init.mp4 exists; returns its path.
   * If init.mp4 already has content, returns it immediately without (re)spawning.
   */
  async ensureInit(session: Session): Promise<string> {
    session.lastAccess = Date.now();
    const initPath = path.join(session.dir, "init.mp4");

    // Fast path: init already written by a prior ffmpeg run.
    try {
      const stat = await fs.promises.stat(initPath);
      if (stat.size > 0) return initPath;
    } catch {
      /* not present — fall through to spawn */
    }

    await this.runExclusive(session.id, async () => {
      if (!this.isProcAlive(session)) {
        await this.spawnFfmpeg(session, session.currentStart);
      }
    });

    try {
      const result = await this.waitForFile(initPath);
      session.lastAccess = Date.now();
      return result;
    } catch (err) {
      if (err instanceof SegmentTimeoutError) {
        this.killProc(session);
      }
      throw err;
    }
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastAccess > IDLE_TIMEOUT_MS) {
        await this.removeSession(key, session);
      }
    }
  }

  private async removeSession(key: string, session: Session): Promise<void> {
    this.killProc(session);
    this.sessions.delete(key);
    this.locks.delete(session.id);
    try {
      await fs.promises.rm(session.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /** Kill all ffmpeg processes and remove all session dirs. Call from app onClose. */
  async closeAll(): Promise<void> {
    clearInterval(this.reapTimer);
    await Promise.all(
      Array.from(this.sessions.entries()).map(([key, session]) =>
        this.removeSession(key, session),
      ),
    );
  }
}
