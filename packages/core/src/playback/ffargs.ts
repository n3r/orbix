export interface HlsArgsOpts {
  input: string;
  startSegment: number;
  segSec: number;
  outDir: string;
  mode: "remux" | "transcode";
  audioAction: "copy" | "aac";
  encoder?: "libx264";
}

export function buildHlsArgs(opts: HlsArgsOpts): string[] {
  const { input, startSegment, segSec, outDir, mode, audioAction, encoder } = opts;

  const args: string[] = [];

  // 1. Input-side seek (before -i) when resuming
  if (startSegment > 0) {
    args.push("-ss", String(startSegment * segSec));
  }

  // 2. Input
  args.push("-i", input);

  // 3. Stream mapping
  args.push("-map", "0:v:0", "-map", "0:a:0");

  // 4. Video codec
  if (mode === "remux") {
    args.push("-c:v", "copy");
  } else {
    const videoEncoder = encoder ?? "libx264";
    args.push("-c:v", videoEncoder, "-preset", "veryfast", "-crf", "21");
  }

  // 5. Audio codec
  if (audioAction === "copy") {
    args.push("-c:a", "copy");
  } else {
    args.push("-c:a", "aac", "-b:a", "192k");
  }

  // 6. HLS muxer flags
  args.push(
    "-f", "hls",
    "-hls_segment_type", "fmp4",
    "-hls_time", String(segSec),
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-start_number", String(startSegment),
    "-hls_segment_filename", `${outDir}/seg%d.m4s`,
    "-hls_fmp4_init_filename", "init.mp4",
    `${outDir}/index_live.m3u8`,
  );

  return args;
}
