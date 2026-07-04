import { describe, it, expect } from "vitest";
import { planIptvOrgSync, planM3uSync } from "./sync-planner";
import type {
  IptvOrgChannel,
  IptvOrgFeed,
  IptvOrgLogo,
  IptvOrgStream,
  TvM3uPlaylist,
} from "./types";

function ch(
  id: string,
  name: string,
  country: string,
  extra: Partial<IptvOrgChannel> = {},
): IptvOrgChannel {
  return {
    id,
    name,
    alt_names: [],
    country,
    categories: [],
    is_nsfw: false,
    closed: null,
    replaced_by: null,
    website: null,
    ...extra,
  };
}

function st(channel: string | null, url: string, extra: Partial<IptvOrgStream> = {}): IptvOrgStream {
  return {
    channel,
    feed: null,
    title: "",
    url,
    referrer: null,
    user_agent: null,
    quality: null,
    label: null,
    ...extra,
  };
}

const channels: IptvOrgChannel[] = [
  ch("ChannelOne.ru", "Channel One", "RU", {
    alt_names: ["Первый канал"],
    categories: ["general"],
    website: "https://1tv.ru",
  }),
  ch("BBCOne.uk", "BBC One", "UK", { categories: ["general"] }),
  ch("Adult.ru", "Adult", "RU", { is_nsfw: true }),
  ch("Blocked.ru", "Blocked", "RU"),
  ch("OldName.ru", "Old Name", "RU", { closed: "2024-01-01", replaced_by: "NewName.ru" }),
  ch("NewName.ru", "New Name", "RU"),
  ch("GoneForever.ru", "Gone Forever", "RU", { closed: "2020-05-05" }),
  ch("MovedAbroad.ru", "Moved Abroad", "RU", { closed: "2023-02-02", replaced_by: "Moved.fr" }),
  ch("NoStreams.ru", "No Streams", "RU"),
  ch("Telecinco.es", "Telecinco", "ES"),
];

const feeds: IptvOrgFeed[] = [
  { channel: "ChannelOne.ru", id: "SD", name: "SD", is_main: true, languages: ["rus"], format: "576i" },
  { channel: "ChannelOne.ru", id: "HD", name: "HD", is_main: false, languages: ["rus"], format: "1080i" },
];

const streams: IptvOrgStream[] = [
  st("ChannelOne.ru", "https://cdn.example/1tv-hd.m3u8", { feed: "HD", quality: "1080p" }),
  st("ChannelOne.ru", "https://cdn.example/1tv-sd.m3u8", {
    feed: "SD",
    quality: "480p",
    referrer: "https://ref.example/",
    user_agent: "Mozilla/5.0",
  }),
  st("ChannelOne.ru", "https://mirror.example/1tv.m3u8", { label: "Not 24/7" }),
  st("ChannelOne.ru", "https://cdn.example/1tv-hd.m3u8", { feed: "HD" }), // duplicate URL
  st("BBCOne.uk", "https://bbc.example/one.mpd"),
  st("Blocked.ru", "https://blocked.example/x.m3u8"),
  st("Adult.ru", "https://adult.example/x.m3u8"),
  st("OldName.ru", "https://old.example/x.m3u8"),
  st("NewName.ru", "https://new.example/x.m3u8"),
  st("GoneForever.ru", "https://gone.example/x.m3u8"),
  st("MovedAbroad.ru", "https://moved.example/x.m3u8"),
  st("Telecinco.es", "https://t5.example/x.m3u8"),
  st(null, "https://unmatched.example/x.m3u8"), // unmatched stream — ignored
];

const logos: IptvOrgLogo[] = [
  { channel: "ChannelOne.ru", feed: null, url: "https://logos.example/1tv-small.png", width: 256, height: 256, format: "png" },
  { channel: "ChannelOne.ru", feed: "HD", url: "https://logos.example/1tv-wide.png", width: 512, height: 512, format: "png" },
  { channel: "ChannelOne.ru", feed: null, url: "https://logos.example/1tv-huge.jpg", width: 1024, height: 1024, format: "jpg" },
];

const blocklist = [{ channel: "Blocked.ru" }];

