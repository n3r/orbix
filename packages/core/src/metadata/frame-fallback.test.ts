import { describe, it, expect } from "vitest";
import { backdropFrameTimestampSec, episodeFrameTimestampSec } from "./frame-fallback";

describe("backdropFrameTimestampSec", () => {
  it("uses ~20% into a known runtime", () => {
    expect(backdropFrameTimestampSec(6000)).toBe(1200);
  });

  it("clamps very short runtimes to a 5s minimum", () => {
    expect(backdropFrameTimestampSec(10)).toBe(5);
  });

  it("falls back to 60s for unknown/invalid durations", () => {
    expect(backdropFrameTimestampSec(null)).toBe(60);
    expect(backdropFrameTimestampSec(0)).toBe(60);
    expect(backdropFrameTimestampSec(undefined)).toBe(60);
  });
});

describe("episodeFrameTimestampSec", () => {
  it("stays early, clamped to a 10s ceiling for long episodes", () => {
    expect(episodeFrameTimestampSec(1200)).toBe(10); // 5% = 60 → capped at 10
  });

  it("uses ~5% for short episodes", () => {
    expect(episodeFrameTimestampSec(100)).toBe(5);
  });

  it("never goes below 1s", () => {
    expect(episodeFrameTimestampSec(10)).toBe(1);
  });

  it("falls back to 1s for unknown/invalid durations", () => {
    expect(episodeFrameTimestampSec(null)).toBe(1);
    expect(episodeFrameTimestampSec(0)).toBe(1);
    expect(episodeFrameTimestampSec(undefined)).toBe(1);
  });
});
