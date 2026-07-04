import type { XmltvChannelName } from "./xmltv";

// Quality/codec/junk tokens that carry no identity (same family of rules as
// cleanChannelName, kept standalone so EPG matching has no coupling to the
// playlist cleaner's exact behavior).
const JUNK_TOKENS =
  /\b(?:uhd|fhd|hd|sd|4k|8k|hevc|h265|h264|50\s?fps|60\s?fps|2160p?|1080p?|720p?|576p?|480p?|360p?)\b/gi;

/**
 * Normalize a channel name for cross-source identity comparison:
 * NFC → lowercase → strip diacritics → drop bracketed/quality junk →
 * non-alphanumerics to spaces → collapse whitespace.
 */
export function normalizeChannelName(s: string): string {
  let out = s.normalize("NFC").toLowerCase();
  out = out.normalize("NFD").replace(/[̀-ͯ]/g, ""); // strip combining marks
  out = out.replace(/\[[^\]]*\]|\([^)]*\)/g, " "); // [Not 24/7], (1080p), (backup)…
  out = out.replace(JUNK_TOKENS, " ");
  out = out.replace(/[^\p{L}\p{N}]+/gu, " "); // punctuation/symbols → space
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Map TvChannel.id -> xmltv channel id.
 * Pass 1: exact epgId match. Pass 2: unique normalized-name match — skipped
 * when the name is ambiguous on either side. Pass 2 never overrides pass 1.
 */
export function matchEpgChannels(
  channels: { id: string; epgId: string | null; name: string; altNames: string[] }[],
  xmltvChannels: XmltvChannelName[],
): Map<string, string> {
  const out = new Map<string, string>();
  const xmltvIds = new Set(xmltvChannels.map((c) => c.id));

  // Pass 1 — exact epgId
  for (const ch of channels) {
    if (ch.epgId && xmltvIds.has(ch.epgId)) out.set(ch.id, ch.epgId);
  }

  // Pass 2 — unique normalized-name
  const byName = new Map<string, Set<string>>();
  for (const xc of xmltvChannels) {
    for (const n of xc.names) {
      const key = normalizeChannelName(n);
      if (!key) continue;
      let set = byName.get(key);
      if (!set) byName.set(key, (set = new Set()));
      set.add(xc.id);
    }
  }
  for (const ch of channels) {
    if (out.has(ch.id)) continue; // never override pass 1
    const candidates = new Set<string>();
    for (const n of [ch.name, ...ch.altNames]) {
      const ids = byName.get(normalizeChannelName(n));
      if (ids) for (const id of ids) candidates.add(id);
    }
    if (candidates.size === 1) out.set(ch.id, [...candidates][0]);
    // 0 → no guide for this channel; ≥2 → ambiguous, fail-safe skip
  }
  return out;
}
