import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  normalizeToVtt,
  selectTextSubtitleTracks,
  subtitleVttRelPath,
  type SubtitleTrackLike,
} from "@orbix/core";

const execFileAsync = promisify(execFile);

export interface SubtitleExtractDeps {
  /** Extract one subtitle stream to raw WebVTT stdout (slow — full-file demux). */
  run: (filePath: string, trackIndex: number) => Promise<string>;
  /** Whether a persisted VTT already exists at this absolute path. */
  exists: (absPath: string) => Promise<boolean>;
  /** Persist a VTT to disk (creating parent dirs). */
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** Durable metadata root the VTTs are written under. */
  metadataDir: string;
  prisma: {
    mediaFile: {
      findUnique: (args: unknown) => Promise<{ id: string; path: string; subtitleTracks: unknown } | null>;
    };
  };
}

export type SubtitleExtractResult =
  | { extracted: number; skipped: number; failed: number }
  | { skipped: "not_found" | "no_text_tracks" };

/**
 * Pre-extract every TEXT subtitle track of one MediaFile to a durable WebVTT
 * under METADATA_DIR (keyed by fileId+trackIndex). Extraction is slow — ffmpeg
 * demuxes the whole container (tens of seconds for a feature film) — which is
 * why it runs as a background queue job, not inline in the scan.
 *
 * Idempotent: tracks whose VTT already exists are skipped, so re-running (a
 * rescan, or the backfill pass) only extracts what is missing. Image-based
 * tracks (PGS/VobSub) are never extracted — they cannot be served as VTT.
 * Per-track failures are counted and swallowed so one bad stream never fails
 * the rest.
 */
export async function extractSubtitles(
  fileId: string,
  deps: SubtitleExtractDeps,
): Promise<SubtitleExtractResult> {
  const file = await deps.prisma.mediaFile.findUnique({
    where: { id: fileId },
    select: { id: true, path: true, subtitleTracks: true },
  });
  if (!file) return { skipped: "not_found" };

  const tracks = Array.isArray(file.subtitleTracks)
    ? (file.subtitleTracks as SubtitleTrackLike[])
    : [];
  const textTracks = selectTextSubtitleTracks(tracks);
  if (textTracks.length === 0) return { skipped: "no_text_tracks" };

  let extracted = 0;
  let skipped = 0;
  let failed = 0;

  for (const track of textTracks) {
    const absPath = path.join(deps.metadataDir, subtitleVttRelPath(file.id, track.index));
    if (await deps.exists(absPath)) {
      skipped++;
      continue;
    }
    try {
      const raw = await deps.run(file.path, track.index);
      await deps.writeFile(absPath, normalizeToVtt(raw));
      extracted++;
    } catch {
      // A single unreadable/mis-tagged stream must not fail the others.
      failed++;
    }
  }

  return { extracted, skipped, failed };
}

/**
 * Real ffmpeg runner: extract one subtitle stream to WebVTT on stdout. `-v
 * quiet` keeps the pipe clean; the webvtt muxer emits a WEBVTT header for text
 * codecs (normalizeToVtt covers the rare SRT-like fallback).
 */
export function subtitleExtractRunner(filePath: string, trackIndex: number): Promise<string> {
  return execFileAsync(
    "ffmpeg",
    ["-v", "quiet", "-i", filePath, "-map", `0:${trackIndex}`, "-f", "webvtt", "-"],
    { maxBuffer: 10 * 1024 * 1024 },
  ).then(({ stdout }) => stdout);
}
