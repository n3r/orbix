import { describe, it, expect } from "vitest";
import { isFinished, continueWatching } from "./resume";

describe("isFinished", () => {
  it("returns true when positionSec >= 0.9 * durationSec (95/100)", () => {
    expect(isFinished(95, 100)).toBe(true);
  });

  it("returns true at exactly 0.9 * durationSec (90/100)", () => {
    expect(isFinished(90, 100)).toBe(true);
  });

  it("returns false when positionSec < 0.9 * durationSec (89/100)", () => {
    expect(isFinished(89, 100)).toBe(false);
  });

  it("returns false well before threshold (50/100)", () => {
    expect(isFinished(50, 100)).toBe(false);
  });

  it("returns false when durationSec is 0", () => {
    expect(isFinished(10, 0)).toBe(false);
  });
});

describe("continueWatching", () => {
  const states = [
    {
      mediaItemId: "finished-item",
      positionSec: 95,
      durationSec: 100,
      finished: true,
      updatedAt: new Date("2026-06-29T10:00:00Z"),
    },
    {
      mediaItemId: "not-started-item",
      positionSec: 0,
      durationSec: 100,
      finished: false,
      updatedAt: new Date("2026-06-29T09:00:00Z"),
    },
    {
      mediaItemId: "in-progress-older",
      positionSec: 30,
      durationSec: 100,
      finished: false,
      updatedAt: new Date("2026-06-29T08:00:00Z"),
    },
    {
      mediaItemId: "in-progress-newer",
      positionSec: 50,
      durationSec: 120,
      finished: false,
      updatedAt: new Date("2026-06-29T11:00:00Z"),
    },
  ];

  it("returns only in-progress items (positionSec > 0 && !finished)", () => {
    const result = continueWatching(states);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.mediaItemId);
    expect(ids).not.toContain("finished-item");
    expect(ids).not.toContain("not-started-item");
  });

  it("sorts by updatedAt DESC (newest first)", () => {
    const result = continueWatching(states);
    expect(result[0].mediaItemId).toBe("in-progress-newer");
    expect(result[1].mediaItemId).toBe("in-progress-older");
  });

  it("maps output to {mediaItemId, positionSec, durationSec} only", () => {
    const result = continueWatching(states);
    for (const item of result) {
      expect(Object.keys(item).sort()).toEqual(["durationSec", "mediaItemId", "positionSec"]);
    }
    expect(result[0]).toEqual({ mediaItemId: "in-progress-newer", positionSec: 50, durationSec: 120 });
    expect(result[1]).toEqual({ mediaItemId: "in-progress-older", positionSec: 30, durationSec: 100 });
  });

  it("returns empty array when all items are finished or not started", () => {
    expect(continueWatching([states[0], states[1]])).toEqual([]);
  });
});
