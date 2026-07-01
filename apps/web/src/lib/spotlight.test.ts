import { describe, it, expect } from "vitest";
import { isNew, progressPct, timeLeftParts, resumeLabel } from "./spotlight";

describe("isNew", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  it("is true within 14 days", () => {
    expect(isNew("2026-06-20T00:00:00Z", now)).toBe(true);
  });
  it("is false at 15 days", () => {
    expect(isNew("2026-06-16T00:00:00Z", now)).toBe(false);
  });
  it("is false when addedAt is undefined", () => {
    expect(isNew(undefined, now)).toBe(false);
  });
});

describe("progressPct", () => {
  it("returns a 0..100 percentage", () => {
    expect(progressPct(600, 1200)).toBe(50);
  });
  it("returns 0 for a zero/invalid duration", () => {
    expect(progressPct(600, 0)).toBe(0);
  });
  it("clamps to 100", () => {
    expect(progressPct(9999, 1200)).toBe(100);
  });
});

describe("timeLeftParts", () => {
  it("formats minutes", () => {
    expect(timeLeftParts(600, 1200)).toEqual({ h: 0, m: 10 });
  });
  it("formats hours + minutes", () => {
    expect(timeLeftParts(600, 4500)).toEqual({ h: 1, m: 5 });
  });
  it("returns null for invalid duration", () => {
    expect(timeLeftParts(10, 0)).toBeNull();
  });
});

describe("resumeLabel", () => {
  it("formats season, episode and title", () => {
    expect(resumeLabel({ seasonNumber: 3, episodeNumber: 4, episodeTitle: "Old Friends" }))
      .toBe("S3 E4 · Old Friends");
  });
  it("omits the title when absent", () => {
    expect(resumeLabel({ seasonNumber: 1, episodeNumber: 2, episodeTitle: null }))
      .toBe("S1 E2");
  });
  it("returns null for a movie (null resume)", () => {
    expect(resumeLabel(null)).toBeNull();
  });
});
