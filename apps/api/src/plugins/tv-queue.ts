import fp from "fastify-plugin";
import { Queue, Worker, type Job } from "bullmq";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import {
  assignNumbers,
  cacheImageFromUrl,
  parseM3u,
  planIptvOrgSync,
  planM3uSync,
  type ChannelUpsertPlan,
} from "@orbix/core";
import { buildIptvOrgDeps, fetchIptvOrgCatalog } from "../lib/iptv-org";

// ── Module-level in-process EventEmitter for SSE progress ──────────────────

export const tvEvents = new EventEmitter();
tvEvents.setMaxListeners(200);

/**
 * Cache of "done"/"error" events keyed by jobId so late SSE subscribers can
 * get the result even if the sync finished before they connected.
 */
export const tvDoneCache = new Map<string, Record<string, unknown>>();

export interface TvSyncJobData {
  jobId: string;
  /** Sync one source; absent = sync every enabled source (the scheduler path). */
  sourceId?: string;
}

// ── Plugin factory ───────────────────────────────────────────────────────────

export function tvQueuePlugin(env: Env) {
  return fp(async (app: FastifyInstance) => {
    // Same rationale as queuePlugin: tests never process jobs and point
    // REDIS_URL at a bogus host — creating real BullMQ queues/workers leaks
    // ioredis DNS failures as unhandled rejections. Decorate an inert stub.
    if (env.NODE_ENV === "test") {
      const stub = { add: async () => undefined, close: async () => undefined };
      app.decorate("tvQueue", stub as unknown as Queue<TvSyncJobData>);
      return;
    }

    const connection = { url: env.REDIS_URL };
    const queue = new Queue<TvSyncJobData>("tv", { connection });

    interface SyncCounters {
      channels: number;
      streams: number;
      logosCached: number;
    }

    // ── Sync one source ─────────────────────────────────────────────────────

    async function syncSource(
      source: {
        id: string;
        kind: string;
        name: string;
        url: string | null;
        filePath: string | null;
        countries: string[];
      },
      jobId: string,
    ): Promise<SyncCounters> {
      const { prisma } = app;
      await prisma.tvSource.update({
        where: { id: source.id },
        data: { status: "syncing", statusMessage: null },
      });
      try {
        // 1. Plan (pure core; only the inputs differ by source kind).
        let plans: ChannelUpsertPlan[];
        let epgUrls: string[] = [];
        if (source.kind === "iptv-org") {
          const catalog = await fetchIptvOrgCatalog(buildIptvOrgDeps(app, env));
          plans = planIptvOrgSync({ ...catalog, countries: source.countries });
        } else {
          let text: string;
          if (source.url) {
            const res = await fetch(source.url);
            if (!res.ok) throw new Error(`playlist fetch failed: HTTP ${res.status}`);
            text = await res.text();
          } else if (source.filePath) {
            text = await fs.promises.readFile(source.filePath, "utf8");
          } else {
            throw new Error("m3u source has neither url nor filePath");
          }
          const playlist = parseM3u(text);
          plans = planM3uSync(playlist);
          epgUrls = playlist.epgUrls;
        }

        // 2. Numbers: existing extIds keep theirs; new channels append after
        //    the GLOBAL max (numbers are never reused or auto-renumbered).
        const existingRows = await prisma.tvChannel.findMany({
          where: { sourceId: source.id },
          select: { id: true, extId: true, number: true, logoUrl: true, logoPath: true },
        });
        const existingByExt = new Map(existingRows.map((r) => [r.extId, r]));
        const maxAgg = await prisma.tvChannel.aggregate({ _max: { number: true } });
        const numbers = assignNumbers(
          maxAgg._max.number ?? 0,
          new Map(existingRows.map((r) => [r.extId, r.number])),
          plans.map((p) => ({ extId: p.extId, country: p.country, name: p.name })),
        );

        // 3. Upsert channels by (sourceId, extId) + replace streams wholesale.
        //    NOTE: replacing resets stream status to "unknown" on every sync —
        //    accepted for v1; the tv-health job (later phase) re-learns status
        //    within a day. Manual `hidden` flags are NOT touched on update.
        const logoTargets: { channelId: string; logoUrl: string }[] = [];
        let processed = 0;
        let streamCount = 0;
        for (const plan of plans) {
          const existing = existingByExt.get(plan.extId);
          const data = {
            name: plan.name,
            rawName: plan.rawName,
            altNames: plan.altNames,
            country: plan.country,
            languages: plan.languages,
            categories: plan.categories,
            website: plan.website,
            quality: plan.quality,
            logoUrl: plan.logoUrl,
          };
          let channelId: string;
          if (existing) {
            await prisma.tvChannel.update({ where: { id: existing.id }, data });
            channelId = existing.id;
          } else {
            const created = await prisma.tvChannel.create({
              data: {
                ...data,
                sourceId: source.id,
                extId: plan.extId,
                number: numbers.get(plan.extId)!,
                epgId: plan.epgId,
              },
              select: { id: true },
            });
            channelId = created.id;
          }

          await prisma.tvStream.deleteMany({ where: { channelId } });
          if (plan.streams.length > 0) {
            await prisma.tvStream.createMany({
              data: plan.streams.map((s) => ({
                channelId,
                url: s.url,
                feedId: s.feedId,
                quality: s.quality,
                label: s.label,
                referrer: s.referrer,
                userAgent: s.userAgent,
                priority: s.priority,
                protocol: s.protocol,
              })),
            });
          }
          streamCount += plan.streams.length;

          // Logo caching happens AFTER all upserts — collect targets now.
          if (plan.logoUrl && (!existing || existing.logoPath == null || existing.logoUrl !== plan.logoUrl)) {
            logoTargets.push({ channelId, logoUrl: plan.logoUrl });
          }

          processed++;
          if (processed % 50 === 0 || processed === plans.length) {
            tvEvents.emit(jobId, { phase: "channels", processed, total: plans.length });
          }
        }

        // 4. Channels that vanished upstream: hide them and mark their streams
        //    dead (rows are kept — favorites/recents keep referential integrity).
        const planExtIds = new Set(plans.map((p) => p.extId));
        const vanishedIds = existingRows.filter((r) => !planExtIds.has(r.extId)).map((r) => r.id);
        if (vanishedIds.length > 0) {
          await prisma.tvChannel.updateMany({
            where: { id: { in: vanishedIds } },
            data: { hidden: true },
          });
          await prisma.tvStream.updateMany({
            where: { channelId: { in: vanishedIds } },
            data: { status: "dead" },
          });
        }

        // 5. Auto-create EPG sources from the playlist's url-tvg header (dedupe by url).
        for (const url of epgUrls) {
          const dup = await prisma.tvEpgSource.findFirst({ where: { url }, select: { id: true } });
          if (!dup) {
            await prisma.tvEpgSource.create({ data: { name: `${source.name} EPG`, url } });
          }
        }

        // 6. Cache logos to disk AFTER upserts (offline guarantee). Per-image
        //    failures leave logoPath null — the UI falls back to a monogram.
        const io = {
          fetchImpl: fetch,
          exists: (a: string) =>
            fs.promises.access(a).then(
              () => true,
              () => false,
            ),
          writeFile: async (a: string, bytes: Uint8Array) => {
            await fs.promises.mkdir(path.dirname(a), { recursive: true });
            await fs.promises.writeFile(a, bytes);
          },
          baseDir: env.METADATA_DIR,
        };
        let logosCached = 0;
        let logosProcessed = 0;
        for (const target of logoTargets) {
          try {
            const rel = await cacheImageFromUrl(target.logoUrl, "channel", io);
            await prisma.tvChannel.update({
              where: { id: target.channelId },
              data: { logoPath: rel },
            });
            logosCached++;
          } catch (err) {
            app.log.debug(
              { err, channelId: target.channelId },
              "[tv-sync] logo cache failed — monogram fallback",
            );
          }
          logosProcessed++;
          if (logosProcessed % 50 === 0 || logosProcessed === logoTargets.length) {
            tvEvents.emit(jobId, { phase: "logos", processed: logosProcessed, total: logoTargets.length });
          }
        }

        await prisma.tvSource.update({
          where: { id: source.id },
          data: { status: "ok", statusMessage: null, lastSyncAt: new Date() },
        });
        return { channels: plans.length, streams: streamCount, logosCached };
      } catch (err) {
        await prisma.tvSource.update({
          where: { id: source.id },
          data: { status: "error", statusMessage: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
    }

    // ── Processor ───────────────────────────────────────────────────────────

    async function processor(job: Job<TvSyncJobData>): Promise<void> {
      if (job.name !== "tv-sync") return;
      const { jobId, sourceId } = job.data;
      try {
        const sources = await app.prisma.tvSource.findMany({
          where: sourceId ? { id: sourceId } : { enabled: true },
          select: { id: true, kind: true, name: true, url: true, filePath: true, countries: true },
          orderBy: { createdAt: "asc" },
        });
        const totals: Record<string, number> = { channels: 0, streams: 0, logosCached: 0 };
        for (const source of sources) {
          const c = await syncSource(source, jobId);
          totals.channels += c.channels;
          totals.streams += c.streams;
          totals.logosCached += c.logosCached;
        }
        const doneEvent: Record<string, unknown> = { phase: "done", ...totals };
        // Cache so late SSE subscribers get the result; evict after 5 min.
        tvDoneCache.set(jobId, doneEvent);
        const doneTimer = setTimeout(() => tvDoneCache.delete(jobId), 5 * 60 * 1000);
        doneTimer.unref?.();
        tvEvents.emit(jobId, doneEvent);
      } catch (err) {
        const errEvt: Record<string, unknown> = {
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        tvDoneCache.set(jobId, errEvt);
        const errTimer = setTimeout(() => tvDoneCache.delete(jobId), 5 * 60 * 1000);
        errTimer.unref?.();
        tvEvents.emit(jobId, errEvt);
        throw err;
      }
    }

    // ── Worker ───────────────────────────────────────────────────────────────

    const worker = new Worker<TvSyncJobData, void>("tv", processor, { connection });
    worker.on("error", (err) => app.log.error({ err }, "tv worker error"));

    app.decorate("tvQueue", queue);

    app.addHook("onClose", async () => {
      await worker.close();
      await queue.close();
    });
  });
}

// ── Fastify type augmentation ─────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyInstance {
    tvQueue: Queue<TvSyncJobData>;
  }
}
