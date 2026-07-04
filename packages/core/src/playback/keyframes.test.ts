import { describe, it, expect } from "vitest";
import { parseKeyframePackets, computeSegmentBoundaries } from "./keyframes";

describe("parseKeyframePackets", () => {
  it("extracts only K-flagged packet pts, sorted ascending", () => {
    const csv = [
      "0.000000,K__",
      "0.040000,___",
      "2.000000,K__",
      "1.960000,___",
      "4.000000,K__",
      "", // trailing blank
    ].join("\n");
    expect(parseKeyframePackets(csv)).toEqual([0, 2, 4]);
  });

  it("tolerates side_data noise lines and dedupes", () => {
    const csv = "0.000000,K__\nunknown,garbage\n0.000000,K__\n6.006000,K_F\n";
    expect(parseKeyframePackets(csv)).toEqual([0, 6.006]);
  });

  it("returns [] for empty/garbage input", () => {
    expect(parseKeyframePackets("")).toEqual([]);
    expect(parseKeyframePackets("N/A,___\n")).toEqual([]);
  });
});

describe("computeSegmentBoundaries", () => {
  it("cuts at the first keyframe >= target (hls muxer rule)", () => {
    // keyframes every 2s, 6s target → cuts at 6, 12; total 15s
    const kf = [0, 2, 4, 6, 8, 10, 12, 14];
    expect(computeSegmentBoundaries(kf, 15, 6)).toEqual([
      { start: 0, duration: 6 },
      { start: 6, duration: 6 },
      { start: 12, duration: 3 },
    ]);
  });

  it("handles keyframe gaps longer than the target (long segments)", () => {
    // GOP of 10s > 6s target → segments cut at each keyframe
    const kf = [0, 10, 20];
    expect(computeSegmentBoundaries(kf, 25, 6)).toEqual([
      { start: 0, duration: 10 },
      { start: 10, duration: 10 },
      { start: 20, duration: 5 },
    ]);
  });

  it("ignores a non-zero first keyframe offset by starting at it", () => {
    const kf = [0.033, 6.033, 12.033];
    const b = computeSegmentBoundaries(kf, 14, 6)!;
    expect(b[0].start).toBe(0.033);
    expect(b[0].duration).toBeCloseTo(6, 3);
    expect(b[2].start).toBe(12.033);
    expect(b[2].duration).toBeCloseTo(1.967, 3);
  });

  it("returns null for an empty index and a single full-length segment when only one keyframe exists", () => {
    expect(computeSegmentBoundaries([], 100, 6)).toBeNull();
    expect(computeSegmentBoundaries([0], 100, 6)).toEqual([{ start: 0, duration: 100 }]);
  });

  it("drops zero/negative-duration tails (duration <= keyframe start)", () => {
    expect(computeSegmentBoundaries([0, 6], 6, 6)).toEqual([{ start: 0, duration: 6 }]);
  });
});
