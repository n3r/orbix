import { describe, it, expect } from "vitest";
import { decidePlayback, type ClientCapabilities } from "./strategy";

const WEB: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: ["h264"],
  audioCodecs: ["aac"],
  maxAudioChannels: 2,
  hlsMultichannelAacBroken: true,
};

const APPLE_TV: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac", "ac3", "eac3", "flac"],
  maxAudioChannels: 6,
};

const aac2 = { index: 1, codec: "aac", channels: 2, language: "en" };
const aac6 = { index: 1, codec: "aac", channels: 6, language: "en" };
const ac3 = { index: 1, codec: "ac3", channels: 6, language: "en" };
const dts = { index: 1, codec: "dts", channels: 6, language: "en" };
const commentary = { index: 2, codec: "aac", channels: 2, language: "ru" };

describe("decidePlayback — web profile parity", () => {
  it("direct: mp4 + h264 + first-track aac", () => {
    expect(decidePlayback({ container: "mov,mp4,m4a,3gp,3g2,mj2", videoCodec: "h264", audioTracks: [aac2] }, WEB))
      .toEqual({ mode: "direct" });
  });

  it('accepts the conventional "mkv" container name via the matroska alias', () => {
    const caps = { ...WEB, containers: ["mp4", "mkv"] };
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [aac2] }, caps))
      .toEqual({ mode: "direct" });
  });

  it("direct is NOT blocked by 5.1 AAC (progressive decode is native)", () => {
    expect(decidePlayback({ container: "mp4", videoCodec: "h264", audioTracks: [aac6] }, WEB))
      .toEqual({ mode: "direct" });
  });

  it("remux + audio copy: mkv + h264 + stereo aac", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [aac2] }, WEB))
      .toEqual({ mode: "remux", audioAction: "copy", audioTrackIndex: 0, audioChannels: 2 });
  });

  it("remux + aac transcode: mkv + h264 + ac3 (downmix to caps ceiling)", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [ac3] }, WEB))
      .toEqual({ mode: "remux", audioAction: "aac", audioTrackIndex: 0, audioChannels: 2 });
  });

  it("multichannel AAC over HLS is transcoded for web (hls.js MSE quirk)", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [aac6] }, WEB))
      .toEqual({ mode: "remux", audioAction: "aac", audioTrackIndex: 0, audioChannels: 2 });
  });

  it("transcode: hevc for a h264-only client", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "hevc", audioTracks: [aac2] }, WEB))
      .toEqual({ mode: "transcode", audioAction: "copy", audioTrackIndex: 0, audioChannels: 2 });
  });

  it("no audio track: aac action with stereo default", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [] }, WEB))
      .toEqual({ mode: "remux", audioAction: "aac", audioTrackIndex: 0, audioChannels: 2 });
  });
});

describe("decidePlayback — Apple TV profile", () => {
  it("remux (not transcode) for HEVC in MKV", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "hevc", audioTracks: [aac2] }, APPLE_TV))
      .toEqual({ mode: "remux", audioAction: "copy", audioTrackIndex: 0, audioChannels: 2 });
  });

  it("AC-3 5.1 passes through", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "hevc", audioTracks: [ac3] }, APPLE_TV))
      .toEqual({ mode: "remux", audioAction: "copy", audioTrackIndex: 0, audioChannels: 6 });
  });

  it("DTS is transcoded to multichannel AAC", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "hevc", audioTracks: [dts] }, APPLE_TV))
      .toEqual({ mode: "remux", audioAction: "aac", audioTrackIndex: 0, audioChannels: 6 });
  });

  it("multichannel AAC copies for clients without the MSE quirk", () => {
    expect(decidePlayback({ container: "matroska,webm", videoCodec: "h264", audioTracks: [aac6] }, APPLE_TV))
      .toEqual({ mode: "remux", audioAction: "copy", audioTrackIndex: 0, audioChannels: 6 });
  });
});

describe("decidePlayback — audio track selection", () => {
  it("selecting a non-default track forces non-direct and maps the relative index", () => {
    const src = { container: "mp4", videoCodec: "h264", audioTracks: [ac3, commentary] };
    expect(decidePlayback(src, APPLE_TV, { audioTrackIndex: 1 }))
      .toEqual({ mode: "remux", audioAction: "copy", audioTrackIndex: 1, audioChannels: 2 });
  });

  it("out-of-range track index falls back to aac/stereo defaults", () => {
    const src = { container: "matroska,webm", videoCodec: "h264", audioTracks: [aac2] };
    expect(decidePlayback(src, WEB, { audioTrackIndex: 5 }))
      .toEqual({ mode: "remux", audioAction: "aac", audioTrackIndex: 5, audioChannels: 2 });
  });
});
