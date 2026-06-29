import { describe, it, expect } from "vitest";
import { buildHlsArgs } from "./ffargs";

const BASE_REMUX = {
  input: "/media/test.mkv",
  startSegment: 0,
  segSec: 6,
  outDir: "/tmp/hls/abc",
  mode: "remux" as const,
  audioAction: "copy" as const,
};

const BASE_TRANSCODE = {
  ...BASE_REMUX,
  mode: "transcode" as const,
  audioAction: "aac" as const,
};

describe("buildHlsArgs", () => {
  // --- startSegment=0: no -ss, first args are -i <input> ---
  it("startSegment=0: first two elements are -i and input", () => {
    const args = buildHlsArgs(BASE_REMUX);
    expect(args[0]).toBe("-i");
    expect(args[1]).toBe("/media/test.mkv");
  });

  it("startSegment=0: no -ss present", () => {
    const args = buildHlsArgs(BASE_REMUX);
    expect(args).not.toContain("-ss");
  });

  // --- startSegment > 0: input-side seek BEFORE -i ---
  it("startSegment=2, segSec=6: argv starts with [-ss, 12, -i, input]", () => {
    const args = buildHlsArgs({ ...BASE_REMUX, startSegment: 2, segSec: 6 });
    expect(args[0]).toBe("-ss");
    expect(args[1]).toBe("12");
    expect(args[2]).toBe("-i");
    expect(args[3]).toBe("/media/test.mkv");
  });

  it("startSegment=2: -start_number is 2", () => {
    const args = buildHlsArgs({ ...BASE_REMUX, startSegment: 2, segSec: 6 });
    const idx = args.indexOf("-start_number");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("2");
  });

  // --- map flags ---
  it("includes -map 0:v:0 and -map 0:a:0? (optional audio)", () => {
    const args = buildHlsArgs(BASE_REMUX);
    const maps = args.filter((a) => a === "-map");
    expect(maps).toHaveLength(2);
    const v = args.indexOf("-map");
    expect(args[v + 1]).toBe("0:v:0");
    expect(args[v + 3]).toBe("0:a:0?"); // second -map is two positions later, ? makes audio optional
  });

  // --- video: remux ---
  it("remux: -c:v copy", () => {
    const args = buildHlsArgs(BASE_REMUX);
    const idx = args.indexOf("-c:v");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("copy");
  });

  it("remux: no libx264, -preset, -crf", () => {
    const args = buildHlsArgs(BASE_REMUX);
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("-preset");
    expect(args).not.toContain("-crf");
  });

  // --- video: transcode ---
  it("transcode: -c:v libx264 -preset veryfast -crf 21", () => {
    const args = buildHlsArgs(BASE_TRANSCODE);
    const idx = args.indexOf("-c:v");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("libx264");
    expect(args).toContain("-preset");
    expect(args[args.indexOf("-preset") + 1]).toBe("veryfast");
    expect(args).toContain("-crf");
    expect(args[args.indexOf("-crf") + 1]).toBe("21");
  });

  it("transcode: custom encoder override (libx264 passthrough)", () => {
    const args = buildHlsArgs({ ...BASE_TRANSCODE, encoder: "libx264" });
    const idx = args.indexOf("-c:v");
    expect(args[idx + 1]).toBe("libx264");
  });

  it("transcode: software encoder maps to libx264", () => {
    const args = buildHlsArgs({ ...BASE_TRANSCODE, encoder: "software" });
    const idx = args.indexOf("-c:v");
    expect(args[idx + 1]).toBe("libx264");
  });

  it("transcode: nvenc encoder maps to h264_nvenc", () => {
    const args = buildHlsArgs({ ...BASE_TRANSCODE, encoder: "nvenc" });
    const idx = args.indexOf("-c:v");
    expect(args[idx + 1]).toBe("h264_nvenc");
  });

  it("transcode: vaapi encoder maps to h264_vaapi", () => {
    const args = buildHlsArgs({ ...BASE_TRANSCODE, encoder: "vaapi" });
    const idx = args.indexOf("-c:v");
    expect(args[idx + 1]).toBe("h264_vaapi");
  });

  it("transcode: qsv encoder maps to h264_qsv", () => {
    const args = buildHlsArgs({ ...BASE_TRANSCODE, encoder: "qsv" });
    const idx = args.indexOf("-c:v");
    expect(args[idx + 1]).toBe("h264_qsv");
  });

  it("transcode: no encoder → defaults to libx264", () => {
    const args = buildHlsArgs(BASE_TRANSCODE); // no encoder field
    const idx = args.indexOf("-c:v");
    expect(args[idx + 1]).toBe("libx264");
  });

  // --- audio ---
  it("audioAction=copy: -c:a copy", () => {
    const args = buildHlsArgs(BASE_REMUX);
    const idx = args.indexOf("-c:a");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("copy");
  });

  it("audioAction=aac: -c:a aac -b:a 192k", () => {
    const args = buildHlsArgs(BASE_TRANSCODE);
    const idx = args.indexOf("-c:a");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("aac");
    expect(args).toContain("-b:a");
    expect(args[args.indexOf("-b:a") + 1]).toBe("192k");
  });

  // --- HLS muxer flags ---
  it("-hls_segment_type fmp4", () => {
    const args = buildHlsArgs(BASE_REMUX);
    const idx = args.indexOf("-hls_segment_type");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("fmp4");
  });

  it("-f hls", () => {
    const args = buildHlsArgs(BASE_REMUX);
    const idx = args.indexOf("-f");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("hls");
  });

  it("-hls_time equals segSec", () => {
    const args = buildHlsArgs(BASE_REMUX);
    const idx = args.indexOf("-hls_time");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("6");
  });

  it("-hls_playlist_type vod", () => {
    const args = buildHlsArgs(BASE_REMUX);
    const idx = args.indexOf("-hls_playlist_type");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("vod");
  });

  it("-hls_flags independent_segments+temp_file", () => {
    const args = buildHlsArgs(BASE_REMUX);
    const idx = args.indexOf("-hls_flags");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("independent_segments+temp_file");
  });

  it("-hls_segment_filename is outDir/seg%d.m4s", () => {
    const args = buildHlsArgs(BASE_REMUX);
    const idx = args.indexOf("-hls_segment_filename");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/tmp/hls/abc/seg%d.m4s");
  });

  it("-hls_fmp4_init_filename is init.mp4 (relative)", () => {
    const args = buildHlsArgs(BASE_REMUX);
    const idx = args.indexOf("-hls_fmp4_init_filename");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("init.mp4");
  });

  it("last arg is outDir/index_live.m3u8", () => {
    const args = buildHlsArgs(BASE_REMUX);
    expect(args[args.length - 1]).toBe("/tmp/hls/abc/index_live.m3u8");
  });

  // --- path integrity (no shell splitting) ---
  it("input path with spaces is a single argv element", () => {
    const input = "/m/My Movie.mkv";
    const args = buildHlsArgs({ ...BASE_REMUX, input });
    expect(args[args.indexOf("-i") + 1]).toBe(input);
  });

  it("no element contains shell metacharacters from path concatenation", () => {
    const args = buildHlsArgs(BASE_REMUX);
    // Every element should be a single token — none should contain unquoted spaces
    // introduced by string concatenation bugs (the path itself may not have spaces here)
    for (const a of args) {
      // Reject any element that looks like two flags smashed together
      expect(a).not.toMatch(/^-\S+ -/);
    }
  });
});
