import { describe, it, expect } from "vitest";
import { decideStrategy } from "./strategy";

describe("decideStrategy", () => {
  it("direct-play: mp4 container, h264 video, aac audio", () => {
    expect(decideStrategy({ container: "mp4", videoCodec: "h264", audioCodecs: ["aac"] })).toEqual({ mode: "direct" });
  });

  it("direct-play: MP4-family substring container (ffprobe format)", () => {
    expect(
      decideStrategy({ container: "mov,mp4,m4a,3gp,3g2,mj2", videoCodec: "h264", audioCodecs: ["aac"] })
    ).toEqual({ mode: "direct" });
  });

  it("remux: h264 in mkv container, no aac audio → audioAction aac", () => {
    expect(
      decideStrategy({ container: "matroska,webm", videoCodec: "h264", audioCodecs: ["ac3"] })
    ).toEqual({ mode: "remux", audioAction: "aac" });
  });

  it("remux: h264 in mkv container, aac audio present → audioAction copy", () => {
    expect(
      decideStrategy({ container: "matroska,webm", videoCodec: "h264", audioCodecs: ["aac"] })
    ).toEqual({ mode: "remux", audioAction: "copy" });
  });

  it("transcode: hevc video, aac audio → audioAction copy", () => {
    expect(
      decideStrategy({ container: "matroska", videoCodec: "hevc", audioCodecs: ["aac"] })
    ).toEqual({ mode: "transcode", audioAction: "copy" });
  });

  it("transcode: vp9 video, no audio → audioAction aac", () => {
    expect(decideStrategy({ videoCodec: "vp9", audioCodecs: [] })).toEqual({ mode: "transcode", audioAction: "aac" });
  });

  it("transcode: no videoCodec, no audio → audioAction aac", () => {
    expect(decideStrategy({ audioCodecs: [] })).toEqual({ mode: "transcode", audioAction: "aac" });
  });

  it("direct-play: mov container", () => {
    expect(decideStrategy({ container: "mov", videoCodec: "h264", audioCodecs: ["aac"] })).toEqual({ mode: "direct" });
  });

  it("direct-play: m4v container (case-insensitive)", () => {
    expect(decideStrategy({ container: "M4V", videoCodec: "h264", audioCodecs: ["aac"] })).toEqual({ mode: "direct" });
  });

  it("remux: mp4 container, h264 video, but no aac audio → remux with audioAction aac", () => {
    expect(decideStrategy({ container: "mp4", videoCodec: "h264", audioCodecs: ["ac3"] })).toEqual({
      mode: "remux",
      audioAction: "aac",
    });
  });

  it("transcode: av1 video, aac audio → audioAction copy", () => {
    expect(decideStrategy({ container: "matroska", videoCodec: "av1", audioCodecs: ["aac"] })).toEqual({
      mode: "transcode",
      audioAction: "copy",
    });
  });
});
