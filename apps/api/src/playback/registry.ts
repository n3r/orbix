import { randomUUID } from "node:crypto";
import type { PlaybackAudioMode, PlaybackPlan, PlaybackQuality, SegmentBoundary } from "@orbix/core";

/**
 * Snapshot of a file's technical metadata + selected-track info, captured at
 * negotiation time so the HLS session routes (master/index playlists) can
 * build spec-complete output without re-querying the DB per segment request.
 */
export interface PlaySessionMedia {
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  videoProfile?: string | null;
  videoLevel?: number | null;
  colorTransfer?: string | null;
  frameRate?: number | null;
  videoCodec?: string | null;
  container?: string | null;
  /** The SELECTED audio track's codec (per the negotiated audioTrackIndex). */
  audioCodec?: string | null;
  subtitleTracks: { index: number; codec?: string; language?: string }[];
}

export interface PlaySessionEntry {
  playSessionId: string;
  fileId: string;
  inputPath: string;
  durationSec: number;
  plan: PlaybackPlan;
  /**
   * The chosen output quality (source or a manual downscale rendition) and
   * audio-processing mode, negotiated at /playback/info time. Both flow into
   * the SessionManager session so the HLS routes serve the right variant; the
   * client changes them by re-negotiating (which mints a fresh session).
   */
  quality: PlaybackQuality;
  audioMode: PlaybackAudioMode;
  /**
   * Keyframe-derived segment boundaries for a remux plan (null when the plan
   * isn't remux, or when computeSegmentBoundaries had nothing to compute).
   */
  boundaries: SegmentBoundary[] | null;
  /** Transcode plans force keyframes at the segment cadence so fixed EXTINFs stay exact. */
  forceKeyframes: boolean;
  /**
   * Whether the master playlist should emit EXT-X-MEDIA subtitle renditions
   * for this session. False for clients that declared sidecar subtitle
   * delivery (see ClientCapabilities.subtitleDelivery) — their own <Track>
   * elements would otherwise duplicate the in-manifest renditions.
   */
  subtitleRenditions: boolean;
  media: PlaySessionMedia | null;
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

  create(input: {
    fileId: string;
    inputPath: string;
    durationSec: number;
    plan: PlaybackPlan;
    quality: PlaybackQuality;
    audioMode: PlaybackAudioMode;
    boundaries: SegmentBoundary[] | null;
    forceKeyframes: boolean;
    subtitleRenditions: boolean;
    media: PlaySessionMedia | null;
  }): PlaySessionEntry {
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
