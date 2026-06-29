/**
 * buildVodPlaylist — emit a complete VOD HLS playlist (fMP4 / CMAF) immediately,
 * before any segment exists, so the player scrubber spans the full duration.
 *
 * @param durationSec  Total video duration in seconds.
 * @param segSec       Target segment length in seconds (default 6).
 * @returns            A complete #EXTM3U playlist string.
 */
export function buildVodPlaylist(durationSec: number, segSec = 6): string {
  const targetDuration = Math.ceil(segSec);
  const fullSegments = Math.floor(durationSec / segSec);
  const remainder = durationSec - fullSegments * segSec;

  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    '#EXT-X-MAP:URI="init.mp4"',
  ];

  let segIndex = 0;

  for (let i = 0; i < fullSegments; i++) {
    lines.push(`#EXTINF:${segSec.toFixed(3)},`);
    lines.push(`seg${segIndex}.m4s`);
    segIndex++;
  }

  // Add remainder segment only if it is meaningfully non-zero (float safety).
  if (remainder > 0.001) {
    lines.push(`#EXTINF:${remainder.toFixed(3)},`);
    lines.push(`seg${segIndex}.m4s`);
  }

  lines.push("#EXT-X-ENDLIST");

  return lines.join("\n");
}
