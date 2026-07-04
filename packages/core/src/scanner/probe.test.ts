import { describe, it, expect } from "vitest";
import { probeFile } from "./probe";

const FIXTURE = JSON.stringify({
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
    { index: 1, codec_type: "audio", codec_name: "ac3", channels: 6, tags: { language: "eng" } },
    { index: 2, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" } },
  ],
  format: {
    format_name: "matroska,webm",
    duration: "7200.500000",
    bit_rate: "8000000",
  },
});

describe("probeFile", () => {
  it("parses a full ffprobe fixture correctly", async () => {
    const result = await probeFile("/fake/path.mkv", {
      run: async () => FIXTURE,
    });

    expect(result.videoCodec).toBe("h264");
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.audioCodecs).toEqual(["ac3"]);
    expect(result.audioTracks[0].channels).toBe(6);
    expect(result.audioTracks[0].language).toBe("eng");
    expect(result.subtitleTracks.length).toBe(1);
    expect(result.subtitleTracks[0].language).toBe("eng");
    expect(result.durationSec).toBe(7200);
    expect(result.bitrate).toBe(8000000);
    expect(result.container).toBe("matroska,webm");
  });

  it("returns empty arrays and no error for empty/partial probe output", async () => {
    const result = await probeFile("/fake/empty.mkv", {
      run: async () => JSON.stringify({}),
    });

    expect(result.audioCodecs).toEqual([]);
    expect(result.subtitleTracks).toEqual([]);
    expect(result.audioTracks).toEqual([]);
    expect(result.videoCodec).toBeUndefined();
    expect(result.container).toBeUndefined();
    expect(result.durationSec).toBeUndefined();
  });
});

describe("HLS metadata fields", () => {
  it("captures profile, level, color transfer, and frame rate from the video stream", async () => {
    const raw = JSON.stringify({
      streams: [{
        index: 0, codec_type: "video", codec_name: "hevc", width: 3840, height: 2160,
        profile: "Main 10", level: 153, color_transfer: "smpte2084", r_frame_rate: "24000/1001",
      }],
      format: { format_name: "matroska,webm", duration: "100.0" },
    });
    const tech = await probeFile("/x.mkv", { run: async () => raw });
    expect(tech.videoProfile).toBe("Main 10");
    expect(tech.videoLevel).toBe(153);
    expect(tech.colorTransfer).toBe("smpte2084");
    expect(tech.frameRate).toBe(23.976);
  });

  it("tolerates missing/malformed frame rate", async () => {
    const raw = JSON.stringify({
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", r_frame_rate: "0/0" },
      ],
      format: {},
    });
    const tech = await probeFile("/x.mkv", { run: async () => raw });
    expect(tech.frameRate).toBeUndefined();
    expect(tech.videoProfile).toBeUndefined();
  });
});
