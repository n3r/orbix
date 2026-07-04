import type { PrismaClient } from "@orbix/db";
import { nextStreamHealth } from "../lib/tv-health-state";

export const HEALTH_RECHECK_MS = 24 * 60 * 60 * 1000;
export const HEALTH_DEAD_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
export const HEALTH_BATCH_CAP = 500;
export const HEALTH_CONCURRENCY = 8;

export interface TvHealthDeps {
  fetchUpstream: (
    url: string,
    opts: { userAgent?: string; referrer?: string; wantText: boolean; timeoutMs?: number },
  ) => Promise<{ finalUrl: string; status: number; headers: Record<string, string>; body: unknown; text?: string }>;
  now?: () => Date;
  concurrency?: number;
}

export interface TvHealthResult {
  checked: number;
  ok: number;
  degraded: number;
  dead: number;
}

/**
 * Nightly stream probe: GET the playlist with the stream's own headers and a
 * browser-default UA (the upstream helper's default), verdict = HTTP 200 with
 * "#EXTM3U" in the body. Geo-blocks from the server are honest dead-from-here —
 * exactly what the household experiences, since the server fetches everything.
 */
export async function runTvHealthSweep(prisma: PrismaClient, deps: TvHealthDeps): Promise<TvHealthResult> {
  const now = deps.now ? deps.now() : new Date();
  const stale = new Date(now.getTime() - HEALTH_RECHECK_MS);
  const deadRetry = new Date(now.getTime() - HEALTH_DEAD_RETRY_MS);

  const streams = await prisma.tvStream.findMany({
    where: {
      protocol: "hls", // only hls is playable v1 — probing others is noise
      AND: [
        { OR: [{ lastCheckAt: null }, { lastCheckAt: { lt: stale } }] },
        // dead streams get a weekly retry instead of the daily one
        { OR: [{ status: { not: "dead" } }, { lastCheckAt: null }, { lastCheckAt: { lt: deadRetry } }] },
      ],
    },
    orderBy: { lastCheckAt: { sort: "asc", nulls: "first" } },
    take: HEALTH_BATCH_CAP,
    select: { id: true, url: true, userAgent: true, referrer: true, status: true, failCount: true },
  });

  const result: TvHealthResult = { checked: 0, ok: 0, degraded: 0, dead: 0 };
  const limit = Math.max(1, deps.concurrency ?? HEALTH_CONCURRENCY);
  let cursor = 0;

  async function workerLoop(): Promise<void> {
    while (cursor < streams.length) {
      const stream = streams[cursor++];
      let healthy = false;
      try {
        const res = await deps.fetchUpstream(stream.url, {
          userAgent: stream.userAgent ?? undefined,
          referrer: stream.referrer ?? undefined,
          wantText: true,
          timeoutMs: 10_000,
        });
        healthy = res.status === 200 && (res.text ?? "").includes("#EXTM3U");
      } catch {
        healthy = false;
      }
      result.checked++;
      const nextState = nextStreamHealth(stream, healthy);
      if (healthy) {
        result.ok++;
        await prisma.tvStream.update({
          where: { id: stream.id },
          data: { ...nextState, lastOkAt: now, lastCheckAt: now },
        });
      } else {
        if (nextState.status === "degraded" && stream.status !== "degraded") result.degraded++;
        if (nextState.status === "dead" && stream.status !== "dead") result.dead++;
        await prisma.tvStream.update({
          where: { id: stream.id },
          data: { ...nextState, lastCheckAt: now },
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, streams.length) }, () => workerLoop()));
  return result;
}
