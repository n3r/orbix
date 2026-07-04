const H264_PROFILES: Record<string, string> = {
  baseline: "42",
  "constrained baseline": "42",
  main: "4D",
  high: "64",
  "high 10": "6E",
};

/** RFC 6381 codec string for the CODECS attribute; null = unknown (omit rather than lie). */
export function videoCodecString(codec: string | undefined, profile?: string, level?: number): string | null {
  if (codec === "h264") {
    const pp = H264_PROFILES[(profile ?? "high").toLowerCase()] ?? "64";
    const ll = (level && level > 0 ? level : 41).toString(16).toUpperCase().padStart(2, "0");
    return `avc1.${pp}00${ll}`;
  }
  if (codec === "hevc" || codec === "h265") {
    const p = (profile ?? "").toLowerCase();
    const isMain10 = p === "" || p.includes("10"); // default Main10: safe for 10-bit content
    const lvl = level && level > 0 ? level : 120;
    return isMain10 ? `hvc1.2.4.L${lvl}.B0` : `hvc1.1.6.L${lvl}.B0`;
  }
  return null;
}

export function audioCodecString(codec: string | undefined): string | null {
  switch (codec) {
    case "aac": return "mp4a.40.2";
    case "ac3": return "ac-3";
    case "eac3": return "ec-3";
    case "flac": return "fLaC";
    default: return null;
  }
}

/** HLS VIDEO-RANGE from ffprobe color_transfer. */
export function videoRange(colorTransfer: string | undefined): "SDR" | "PQ" | "HLG" {
  if (colorTransfer === "smpte2084") return "PQ";
  if (colorTransfer === "arib-std-b67") return "HLG";
  return "SDR";
}
