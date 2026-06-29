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
