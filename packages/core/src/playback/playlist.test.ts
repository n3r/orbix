import { describe, it, expect } from "vitest";
import { buildVodPlaylist } from "./playlist";

describe("buildVodPlaylist", () => {
  it("20s at 6s/seg → 4 segments (6,6,6,2), correct headers and endlist", () => {
    const playlist = buildVodPlaylist(20, 6);

    // First line is #EXTM3U
    expect(playlist.split("\n")[0]).toBe("#EXTM3U");

    // Required headers
    expect(playlist).toContain("#EXT-X-VERSION:7");
    expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(playlist).toContain("#EXT-X-TARGETDURATION:6");
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');

    // 4 segment files
    expect(playlist).toContain("seg0.m4s");
    expect(playlist).toContain("seg1.m4s");
    expect(playlist).toContain("seg2.m4s");
    expect(playlist).toContain("seg3.m4s");
    expect(playlist).not.toContain("seg4.m4s");

    // EXTINF durations
    expect(playlist).toContain("#EXTINF:6.000,");
    expect(playlist).toContain("#EXTINF:2.000,");

    // Count EXTINF lines: should be exactly 4
    const extinfCount = (playlist.match(/#EXTINF:/g) ?? []).length;
    expect(extinfCount).toBe(4);

    // Ends with #EXT-X-ENDLIST
    const lines = playlist.split("\n").filter((l) => l.trim() !== "");
    expect(lines[lines.length - 1]).toBe("#EXT-X-ENDLIST");
  });

  it("12s at 6s/seg → exactly 2 full segments, no remainder", () => {
    const playlist = buildVodPlaylist(12, 6);

    expect(playlist).toContain("seg0.m4s");
    expect(playlist).toContain("seg1.m4s");
    expect(playlist).not.toContain("seg2.m4s");

    const extinfCount = (playlist.match(/#EXTINF:/g) ?? []).length;
    expect(extinfCount).toBe(2);

    // Both are full 6s segments
    const extinfLines = playlist.split("\n").filter((l) => l.startsWith("#EXTINF:"));
    expect(extinfLines).toEqual(["#EXTINF:6.000,", "#EXTINF:6.000,"]);
  });

  it("6s at 6s/seg → exactly 1 segment", () => {
    const playlist = buildVodPlaylist(6, 6);

    expect(playlist).toContain("seg0.m4s");
    expect(playlist).not.toContain("seg1.m4s");

    const extinfCount = (playlist.match(/#EXTINF:/g) ?? []).length;
    expect(extinfCount).toBe(1);
  });

  it("targetduration line equals ceil(segSec)", () => {
    const playlist = buildVodPlaylist(20, 6);
    expect(playlist).toContain("#EXT-X-TARGETDURATION:6");
  });

  it("default segSec is 6 when omitted", () => {
    const playlist = buildVodPlaylist(12);
    const extinfLines = playlist.split("\n").filter((l) => l.startsWith("#EXTINF:"));
    expect(extinfLines).toEqual(["#EXTINF:6.000,", "#EXTINF:6.000,"]);
  });

  it("non-integer segment size: targetduration is ceil", () => {
    // segSec = 5.5 → ceil = 6
    const playlist = buildVodPlaylist(11, 5.5);
    expect(playlist).toContain("#EXT-X-TARGETDURATION:6");
    const extinfLines = playlist.split("\n").filter((l) => l.startsWith("#EXTINF:"));
    expect(extinfLines).toEqual(["#EXTINF:5.500,", "#EXTINF:5.500,"]);
  });
});
