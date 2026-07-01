const NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** True when `addedAt` (ISO) is within the last 14 days of `now`. */
export function isNew(addedAt: string | undefined, now: Date): boolean {
  if (!addedAt) return false;
  const added = new Date(addedAt).getTime();
  if (Number.isNaN(added)) return false;
  return now.getTime() - added <= NEW_WINDOW_MS;
}

/** Playback progress as an integer 0..100. 0 when duration is not positive. */
export function progressPct(positionSec: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return Math.min(100, Math.round((positionSec / durationSec) * 100));
}

/** Remaining time split into hours/minutes; null when duration is not positive. */
export function timeLeftParts(positionSec: number, durationSec: number): { h: number; m: number } | null {
  if (durationSec <= 0) return null;
  const leftMin = Math.max(0, Math.round((durationSec - positionSec) / 60));
  return { h: Math.floor(leftMin / 60), m: leftMin % 60 };
}

/** "S3 E4 · Old Friends" / "S1 E2"; null for a movie (null/undefined resume). */
export function resumeLabel(
  resume: { seasonNumber: number; episodeNumber: number; episodeTitle: string | null } | null | undefined,
): string | null {
  if (!resume) return null;
  const base = `S${resume.seasonNumber} E${resume.episodeNumber}`;
  return resume.episodeTitle ? `${base} · ${resume.episodeTitle}` : base;
}
