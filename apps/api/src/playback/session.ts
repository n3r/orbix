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
const TIMEOUT_MS = 30_000;
const REAP_INTERVAL_MS = 60_000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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
  private transcodeDir: string;
  private spawnFn: SpawnFn;
  private reapTimer: ReturnType<typeof setInterval>;

  constructor({ transcodeDir, spawn }: { transcodeDir: string; spawn?: SpawnFn }) {
    this.transcodeDir = transcodeDir;
    this.spawnFn = spawn ?? (nodeSpawn as SpawnFn);
    this.reapTimer = setInterval(() => {
      void this.reap();
    }, REAP_INTERVAL_MS);
    this.reapTimer.unref();
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
    return session.proc !== null && !session.proc.killed;
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

  private spawnFfmpeg(session: Session, startSegment: number): void {
    this.killProc(session);

    const mode: "remux" | "transcode" =
      session.plan.mode === "transcode" ? "transcode" : "remux";
    const audioAction: "copy" | "aac" =
      "audioAction" in session.plan ? session.plan.audioAction : "aac";

    const args = buildHlsArgs({
      input: session.inputPath,
      startSegment,
      segSec: session.segSec,
      outDir: session.dir,
      mode,
      audioAction,
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
    const deadline = Date.now() + TIMEOUT_MS;
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
   */
  async ensureSegment(session: Session, n: number): Promise<string> {
    session.lastAccess = Date.now();
    const segPath = path.join(session.dir, `seg${n}.m4s`);

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
      this.spawnFfmpeg(session, n);
    }

    return this.waitForFile(segPath);
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

    if (!this.isProcAlive(session)) {
      this.spawnFfmpeg(session, session.currentStart);
    }

    return this.waitForFile(initPath);
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
