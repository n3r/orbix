/** Parse `ffprobe -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0` output. */
export function parseKeyframePackets(csv: string): number[] {
  const out: number[] = [];
  for (const line of csv.split("\n")) {
    const [pts, flags] = line.split(",");
    if (!pts || !flags || !flags.includes("K")) continue;
    const t = Number(pts);
    if (!Number.isFinite(t) || t < 0) continue;
    out.push(Math.round(t * 1000) / 1000);
  }
  out.sort((a, b) => a - b);
  return out.filter((t, i) => i === 0 || t !== out[i - 1]);
}

export interface SegmentBoundary {
  start: number;
  duration: number;
}

/**
 * Simulate ffmpeg's hls-muxer cut rule over a keyframe index: a segment ends
 * at the first keyframe whose pts >= segStart + targetSec (segments can run
 * long when GOPs exceed the target — never short); the final segment ends at
 * durationSec. The playlist built from these boundaries declares EXTINFs that
 * match what ffmpeg actually produces, which AVPlayer requires.
 */
export function computeSegmentBoundaries(
  keyframes: number[],
  durationSec: number,
  targetSec = 6,
): SegmentBoundary[] | null {
  if (keyframes.length === 0) return null;
  const out: SegmentBoundary[] = [];
  let start = keyframes[0];
  let i = 1;
  const EPS = 1e-9; // tolerance for floating-point comparison
  while (start < durationSec) {
    while (i < keyframes.length && keyframes[i] < start + targetSec - EPS) i++;
    const end = i < keyframes.length ? keyframes[i] : durationSec;
    const duration = Math.round((Math.min(end, durationSec) - start) * 1000) / 1000;
    if (duration > 0.001) out.push({ start, duration });
    if (i >= keyframes.length) break;
    start = keyframes[i];
    i++;
  }
  return out.length > 0 ? out : null;
}
