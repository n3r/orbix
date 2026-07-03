export interface CleanedChannelName {
  name: string;
  quality: string | null;
  label: string | null;
}

// "RU| ПЕРВЫЙ", "USA| CNN" — 2-3 uppercase ASCII letters + a pipe.
const COUNTRY_PREFIX_RE = /^[A-Z]{2,3}\s*\|\s*/;
// Resolution token, optionally parenthesised: 1080p, 576i, (720p) …
const RESOLUTION_RE = /\(?\b(\d{3,4}[pi])\b\)?/i;
// Bare quality words; stripped from the name, used as quality only when no
// resolution token exists ("CNN HD" → quality "HD").
const QUALITY_WORD_RE = /\b(UHD|FHD|HD|SD|4K|8K)\b/gi;
// Bracketed status suffixes: [Not 24/7], [Geo-blocked] …
const BRACKET_RE = /\[([^\]]*)\]/g;

/**
 * Clean a raw playlist channel name ("RU| ПЕРВЫЙ HD 1080p") into a display
 * name plus extracted quality ("1080p" | "576i" | "HD" | null) and status
 * label ("Not 24/7" | "Geo-blocked" | null). Idempotent: cleaning an
 * already-clean name returns it unchanged.
 */
export function cleanChannelName(raw: string): CleanedChannelName {
  let s = raw.trim();
  let label: string | null = null;
  let quality: string | null = null;

  s = s.replace(COUNTRY_PREFIX_RE, "");

  s = s.replace(BRACKET_RE, (_m: string, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed && label == null) label = trimmed; // first bracket wins
    return " ";
  });

  const res = RESOLUTION_RE.exec(s);
  if (res) {
    quality = res[1].toLowerCase();
    s = s.replace(res[0], " ");
  }

  const words = [...s.matchAll(QUALITY_WORD_RE)];
  if (words.length > 0) {
    if (quality == null) quality = words[0][1].toUpperCase();
    s = s.replace(QUALITY_WORD_RE, " ");
  }

  s = s.replace(/\(\s*\)/g, " "); // leftover empty parens
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/[\s\-–—|]+$/g, "").trim(); // trailing separators

  return { name: s.length > 0 ? s : raw.trim(), quality, label };
}
