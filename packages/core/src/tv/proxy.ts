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

/**
 * Length-prefix streamId so a "|" inside upstreamUrl can't be re-split into a
 * forged (streamId, url) pair that serializes to the same string — e.g.
 * ("a","b|c") and ("a|b","c") would both naively join to "a|b|c".
 */
function signingPayload(streamId: string, upstreamUrl: string): string {
  return `${streamId.length}:${streamId}|${upstreamUrl}`;
}

/**
 * b64url(HMAC-SHA256(secret, `${streamId.length}:${streamId}|${upstreamUrl}`)),
 * first 32 chars. The length prefix makes the streamId/url boundary
 * unambiguous even when upstreamUrl itself contains "|".
 */
export function signProxyPayload(secret: string, streamId: string, upstreamUrl: string): string {
  return createHmac("sha256", secret)
    .update(signingPayload(streamId, upstreamUrl))
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
        // Case-insensitive tag match (HLS tags are conventionally uppercase,
        // but a lowercase/mixed-case tag must still have its URI proxied);
        // only the match is case-folded — the emitted line keeps its
        // original casing.
        const upperTrimmed = trimmed.toUpperCase();
        const tag = ATTR_URI_TAGS.find(([prefix]) => upperTrimmed.startsWith(prefix));
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

/** Pure decimal IPv4 parser: exactly 4 dot-separated 0-255 integers, else null. */
function parseIPv4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return null;
  return nums as [number, number, number, number];
}

/** True for IPv4 octets in a range this SSRF guard treats as private/unsafe. */
function isPrivateIPv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Expand a syntactically valid IPv6 literal into its 8 numeric hextets
 * (0-0xffff each), compression-agnostic (`::1` and `0:0:0:0:0:0:0:1` both
 * expand identically). Returns null when the input isn't a valid IPv6
 * literal: more than one "::", a stray empty group, a group with non-hex or
 * more than 4 hex digits, or a group count that doesn't resolve to exactly
 * 8. Pure string logic — no node:net.
 */
function expandIPv6(raw: string): number[] | null {
  const zoneIdx = raw.indexOf("%");
  const s = zoneIdx === -1 ? raw : raw.slice(0, zoneIdx);
  if (s.length === 0) return null;

  const halves = s.split("::");
  if (halves.length > 2) return null; // "::" may appear at most once

  const toGroups = (half: string): string[] => (half === "" ? [] : half.split(":"));
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (head.some((g) => g === "") || tail.some((g) => g === "")) return null; // stray ":"

  const hexGroup = /^[0-9a-fA-F]{1,4}$/;
  if (!head.every((g) => hexGroup.test(g)) || !tail.every((g) => hexGroup.test(g))) return null;

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // "::" must stand in for at least one group
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    if (head.length !== 8) return null; // no elision — all 8 groups must be spelled out
    groups = head;
  }
  return groups.map((g) => Number.parseInt(g, 16));
}

/**
 * True for hosts the proxy must never fetch directly (SSRF guard):
 * - IPv4: loopback 127/8, RFC1918 (10/8, 172.16-31/12, 192.168/16),
 *   link-local 169.254/16, and 0/8.
 * - IPv6: loopback ::1, unspecified ::, link-local fe80::/10, ULA fc00::/7.
 * - v4-mapped v6 forms of any of the above, in dotted-quad
 *   (`::ffff:1.2.3.4`) or hex (`::ffff:AABB:CCDD`) notation.
 * - legacy v4-compatible v6 forms (`::1.2.3.4`, i.e. hex `::AABB:CCDD` with
 *   no `ffff` marker hextet) of any of the above.
 * IPv6 matching is compression-agnostic (`::1` and `0:0:0:0:0:0:0:1` alike).
 * Anything that isn't a syntactically valid IPv4 or IPv6 literal — including
 * plain hostnames — is treated as private: this is a security guard, so
 * unrecognized input must never be read as "public" (fail closed).
 */
export function isPrivateHost(ip: string): boolean {
  const s = ip.trim().toLowerCase();

  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (mappedDotted) return isPrivateHost(mappedDotted[1]!);

  const v4 = parseIPv4(s);
  if (v4) return isPrivateIPv4(v4);

  const hextets = expandIPv6(s);
  if (hextets) {
    // v4-mapped v6 spelled in hex, e.g. ::ffff:a9fe:a9fe === ::ffff:169.254.169.254.
    if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
      const a = hextets[6]! >> 8;
      const b = hextets[6]! & 0xff;
      const c = hextets[7]! >> 8;
      const d = hextets[7]! & 0xff;
      return isPrivateIPv4([a, b, c, d]);
    }
    if (hextets.every((h) => h === 0)) return true; // :: (unspecified)
    if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return true; // ::1 (loopback)
    // Legacy v4-compatible v6, e.g. ::a9fe:a9fe === ::169.254.169.254 — same
    // embedding as the v4-mapped form above but without the 0xffff marker
    // hextet. Checked after the ::/::1 special cases above (both of which
    // also satisfy "hextets[0..5] all zero"), so this never needs to
    // special-case them itself; they fall through here as embedded 0.0.0.0
    // and 0.0.0.1, both already inside the blocked 0.0.0.0/8 range.
    if (hextets.slice(0, 6).every((h) => h === 0)) {
      const a = hextets[6]! >> 8;
      const b = hextets[6]! & 0xff;
      const c = hextets[7]! >> 8;
      const d = hextets[7]! & 0xff;
      return isPrivateIPv4([a, b, c, d]);
    }
    if ((hextets[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
    if ((hextets[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
    return false;
  }

  return true; // not a recognizable IP literal — fail closed
}
