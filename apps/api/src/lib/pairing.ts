import { randomBytes } from "node:crypto";
import { generatePairingCode, PAIRING_TTL_MS } from "@orbix/core";

interface PendingEntry {
  code: string;
  pollToken: string;
  name: string;
  platform: string;
  createdAtMs: number;
  approved: { deviceToken: string; deviceId: string } | null;
}

const INITIATE_LIMIT_PER_MIN = 5;
const POLL_LIMIT_PER_MIN = 60;
const WINDOW_MS = 60_000;
const MAX_PENDING = 50;

/**
 * In-memory pairing exchange: a TV calls initiate() and displays the code, a
 * signed-in web user approves it, the TV's poll redeems the device token once.
 * Single-node by design (pairing is ephemeral); entries expire after
 * PAIRING_TTL_MS. Includes small per-IP rate limits since initiate/poll are
 * the only unauthenticated brute-forceable endpoints.
 */
export class PairingStore {
  private entries = new Map<string, PendingEntry>(); // keyed by code
  private byPollToken = new Map<string, string>(); // pollToken -> code
  private hits = new Map<string, { windowStartMs: number; count: number }>();
  private now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  private allow(bucket: string, limit: number): boolean {
    const nowMs = this.now();
    const hit = this.hits.get(bucket);
    if (!hit || nowMs - hit.windowStartMs > WINDOW_MS) {
      this.hits.set(bucket, { windowStartMs: nowMs, count: 1 });
      return true;
    }
    hit.count += 1;
    return hit.count <= limit;
  }

  private sweep(): void {
    const nowMs = this.now();
    for (const [code, e] of this.entries) {
      if (nowMs - e.createdAtMs > PAIRING_TTL_MS) {
        this.byPollToken.delete(e.pollToken);
        this.entries.delete(code);
      }
    }
    for (const [bucket, hit] of this.hits) {
      if (nowMs - hit.windowStartMs > WINDOW_MS) {
        this.hits.delete(bucket);
      }
    }
  }

  initiate(input: { name: string; platform: string; ip: string }):
    | { code: string; pollToken: string; expiresInSec: number }
    | "rate_limited" {
    if (!this.allow(`i:${input.ip}`, INITIATE_LIMIT_PER_MIN)) return "rate_limited";
    this.sweep();
    if (this.entries.size >= MAX_PENDING) return "rate_limited";

    // Regenerate on the (astronomically unlikely) code collision.
    let code = generatePairingCode();
    while (this.entries.has(code)) code = generatePairingCode();

    const pollToken = randomBytes(32).toString("base64url");
    this.entries.set(code, {
      code,
      pollToken,
      name: input.name,
      platform: input.platform,
      createdAtMs: this.now(),
      approved: null,
    });
    this.byPollToken.set(pollToken, code);
    return { code, pollToken, expiresInSec: PAIRING_TTL_MS / 1000 };
  }

  /** Pending (unapproved, unexpired) entry metadata for the approval UI. */
  lookup(code: string): { name: string; platform: string } | null {
    this.sweep();
    const e = this.entries.get(code);
    if (!e || e.approved) return null;
    return { name: e.name, platform: e.platform };
  }

  markApproved(code: string, payload: { deviceToken: string; deviceId: string }): boolean {
    this.sweep();
    const e = this.entries.get(code);
    if (!e || e.approved) return false;
    e.approved = payload;
    return true;
  }

  /** null = unknown/expired; approved redemption deletes the entry (single-use). */
  redeem(pollToken: string):
    | { status: "pending" }
    | { status: "approved"; deviceToken: string; deviceId: string }
    | null {
    this.sweep();
    const code = this.byPollToken.get(pollToken);
    if (!code) return null;
    const e = this.entries.get(code);
    if (!e) return null;
    if (!e.approved) return { status: "pending" };
    this.entries.delete(code);
    this.byPollToken.delete(pollToken);
    return { status: "approved", ...e.approved };
  }

  allowPoll(ip: string): boolean {
    return this.allow(`p:${ip}`, POLL_LIMIT_PER_MIN);
  }
}
