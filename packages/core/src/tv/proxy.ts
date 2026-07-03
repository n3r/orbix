import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signing + rewrite helpers for the TV HLS proxy.
 *
 * Pure string/crypto transforms (node:crypto only — no IO): the api layer
 * decides what to fetch; these functions only mint/verify proxy URLs and
 * rewrite playlists so every URI a client sees points back at the proxy.
 * The signature binds (streamId, absolute upstream URL) to SESSION_SECRET so
 * the proxy only ever fetches URLs the server itself minted (anti-SSRF).
 */

/** b64url(HMAC-SHA256(secret, `${streamId}|${upstreamUrl}`)), first 32 chars. */
export function signProxyPayload(secret: string, streamId: string, upstreamUrl: string): string {
  return createHmac("sha256", secret)
    .update(`${streamId}|${upstreamUrl}`)
    .digest("base64url")
    .slice(0, 32);
}

/** Timing-safe check of a signProxyPayload signature. */
export function verifyProxyPayload(
  secret: string,
  streamId: string,
  upstreamUrl: string,
  sig: string,
): boolean {
  const expected = Buffer.from(signProxyPayload(secret, streamId, upstreamUrl));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(expected, given);
}

/** URL → base64url (the `u` query param of the /p and /s proxy routes). */
export function encodeUpstream(url: string): string {
  return Buffer.from(url, "utf8").toString("base64url");
}

/** base64url → URL string; null when undecodable or not http(s). */
export function decodeUpstream(u: string): string | null {
  if (u === "") return null;
  let decoded: string;
  try {
    decoded = Buffer.from(u, "base64url").toString("utf8");
  } catch {
    return null;
  }
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return decoded;
}

/** True when a URL's pathname looks like an HLS playlist (.m3u8 / .m3u). */
function isPlaylistUrl(absUrl: string): boolean {
  try {
    const p = new URL(absUrl).pathname.toLowerCase();
    return p.endsWith(".m3u8") || p.endsWith(".m3u");
  } catch {
    return false;
  }
}

// Tags whose URI="…" attribute must be rewritten, with the proxy kind of the
// referenced resource (keys/init sections are opaque bytes; alternate media
// and I-frame renditions are playlists).
const ATTR_URI_TAGS: [prefix: string, kind: "playlist" | "bytes"][] = [
  ["#EXT-X-KEY:", "bytes"],
  ["#EXT-X-MAP:", "bytes"],
  ["#EXT-X-MEDIA:", "playlist"],
  ["#EXT-X-I-FRAME-STREAM-INF:", "playlist"],
];

/**
 * Rewrite every URI in an HLS playlist to a proxy URL.
 * - Non-# lines are URIs: resolve against `finalBaseUrl` (the playlist's
 *   FINAL URL after redirects) → toProxy(abs, playlist|bytes by extension).
 * - URI="…" attributes on KEY/MAP/MEDIA/I-FRAME-STREAM-INF tags are resolved
 *   and rewritten with their tag's kind. Everything else passes through.
 * CRLF input is tolerated (output normalized to \n).
 */
export function rewritePlaylist(
  text: string,
  finalBaseUrl: string,
  toProxy: (absUrl: string, kind: "playlist" | "bytes") => string,
): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return line;
      if (trimmed.startsWith("#")) {
        const tag = ATTR_URI_TAGS.find(([prefix]) => trimmed.startsWith(prefix));
        if (!tag) return line;
        return line.replace(/URI="([^"]*)"/, (match, uri: string) => {
          let abs: string;
          try {
            abs = new URL(uri, finalBaseUrl).toString();
          } catch {
            return match; // unresolvable URI — leave untouched
          }
          return `URI="${toProxy(abs, tag[1])}"`;
        });
      }
      let abs: string;
      try {
        abs = new URL(trimmed, finalBaseUrl).toString();
      } catch {
        return line; // unresolvable URI line — leave untouched
      }
      return toProxy(abs, isPlaylistUrl(abs) ? "playlist" : "bytes");
    })
    .join("\n");
}

/**
 * True for IPs the proxy must never fetch (SSRF guard): v4 loopback /
 * RFC1918 / link-local / 0.0.0.0/8 and v6 loopback / unspecified /
 * link-local fe80::/10 / ULA fc00::/7, including v4-mapped v6.
 * Unparsable input is treated as private (fail-safe).
 */
export function isPrivateHost(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (mapped) return isPrivateHost(mapped[1]!);
  if (s.includes(":")) {
    if (s === "::" || s === "::1") return true;
    const first = Number.parseInt(s.split(":", 1)[0]!, 16);
    if (Number.isNaN(first)) return true; // "::…" shorthand / junk — fail safe
    if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local fe80::/10
    if (first >= 0xfc00 && first <= 0xfdff) return true; // ULA fc00::/7
    return false;
  }
  const parts = s.split(".");
  if (parts.length !== 4) return true;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return true;
  const [a, b] = nums as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
