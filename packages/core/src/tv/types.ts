// ── M3U playlist shapes ──────────────────────────────────────────────────────

/** One channel entry parsed from an IPTV M3U playlist. */
export interface TvM3uEntry {
  /** Display name (text after the #EXTINF comma; falls back to tvg-name). */
  name: string;
  /** Stream URL with any `|Header=Value` pipe suffix already stripped. */
  url: string;
  tvgId?: string;
  tvgName?: string;
  tvgLogo?: string;
  /** Parsed but ignored downstream (EPG shift is a later-phase concern). */
  tvgShift?: string;
  /** Parsed but ignored downstream (provider numbers are junk — TiviMate practice). */
  tvgChno?: string;
  /** `group-title` split on ";" — a channel can sit in several groups. */
  groupTitles: string[];
  /** From #EXTVLCOPT:http-referrer or a `|Referer=` pipe suffix. */
  referrer?: string;
  /** From #EXTVLCOPT:http-user-agent or a `|User-Agent=` pipe suffix. */
  userAgent?: string;
  /** From #EXTVLCOPT:http-origin or an `|Origin=` pipe suffix. */
  origin?: string;
}

export interface TvM3uPlaylist {
  entries: TvM3uEntry[];
  /** From the #EXTM3U header's url-tvg / x-tvg-url attribute (comma-separated). */
  epgUrls: string[];
}

// ── iptv-org API shapes (https://iptv-org.github.io/api/*.json) ─────────────
// Field names mirror the upstream JSON exactly (snake_case) — these are wire
// types, not domain types.

export interface IptvOrgChannel {
  id: string;
  name: string;
  alt_names: string[];
  /** iptv-org country code — authoritative, NOT ISO ("UK", not "GB"). */
  country: string;
  categories: string[];
  is_nsfw: boolean;
  /** Closure date (channel no longer broadcasts) or null. */
  closed: string | null;
  /** Successor channel id when renamed/rebranded, or null. */
  replaced_by: string | null;
  website: string | null;
}

export interface IptvOrgFeed {
  /** Owning channel id. */
  channel: string;
  /** Feed id within the channel ("SD", "HD", "Plus1"). */
  id: string;
  name: string;
  /** Exactly one main feed per channel upstream. */
  is_main: boolean;
  languages: string[];
  format: string | null;
}

export interface IptvOrgStream {
  /** Channel id, or null when the stream is unmatched upstream. */
  channel: string | null;
  feed: string | null;
  title: string;
  url: string;
  referrer: string | null;
  user_agent: string | null;
  quality: string | null;
  label: string | null;
}

export interface IptvOrgLogo {
  channel: string;
  feed: string | null;
  url: string;
  width: number;
  height: number;
  format: string | null;
}

// ── Sync planner output ──────────────────────────────────────────────────────

export interface StreamPlan {
  url: string;
  feedId: string | null;
  quality: string | null;
  label: string | null;
  referrer: string | null;
  userAgent: string | null;
  /** Lower tried first; main-feed streams first. */
  priority: number;
  protocol: "hls" | "dash" | "other";
}

/** One channel to upsert by (sourceId, extId) — the sync job's unit of work. */
export interface ChannelUpsertPlan {
  extId: string;
  name: string;
  rawName: string | null;
  altNames: string[];
  country: string | null;
  languages: string[];
  categories: string[];
  logoUrl: string | null;
  website: string | null;
  /** XMLTV id: `extId@mainFeedId` when a main feed exists, else extId (m3u: tvg-id). */
  epgId: string | null;
  /** Best known quality across streams ("1080p"). */
  quality: string | null;
  streams: StreamPlan[];
}
