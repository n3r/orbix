/** Classify a stream URL by container extension: .m3u8 → hls, .mpd → dash, else other. */
export function classifyProtocol(url: string): "hls" | "dash" | "other" {
  let probe = url;
  try {
    probe = new URL(url).pathname; // drop query/hash so "index.m3u8?token=x" classifies
  } catch {
    // not parseable as a URL — classify on the raw string
  }
  const lower = probe.toLowerCase();
  if (lower.endsWith(".m3u8")) return "hls";
  if (lower.endsWith(".mpd")) return "dash";
  return "other";
}

const STATUS_RANK: Record<string, number> = { ok: 0, unknown: 1, degraded: 2 };

/**
 * Order streams for playback: HLS only (v1 plays nothing else), dead excluded,
 * ranked by status (ok > unknown > degraded), then priority ascending.
 * Returns a new array — the input is never mutated.
 */
export function orderStreams<T extends { priority: number; status: string; protocol: string }>(
  streams: T[],
): T[] {
  return streams
    .filter((s) => s.protocol === "hls" && s.status !== "dead")
    .sort((a, b) => {
      const ra = STATUS_RANK[a.status] ?? 1;
      const rb = STATUS_RANK[b.status] ?? 1;
      if (ra !== rb) return ra - rb;
      return a.priority - b.priority;
    });
}
