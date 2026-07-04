import { describe, it, expect } from "vitest";
import { videoCodecString, audioCodecString, videoRange } from "./codec-string";

describe("videoCodecString", () => {
  it("builds avc1 from h264 profile+level", () => {
    expect(videoCodecString("h264", "High", 41)).toBe("avc1.640029");
    expect(videoCodecString("h264", "Main", 40)).toBe("avc1.4D0028");
    expect(videoCodecString("h264", "Baseline", 30)).toBe("avc1.42001E");
  });
  it("defaults h264 to High@4.1 when fields are missing", () => {
    expect(videoCodecString("h264")).toBe("avc1.640029");
  });
  it("builds hvc1 from hevc profile+level", () => {
    expect(videoCodecString("hevc", "Main 10", 153)).toBe("hvc1.2.4.L153.B0");
    expect(videoCodecString("hevc", "Main", 120)).toBe("hvc1.1.6.L120.B0");
  });
  it("defaults hevc to Main10@L120 when fields are missing", () => {
    expect(videoCodecString("hevc")).toBe("hvc1.2.4.L120.B0");
  });
  it("returns null for unknown codecs", () => {
    expect(videoCodecString("vp9")).toBeNull();
    expect(videoCodecString(undefined)).toBeNull();
  });
});

describe("audioCodecString", () => {
  it("maps the supported set", () => {
    expect(audioCodecString("aac")).toBe("mp4a.40.2");
    expect(audioCodecString("ac3")).toBe("ac-3");
    expect(audioCodecString("eac3")).toBe("ec-3");
    expect(audioCodecString("flac")).toBe("fLaC");
    expect(audioCodecString("dts")).toBeNull();
    expect(audioCodecString(undefined)).toBeNull();
  });
});

describe("videoRange", () => {
  it("maps transfer characteristics", () => {
    expect(videoRange("smpte2084")).toBe("PQ");
    expect(videoRange("arib-std-b67")).toBe("HLG");
    expect(videoRange("bt709")).toBe("SDR");
    expect(videoRange(undefined)).toBe("SDR");
  });
});
