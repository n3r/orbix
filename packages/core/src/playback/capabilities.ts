import type { EncoderSetting } from "./ffargs";

/** Encoder settings in the same order as the Settings dropdown. */
export const ENCODER_ORDER: EncoderSetting[] = ["software", "vaapi", "qsv", "nvenc"];

/**
 * Parse the stdout of `ffmpeg -encoders` into the set of codec names present.
 * Each encoder row is `<6-char flag column> <codec name> <description>`, listed
 * after a `------` divider. We only parse rows after the divider so header lines
 * like ` V..... = Video` are ignored.
 */
export function parseEncoderList(raw: string): Set<string> {
  const lines = raw.split(/\r?\n/);
  const dividerIdx = lines.findIndex((l) => /^\s*-{4,}\s*$/.test(l));
  const body = dividerIdx >= 0 ? lines.slice(dividerIdx + 1) : lines;
  const names = new Set<string>();
  for (const line of body) {
    // 6-char flag column, whitespace, then the codec token.
    const m = line.match(/^\s*\S{6}\s+(\S+)/);
    if (m) names.add(m[1]);
  }
  return names;
}

// A fraction-of-a-second synthetic input, muxed to the null sink so nothing is
// written to disk. Placed after `-i` so `-frames:v` bounds the output.
const TEST_INPUT = [
  "-f", "lavfi",
  "-i", "testsrc=duration=0.1:size=320x240:rate=25",
  "-frames:v", "3",
];
const HEAD = ["-hide_banner", "-nostdin"];
const NULL_OUT = ["-f", "null", "-"];

/**
 * Build the ffmpeg argument list for a tiny test-encode of one encoder. The
 * hardware paths must upload frames to the GPU first (a bare `-c:v h264_vaapi`
 * on a CPU-memory input fails even when VAAPI works), so each encoder gets its
 * own recipe.
 */
export function buildEncoderTestArgs(
  encoder: EncoderSetting,
  opts: { vaapiDevice: string },
): string[] {
  switch (encoder) {
    case "software":
      return [...HEAD, ...TEST_INPUT, "-c:v", "libx264", "-preset", "ultrafast", ...NULL_OUT];
    case "nvenc":
      // NVENC accepts system-memory frames and uploads internally.
      return [...HEAD, ...TEST_INPUT, "-c:v", "h264_nvenc", ...NULL_OUT];
    case "vaapi":
      return [
        ...HEAD,
        "-vaapi_device", opts.vaapiDevice,
        ...TEST_INPUT,
        "-vf", "format=nv12,hwupload",
        "-c:v", "h264_vaapi",
        ...NULL_OUT,
      ];
    case "qsv":
      return [
        ...HEAD,
        ...TEST_INPUT,
        "-vf", "hwupload=extra_hw_frames=64,format=qsv",
        "-c:v", "h264_qsv",
        ...NULL_OUT,
      ];
  }
}
