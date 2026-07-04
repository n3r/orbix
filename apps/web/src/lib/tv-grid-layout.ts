// Pure EPG-grid layout helpers (unit-tested; no fetch/DOM) — the window/nav
// model for TvGuideGrid (floor/shift/prime-time) plus the position math for
// rendering a time×channel grid: programme-block rects, ruler tick marks,
// and the now-line, all expressed as percentages of a fixed time window so
// the component never has to measure the DOM.

/** Floors a Date to the start of its local hour (zeroes minutes/seconds/ms). */
export function floorToHour(d: Date): Date {
  const floored = new Date(d);
  floored.setMinutes(0, 0, 0);
  return floored;
}

/** Shifts a Date by a (possibly negative) number of hours — the Prev/Next nav. */
export function shiftHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

/**
 * A given local day (offset from `from`'s day) at a fixed local hour. Used
 * for the Tomorrow day chip: the grid opens at prime time (18:00 local)
 * rather than midnight so it lands on useful content instead of an empty
 * early-morning window. The Today chip doesn't use this — it's the same
 * "now, floored to the hour" anchor as the Now button.
 */
export function primeTimeOnDay(offsetDays: number, hour: number, from: Date = new Date()): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + offsetDays, hour, 0, 0, 0);
}

/**
 * A programme's rect within the time track, as percentages of the window
 * width. Clamped so blocks at the window edges never overflow it: `left` is
 * clamped to [0,100] and `left + width` (i.e. the clamped right edge) is
 * separately clamped to [0,100], so a programme that starts before the
 * window or ends after it renders as a partial block flush with the
 * corresponding edge instead of spilling out or wrapping.
 */
export function computeBlockRect(
  programme: { start: string; stop: string },
  windowStartMs: number,
  windowMs: number,
): { left: number; width: number } {
  if (windowMs <= 0) return { left: 0, width: 0 }; // degenerate window — render nothing rather than divide-by-zero/NaN
  const startMs = Date.parse(programme.start);
  const stopMs = Date.parse(programme.stop);
  const rawLeft = ((startMs - windowStartMs) / windowMs) * 100;
  const rawRight = ((stopMs - windowStartMs) / windowMs) * 100;
  const left = Math.min(100, Math.max(0, rawLeft));
  const right = Math.min(100, Math.max(0, rawRight));
  return { left, width: Math.max(0, right - left) };
}

/** One ruler tick: its timestamp and left position as a window-relative percentage. */
export interface TimeTick {
  ms: number;
  leftPct: number;
}

/**
 * Tick marks spanning the window at a fixed step (default 30 min), inclusive
 * of both edges (a tick at 0% and one at 100%) so the ruler always closes on
 * the window boundary.
 */
export function generateTimeTicks(
  windowStartMs: number,
  windowMs: number,
  stepMs: number = 30 * 60_000,
): TimeTick[] {
  if (windowMs <= 0 || stepMs <= 0) return [];
  const ticks: TimeTick[] = [];
  for (let t = 0; t <= windowMs; t += stepMs) {
    ticks.push({ ms: windowStartMs + t, leftPct: (t / windowMs) * 100 });
  }
  return ticks;
}

/**
 * The now-line's left position as a window-relative percentage, or `null`
 * when "now" falls outside the half-open window `[windowStart, windowEnd)`
 * (the line is hidden entirely rather than clamped to an edge).
 */
export function nowLinePercent(windowStartMs: number, windowMs: number, atMs: number = Date.now()): number | null {
  if (windowMs <= 0) return null; // degenerate window — no meaningful position, hide the line
  if (atMs < windowStartMs || atMs >= windowStartMs + windowMs) return null;
  return ((atMs - windowStartMs) / windowMs) * 100;
}
