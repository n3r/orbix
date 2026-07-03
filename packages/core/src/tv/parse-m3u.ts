import type { TvM3uEntry, TvM3uPlaylist } from "./types";

const ATTR_RE = /([\w-]+)="([^"]*)"/g;

/** Parse `#EXTINF:<dur> attr="v" …,Display Name` into attrs + display name. */
function parseExtinf(line: string): { attrs: Record<string, string>; name: string } {
  const body = line.slice("#EXTINF:".length);
  // Strip the duration token ("-1", "0", "12.5").
  const dur = /^\s*-?\d+(?:\.\d+)?/.exec(body);
  const rest = dur ? body.slice(dur[0].length) : body;

  const attrs: Record<string, string> = {};
  let attrsEnd = 0;
  for (const m of rest.matchAll(ATTR_RE)) {
    attrs[m[1].toLowerCase()] = m[2];
    attrsEnd = (m.index ?? 0) + m[0].length;
  }
  // The display name is everything after the comma that follows the last
  // attribute (names themselves may contain commas — take the whole tail).
  const tail = rest.slice(attrsEnd);
  const comma = tail.indexOf(",");
  const name = (comma >= 0 ? tail.slice(comma + 1) : tail).trim();
  return { attrs, name };
}

/** Split a `URL|Key=Value&Key2=Value2` pipe suffix into url + header map. */
function parsePipeSuffix(rawUrl: string): { url: string; headers: Record<string, string> } {
  const pipe = rawUrl.indexOf("|");
  if (pipe < 0) return { url: rawUrl, headers: {} };
  const headers: Record<string, string> = {};
  for (const pair of rawUrl.slice(pipe + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    headers[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
  }
  return { url: rawUrl.slice(0, pipe), headers };
}

/**
 * Parse an IPTV-dialect M3U playlist into entries + EPG URLs.
 *
 * CRLF-safe (iptv-org playlists are CRLF). Understands #EXTINF attributes
 * (tvg-id/tvg-name/tvg-logo/tvg-shift/tvg-chno/group-title incl. ";"-multi),
 * #EXTVLCOPT http-referrer/http-user-agent/http-origin, `URL|Header=Value`
 * pipe suffixes (which override #EXTVLCOPT), and the header's url-tvg /
 * x-tvg-url EPG URLs. #KODIPROP and unknown comments are tolerated and
 * ignored. URL lines with no preceding #EXTINF are skipped.
 */
export function parseM3u(text: string): TvM3uPlaylist {
  const entries: TvM3uEntry[] = [];
  const epgUrls: string[] = [];

  let pending: { attrs: Record<string, string>; name: string } | null = null;
  let vlcOpts: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line.startsWith("#EXTM3U")) {
      for (const m of line.matchAll(ATTR_RE)) {
        const key = m[1].toLowerCase();
        if (key === "url-tvg" || key === "x-tvg-url") {
          for (const u of m[2].split(",")) {
            const trimmed = u.trim();
            if (trimmed) epgUrls.push(trimmed);
          }
        }
      }
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pending = parseExtinf(line);
      vlcOpts = {};
      continue;
    }
    if (line.startsWith("#EXTVLCOPT:")) {
      const body = line.slice("#EXTVLCOPT:".length);
      const eq = body.indexOf("=");
      if (eq > 0) vlcOpts[body.slice(0, eq).trim().toLowerCase()] = body.slice(eq + 1).trim();
      continue;
    }
    if (line.startsWith("#")) continue; // #KODIPROP and other comments: tolerated, ignored

    // A URL line. Without channel info there is nothing to import — skip.
    if (!pending) continue;

    const { url, headers } = parsePipeSuffix(line);
    const attrs = pending.attrs;
    const name = pending.name || attrs["tvg-name"] || "Channel";
    const groupTitles = (attrs["group-title"] ?? "")
      .split(";")
      .map((g) => g.trim())
      .filter((g) => g.length > 0);

    // Pipe-suffix headers are the more specific form — they win over #EXTVLCOPT.
    const referrer = headers["referer"] ?? headers["referrer"] ?? vlcOpts["http-referrer"];
    const userAgent = headers["user-agent"] ?? vlcOpts["http-user-agent"];
    const origin = headers["origin"] ?? vlcOpts["http-origin"];

    entries.push({
      name,
      url,
      ...(attrs["tvg-id"] ? { tvgId: attrs["tvg-id"] } : {}),
      ...(attrs["tvg-name"] ? { tvgName: attrs["tvg-name"] } : {}),
      ...(attrs["tvg-logo"] ? { tvgLogo: attrs["tvg-logo"] } : {}),
      ...(attrs["tvg-shift"] ? { tvgShift: attrs["tvg-shift"] } : {}),
      ...(attrs["tvg-chno"] ? { tvgChno: attrs["tvg-chno"] } : {}),
      groupTitles,
      ...(referrer ? { referrer } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(origin ? { origin } : {}),
    });
    pending = null;
    vlcOpts = {};
  }

  return { entries, epgUrls };
}
