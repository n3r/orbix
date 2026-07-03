export type PlaybackPlan =
  | { mode: "direct" }
  | { mode: "remux"; audioAction: "copy" | "aac"; audioTrackIndex?: number; audioChannels?: number }
  | { mode: "transcode"; audioAction: "copy" | "aac"; audioTrackIndex?: number; audioChannels?: number };

const MP4_FAMILY_RE = /mp4|mov|m4v/i;

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
  /**
   * Direct-play containers as ffprobe format_name substrings. "mp4" implies
   * the whole MP4 family (mov/m4v); "mkv" is aliased to "matroska".
   */
  containers: string[];
  videoCodecs: string[];
  /**
   * Codecs the client decodes. AAC is the universal transcode target — every
   * profile is assumed to include "aac".
   */
  audioCodecs: string[];
  maxAudioChannels: number;
  hlsMultichannelAacBroken?: boolean;
}

function containerMatches(container: string | undefined, caps: string[]): boolean {
  if (!container) return false;
  // "mp4" implies the whole MP4 family (ffprobe reports "mov,mp4,m4a,3gp,3g2,mj2").
  if (caps.includes("mp4") && MP4_FAMILY_RE.test(container)) return true;
  // "mkv" is the conventional name; ffprobe reports "matroska,webm".
  if (caps.includes("mkv") && /matroska/i.test(container)) return true;
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
