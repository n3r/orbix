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

/**
 * Pick a timestamp (seconds) for an episode thumbnail frame. Unlike the backdrop,
 * this stays near the start — an early frame is cheap, spoiler-free, and "1 second
 * or so" as requested — but nudged a little in (and clamped for short clips) to
 * skip pure-black opening frames. Falls back to 1s when the duration is unknown.
 */
export function episodeFrameTimestampSec(durationSec: number | null | undefined): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return 1;
  }
  return Math.min(10, Math.max(1, Math.floor(durationSec * 0.05)));
}
