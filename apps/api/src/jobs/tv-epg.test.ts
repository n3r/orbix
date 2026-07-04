import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import type { PrismaClient } from "@orbix/db";
import { runTvEpgSync, type TvEpgDeps } from "./tv-epg";

const NOW = new Date("2026-07-03T16:00:00.000Z");

// One direct-epgId channel, one name-match-only channel, one untracked feed id.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="ChannelOne.ru"><display-name>Первый канал</display-name></channel>
  <channel id="zdf.de"><display-name>ZDF</display-name></channel>
  <channel id="noise.tv"><display-name>Noise</display-name></channel>
  <programme start="20260703190000 +0300" stop="20260703210000 +0300" channel="ChannelOne.ru">
    <title lang="ru">Время</title>
  </programme>
  <programme start="20260703180000 +0200" stop="20260703190000 +0200" channel="zdf.de">
    <title lang="de">heute journal</title>
  </programme>
  <programme start="20260701000000 +0000" stop="20260701010000 +0000" channel="ChannelOne.ru">
    <title>Stale — outside window</title>
  </programme>
  <programme start="20260703180000 +0000" stop="20260703190000 +0000" channel="noise.tv">
    <title>Untracked</title>
  </programme>
</tv>`;

interface UpsertCall { where: { channelId_start: { channelId: string; start: Date } }; create: { title: string; channelId: string } }

function fakePrisma(opts?: { sources?: object[]; channels?: object[] }) {
  const upserts: UpsertCall[] = [];
  const sourceUpdates: { id: string; data: Record<string, unknown> }[] = [];
  let deleteWhere: unknown = null;
  const prisma = {
    tvChannel: {
      findMany: async () => opts?.channels ?? [
        { id: "ch-one", epgId: "ChannelOne.ru", name: "Первый канал", altNames: [] },
        { id: "ch-zdf", epgId: null, name: "ZDF HD", altNames: [] }, // name-match only
        { id: "ch-none", epgId: "absent.id", name: "Nothing Ever Matches", altNames: [] },
      ],
    },
    tvEpgSource: {
      findMany: async () => opts?.sources ?? [
        { id: "es1", name: "test feed", url: "https://example.test/epg.xml.gz", enabled: true, offsetMin: 0 },
      ],
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        sourceUpdates.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
    tvProgramme: {
      upsert: (args: UpsertCall) => { upserts.push(args); return Promise.resolve({}); },
      deleteMany: async ({ where }: { where: unknown }) => { deleteWhere = where; return { count: 3 }; },
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return { prisma: prisma as unknown as PrismaClient, upserts, sourceUpdates, getDeleteWhere: () => deleteWhere };
}

function gzBody(xml: string): Readable {
  const gz = gzipSync(Buffer.from(xml, "utf8"));
  // two chunks to prove streaming decompression works
  return Readable.from([gz.subarray(0, Math.floor(gz.length / 2)), gz.subarray(Math.floor(gz.length / 2))]);
}

describe("runTvEpgSync", () => {
  it("gunzips, windows, maps direct epgIds AND name-matched channels in one pass", async () => {
    const { prisma, upserts, sourceUpdates } = fakePrisma();
    const deps: TvEpgDeps = {
      fetchUpstream: async (url) => ({ finalUrl: url, status: 200, headers: {}, body: gzBody(XML) }),
      now: () => NOW,
    };
    const result = await runTvEpgSync(prisma, deps);

    // direct: Время @16:00Z–18:00Z for ch-one; name-match: heute journal for ch-zdf
    const byChannel = new Map(upserts.map((u) => [u.create.channelId, u]));
    expect(byChannel.get("ch-one")?.create.title).toBe("Время");
    expect(byChannel.get("ch-zdf")?.create.title).toBe("heute journal");
    // stale + untracked rows dropped
    expect(upserts).toHaveLength(2);
    expect(result.programmesUpserted).toBe(2);
    expect(result.channelsMatchedByName).toBe(1);
    expect(result.errors).toHaveLength(0);
    // source lifecycle: syncing → ok with lastSyncAt
    expect(sourceUpdates[0].data.status).toBe("syncing");
    const last = sourceUpdates.at(-1)!.data;
    expect(last.status).toBe("ok");
    expect(last.lastSyncAt).toBeInstanceOf(Date);
  });

  it("matches a channel's epgId case-insensitively (stored UPPERCASE vs feed lowercase)", async () => {
    // Stored epgId "ZDF.DE" vs the fixture's <programme channel="zdf.de"> — a
    // case-mismatched direct id must still hit the SAX gate and be upserted,
    // not silently dropped (regression guard for the case-sensitivity bug).
    const { prisma, upserts } = fakePrisma({
      channels: [{ id: "ch-zdf-upper", epgId: "ZDF.DE", name: "ZDF Uppercase", altNames: [] }],
    });
    const deps: TvEpgDeps = {
      fetchUpstream: async (url) => ({ finalUrl: url, status: 200, headers: {}, body: gzBody(XML) }),
      now: () => NOW,
    };
    const result = await runTvEpgSync(prisma, deps);

    const zdf = upserts.find((u) => u.create.channelId === "ch-zdf-upper");
    expect(zdf?.create.title).toBe("heute journal"); // upserted, not dropped
    expect(upserts).toHaveLength(1);
    expect(result.programmesUpserted).toBe(1);
    expect(result.channelsMatchedByName).toBe(0); // direct hit, not a name-match fallback
    expect(result.errors).toHaveLength(0);
  });

  it("applies the source offsetMin to stored rows", async () => {
    const { prisma, upserts } = fakePrisma({
      sources: [{ id: "es1", name: "shifted", url: "https://example.test/epg.xml.gz", enabled: true, offsetMin: 60 }],
    });
    await runTvEpgSync(prisma, {
      fetchUpstream: async (url) => ({ finalUrl: url, status: 200, headers: {}, body: gzBody(XML) }),
      now: () => NOW,
    });
    const one = upserts.find((u) => u.create.channelId === "ch-one")!;
    expect(one.where.channelId_start.start.toISOString()).toBe("2026-07-03T17:00:00.000Z"); // 16:00Z + 60min
  });

  it("handles plain .xml (no gunzip) and multibyte chunk boundaries", async () => {
    const { prisma, upserts } = fakePrisma({
      sources: [{ id: "es1", name: "plain", url: "https://example.test/epg.xml", enabled: true, offsetMin: 0 }],
    });
    const buf = Buffer.from(XML, "utf8");
    const cut = buf.indexOf(Buffer.from("Время", "utf8")) + 3; // mid-Cyrillic-codepoint
    await runTvEpgSync(prisma, {
      fetchUpstream: async (url) => ({ finalUrl: url, status: 200, headers: {}, body: Readable.from([buf.subarray(0, cut), buf.subarray(cut)]) }),
      now: () => NOW,
    });
    expect(upserts.find((u) => u.create.channelId === "ch-one")?.create.title).toBe("Время");
  });

  it("marks a failing source error and continues; prunes after all sources", async () => {
    const { prisma, upserts, sourceUpdates, getDeleteWhere } = fakePrisma({
      sources: [
        { id: "bad", name: "bad", url: "https://example.test/dead.xml.gz", enabled: true, offsetMin: 0 },
        { id: "good", name: "good", url: "https://example.test/epg.xml.gz", enabled: true, offsetMin: 0 },
      ],
    });
    const result = await runTvEpgSync(prisma, {
      fetchUpstream: async (url) => {
        if (url.includes("dead")) throw new Error("connect timeout");
        return { finalUrl: url, status: 200, headers: {}, body: gzBody(XML) };
      },
      now: () => NOW,
    });
    expect(result.errors).toHaveLength(1);
    const bad = sourceUpdates.filter((u) => u.id === "bad").at(-1)!.data;
    expect(bad.status).toBe("error");
    expect(String(bad.statusMessage)).toContain("connect timeout");
    expect(upserts.length).toBe(2); // good source still ingested
    expect(result.pruned).toBe(3);
    // prune boundary = now − 6h
    expect(JSON.stringify(getDeleteWhere())).toContain("2026-07-03T10:00:00.000Z");
  });

  it("reports progress with the source name", async () => {
    const { prisma } = fakePrisma();
    const events: { source: string; processed: number }[] = [];
    await runTvEpgSync(prisma, {
      fetchUpstream: async (url) => ({ finalUrl: url, status: 200, headers: {}, body: gzBody(XML) }),
      now: () => NOW,
      onProgress: (p) => events.push(p),
    });
    expect(events.at(-1)).toEqual({ source: "test feed", processed: 2 });
  });
});
