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

/**
 * Ensure a subtitle blob extracted by ffmpeg is valid WebVTT. ffmpeg's webvtt
 * muxer already emits a WEBVTT header for most text codecs (incl. subrip, where
 * it handles comma→dot); if the blob ever comes back SRT-like (no header),
 * convert it as a fallback. Pure so both the scan-time extractor and the
 * on-demand serving path share one normalization rule.
 */
export function normalizeToVtt(raw: string): string {
  return raw.trimStart().startsWith("WEBVTT") ? raw : srtToVtt(raw);
}

/**
 * Codecs that produce image-based subtitle bitmaps (PGS, VobSub, …). These
 * cannot be served as WebVTT text renditions — they need burn-in — so they are
 * never pre-extracted, never offered as an HLS subtitle rendition, and reported
 * as `burnIn` in the track list. Canonical source of truth (the api routes
 * re-export this as `IMAGE_CODECS`).
 */
export const IMAGE_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "pgssub",
  "pgs",
  "dvd_subtitle",
  "dvdsub",
  "vobsub",
  "xsub",
]);

/** Whether a codec name is an image-based subtitle (cannot be served as VTT). */
export function isImageSubtitleCodec(codec: string | null | undefined): boolean {
  return codec != null && IMAGE_SUBTITLE_CODECS.has(codec);
}

export interface SubtitleTrackLike {
  index: number;
  codec?: string | null;
  language?: string | null;
  title?: string | null;
}

/**
 * The subset of subtitle tracks that can be extracted to WebVTT — i.e. every
 * text-based track (image-based ones are excluded). Used both to decide which
 * tracks the scan-time extractor should process and which tracks may appear as
 * HLS subtitle renditions.
 */
export function selectTextSubtitleTracks<T extends SubtitleTrackLike>(tracks: T[]): T[] {
  return tracks.filter((t) => !isImageSubtitleCodec(t.codec));
}

/**
 * Metadata-relative path of a pre-extracted WebVTT for one file's subtitle
 * track. Persisted under METADATA_DIR (durable, offline-safe) keyed by
 * fileId+trackIndex so scan-time extraction, the backfill job, and the
 * on-demand serving fallback all agree on one location. Returned relative (the
 * api layer joins it with METADATA_DIR, mirroring poster/backdrop paths); the
 * inputs are a cuid + a validated integer, so there are no unsafe path chars.
 */
export function subtitleVttRelPath(fileId: string, trackIndex: number): string {
  return `subs/${fileId}_${trackIndex}.vtt`;
}

export interface SubtitleRenditionInput {
  index: number;
  codec?: string | null;
  language?: string | null;
  /** Whether the pre-extracted WebVTT already exists on disk (ready to serve instantly). */
  ready?: boolean;
}

export interface SubtitleRendition {
  index: number;
  name: string;
  language?: string;
  autoselect: boolean;
}

/**
 * Decide the HLS subtitle renditions to advertise in a master playlist.
 *
 * - Image-based tracks are dropped (they have no VTT rendition).
 * - `AUTOSELECT` is enabled ONLY for tracks whose WebVTT is already extracted
 *   and persisted (`ready`). A not-yet-extracted track stays `AUTOSELECT=NO` so
 *   AVPlayer never auto-points at a slow (~30s) live extraction and stalls
 *   `.readyToPlay` — the exact hang pre-extraction exists to prevent. Once a
 *   track is extracted (scan/backfill/first manual fetch), the next
 *   negotiation's master will flip it to `AUTOSELECT=YES`.
 */
export function selectSubtitleRenditions(tracks: SubtitleRenditionInput[]): SubtitleRendition[] {
  return selectTextSubtitleTracks(tracks).map((t) => ({
    index: t.index,
    name: t.language ?? `Track ${t.index}`,
    ...(t.language ? { language: t.language } : {}),
    autoselect: t.ready === true,
  }));
}
