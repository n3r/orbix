import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@orbix/db";
import { loadNowNext } from "./tv-now-next";

const AT = new Date("2026-07-03T16:00:00.000Z");

function fakePrisma(rows: { channelId: string; title: string; start: Date; stop: Date }[]) {
  const calls: unknown[] = [];
  const prisma = {
    tvProgramme: {
      findMany: async (args: unknown) => {
        calls.push(args);
        return rows;
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

describe("loadNowNext", () => {
  it("resolves now (start<=at<stop) and next (first start>at) per channel in ONE query", async () => {
    const { prisma, calls } = fakePrisma([
      { channelId: "a", title: "News", start: new Date("2026-07-03T15:30:00Z"), stop: new Date("2026-07-03T16:30:00Z") },
      { channelId: "a", title: "Film", start: new Date("2026-07-03T16:30:00Z"), stop: new Date("2026-07-03T18:00:00Z") },
      { channelId: "b", title: "Later", start: new Date("2026-07-03T17:00:00Z"), stop: new Date("2026-07-03T18:00:00Z") },
    ]);
    const map = await loadNowNext(prisma, ["a", "b", "c"], AT);
    expect(calls).toHaveLength(1); // grouped query — never per-channel
    expect(map.get("a")).toEqual({
      now: { title: "News", start: "2026-07-03T15:30:00.000Z", stop: "2026-07-03T16:30:00.000Z" },
      next: { title: "Film", start: "2026-07-03T16:30:00.000Z", stop: "2026-07-03T18:00:00.000Z" },
    });
    // gap: nothing on now, next still found
    expect(map.get("b")).toEqual({
      now: null,
      next: { title: "Later", start: "2026-07-03T17:00:00.000Z", stop: "2026-07-03T18:00:00.000Z" },
    });
    expect(map.get("c")).toBeUndefined(); // absent = caller renders {now:null,next:null}
  });

  it("short-circuits on empty ids without querying", async () => {
    const { prisma, calls } = fakePrisma([]);
    const map = await loadNowNext(prisma, [], AT);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
