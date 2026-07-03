import type { SegmentBoundary } from "./keyframes";

export interface MultivariantOpts {
  mediaUri: string;
  bandwidth: number;
  averageBandwidth?: number;
  codecs: string[];
  resolution?: { width: number; height: number };
  frameRate?: number;
  videoRange?: "SDR" | "PQ" | "HLG";
  subtitles?: { name: string; language?: string; uri: string; autoselect?: boolean }[];
}

/** Apple-spec multivariant playlist: one variant + optional subtitle renditions. */
export function buildMultivariantPlaylist(opts: MultivariantOpts): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];

  for (const s of opts.subtitles ?? []) {
    const attrs = [
      "TYPE=SUBTITLES",
      'GROUP-ID="subs"',
      `NAME="${s.name}"`,
      ...(s.language ? [`LANGUAGE="${s.language}"`] : []),
      `AUTOSELECT=${s.autoselect === false ? "NO" : "YES"}`,
      `URI="${s.uri}"`,
    ];
    lines.push(`#EXT-X-MEDIA:${attrs.join(",")}`);
  }

  const attrs = [
    `BANDWIDTH=${Math.round(opts.bandwidth)}`,
    `AVERAGE-BANDWIDTH=${Math.round(opts.averageBandwidth ?? opts.bandwidth)}`,
  ];
  if (opts.codecs.length > 0) attrs.push(`CODECS="${opts.codecs.join(",")}"`);
  if (opts.resolution) attrs.push(`RESOLUTION=${opts.resolution.width}x${opts.resolution.height}`);
  if (opts.frameRate) attrs.push(`FRAME-RATE=${trimFixed(opts.frameRate)}`);
  if (opts.videoRange === "PQ" || opts.videoRange === "HLG") attrs.push(`VIDEO-RANGE=${opts.videoRange}`);
  if ((opts.subtitles ?? []).length > 0) attrs.push('SUBTITLES="subs"');

  lines.push(`#EXT-X-STREAM-INF:${attrs.join(",")}`, opts.mediaUri);
  return lines.join("\n");
}

/** Media playlist whose EXTINFs come from real keyframe-derived boundaries. */
export function buildMediaPlaylistFromBoundaries(boundaries: SegmentBoundary[], query?: string): string {
  const suffix = query ? `?${query}` : "";
  const target = Math.ceil(Math.max(...boundaries.map((b) => b.duration)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="init.mp4${suffix}"`,
  ];
  boundaries.forEach((b, i) => {
    lines.push(`#EXTINF:${b.duration.toFixed(3)},`, `seg${i}.m4s${suffix}`);
  });
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

/** Full-duration single-segment WebVTT rendition playlist (Apple rule 5.5). */
export function buildSubtitleMediaPlaylist(durationSec: number, vttUri: string): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${Math.ceil(durationSec)}`,
    `#EXTINF:${durationSec.toFixed(3)},`,
    vttUri,
    "#EXT-X-ENDLIST",
  ].join("\n");
}

function trimFixed(n: number): string {
  return n.toFixed(3).replace(/\.?0+$/, "");
}
