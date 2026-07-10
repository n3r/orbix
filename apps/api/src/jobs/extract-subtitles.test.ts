import { describe, it, expect } from "vitest";
import { extractSubtitles } from "./extract-subtitles";

const TEXT_AND_IMAGE_TRACKS = [
  { index: 2, codec: "subrip", language: "en" },
  { index: 3, codec: "hdmv_pgs_subtitle", language: "ru" }, // image → never extracted
  { index: 4, codec: "ass", language: "de" },
];

function harness(opts: {
  subtitleTracks?: unknown;
  existing?: Set<string>;
  runImpl?: (filePath: string, trackIndex: number) => Promise<string>;
  file?: { id: string; path: string; subtitleTracks: unknown } | null;
} = {}) {
  const writes: { absPath: string; content: string }[] = [];
  const existing = opts.existing ?? new Set<string>();
  // Distinguish "subtitleTracks not provided" (use the default) from an explicit
  // null/[] (which must be passed through, to exercise the non-array guard).
  const subtitleTracks = "subtitleTracks" in opts ? opts.subtitleTracks : TEXT_AND_IMAGE_TRACKS;
  const file =
    opts.file === null
      ? null
      : opts.file ?? { id: "f1", path: "/media/movie.mkv", subtitleTracks };
  return {
    writes,
    deps: {
      metadataDir: "/meta",
      run: opts.runImpl ?? (async () => "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n"),
      exists: async (absPath: string) => existing.has(absPath),
      writeFile: async (absPath: string, content: string) => {
        writes.push({ absPath, content });
      },
      prisma: { mediaFile: { findUnique: async () => file } },
    },
  };
}

describe("extractSubtitles", () => {
  it("extracts every text track to a durable VTT and skips image tracks", async () => {
    const { deps, writes } = harness();
    const res = await extractSubtitles("f1", deps as never);
    expect(res).toEqual({ extracted: 2, skipped: 0, failed: 0 });
    // Only the two text tracks (2, 4) are written; the PGS track (3) is skipped entirely.
    expect(writes.map((w) => w.absPath)).toEqual([
      "/meta/subs/f1_2.vtt",
      "/meta/subs/f1_4.vtt",
    ]);
    expect(writes[0]!.content).toMatch(/^WEBVTT/);
  });

  it("is idempotent — skips tracks whose VTT already exists", async () => {
    const { deps, writes } = harness({ existing: new Set(["/meta/subs/f1_2.vtt"]) });
    const res = await extractSubtitles("f1", deps as never);
    expect(res).toEqual({ extracted: 1, skipped: 1, failed: 0 });
    expect(writes.map((w) => w.absPath)).toEqual(["/meta/subs/f1_4.vtt"]);
  });

  it("normalizes an SRT-like extraction (no WEBVTT header) to VTT", async () => {
    const { deps, writes } = harness({
      subtitleTracks: [{ index: 2, codec: "subrip", language: "en" }],
      runImpl: async () => "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
    });
    await extractSubtitles("f1", deps as never);
    expect(writes[0]!.content).toMatch(/^WEBVTT/);
    expect(writes[0]!.content).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("counts a failing stream without aborting the others", async () => {
    const { deps, writes } = harness({
      subtitleTracks: [
        { index: 2, codec: "subrip", language: "en" },
        { index: 4, codec: "ass", language: "de" },
      ],
      runImpl: async (_p, idx) => {
        if (idx === 2) throw new Error("bad stream");
        return "WEBVTT\n\ncue\n";
      },
    });
    const res = await extractSubtitles("f1", deps as never);
    expect(res).toEqual({ extracted: 1, skipped: 0, failed: 1 });
    expect(writes.map((w) => w.absPath)).toEqual(["/meta/subs/f1_4.vtt"]);
  });

  it("skips a missing file", async () => {
    const { deps, writes } = harness({ file: null });
    expect(await extractSubtitles("f1", deps as never)).toEqual({ skipped: "not_found" });
    expect(writes).toHaveLength(0);
  });

  it("skips a file with no text subtitle tracks", async () => {
    const { deps, writes } = harness({
      subtitleTracks: [{ index: 3, codec: "hdmv_pgs_subtitle", language: "ru" }],
    });
    expect(await extractSubtitles("f1", deps as never)).toEqual({ skipped: "no_text_tracks" });
    expect(writes).toHaveLength(0);
  });

  it("treats a non-array subtitleTracks as no tracks", async () => {
    const { deps } = harness({ subtitleTracks: null });
    expect(await extractSubtitles("f1", deps as never)).toEqual({ skipped: "no_text_tracks" });
  });
});
