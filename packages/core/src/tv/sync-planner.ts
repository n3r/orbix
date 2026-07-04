import type {
  ChannelUpsertPlan,
  IptvOrgChannel,
  IptvOrgFeed,
  IptvOrgLogo,
  IptvOrgStream,
  StreamPlan,
  TvM3uPlaylist,
} from "./types";
import { classifyProtocol } from "./pick-stream";
import { cleanChannelName } from "./clean-name";

// ── shared helpers ───────────────────────────────────────────────────────────

/** Numeric height of a quality token ("1080p" → 1080); 0 when unknown. */
function qualityHeight(q: string | null | undefined): number {
  if (!q) return 0;
  const m = /^(\d{3,4})[pi]/i.exec(q.trim());
  return m ? Number(m[1]) : 0;
}

/** Highest-resolution stream quality among a plan's streams, else null. */
function bestQuality(streams: StreamPlan[]): string | null {
  let best: string | null = null;
  for (const s of streams) {
    if (s.quality && qualityHeight(s.quality) >= qualityHeight(best)) best = s.quality;
  }
  return best;
}

// ── iptv-org ─────────────────────────────────────────────────────────────────

const LOGO_FORMAT_PREF: Record<string, number> = { svg: 0, png: 0 };

/**
 * Best logo for a channel: PNG/SVG preferred over lossy formats, then widest,
 * then channel-level (feed == null) over feed-specific.
 */
function pickLogo(logos: IptvOrgLogo[]): string | null {
  if (logos.length === 0) return null;
  const ranked = [...logos].sort((a, b) => {
    const fa = LOGO_FORMAT_PREF[(a.format ?? "").toLowerCase()] ?? 1;
    const fb = LOGO_FORMAT_PREF[(b.format ?? "").toLowerCase()] ?? 1;
    if (fa !== fb) return fa - fb;
    if (a.width !== b.width) return b.width - a.width;
    return (a.feed == null ? 0 : 1) - (b.feed == null ? 0 : 1);
  });
  return ranked[0].url;
}

/**
 * Plan an iptv-org catalog sync: filter to enabled countries (their codes are
 * authoritative — "UK", not "GB"; no ISO mapping), drop NSFW / blocklisted /
 * stream-less channels, apply the closed-channel rule, flatten feeds
 * (main-first priority, URL-deduped), and pick epgId/quality/logo.
 *
 * Closed-channel rule: a closed channel with no successor is dead — dropped;
 * a closed channel whose `replaced_by` successor is itself in this batch is a
 * duplicate of the successor — dropped; a closed channel whose successor is
 * NOT importable here (other country, no streams…) is kept so the household
 * doesn't lose a still-working stream.
 */
