export type PlaybackQualityId = "source" | "1080p" | "720p" | "480p";

export interface PlaybackQuality {
  id: PlaybackQualityId;
  label: string;
  width: number | null;
  height: number | null;
  bandwidth: number;
  targetVideoBitrate: number | null;
}

const QUALITY_TARGETS: Array<{
  id: Exclude<PlaybackQualityId, "source">;
  height: number;
  bandwidth: number;
  targetVideoBitrate: number;
}> = [
  { id: "1080p", height: 1080, bandwidth: 5_500_000, targetVideoBitrate: 5_000_000 },
  { id: "720p", height: 720, bandwidth: 3_000_000, targetVideoBitrate: 2_600_000 },
  { id: "480p", height: 480, bandwidth: 1_600_000, targetVideoBitrate: 1_300_000 },
];

function positiveInt(value: number | null | undefined): number | null {
  if (!Number.isFinite(value) || value == null || value <= 0) return null;
  return Math.floor(value);
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function widthForHeight(sourceWidth: number | null, sourceHeight: number | null, height: number): number {
  if (sourceWidth && sourceHeight) return even((sourceWidth / sourceHeight) * height);
  return even((16 / 9) * height);
}

function estimatedSourceBandwidth(height: number | null, bitrate: number | null): number {
  if (bitrate && bitrate > 0) return bitrate;
  if (!height) return 3_000_000;
  if (height > 1440) return 16_000_000;
  if (height > 1080) return 9_000_000;
  if (height > 720) return 5_500_000;
  if (height > 480) return 3_000_000;
  return 1_600_000;
}

export function buildPlaybackQualities(input: {
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
}): PlaybackQuality[] {
  const sourceWidth = positiveInt(input.width);
  const sourceHeight = positiveInt(input.height);
  const sourceBitrate = positiveInt(input.bitrate);
  const qualities: PlaybackQuality[] = [
    {
      id: "source",
      label: sourceHeight ? `Original (${sourceHeight}p)` : "Original",
      width: sourceWidth,
      height: sourceHeight,
      bandwidth: estimatedSourceBandwidth(sourceHeight, sourceBitrate),
      targetVideoBitrate: null,
    },
  ];

  if (!sourceHeight) return qualities;

  for (const target of QUALITY_TARGETS) {
    if (sourceHeight <= target.height + 16) continue;
    qualities.push({
      id: target.id,
      label: target.id,
      width: widthForHeight(sourceWidth, sourceHeight, target.height),
      height: target.height,
      bandwidth: target.bandwidth,
      targetVideoBitrate: target.targetVideoBitrate,
    });
  }

  return qualities;
}

export function isPlaybackQualityId(value: string): value is PlaybackQualityId {
  return value === "source" || value === "1080p" || value === "720p" || value === "480p";
}

export function findPlaybackQuality(
  qualities: PlaybackQuality[],
  id: string,
): PlaybackQuality | null {
  if (!isPlaybackQualityId(id)) return null;
  return qualities.find((q) => q.id === id) ?? null;
}
