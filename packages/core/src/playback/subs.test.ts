import { describe, it, expect } from "vitest";
import { srtToVtt } from "./subs";

describe("srtToVtt", () => {
  it("starts with WEBVTT", () => {
    const result = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nHello\n");
    expect(result).toMatch(/^WEBVTT/);
  });

  it("converts timestamp comma to dot", () => {
    const result = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nHello\n");
    expect(result).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("contains the cue text", () => {
    const result = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nHello\n");
    expect(result).toContain("Hello");
  });

  it("has no timestamp comma left", () => {
    const result = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nHello\n");
    expect(result).not.toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
  });

  it("handles two cues", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "Hello world",
      "",
      "2",
      "00:00:03,500 --> 00:00:05,000",
      "Second line",
      "",
    ].join("\n");
    const result = srtToVtt(srt);
    expect(result).toMatch(/^WEBVTT/);
    expect(result).toContain("00:00:01.000 --> 00:00:02.000");
    expect(result).toContain("00:00:03.500 --> 00:00:05.000");
    expect(result).toContain("Hello world");
    expect(result).toContain("Second line");
    expect(result).not.toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
  });
});
