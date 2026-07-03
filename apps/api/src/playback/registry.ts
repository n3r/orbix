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
      ...input,
      playSessionId: randomUUID(),
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

declare module "fastify" {
  interface FastifyInstance { playSessions?: PlaySessionRegistry }
}
