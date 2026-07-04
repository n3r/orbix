import { describe, it, expect } from "vitest";
import {
  createXmltvCollector,
  parseXmltvDate,
  type XmltvChannelName,
  type XmltvProgramme,
} from "./xmltv";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="ChannelOne.ru">
    <display-name>Первый канал</display-name>
    <display-name>Channel One</display-name>
  </channel>
  <channel id="zdf.de">
    <display-name>ZDF HD</display-name>
  </channel>
  <programme start="20260703193000 +0300" stop="20260703210000 +0300" channel="ChannelOne.ru">
    <title lang="ru">Время</title>
    <title lang="en">Vremya</title>
    <desc lang="ru">Информационная программа.</desc>
    <category lang="ru">Новости</category>
    <category lang="ru">Инфо</category>
  </programme>
  <programme start="20260703100000 +0300" stop="20260703110000 +0300" channel="ChannelOne.ru">
    <title>Доброе утро</title>
  </programme>
  <programme start="20260703190000" stop="20260703200000" channel="untracked.id">
    <title>Skip me</title>
  </programme>
</tv>`;

const windowStart = new Date("2026-07-03T12:00:00.000Z");
const windowEnd = new Date("2026-07-05T12:00:00.000Z");

function collect(opts: { wantedIds: Set<string> | null; offsetMin?: number }) {
  const programmes: XmltvProgramme[] = [];
  const channels: XmltvChannelName[] = [];
  const c = createXmltvCollector({
    wantedIds: opts.wantedIds,
    offsetMin: opts.offsetMin ?? 0,
    windowStart,
    windowEnd,
    onProgramme: (p) => programmes.push(p),
    onChannel: (ch) => channels.push(ch),
  });
  return { c, programmes, channels };
}

describe("parseXmltvDate", () => {
  it("parses full form with offset", () => {
    expect(parseXmltvDate("20260703193000 +0300")?.toISOString()).toBe("2026-07-03T16:30:00.000Z");
  });
  it("parses a negative offset", () => {
    expect(parseXmltvDate("20260703193000 -0500")?.toISOString()).toBe("2026-07-04T00:30:00.000Z");
  });
  it("tolerates a missing offset as UTC", () => {
    expect(parseXmltvDate("20260703193000")?.toISOString()).toBe("2026-07-03T19:30:00.000Z");
  });
  it("tolerates missing seconds", () => {
    expect(parseXmltvDate("202607031930 +0000")?.toISOString()).toBe("2026-07-03T19:30:00.000Z");
  });
  it("returns null on garbage", () => {
    expect(parseXmltvDate("not-a-date")).toBeNull();
    expect(parseXmltvDate("")).toBeNull();
  });
});

describe("createXmltvCollector", () => {
  it("collects wanted programmes inside the window; first title/category win; lang from first title", () => {
    // wantedIds is matched case-insensitively — the collector requires callers to
    // pass lowercased ids, so this (and every other fixture below) is lowercased.
    const { c, programmes } = collect({ wantedIds: new Set(["channelone.ru", "zdf.de"]) });
    c.write(XML);
    c.end();
    // programme 2 (07:00–08:00Z) ends before windowStart → dropped; programme 3 untracked → dropped
    expect(programmes).toHaveLength(1);
    const p = programmes[0];
    expect(p.epgId).toBe("ChannelOne.ru");
    expect(p.title).toBe("Время");
    expect(p.lang).toBe("ru");
    expect(p.description).toBe("Информационная программа.");
    expect(p.category).toBe("Новости");
    expect(p.start.toISOString()).toBe("2026-07-03T16:30:00.000Z");
    expect(p.stop.toISOString()).toBe("2026-07-03T18:00:00.000Z");
  });

  it("applies offsetMin AFTER parsing", () => {
    const { c, programmes } = collect({ wantedIds: new Set(["channelone.ru"]), offsetMin: 60 });
    c.write(XML);
    c.end();
    expect(programmes[0].start.toISOString()).toBe("2026-07-03T17:30:00.000Z");
    expect(programmes[0].stop.toISOString()).toBe("2026-07-03T19:00:00.000Z");
  });

  it("emits channel display-names via onChannel", () => {
    const { c, channels } = collect({ wantedIds: new Set(["channelone.ru"]) });
    c.write(XML);
    c.end();
    expect(channels).toEqual([
      { id: "ChannelOne.ru", names: ["Первый канал", "Channel One"] },
      { id: "zdf.de", names: ["ZDF HD"] },
    ]);
  });

  it("wantedIds null = discovery pass: channels only, zero programmes", () => {
    const { c, programmes, channels } = collect({ wantedIds: null });
    c.write(XML);
    c.end();
    expect(programmes).toHaveLength(0);
    expect(channels).toHaveLength(2);
  });

  it("is chunk-boundary safe (split mid-tag and mid-Cyrillic text)", () => {
    const { c, programmes, channels } = collect({ wantedIds: new Set(["channelone.ru"]) });
    const cut1 = XML.indexOf("Первый кан") + 9; // inside a Cyrillic display-name
    const cut2 = XML.indexOf("<programme") + 5; // inside a tag name
    c.write(XML.slice(0, cut1));
    c.write(XML.slice(cut1, cut2));
    c.write(XML.slice(cut2));
    c.end();
    expect(channels[0].names[0]).toBe("Первый канал");
    expect(programmes).toHaveLength(1);
    expect(programmes[0].title).toBe("Время");
  });

  it("reads wantedIds LIVE — ids added after channels streamed are honored for later programmes", () => {
    const wanted = new Set<string>();
    const programmes: XmltvProgramme[] = [];
    const c = createXmltvCollector({
      wantedIds: wanted,
      offsetMin: 0,
      windowStart,
      windowEnd,
      onProgramme: (p) => programmes.push(p),
      onChannel: (ch) => {
        if (ch.id === "ChannelOne.ru") wanted.add(ch.id.toLowerCase()); // simulate name-match admission
      },
    });
    c.write(XML);
    c.end();
    expect(programmes).toHaveLength(1);
  });

  it("skips malformed programmes (bad dates / missing title) without throwing", () => {
    const bad = `<tv><programme start="garbage" stop="20260703200000" channel="x"><title>t</title></programme>
      <programme start="20260703190000" stop="20260703200000" channel="x"></programme></tv>`;
    const { c, programmes } = collect({ wantedIds: new Set(["x"]) });
    c.write(bad);
    c.end();
    expect(programmes).toHaveLength(0);
  });
});
