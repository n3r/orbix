// Shared stream-health transition logic — used by the POST /tv/streams/:id/health
// route (player-reported feedback), the proxy's own upstream-failure bump, and the
// nightly tv-health probe job. A single source of truth keeps the three call sites'
// degraded/dead thresholds from ever drifting apart.
export const TV_DEGRADED_AT = 3;
export const TV_DEAD_AT = 8;

export function nextStreamHealth(
  prev: { status: string; failCount: number },
  ok: boolean,
): { status: string; failCount: number } {
  if (ok) return { status: "ok", failCount: 0 };
  const failCount = prev.failCount + 1;
  const status = failCount >= TV_DEAD_AT ? "dead" : failCount >= TV_DEGRADED_AT ? "degraded" : prev.status;
  return { status, failCount };
}
