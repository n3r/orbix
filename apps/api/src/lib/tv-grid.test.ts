import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@orbix/db";
import { loadProgrammeWindow } from "./tv-grid";

const WINDOW_START = new Date("2026-07-04T18:00:00.000Z");
const WINDOW_END = new Date("2026-07-04T21:00:00.000Z"); // 3h window

function fakePrisma(
  rows: { id: string; channelId: string; title: string; start: Date; stop: Date; category: string | null }[],
) {
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

describe("loadProgrammeWindow", () => {
  it("issues exactly ONE grouped query regardless of channel count (no N+1)", async () => {
    const { prisma, calls } = fakePrisma([]);
    await loadProgrammeWindow(prisma, ["a", "b", "c", "d", "e"], WINDOW_START, WINDOW_END);
    expect(calls).toHaveLength(1);
  });

  it("builds a where clause intersecting [windowStart, windowEnd): straddling via stop>windowStart, excludes anything starting at/after windowEnd via start<windowEnd", async () => {
    const { prisma, calls } = fakePrisma([]);
    await loadProgrammeWindow(prisma, ["a"], WINDOW_START, WINDOW_END);
    expect(calls).toHaveLength(1);
    const args = calls[0] as { where: unknown; orderBy: unknown };
    expect(args.where).toEqual({
      channelId: { in: ["a"] },
      stop: { gt: WINDOW_START },
      start: { lt: WINDOW_END },
    });
    expect(args.orderBy).toEqual({ start: "asc" });
  });

  it("groups rows per channel, start-ascending, with ISO-serialized start/stop and category passthrough", async () => {
    const { prisma } = fakePrisma([
      // Prisma returns rows already start-ascending (orderBy:{start:"asc"}); a programme that
      // started before the window but straddles windowStart (stop>windowStart) sorts first.
      {
        id: "p1",
        channelId: "a",
        title: "Straddles window start",
        start: new Date("2026-07-04T17:30:00Z"),
        stop: new Date("2026-07-04T18:30:00Z"),
        category: "news",
      },
      {
        id: "p2",
        channelId: "b",
        title: "Fully inside window",
        start: new Date("2026-07-04T18:00:00Z"),
        stop: new Date("2026-07-04T19:00:00Z"),
        category: null,
      },
      {
        id: "p3",
        channelId: "a",
        title: "Second on A",
        start: new Date("2026-07-04T18:30:00Z"),
        stop: new Date("2026-07-04T20:00:00Z"),
        category: "movies",
      },
    ]);
    const map = await loadProgrammeWindow(prisma, ["a", "b", "c"], WINDOW_START, WINDOW_END);
    expect(map.get("a")).toEqual([
      {
        id: "p1",
        title: "Straddles window start",
        start: "2026-07-04T17:30:00.000Z",
        stop: "2026-07-04T18:30:00.000Z",
        category: "news",
      },
      {
        id: "p3",
        title: "Second on A",
        start: "2026-07-04T18:30:00.000Z",
        stop: "2026-07-04T20:00:00.000Z",
        category: "movies",
      },
    ]);
    expect(map.get("b")).toEqual([
      {
        id: "p2",
        title: "Fully inside window",
        start: "2026-07-04T18:00:00.000Z",
        stop: "2026-07-04T19:00:00.000Z",
        category: null,
      },
    ]);
    expect(map.get("c")).toBeUndefined(); // channel with no rows is absent, not []
  });

  it("short-circuits on empty channelIds without querying", async () => {
    const { prisma, calls } = fakePrisma([]);
    const map = await loadProgrammeWindow(prisma, [], WINDOW_START, WINDOW_END);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
