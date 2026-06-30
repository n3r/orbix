// Hero backdrop fallback: when a title has no TMDB/fanart backdrop, the API
// layer grabs a representative frame from the video via ffmpeg. The timestamp
// choice is pure logic kept here so it can be unit-tested; the actual ffmpeg
// spawn + file write is supplied by the API layer (keeps core I/O-free).

/**
 * Pick a representative timestamp (seconds) to grab a frame from. Uses ~20% into
 * the runtime to avoid intros/black frames, clamped to a sane minimum. Falls
 * back to 60s when the duration is unknown.
 */
export function backdropFrameTimestampSec(durationSec: number | null | undefined): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return 60;
  }
  return Math.max(5, Math.floor(durationSec * 0.2));
}
