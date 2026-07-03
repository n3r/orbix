export interface StrategyInput {
  container?: string;
  videoCodec?: string;
  audioCodecs: string[];
}

export type PlaybackPlan =
  | { mode: "direct" }
  | { mode: "remux"; audioAction: "copy" | "aac"; audioTrackIndex?: number; audioChannels?: number }
  | { mode: "transcode"; audioAction: "copy" | "aac"; audioTrackIndex?: number; audioChannels?: number };

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

export interface AudioTrack {
  index: number; // ffprobe ABSOLUTE stream index (as stored in MediaFile.audioTracks)
  codec?: string;
  channels?: number;
  language?: string;
}

export interface StrategySource2 {
  container?: string;
  videoCodec?: string;
  audioTracks: AudioTrack[];
}

export interface ClientCapabilities {
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  maxAudioChannels: number;
  hlsMultichannelAacBroken?: boolean;
}

function containerMatches(container: string | undefined, caps: string[]): boolean {
  if (!container) return false;
  // "mp4" implies the whole MP4 family (ffprobe reports "mov,mp4,m4a,3gp,3g2,mj2").
  if (caps.includes("mp4") && MP4_FAMILY_RE.test(container)) return true;
  return caps.some((c) => container.toLowerCase().includes(c.toLowerCase()));
}

/**
 * Capability-aware playback decision. `opts.audioTrackIndex` is the
 * audio-RELATIVE position within source.audioTracks (what ffmpeg -map 0:a:N
 * takes) — NOT the absolute stream index stored in each track's `index`.
 */
export function decidePlayback(
  source: StrategySource2,
  caps: ClientCapabilities,
  opts?: { audioTrackIndex?: number },
): PlaybackPlan {
  const audioTrackIndex = opts?.audioTrackIndex ?? 0;
  const track = source.audioTracks[audioTrackIndex];
  const videoOk = source.videoCodec !== undefined && caps.videoCodecs.includes(source.videoCodec);

  if (
    audioTrackIndex === 0 &&
    videoOk &&
    containerMatches(source.container, caps.containers) &&
    track?.codec !== undefined &&
    caps.audioCodecs.includes(track.codec)
    // No channel constraint here: progressive playback decodes natively; the
    // multichannel-AAC quirk below is HLS/MSE-specific.
  ) {
    return { mode: "direct" };
  }

  const channels = track?.channels ?? 2;
  const copyOk =
    track?.codec !== undefined &&
    caps.audioCodecs.includes(track.codec) &&
    channels <= caps.maxAudioChannels &&
    !(caps.hlsMultichannelAacBroken && track.codec === "aac" && channels > 2);

  const audio = copyOk
    ? { audioAction: "copy" as const, audioChannels: channels }
    : { audioAction: "aac" as const, audioChannels: Math.max(1, Math.min(channels, caps.maxAudioChannels)) };

  const mode = videoOk ? ("remux" as const) : ("transcode" as const);
  return { mode, ...audio, audioTrackIndex };
}
