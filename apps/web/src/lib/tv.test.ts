import { describe, it, expect } from "vitest";
import { channelInitials, channelHue, regionName } from "./tv";

describe("channelInitials", () => {
  it("takes the first letters of up to two words, uppercased", () => {
    expect(channelInitials("Первый канал")).toBe("ПК");
    expect(channelInitials("  bbc  one ")).toBe("BO");
    expect(channelInitials("ARD")).toBe("A");
  });
  it("falls back to ? for empty names", () => {
    expect(channelInitials("")).toBe("?");
    expect(channelInitials("   ")).toBe("?");
  });
  it("is code-point-aware and does not split astral-plane characters (emoji)", () => {
    expect(channelInitials("😀 CNN")).toBe("😀C");
  });
  it("still handles Cyrillic (BMP) correctly — no regression", () => {
    expect(channelInitials("Первый канал")).toBe("ПК");
  });
});

describe("channelHue", () => {
  it("is deterministic with known values", () => {
    expect(channelHue("a")).toBe(97);
    expect(channelHue("b")).toBe(98);
    expect(channelHue("ab")).toBe(225);
    expect(channelHue("")).toBe(0);
  });
  it("always lands in 0..359", () => {
    for (const seed of ["cmb1x2y3", "ChannelOne.ru", "x".repeat(200), "☃"]) {
      const h = channelHue(seed);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe("regionName", () => {
  it("maps iptv-org UK to the ISO GB display name", () => {
    expect(regionName("UK", "en")).toBe("United Kingdom");
    expect(regionName("uk", "en")).toBe("United Kingdom");
  });
  it("resolves normal codes in the given locale", () => {
    expect(regionName("RU", "en")).toBe("Russia");
    expect(regionName("DE", "en")).toBe("Germany");
  });
  it("returns null for null/undefined and echoes junk codes", () => {
    expect(regionName(null, "en")).toBeNull();
    expect(regionName(undefined, "en")).toBeNull();
    expect(regionName("ZZZZ", "en")).toBe("ZZZZ");
  });
});