describe("planIptvOrgSync", () => {
  const plans = planIptvOrgSync({ channels, feeds, streams, logos, blocklist, countries: ["RU", "UK"] });
  const ids = plans.map((p) => p.extId);

  it("filters to enabled countries, passing iptv-org codes through verbatim (UK, not GB)", () => {
    expect(ids).toContain("BBCOne.uk");
    expect(ids).not.toContain("Telecinco.es");
  });

  it("excludes NSFW, blocklisted and stream-less channels", () => {
    expect(ids).not.toContain("Adult.ru");
    expect(ids).not.toContain("Blocked.ru");
    expect(ids).not.toContain("NoStreams.ru");
  });

  it("drops closed channels (replaced in-batch or dead-ended) but keeps one whose replacement is not importable", () => {
    expect(ids).not.toContain("OldName.ru"); // replacement NewName.ru is in this batch
    expect(ids).toContain("NewName.ru");
    expect(ids).not.toContain("GoneForever.ru"); // closed with no successor
    expect(ids).toContain("MovedAbroad.ru"); // successor Moved.fr is not importable here
  });

  it("flattens feeds main-first, dedupes stream URLs and classifies protocols", () => {
    const one = plans.find((p) => p.extId === "ChannelOne.ru")!;
    expect(one.streams.map((s) => s.url)).toEqual([
      "https://cdn.example/1tv-sd.m3u8", // main feed (SD) first
      "https://mirror.example/1tv.m3u8", // channel-level stream next
      "https://cdn.example/1tv-hd.m3u8", // other feed last; duplicate URL dropped
    ]);
    expect(one.streams.map((s) => s.priority)).toEqual([0, 1, 2]);
    expect(one.streams[0]).toMatchObject({
      feedId: "SD",
      referrer: "https://ref.example/",
      userAgent: "Mozilla/5.0",
      protocol: "hls",
    });
    expect(one.streams[1].label).toBe("Not 24/7");
    const bbc = plans.find((p) => p.extId === "BBCOne.uk")!;
    expect(bbc.streams[0].protocol).toBe("dash");
  });

  it("derives epgId from the main feed, quality from the best stream, languages from the main feed", () => {
    const one = plans.find((p) => p.extId === "ChannelOne.ru")!;
    expect(one.epgId).toBe("ChannelOne.ru@SD");
    expect(one.quality).toBe("1080p");
    expect(one.languages).toEqual(["rus"]);
    expect(one.altNames).toEqual(["Первый канал"]);
    expect(one.website).toBe("https://1tv.ru");
    expect(one.country).toBe("RU");
    expect(one.rawName).toBeNull();
    const bbc = plans.find((p) => p.extId === "BBCOne.uk")!;
    expect(bbc.epgId).toBe("BBCOne.uk"); // no feeds → bare extId
  });

  it("picks the widest PNG/SVG logo (a wider JPG loses)", () => {
    const one = plans.find((p) => p.extId === "ChannelOne.ru")!;
    expect(one.logoUrl).toBe("https://logos.example/1tv-wide.png");
    const bbc = plans.find((p) => p.extId === "BBCOne.uk")!;
    expect(bbc.logoUrl).toBeNull(); // no logos at all
  });
});

describe("planM3uSync", () => {
  const playlist: TvM3uPlaylist = {
    epgUrls: ["https://epg.example/guide.xml"],
    entries: [
      {
        name: "RU| ПЕРВЫЙ HD 1080p",
        url: "https://a.example/1tv.m3u8",
        tvgId: "ChannelOne.ru",
        tvgLogo: "https://logos.example/1tv.png",
        groupTitles: ["General", "Federal"],
        referrer: "https://ref.example/",
      },
      { name: "RU| ПЕРВЫЙ (backup)", url: "https://b.example/1tv.m3u8", tvgId: "ChannelOne.ru", groupTitles: [] },
      { name: "2x2 (576i)", url: "https://a.example/2x2.m3u8", groupTitles: ["Comedy"], userAgent: "TiviMate/5.1.6" },
    ],
  };
  const plans = planM3uSync(playlist);

  it("groups repeated tvg-ids into one channel with multiple prioritized streams", () => {
    expect(plans).toHaveLength(2);
    const one = plans[0];
    expect(one.extId).toBe("ChannelOne.ru");
    expect(one.name).toBe("ПЕРВЫЙ");
    expect(one.rawName).toBe("RU| ПЕРВЫЙ HD 1080p");
    expect(one.quality).toBe("1080p");
    expect(one.epgId).toBe("ChannelOne.ru");
    expect(one.country).toBeNull();
    expect(one.categories).toEqual(["general", "federal"]);
    expect(one.logoUrl).toBe("https://logos.example/1tv.png");
    expect(one.streams.map((s) => [s.url, s.priority])).toEqual([
      ["https://a.example/1tv.m3u8", 0],
      ["https://b.example/1tv.m3u8", 1],
    ]);
    expect(one.streams[0].referrer).toBe("https://ref.example/");
    expect(one.streams[0].protocol).toBe("hls");
  });

  it("derives a stable hashed extId when tvg-id is absent", () => {
    const two = plans[1];
    expect(two.extId).toMatch(/^m3u-[0-9a-f]{8}$/);
    expect(two.name).toBe("2x2");
    expect(two.quality).toBe("576i");
    expect(two.epgId).toBeNull();
    expect(two.streams[0].userAgent).toBe("TiviMate/5.1.6");
    const again = planM3uSync(playlist);
    expect(again[1].extId).toBe(two.extId); // stable across runs
  });
});
