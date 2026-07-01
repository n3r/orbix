export interface PlaybackStateLike {
  mediaItemId: string;
  positionSec: number;
  durationSec: number;
  finished: boolean;
  updatedAt: Date;
  episodeId: string;
}

/**
 * Returns true when the item is considered finished:
 * durationSec > 0 AND positionSec >= 90% of durationSec.
 */
export function isFinished(positionSec: number, durationSec: number): boolean {
  if (durationSec <= 0) return false;
  return positionSec >= 0.9 * durationSec;
}

/**
 * Returns in-progress items sorted by updatedAt descending (newest first),
 * mapped to { mediaItemId, positionSec, durationSec, episodeId }.
 *
 * In-progress: positionSec > 0 && !finished.
 */
export function continueWatching(
  states: PlaybackStateLike[]
): { mediaItemId: string; positionSec: number; durationSec: number; episodeId: string }[] {
  return states
    .filter((s) => s.positionSec > 0 && !s.finished)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map(({ mediaItemId, positionSec, durationSec, episodeId }) => ({
      mediaItemId,
      positionSec,
      durationSec,
      episodeId,
    }));
}
