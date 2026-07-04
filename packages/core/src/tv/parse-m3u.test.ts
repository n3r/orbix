import { describe, it, expect } from "vitest";
import { parseM3u } from "./parse-m3u";

// Real-world shaped playlist: CRLF line endings, #EXTVLCOPT header options,
// #KODIPROP noise, a pipe-suffixed URL, multi-category group-title, url-tvg
// with two URLs, a stray comment, and an orphan URL without #EXTINF.
const FIXTURE = [
  '#EXTM3U url-tvg="https://epg.example.one/EPG_LITE.xml.gz, https://epg.example.two/ru.xml"',
  '#EXTINF:-1 tvg-id="ChannelOne.ru" tvg-name="Первый канал" tvg-logo="https://logos.example/1tv.png" tvg-shift="+3" tvg-chno="1" group-title="Comedy;Family;Movies",RU| ПЕРВЫЙ HD 1080p',
  "#EXTVLCOPT:http-referrer=https://player.example.ru/",
  "#EXTVLCOPT:http-user-agent=Mozilla/5.0 (SmartTV; rv:120.0)",
  "#EXTVLCOPT:http-origin=https://player.example.ru",
  "#KODIPROP:inputstream.adaptive.manifest_type=hls",
  "https://cdn.example.ru/1tv/index.m3u8",
  "",
  '#EXTINF:0 group-title="News",2x2 (576i)',
  "https://cdn.example.ru/2x2/playlist.m3u8|User-Agent=TiviMate/5.1.6&Referer=https://ref.example/",
  "# a stray comment the parser must tolerate",
  "https://orphan.example/no-extinf.m3u8",
].join("\r\n");

describe("parseM3u", () => {
  it("parses entries, attributes and per-entry headers from a CRLF playlist", () => {
    const { entries, epgUrls } = parseM3u(FIXTURE);
    expect(entries).toHaveLength(2);

    expect(entries[0]).toEqual({
      name: "RU| ПЕРВЫЙ HD 1080p",
      url: "https://cdn.example.ru/1tv/index.m3u8",
      tvgId: "ChannelOne.ru",
      tvgName: "Первый канал",
      tvgLogo: "https://logos.example/1tv.png",
      tvgShift: "+3",
      tvgChno: "1",
      groupTitles: ["Comedy", "Family", "Movies"],
      referrer: "https://player.example.ru/",
      userAgent: "Mozilla/5.0 (SmartTV; rv:120.0)",
      origin: "https://player.example.ru",
    });

    expect(entries[1]).toEqual({
      name: "2x2 (576i)",
      url: "https://cdn.example.ru/2x2/playlist.m3u8",
      groupTitles: ["News"],
      userAgent: "TiviMate/5.1.6",
      referrer: "https://ref.example/",
    });

    expect(epgUrls).toEqual([
      "https://epg.example.one/EPG_LITE.xml.gz",
      "https://epg.example.two/ru.xml",
    ]);
  });

  it("skips URL lines with no preceding #EXTINF", () => {
    const { entries } = parseM3u(FIXTURE);
    expect(entries.some((e) => e.url.includes("orphan.example"))).toBe(false);
  });

  it("does not leak #EXTVLCOPT headers across entries", () => {
    const { entries } = parseM3u(FIXTURE);
    expect(entries[1].origin).toBeUndefined();
  });

  it("returns empty results for empty input", () => {
    expect(parseM3u("")).toEqual({ entries: [], epgUrls: [] });
  });

  it("keeps a pending #EXTINF across blank and comment lines", () => {
    const text = ['#EXTINF:-1 tvg-id="A.tv",A TV', "", "# note", "https://a.example/a.m3u8"].join(
      "\r\n",
    );
    const { entries } = parseM3u(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].tvgId).toBe("A.tv");
    expect(entries[0].name).toBe("A TV");
  });
});
