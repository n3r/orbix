import { describe, it, expect } from "vitest";
import { backdropFrameTimestampSec } from "./frame-fallback";

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
