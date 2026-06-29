export interface StrategyInput {
  container?: string;
  videoCodec?: string;
  audioCodecs: string[];
}

export type PlaybackPlan =
  | { mode: "direct" }
  | { mode: "remux"; audioAction: "copy" | "aac" }
  | { mode: "transcode"; audioAction: "copy" | "aac" };

const MP4_FAMILY_RE = /mp4|mov|m4v/i;

function isMp4Family(container: string | undefined): boolean {
  if (!container) return false;
  return MP4_FAMILY_RE.test(container);
}

function audioAction(audioCodecs: string[]): "copy" | "aac" {
  return audioCodecs.includes("aac") ? "copy" : "aac";
}

export function decideStrategy(input: StrategyInput): PlaybackPlan {
  const { container, videoCodec, audioCodecs } = input;

  // Rule 1: direct — MP4-family container + h264 video + aac audio present
  if (isMp4Family(container) && videoCodec === "h264" && audioCodecs.includes("aac")) {
    return { mode: "direct" };
  }

  // Rule 2: remux — h264 video (but not direct-play eligible)
  if (videoCodec === "h264") {
    return { mode: "remux", audioAction: audioAction(audioCodecs) };
  }

  // Rule 3: transcode — everything else (hevc, h265, vp9, av1, mpeg4, unknown, undefined)
  return { mode: "transcode", audioAction: audioAction(audioCodecs) };
}
