import { describe, it, expect } from "vitest";
import { matchEpgChannels, normalizeChannelName } from "./epg-match";

describe("normalizeChannelName", () => {
  it("lowercases, strips quality suffixes and collapses spaces", () => {
    expect(normalizeChannelName("ZDF HD")).toBe("zdf");
    expect(normalizeChannelName("TF1  (1080p)")).toBe("tf1");
    expect(normalizeChannelName("Rai 1 [Not 24/7]")).toBe("rai 1");
    expect(normalizeChannelName("Channel One FHD 50fps")).toBe("channel one");
  });
  it("strips diacritics and normalizes unicode", () => {
    expect(normalizeChannelName("Première")).toBe("premiere");
    expect(normalizeChannelName("México TV")).toBe("mexico tv");
  });
  it("handles Cyrillic consistently on both sides", () => {
    expect(normalizeChannelName("Первый канал HD")).toBe(normalizeChannelName("ПЕРВЫЙ КАНАЛ"));
  });
  it("keeps timeshift digits distinct", () => {
    expect(normalizeChannelName("Первый канал +1")).not.toBe(normalizeChannelName("Первый канал"));
  });
});

describe("matchEpgChannels", () => {
  const xmltv = [
    { id: "ChannelOne.ru", names: ["Первый канал", "Channel One"] },
    { id: "zdf.de", names: ["ZDF"] },
    { id: "dup-a.tv", names: ["Duplicate"] },
    { id: "dup-b.tv", names: ["Duplicate"] },
  ];

  it("pass 1: exact epgId match", () => {
    const out = matchEpgChannels(
      [{ id: "c1", epgId: "zdf.de", name: "Whatever", altNames: [] }],
      xmltv,
    );
    expect(out.get("c1")).toBe("zdf.de");
  });

  it("pass 2: unique normalized-name match via name or altNames", () => {
    const out = matchEpgChannels(
      [
        { id: "c1", epgId: null, name: "ZDF HD", altNames: [] },
        { id: "c2", epgId: "missing.id", name: "x", altNames: ["Первый канал HD"] },
      ],
      xmltv,
    );
    expect(out.get("c1")).toBe("zdf.de");
    expect(out.get("c2")).toBe("ChannelOne.ru");
  });

  it("skips ambiguous names (two xmltv ids share the normalized name)", () => {
    const out = matchEpgChannels(
      [{ id: "c1", epgId: null, name: "Duplicate", altNames: [] }],
      xmltv,
    );
    expect(out.has("c1")).toBe(false);
  });

  it("skips a channel whose candidate names hit two DIFFERENT xmltv ids", () => {
    const out = matchEpgChannels(
      [{ id: "c1", epgId: null, name: "ZDF", altNames: ["Channel One"] }],
      xmltv,
    );
    expect(out.has("c1")).toBe(false);
  });

  it("pass 2 never overrides pass 1", () => {
    const out = matchEpgChannels(
      [{ id: "c1", epgId: "zdf.de", name: "Первый канал", altNames: [] }],
      xmltv,
    );
    expect(out.get("c1")).toBe("zdf.de");
  });

  it("unmatched channels are simply absent", () => {
    const out = matchEpgChannels(
      [{ id: "c1", epgId: null, name: "Totally Unknown", altNames: [] }],
      xmltv,
    );
    expect(out.size).toBe(0);
  });
});
