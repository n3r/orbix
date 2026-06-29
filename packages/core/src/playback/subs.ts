/**
 * Convert an SRT subtitle string to WebVTT format.
 *
 * The conversion:
 * - Prepends "WEBVTT\n\n"
 * - Replaces SRT timestamp commas with dots (e.g. 00:00:01,000 → 00:00:01.000)
 * - SRT numeric counter lines are valid WebVTT cue identifiers — left as-is.
 */
export function srtToVtt(srt: string): string {
  const body = srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return "WEBVTT\n\n" + body;
}
