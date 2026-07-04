/** Named encoder setting values (as stored in the DB). */
export type EncoderSetting = "software" | "vaapi" | "qsv" | "nvenc";
export type PlaybackAudioMode = "standard" | "leveled";

/** Mapping from encoder setting value to ffmpeg codec name. */
export const ENCODER_MAP: Record<string, string> = {
  software: "libx264",
  vaapi: "h264_vaapi",
  qsv: "h264_qsv",
  nvenc: "h264_nvenc",
};

export interface HlsArgsOpts {
  input: string;
  startSegment: number;
  segSec: number;
  outDir: string;
  mode: "remux" | "transcode";
  audioAction: "copy" | "aac";
  /**
   * Encoder setting value (`software`|`vaapi`|`qsv`|`nvenc`) **or** a raw
   * ffmpeg codec name (`libx264`) for backward compatibility.
   * Defaults to `"software"` (→ libx264) when omitted.
   */
  encoder?: EncoderSetting | "libx264";
  /** VAAPI render node (defaults to /dev/dri/renderD128). */
  vaapiDevice?: string;
  /** Optional downscale target for manually selected quality renditions. */
  targetHeight?: number | null;
  /** Optional target bitrate for manually selected quality renditions. */
  targetVideoBitrate?: number | null;
  /** Advanced audio processing mode. `leveled` normalizes perceived loudness. */
  audioMode?: PlaybackAudioMode;
}

export function buildHlsArgs(opts: HlsArgsOpts): string[] {
  const { input, startSegment, segSec, outDir, mode, audioAction, encoder } = opts;
  const rawEncoder = encoder ?? "software";
  const vaapiDevice = opts.vaapiDevice ?? "/dev/dri/renderD128";
  const targetHeight =
    Number.isFinite(opts.targetHeight) && opts.targetHeight != null && opts.targetHeight > 0
      ? Math.floor(opts.targetHeight)
      : null;
  const targetVideoBitrate =
    Number.isFinite(opts.targetVideoBitrate) &&
    opts.targetVideoBitrate != null &&
    opts.targetVideoBitrate > 0
      ? Math.floor(opts.targetVideoBitrate)
      : null;
  const audioMode = opts.audioMode ?? "standard";

  const args: string[] = [];

  // 0. Hardware device init — must precede -i. A bare `-c:v h264_vaapi` on a
  //    CPU-memory frame fails ("Impossible to convert between the formats"), so
  //    VAAPI needs an explicit render node here plus a hwupload filter below.
  if (mode === "transcode" && rawEncoder === "vaapi") {
    args.push("-vaapi_device", vaapiDevice);
  }

  // 1. Input-side seek (before -i) when resuming
  if (startSegment > 0) {
    args.push("-ss", String(startSegment * segSec));
  }

  // 2. Input
  args.push("-i", input);

  // 3. Stream mapping
  args.push("-map", "0:v:0", "-map", "0:a:0?");

  // 4. Video codec (+ hardware-upload pipeline for GPU encoders). Hardware
  //    encoders take frames on the GPU, so software-decoded frames are uploaded
  //    first; their rate control differs from libx264's -preset/-crf.
  if (mode === "remux") {
    args.push("-c:v", "copy");
  } else {
    const softwareFilters = targetHeight ? [`scale=-2:${targetHeight}`] : [];
    const pushTargetBitrate = () => {
      if (!targetVideoBitrate) return;
      const kbps = Math.max(1, Math.round(targetVideoBitrate / 1000));
      args.push("-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`);
    };

    switch (rawEncoder) {
      case "vaapi":
        args.push(
          "-vf",
          [
            "format=nv12",
            "hwupload",
            ...(targetHeight ? [`scale_vaapi=w=-2:h=${targetHeight}`] : []),
          ].join(","),
          "-c:v",
          "h264_vaapi",
          "-qp",
          "24",
        );
        pushTargetBitrate();
        break;
      case "qsv":
        args.push(
          "-vf",
          [
            "hwupload=extra_hw_frames=64",
            "format=qsv",
            ...(targetHeight ? [`scale_qsv=w=-2:h=${targetHeight}`] : []),
          ].join(","),
          "-c:v",
          "h264_qsv",
          "-global_quality",
          "24",
        );
        pushTargetBitrate();
        break;
      case "nvenc":
        // NVENC ingests system-memory frames directly; it only needs its own
        // quality flags (libx264's -preset/-crf are invalid here).
        if (softwareFilters.length > 0) args.push("-vf", softwareFilters.join(","));
        args.push("-c:v", "h264_nvenc", "-preset", "p5", "-cq", "23");
        pushTargetBitrate();
        break;
      default: {
        // software / libx264 / raw codec name passthrough.
        const videoEncoder = ENCODER_MAP[rawEncoder] ?? rawEncoder;
        if (softwareFilters.length > 0) args.push("-vf", softwareFilters.join(","));
        args.push("-c:v", videoEncoder, "-preset", "veryfast", "-crf", "21");
        pushTargetBitrate();
      }
    }
  }

  // 5. Audio codec. Downmix to stereo when transcoding: multichannel (5.1) AAC
  //    over hls.js/MSE fails to append in the browser — segments load but never
  //    decode (the <video> stays at readyState 0 / buffered empty, with no error).
  //    Stereo AAC is universally compatible.
  if (audioMode === "leveled") {
    args.push(
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ac",
      "2",
      "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11",
    );
  } else if (audioAction === "copy") {
    args.push("-c:a", "copy");
  } else {
    args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  }

  // 6. HLS muxer flags
  args.push(
    "-f", "hls",
    "-hls_segment_type", "fmp4",
    "-hls_time", String(segSec),
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments+temp_file",
    "-start_number", String(startSegment),
    "-hls_segment_filename", `${outDir}/seg%d.m4s`,
    "-hls_fmp4_init_filename", "init.mp4",
    `${outDir}/index_live.m3u8`,
  );

  return args;
}
