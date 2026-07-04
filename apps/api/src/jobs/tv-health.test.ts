import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@orbix/db";
import { runTvHealthSweep } from "./tv-health";

const NOW = new Date("2026-07-03T03:00:00.000Z");

type Stream = { id: string; url: string; userAgent: string | null; referrer: string | null; status: string; failCount: number };

function fakePrisma(streams: Stream[]) {
  let capturedFindArgs: any = null;
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const prisma = {
    tvStream: {
      findMany: async (args: any) => {
        capturedFindArgs = args;
        return streams;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, updates, getFindArgs: () => capturedFindArgs };
}

const s = (over: Partial<Stream>): Stream => ({
  id: "s1", url: "http://up.example/live.m3u8", userAgent: null, referrer: null, status: "unknown", failCount: 0, ...over,
});

describe("runTvHealthSweep", () => {
  it("selects only stale hls streams, capped and ordered nulls-first", async () => {
    const { prisma, getFindArgs } = fakePrisma([]);
    await runTvHealthSweep(prisma, { fetchUpstream: async () => { throw new Error("unused"); }, now: () => NOW });
    const args = getFindArgs();
    expect(args.where.protocol).toBe("hls");
    expect(args.take).toBe(500);
    expect(args.orderBy).toEqual({ lastCheckAt: { sort: "asc", nulls: "first" } });
    // staleness + dead-retry composition
    const [staleness, deadRetry] = args.where.AND;
    expect(staleness.OR[0]).toEqual({ lastCheckAt: null });
    expect(staleness.OR[1].lastCheckAt.lt.toISOString()).toBe("2026-07-02T03:00:00.000Z"); // now−24h
    expect(deadRetry.OR[0]).toEqual({ status: { not: "dead" } });
    expect(deadRetry.OR[2].lastCheckAt.lt.toISOString()).toBe("2026-06-26T03:00:00.000Z"); // now−7d
  });

  it("marks 200+#EXTM3U ok (reset failCount, lastOkAt) and failures via the shared thresholds", async () => {
    const { prisma, updates } = fakePrisma([
      s({ id: "good", url: "http://up.example/good.m3u8" }),
      s({ id: "bounce", failCount: 2, status: "unknown" }),   // 3rd failure → degraded
      s({ id: "dying", failCount: 7, status: "degraded" }),   // 8th failure → dead
      s({ id: "early", failCount: 0, status: "ok" }),         // 1st failure → status unchanged
    ]);
    const result = await runTvHealthSweep(prisma, {
      now: () => NOW,
      fetchUpstream: async (url) => {
        if (url.includes("good")) return { finalUrl: url, status: 200, headers: {}, body: null, text: "#EXTM3U\n#EXT-X-VERSION:3" };
        return { finalUrl: url, status: 403, headers: {}, body: null, text: "denied" };
      },
    });
    const byId = new Map(updates.map((u) => [u.id, u.data]));
    expect(byId.get("good")).toMatchObject({ status: "ok", failCount: 0, lastOkAt: NOW, lastCheckAt: NOW });
    expect(byId.get("bounce")).toMatchObject({ status: "degraded", failCount: 3 });
    expect(byId.get("dying")).toMatchObject({ status: "dead", failCount: 8 });
    expect(byId.get("early")).toMatchObject({ status: "ok", failCount: 1 }); // below threshold: unchanged
    expect(result).toEqual({ checked: 4, ok: 1, degraded: 1, dead: 1 });
  });

  it("treats thrown fetches as failures and passes stream headers + 10s timeout", async () => {
    const seen: { url: string; opts: any }[] = [];
    const { prisma, updates } = fakePrisma([s({ id: "hdr", userAgent: "UA/1", referrer: "http://ref" })]);
    await runTvHealthSweep(prisma, {
      now: () => NOW,
      fetchUpstream: async (url, opts) => { seen.push({ url, opts }); throw new Error("boom"); },
    });
    expect(seen[0].opts).toMatchObject({ userAgent: "UA/1", referrer: "http://ref", wantText: true, timeoutMs: 10_000 });
    expect(updates[0].data).toMatchObject({ failCount: 1, lastCheckAt: NOW });
  });

  it("bounds concurrency with a promise pool", async () => {
    const streams = Array.from({ length: 6 }, (_, i) => s({ id: `c${i}` }));
    const { prisma } = fakePrisma(streams);
    let inFlight = 0;
    let maxInFlight = 0;
    await runTvHealthSweep(prisma, {
      now: () => NOW,
      concurrency: 2,
      fetchUpstream: async (url) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { finalUrl: url, status: 200, headers: {}, body: null, text: "#EXTM3U" };
      },
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
