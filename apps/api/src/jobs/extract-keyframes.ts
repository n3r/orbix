import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseKeyframePackets } from "@orbix/core";

const execFileAsync = promisify(execFile);

export interface KeyframeJobDeps {
  run: (path: string) => Promise<string>;
  prisma: {
    mediaFile: {
      findUnique: (args: unknown) => Promise<{ id: string; path: string; keyframes: unknown } | null>;
      update: (args: unknown) => Promise<unknown>;
    };
  };
}

/**
 * Extract the keyframe index for one MediaFile (full-file ffprobe packet scan
 * — minutes for large files, which is why this is a queue job). Remux HLS
 * playlists are built from this index; files without it transcode instead.
 */
export async function extractKeyframes(
  fileId: string,
  deps: KeyframeJobDeps,
): Promise<{ count: number } | { skipped: string }> {
  const file = await deps.prisma.mediaFile.findUnique({
    where: { id: fileId },
    select: { id: true, path: true, keyframes: true },
  });
  if (!file) return { skipped: "not_found" };
  if (Array.isArray(file.keyframes) && file.keyframes.length > 0) return { skipped: "already_indexed" };

  const csv = await deps.run(file.path);
  const keyframes = parseKeyframePackets(csv);
  if (keyframes.length === 0) return { skipped: "no_keyframes" };

  await deps.prisma.mediaFile.update({ where: { id: fileId }, data: { keyframes } });
  return { count: keyframes.length };
}

/** Real ffprobe packet-scan runner (video stream only, CSV of pts+flags). */
export function keyframeProbeRunner(path: string): Promise<string> {
  return execFileAsync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path],
    { maxBuffer: 64 * 1024 * 1024 },
  ).then(({ stdout }) => stdout);
}
