import { describe, it, expect } from "vitest";
import {
  floorToHour,
  shiftHours,
  primeTimeOnDay,
  computeBlockRect,
  generateTimeTicks,
  nowLinePercent,
} from "./tv-grid-layout";

describe("floorToHour", () => {
  it("zeroes minutes/seconds/ms, keeps the hour", () => {
    const floored = floorToHour(new Date(2026, 6, 3, 14, 37, 22, 500));
    expect(floored.getHours()).toBe(14);
    expect(floored.getMinutes()).toBe(0);
    expect(floored.getSeconds()).toBe(0);
    expect(floored.getMilliseconds()).toBe(0);
  });

  it("does not mutate the input", () => {
    const d = new Date(2026, 6, 3, 14, 37);
    floorToHour(d);
    expect(d.getMinutes()).toBe(37);
  });
});

describe("shiftHours", () => {
  it("shifts forward and backward within a day", () => {
    const d = new Date(2026, 6, 3, 14, 0);
    expect(shiftHours(d, 4).getHours()).toBe(18);
    expect(shiftHours(d, -4).getHours()).toBe(10);
  });

  it("rolls over a day boundary", () => {
    const shifted = shiftHours(new Date(2026, 6, 3, 22, 0), 4);
    expect(shifted.getDate()).toBe(4);
    expect(shifted.getHours()).toBe(2);
  });
});

describe("primeTimeOnDay", () => {
  it("returns the given local hour on the offset day", () => {
    const from = new Date(2026, 6, 3, 9, 15);
    const tomorrow6pm = primeTimeOnDay(1, 18, from);
    expect(tomorrow6pm.getDate()).toBe(4);
    expect(tomorrow6pm.getHours()).toBe(18);
    expect(tomorrow6pm.getMinutes()).toBe(0);
  });

  it("offset 0 stays on the same day", () => {
    const from = new Date(2026, 6, 3, 9, 15);
    expect(primeTimeOnDay(0, 18, from).getDate()).toBe(3);
  });
});

describe("computeBlockRect", () => {
  const windowStart = Date.parse("2026-07-03T14:00:00.000Z");
  const windowMs = 4 * 3_600_000; // 14:00–18:00Z

  it("positions a programme fully inside the window", () => {
    const rect = computeBlockRect(
      { start: "2026-07-03T15:00:00.000Z", stop: "2026-07-03T16:00:00.000Z" },
      windowStart,
      windowMs,
    );
    expect(rect.left).toBeCloseTo(25);
    expect(rect.width).toBeCloseTo(25);
  });

  it("clamps a programme that starts before the window", () => {
    const rect = computeBlockRect(
      { start: "2026-07-03T13:00:00.000Z", stop: "2026-07-03T15:00:00.000Z" },
      windowStart,
      windowMs,
    );
    expect(rect.left).toBe(0);
    expect(rect.width).toBeCloseTo(25); // only the 14:00–15:00 sliver is in-window
  });

  it("clamps a programme that ends after the window (left+width never exceeds 100)", () => {
    const rect = computeBlockRect(
      { start: "2026-07-03T17:00:00.000Z", stop: "2026-07-03T19:00:00.000Z" },
      windowStart,
      windowMs,
    );
    expect(rect.left).toBeCloseTo(75);
    expect(rect.left + rect.width).toBeCloseTo(100);
  });

  it("a programme spanning the whole window clamps to [0,100]", () => {
    const rect = computeBlockRect(
      { start: "2026-07-03T10:00:00.000Z", stop: "2026-07-03T22:00:00.000Z" },
      windowStart,
      windowMs,
    );
    expect(rect.left).toBe(0);
    expect(rect.width).toBe(100);
  });

  it("a programme entirely outside the window collapses to zero width", () => {
    const rect = computeBlockRect(
      { start: "2026-07-03T10:00:00.000Z", stop: "2026-07-03T11:00:00.000Z" },
      windowStart,
      windowMs,
    );
    expect(rect.width).toBe(0);
  });
});

describe("generateTimeTicks", () => {
  it("generates a tick every 30 minutes across the window, inclusive of both edges", () => {
    const ticks = generateTimeTicks(0, 4 * 3_600_000);
    expect(ticks).toHaveLength(9); // 0,30,...,240
    expect(ticks[0]).toEqual({ ms: 0, leftPct: 0 });
    expect(ticks[ticks.length - 1]).toEqual({ ms: 4 * 3_600_000, leftPct: 100 });
    expect(ticks[1]!.leftPct).toBeCloseTo(12.5); // 30 min of a 4h window
  });

  it("respects a custom step", () => {
    const ticks = generateTimeTicks(0, 2 * 3_600_000, 3_600_000);
    expect(ticks).toHaveLength(3); // 0, 60, 120
  });
});

describe("nowLinePercent", () => {
  const windowStart = Date.parse("2026-07-03T14:00:00.000Z");
  const windowMs = 4 * 3_600_000;

  it("positions the line inside the window", () => {
    expect(nowLinePercent(windowStart, windowMs, Date.parse("2026-07-03T15:00:00.000Z"))).toBeCloseTo(25);
  });

  it("returns null before the window starts", () => {
    expect(nowLinePercent(windowStart, windowMs, Date.parse("2026-07-03T13:59:00.000Z"))).toBeNull();
  });

  it("returns null at/after the window end (half-open)", () => {
    expect(nowLinePercent(windowStart, windowMs, windowStart + windowMs)).toBeNull();
  });
});
