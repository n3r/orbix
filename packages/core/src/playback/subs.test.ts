import { describe, it, expect } from "vitest";
import {
  srtToVtt,
  normalizeToVtt,
  isImageSubtitleCodec,
  selectTextSubtitleTracks,
  subtitleVttRelPath,
  selectSubtitleRenditions,
} from "./subs";

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

describe("normalizeToVtt", () => {
  it("passes through a blob that already has a WEBVTT header", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n";
    expect(normalizeToVtt(vtt)).toBe(vtt);
  });

  it("tolerates leading whitespace before the WEBVTT header", () => {
    const vtt = "\n  WEBVTT\n\ncue\n";
    expect(normalizeToVtt(vtt)).toBe(vtt);
  });

  it("converts an SRT-like blob (no header) via srtToVtt", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHi\n";
    const out = normalizeToVtt(srt);
    expect(out).toMatch(/^WEBVTT/);
    expect(out).toContain("00:00:01.000 --> 00:00:02.000");
  });
});

describe("isImageSubtitleCodec", () => {
  it("flags PGS / VobSub bitmap codecs", () => {
    expect(isImageSubtitleCodec("hdmv_pgs_subtitle")).toBe(true);
    expect(isImageSubtitleCodec("dvd_subtitle")).toBe(true);
    expect(isImageSubtitleCodec("vobsub")).toBe(true);
  });

  it("does not flag text codecs, or null/undefined", () => {
    expect(isImageSubtitleCodec("subrip")).toBe(false);
    expect(isImageSubtitleCodec("webvtt")).toBe(false);
    expect(isImageSubtitleCodec("ass")).toBe(false);
    expect(isImageSubtitleCodec(null)).toBe(false);
    expect(isImageSubtitleCodec(undefined)).toBe(false);
  });
});

describe("selectTextSubtitleTracks", () => {
  it("keeps text tracks and drops image tracks", () => {
    const tracks = [
      { index: 2, codec: "subrip", language: "en" },
      { index: 3, codec: "hdmv_pgs_subtitle", language: "ru" },
      { index: 4, codec: "ass", language: "de" },
      { index: 5, codec: "dvd_subtitle" },
    ];
    expect(selectTextSubtitleTracks(tracks).map((t) => t.index)).toEqual([2, 4]);
  });

  it("treats an unknown/missing codec as text (extractable)", () => {
    const tracks = [{ index: 1 }, { index: 2, codec: "mov_text" }];
    expect(selectTextSubtitleTracks(tracks).map((t) => t.index)).toEqual([1, 2]);
  });
});

describe("subtitleVttRelPath", () => {
  it("builds a stable metadata-relative path keyed by fileId + trackIndex", () => {
    expect(subtitleVttRelPath("ckabc123", 2)).toBe("subs/ckabc123_2.vtt");
  });

  it("differs per track so tracks never collide", () => {
    expect(subtitleVttRelPath("f1", 2)).not.toBe(subtitleVttRelPath("f1", 3));
  });
});

describe("selectSubtitleRenditions", () => {
  it("enables AUTOSELECT only for tracks whose VTT is ready", () => {
    const out = selectSubtitleRenditions([
      { index: 2, codec: "subrip", language: "en", ready: true },
      { index: 4, codec: "ass", language: "de", ready: false },
      { index: 5, codec: "mov_text", language: "fr" }, // ready undefined → NO
    ]);
    expect(out).toEqual([
      { index: 2, name: "en", language: "en", autoselect: true },
      { index: 4, name: "de", language: "de", autoselect: false },
      { index: 5, name: "fr", language: "fr", autoselect: false },
    ]);
  });

  it("excludes image-based tracks entirely (no rendition, ready or not)", () => {
    const out = selectSubtitleRenditions([
      { index: 2, codec: "subrip", language: "en", ready: true },
      { index: 3, codec: "hdmv_pgs_subtitle", language: "ru", ready: true },
    ]);
    expect(out.map((r) => r.index)).toEqual([2]);
  });

  it("falls back to a Track-N name when a track has no language", () => {
    const out = selectSubtitleRenditions([{ index: 7, codec: "subrip", ready: true }]);
    expect(out[0]).toEqual({ index: 7, name: "Track 7", autoselect: true });
    expect(out[0]).not.toHaveProperty("language");
  });
});
