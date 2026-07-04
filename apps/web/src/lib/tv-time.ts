// Pure TV time helpers (unit-tested; no fetch/DOM) — now/next formatting +
// progress-percentage for the currently-airing programme, and the local-day
// string the Today/Tomorrow schedule tabs send to the API.
import type { TvProgrammeSlot } from "./types";

/**
 * Programme slot for now/next display. Alias of the phase-2 API type
 * (title/start/stop) — kept as a distinct export so callers can import the
 * "now/next slot" concept from this module, without a second structurally
 * identical interface duplicating `TvProgrammeSlot`.
 */
export type TvNowNextSlot = TvProgrammeSlot;

/** Elapsed fraction of an airing slot, clamped to [0, 100]. */
export function nowProgressPercent(slot: { start: string; stop: string }, atMs: number = Date.now()): number {
  const start = Date.parse(slot.start);
  const stop = Date.parse(slot.stop);
  if (!(stop > start)) return 0;
  return Math.min(100, Math.max(0, ((atMs - start) / (stop - start)) * 100));
}

/** Localized HH:MM for schedule rows and now/next lines. */
export function formatTvTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Local calendar day as "YYYY-MM-DD" (what the Today/Tomorrow tabs send).
 * The API interprets it as a UTC day with overlap semantics — a known v1
 * approximation at extreme timezone edges.
 */
export function tvDayString(offsetDays: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offsetDays);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
