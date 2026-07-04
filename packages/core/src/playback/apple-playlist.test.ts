import { describe, it, expect } from "vitest";
import {
  buildMultivariantPlaylist,
  buildMediaPlaylistFromBoundaries,
  buildSubtitleMediaPlaylist,
} from "./apple-playlist";

describe("buildMultivariantPlaylist", () => {
  it("emits all MUST attributes and subtitle groups", () => {
    const m = buildMultivariantPlaylist({
      mediaUri: "index.m3u8?playSessionId=S&token=T",
      bandwidth: 8_000_000,
      codecs: ["hvc1.2.4.L153.B0", "ec-3"],
      resolution: { width: 3840, height: 2160 },
      frameRate: 23.976,
      videoRange: "PQ",
      subtitles: [
        { name: "English", language: "en", uri: "subs/2/index.m3u8?playSessionId=S&token=T" },
        { name: "Русский", language: "ru", uri: "subs/3/index.m3u8?playSessionId=S&token=T", autoselect: false },
      ],
    });
    const lines = m.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(m).toContain("#EXT-X-VERSION:7");
    expect(m).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    expect(m).toContain(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="subs/2/index.m3u8?playSessionId=S&token=T"',
    );
    expect(m).toContain('NAME="Русский",LANGUAGE="ru",AUTOSELECT=NO');
    const streamInf = lines.find((l) => l.startsWith("#EXT-X-STREAM-INF:"))!;
    expect(streamInf).toBe(
      '#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=8000000,CODECS="hvc1.2.4.L153.B0,ec-3",RESOLUTION=3840x2160,FRAME-RATE=23.976,VIDEO-RANGE=PQ,SUBTITLES="subs"',
    );
    expect(lines[lines.indexOf(streamInf) + 1]).toBe("index.m3u8?playSessionId=S&token=T");
  });

  it("omits optional attributes cleanly (SDR, no codecs, no subs)", () => {
    const m = buildMultivariantPlaylist({ mediaUri: "index.m3u8?x=1", bandwidth: 2_000_000, codecs: [] });
    const streamInf = m.split("\n").find((l) => l.startsWith("#EXT-X-STREAM-INF:"))!;
    expect(streamInf).toBe("#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=2000000");
    expect(m).not.toContain("EXT-X-MEDIA");
    expect(m).not.toContain("VIDEO-RANGE");
  });

  it("sanitizes quote/comma injection in subtitle attributes", () => {
    const m = buildMultivariantPlaylist({
      mediaUri: "index.m3u8", bandwidth: 1, codecs: [],
      subtitles: [{ name: 'Foo" ,EVIL="1', language: "en", uri: "s.m3u8" }],
    });
    expect(m).toContain('NAME="Foo  EVIL=1"');
    expect(m).not.toContain('EVIL="1"');
  });
});

describe("buildMediaPlaylistFromBoundaries", () => {
  it("declares real EXTINFs and a correct TARGETDURATION", () => {
    const p = buildMediaPlaylistFromBoundaries(
      [
        { start: 0, duration: 6.006 },
        { start: 6.006, duration: 10.01 },
        { start: 16.016, duration: 2.5 },
      ],
      "playSessionId=S",
    );
    expect(p).toContain("#EXT-X-VERSION:7");
    expect(p).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(p).toContain("#EXT-X-TARGETDURATION:11"); // ceil(10.01)
    expect(p).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    expect(p).toContain('#EXT-X-MAP:URI="init.mp4?playSessionId=S"');
    expect(p).toContain("#EXTINF:6.006,\nseg0.m4s?playSessionId=S");
    expect(p).toContain("#EXTINF:10.010,\nseg1.m4s?playSessionId=S");
    expect(p).toContain("#EXTINF:2.500,\nseg2.m4s?playSessionId=S");
    expect(p.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });

  it("throws on empty boundaries instead of emitting a broken playlist", () => {
    expect(() => buildMediaPlaylistFromBoundaries([], "x=1")).toThrow(/empty boundaries/);
  });
});

describe("buildSubtitleMediaPlaylist", () => {
  it("emits one full-duration VTT segment", () => {
    const p = buildSubtitleMediaPlaylist(5400.5, "/api/play/f1/subs/2.vtt?hls=1&token=T");
    expect(p).toContain("#EXT-X-TARGETDURATION:5401");
    expect(p).toContain("#EXTINF:5400.500,\n/api/play/f1/subs/2.vtt?hls=1&token=T");
    expect(p).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(p.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });
});
