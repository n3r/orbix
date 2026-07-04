import type { PrismaClient } from "@orbix/db";

export interface TvGridProgramme {
  id: string;
  title: string;
  start: string; // ISO — serialization-ready
  stop: string;
  category: string | null;
}

/**
 * Programmes for a batch of channels intersecting [windowStart, windowEnd), in
 * ONE grouped query (the guide/home N+1 ban lives here too — see loadNowNext).
 * Channels with no rows are simply absent from the map.
 */
export async function loadProgrammeWindow(
  prisma: PrismaClient,
  channelIds: string[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<string, TvGridProgramme[]>> {
  const map = new Map<string, TvGridProgramme[]>();
  if (channelIds.length === 0) return map;
  const rows = await prisma.tvProgramme.findMany({
    where: {
      channelId: { in: channelIds },
      stop: { gt: windowStart },
      start: { lt: windowEnd },
    },
    orderBy: { start: "asc" },
    select: { id: true, channelId: true, title: true, start: true, stop: true, category: true },
  });
  for (const r of rows) {
    const programme: TvGridProgramme = {
      id: r.id,
      title: r.title,
      start: r.start.toISOString(),
      stop: r.stop.toISOString(),
      category: r.category,
    };
    const list = map.get(r.channelId);
    if (list) list.push(programme);
    else map.set(r.channelId, [programme]);
  }
  return map;
}
