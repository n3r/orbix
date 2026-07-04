import { describe, it, expect } from "vitest";
import { nowProgressPercent, tvDayString } from "./tv-time";

describe("nowProgressPercent", () => {
  const slot = { start: "2026-07-03T16:00:00.000Z", stop: "2026-07-03T17:00:00.000Z" };
  it("is the elapsed fraction of the slot", () => {
    expect(nowProgressPercent(slot, Date.parse("2026-07-03T16:30:00.000Z"))).toBe(50);
  });
  it("clamps to [0,100]", () => {
    expect(nowProgressPercent(slot, Date.parse("2026-07-03T15:00:00.000Z"))).toBe(0);
    expect(nowProgressPercent(slot, Date.parse("2026-07-03T18:00:00.000Z"))).toBe(100);
  });
  it("degenerate slot → 0", () => {
    expect(nowProgressPercent({ start: slot.start, stop: slot.start }, Date.parse(slot.start))).toBe(0);
  });
});

describe("tvDayString", () => {
  it("formats the local calendar day with an offset", () => {
    const base = new Date(2026, 6, 3, 23, 30); // local time — crosses midnight with +1
    expect(tvDayString(0, base)).toBe("2026-07-03");
    expect(tvDayString(1, base)).toBe("2026-07-04");
  });
});