export function planIptvOrgSync(input: {
  channels: IptvOrgChannel[];
  feeds: IptvOrgFeed[];
  streams: IptvOrgStream[];
  logos: IptvOrgLogo[];
  blocklist: { channel: string }[];
  countries: string[];
}): ChannelUpsertPlan[] {
  const countrySet = new Set(input.countries.map((c) => c.trim().toUpperCase()));
  const blocked = new Set(input.blocklist.map((b) => b.channel));

  const streamsByChannel = new Map<string, IptvOrgStream[]>();
  for (const s of input.streams) {
    if (!s.channel) continue; // unmatched upstream — nothing to attach to
    const list = streamsByChannel.get(s.channel);
    if (list) list.push(s);
    else streamsByChannel.set(s.channel, [s]);
  }

  const mainFeedByChannel = new Map<string, IptvOrgFeed>();
  for (const f of input.feeds) {
    if (f.is_main) mainFeedByChannel.set(f.channel, f);
  }

  const logosByChannel = new Map<string, IptvOrgLogo[]>();
  for (const l of input.logos) {
    const list = logosByChannel.get(l.channel);
    if (list) list.push(l);
    else logosByChannel.set(l.channel, [l]);
  }

  // Pass 1: candidates — enabled country, not NSFW, not blocklisted, ≥1 stream.
  const candidates = input.channels.filter(
    (c) =>
      countrySet.has(c.country.toUpperCase()) &&
      !c.is_nsfw &&
      !blocked.has(c.id) &&
      (streamsByChannel.get(c.id)?.length ?? 0) > 0,
  );
  const candidateIds = new Set(candidates.map((c) => c.id));

  // Pass 2: the closed-channel rule (see doc comment above).
  const included = candidates.filter((c) => {
    if (c.closed == null) return true;
    if (c.replaced_by == null) return false;
    return !candidateIds.has(c.replaced_by);
  });

  const plans: ChannelUpsertPlan[] = [];
  for (const c of included) {
    const mainFeed = mainFeedByChannel.get(c.id) ?? null;
    const raw = streamsByChannel.get(c.id) ?? [];

    // Main-feed streams first, then channel-level (feed == null), then other
    // feeds; Array.sort is stable, so upstream order holds within each group.
    const rank = (s: IptvOrgStream): number =>
      s.feed != null && s.feed === mainFeed?.id ? 0 : s.feed == null ? 1 : 2;
    const ordered = [...raw].sort((a, b) => rank(a) - rank(b));

    const seenUrls = new Set<string>();
    const streams: StreamPlan[] = [];
    for (const s of ordered) {
      if (seenUrls.has(s.url)) continue; // dedupe by URL, first occurrence wins
      seenUrls.add(s.url);
      streams.push({
        url: s.url,
        feedId: s.feed,
        quality: s.quality,
        label: s.label,
        referrer: s.referrer,
        userAgent: s.user_agent,
        priority: streams.length,
        protocol: classifyProtocol(s.url),
      });
    }

    plans.push({
      extId: c.id,
      name: c.name,
      rawName: null, // iptv-org names are already clean
      altNames: c.alt_names,
      country: c.country,
      languages: mainFeed?.languages ?? [], // channels.json carries no languages; the main feed does
      categories: c.categories,
      logoUrl: pickLogo(logosByChannel.get(c.id) ?? []),
      website: c.website,
      epgId: mainFeed ? `${c.id}@${mainFeed.id}` : c.id,
      quality: bestQuality(streams),
      streams,
    });
  }
  return plans;
}

// ── M3U ──────────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit hex hash — stable extId for entries without a tvg-id. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Plan an M3U playlist sync: one channel per tvg-id (repeats become alternate
 * streams, URL-deduped), stable hashed extId when tvg-id is absent, cleaned
 * display names (raw kept in rawName), lowercased group-titles as categories,
 * epgId = tvg-id (the XMLTV id convention in the m3u world) or null.
 */
export function planM3uSync(playlist: TvM3uPlaylist): ChannelUpsertPlan[] {
  const byExtId = new Map<string, ChannelUpsertPlan>();

  for (const entry of playlist.entries) {
    const cleaned = cleanChannelName(entry.name);
    const extId = entry.tvgId ?? `m3u-${fnv1a(`${entry.name}|${entry.url}`)}`;
    const stream: StreamPlan = {
      url: entry.url,
      feedId: null,
      quality: cleaned.quality,
      label: cleaned.label,
      referrer: entry.referrer ?? null,
      userAgent: entry.userAgent ?? null,
      priority: 0, // adjusted below when appending to an existing channel
      protocol: classifyProtocol(entry.url),
    };

    const existing = byExtId.get(extId);
    if (existing) {
      // Same tvg-id again: an alternate stream for the same channel.
      if (!existing.streams.some((s) => s.url === stream.url)) {
        stream.priority = existing.streams.length;
        existing.streams.push(stream);
      }
      if (existing.quality == null && cleaned.quality != null) existing.quality = cleaned.quality;
      if (existing.logoUrl == null && entry.tvgLogo) existing.logoUrl = entry.tvgLogo;
      continue;
    }

    byExtId.set(extId, {
      extId,
      name: cleaned.name,
      rawName: entry.name,
      altNames: [],
      country: null, // m3u playlists carry no reliable country signal
      languages: [],
      categories: entry.groupTitles.map((g) => g.trim().toLowerCase()).filter((g) => g.length > 0),
      logoUrl: entry.tvgLogo ?? null,
      website: null,
      epgId: entry.tvgId ?? null,
      quality: cleaned.quality,
      streams: [stream],
    });
  }

  return [...byExtId.values()];
}
