import type { PrismaClient } from "@orbix/db";

export interface TvNowNextSlot {
  title: string;
  start: string; // ISO — serialization-ready
  stop: string;
}
export interface TvNowNext {
  now: TvNowNextSlot | null;
  next: TvNowNextSlot | null;
}

const LOOKAHEAD_MS = 12 * 60 * 60 * 1000;

/**
 * Now/next for a batch of channels in ONE grouped query (the guide/home N+1
 * ban lives here). Channels with no rows are simply absent from the map.
 */
export async function loadNowNext(
  prisma: PrismaClient,
  channelIds: string[],
  at: Date = new Date(),
): Promise<Map<string, TvNowNext>> {
  const map = new Map<string, TvNowNext>();
  if (channelIds.length === 0) return map;
  const rows = await prisma.tvProgramme.findMany({
    where: {
      channelId: { in: channelIds },
      stop: { gt: at },
      start: { lt: new Date(at.getTime() + LOOKAHEAD_MS) },
    },
    orderBy: { start: "asc" },
    select: { channelId: true, title: true, start: true, stop: true },
  });
  for (const r of rows) {
    const entry = map.get(r.channelId) ?? { now: null, next: null };
    const slot: TvNowNextSlot = { title: r.title, start: r.start.toISOString(), stop: r.stop.toISOString() };
    if (r.start <= at && r.stop > at) {
      if (!entry.now) entry.now = slot;
    } else if (r.start > at && !entry.next) {
      entry.next = slot;
    }
    map.set(r.channelId, entry);
  }
  return map;
}
