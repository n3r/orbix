import fp from "fastify-plugin";
import { Queue, Worker, type Job } from "bullmq";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import { Prisma, type PrismaClient } from "@orbix/db";
import {
  scanSource,
  probeFile,
  ffprobeRunner,
  enrichItem,
  cacheImage,
  TmdbClient,
  tmdbLanguageTag,
  getSetting,
  type MediaFileTechnical,
  type ImageKind,
  type SaveMetadataInput,
  type TranslateClient,
} from "@orbix/core";

// ── Module-level in-process EventEmitter for SSE progress ──────────────────

export const scanEvents = new EventEmitter();
scanEvents.setMaxListeners(200);

/**
 * Cache of "done" events keyed by jobId so late SSE subscribers can get the
 * result even if the scan finished before they connected.
 */
export const scanDoneCache = new Map<string, Record<string, unknown>>();

// ── listFiles walker ─────────────────────────────────────────────────────────

const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm"]);

async function listFiles(
  root: string,
): Promise<{ path: string; mtime: Date; size: number }[]> {
  const results: { path: string; mtime: Date; size: number }[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // skip unreadable dirs
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (VIDEO_EXTS.has(ext)) {
          try {
            const stat = await fs.promises.stat(fullPath);
            results.push({ path: fullPath, mtime: stat.mtime, size: Number(stat.size) });
          } catch {
            // skip unreadable files
          }
        }
      }
    }
  }

  await walk(root);
  return results;
}

// ── Job data shape ───────────────────────────────────────────────────────────

export interface ScanJobData {
  jobId: string;
  sectionId: string;
  sources: { id: string; path: string }[];
}

export interface TranslateJobData {
  language: string;
}

/**
 * The set of content languages whose metadata must be cached: every distinct
 * profile language except the en base (which lives on the MediaItem/Genre rows).
 */
export async function activeContentLanguages(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.profile.findMany({
    select: { language: true },
    distinct: ["language"],
  });
  return [...new Set(rows.map((r) => r.language))].filter((l) => l && l !== "en");
}

/**
 * Ensure a profile language's catalog metadata is (being) cached. No-op for en
 * (the base) or when translations already exist; otherwise enqueues an
 * idempotent backfill job. Safe to call on every profile create/language change.
 */
export async function ensureMetadataLanguage(
  app: FastifyInstance,
  language: string,
): Promise<void> {
  if (!language || language === "en") return;
  const existing = await app.prisma.mediaItemTranslation.findFirst({
    where: { language },
    select: { mediaItemId: true },
  });
  if (existing) return; // already backfilled (or a backfill is in flight)
  await app.translateQueue.add("translate-metadata", { language });
}

// ── Plugin factory ───────────────────────────────────────────────────────────

export function queuePlugin(env: Env) {
  return fp(async (app: FastifyInstance) => {
    const connection = { url: env.REDIS_URL };

    const queue = new Queue<ScanJobData>("scan", { connection });

    // ── Processor ─────────────────────────────────────────────────────────

    async function processor(job: Job<ScanJobData>): Promise<void> {
      const { jobId, sectionId, sources } = job.data;
      const { prisma } = app;

      try {
      // ── Real adapters ──────────────────────────────────────────────────

      const probe = async (p: string): Promise<MediaFileTechnical> => {
        try {
          const tech = await probeFile(p, { run: ffprobeRunner });
          return { ...tech, probedOk: true };
        } catch {
          // Non-video / missing ffprobe — return empty tech so scan continues
          return { audioCodecs: [], subtitleTracks: [], audioTracks: [], probedOk: false };
        }
      };

      const findFileByPath = async (
        filePath: string,
      ): Promise<{ mtime: Date | null; size: number | null } | null> => {
        const row = await prisma.mediaFile.findUnique({
          where: { path: filePath },
          select: { mtime: true, size: true },
        });
        if (!row) return null;
        return { mtime: row.mtime, size: row.size == null ? null : Number(row.size) };
      };

      const upsertItemAndFile = async (input: {
        sectionId: string;
        file: { path: string; mtime: Date; size: number };
        parsed: { title: string; year?: number; tmdbId?: number; imdbId?: string };
        tech: MediaFileTechnical;
      }): Promise<{ itemId: string; created: boolean }> => {
        const probedOk = input.tech.probedOk ?? true;
        // Check if the file already exists
        const existing = await prisma.mediaFile.findUnique({
          where: { path: input.file.path },
          select: { id: true, mediaItemId: true },
        });

        if (existing) {
          await prisma.mediaFile.update({
            where: { id: existing.id },
            data: {
              mtime: input.file.mtime,
              size: BigInt(input.file.size),
              container: input.tech.container,
              videoCodec: input.tech.videoCodec,
              audioCodecs: input.tech.audioCodecs,
              width: input.tech.width,
              height: input.tech.height,
              durationSec: input.tech.durationSec,
              bitrate: input.tech.bitrate,
              // Prisma accepts Json as unknown[]
              subtitleTracks: input.tech.subtitleTracks as unknown as Prisma.InputJsonValue,
              audioTracks: input.tech.audioTracks as unknown as Prisma.InputJsonValue,
              probedOk,
            },
          });
          return { itemId: existing.mediaItemId, created: false };
        }

        // Find or create the parent MediaItem
        let item = await prisma.mediaItem.findFirst({
          where: {
            sectionId: input.sectionId,
            sortTitle: input.parsed.title.toLowerCase(),
            year: input.parsed.year ?? null,
          },
          select: { id: true },
        });

        if (!item) {
          item = await prisma.mediaItem.create({
            data: {
              sectionId: input.sectionId,
              title: input.parsed.title,
              sortTitle: input.parsed.title.toLowerCase(),
              year: input.parsed.year ?? null,
              tmdbId: input.parsed.tmdbId ?? null,
              imdbId: input.parsed.imdbId ?? null,
              matchState: "unmatched",
            },
            select: { id: true },
          });
        }

        await prisma.mediaFile.create({
          data: {
            mediaItemId: item.id,
            path: input.file.path,
            mtime: input.file.mtime,
            size: BigInt(input.file.size),
            container: input.tech.container,
            videoCodec: input.tech.videoCodec,
            audioCodecs: input.tech.audioCodecs,
            width: input.tech.width,
            height: input.tech.height,
            durationSec: input.tech.durationSec,
            bitrate: input.tech.bitrate,
            subtitleTracks: input.tech.subtitleTracks as unknown as Prisma.InputJsonValue,
            audioTracks: input.tech.audioTracks as unknown as Prisma.InputJsonValue,
            probedOk,
          },
        });

        return { itemId: item.id, created: true };
      };

      // ── Scan phase ─────────────────────────────────────────────────────

      const allItemIds = new Set<string>();
      let totalAdded = 0;
      let totalUpdated = 0;
      let totalSkipped = 0;

      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]!;

        scanEvents.emit(jobId, { phase: "scanning", processed: i, total: sources.length });

        const result = await scanSource(
          { sectionId, root: source.path },
          { listFiles, probe, findFileByPath, upsertItemAndFile },
        );

        totalAdded += result.added;
        totalUpdated += result.updated;
        totalSkipped += result.skipped;

        for (const id of result.itemIds) allItemIds.add(id);

        // Mark last scan time
        await prisma.source.update({
          where: { id: source.id },
          data: { lastScanAt: new Date() },
        });
      }

      // ── Enrichment phase (token-optional) ─────────────────────────────

      const token = await getSetting<string>("tmdbToken", {
        fallback: "",
        read: (k) => prisma.setting.findUnique({ where: { key: k } }),
      });

      let matched = 0;

      if (!token) {
        app.log.warn(
          "No TMDB token configured — skipping enrichment. Items will stay unmatched.",
        );
      } else {
        const client = new TmdbClient(token);

        // Active content languages = distinct profile languages, excluding the
        // en base. Each item is also fetched in these languages at enrich time.
        const activeLanguages = await activeContentLanguages(prisma);
        const translateClients = new Map<string, TranslateClient>();
        for (const lang of activeLanguages) {
          translateClients.set(lang, new TmdbClient(token, undefined, tmdbLanguageTag(lang)));
        }

        const boundCacheImage = (tmdbPath: string, kind: ImageKind): Promise<string> =>
          cacheImage(tmdbPath, kind, {
            fetchImpl: fetch,
            exists: (a) =>
              fs.promises.access(a).then(
                () => true,
                () => false,
              ),
            writeFile: async (a, bytes) => {
              await fs.promises.mkdir(path.dirname(a), { recursive: true });
              await fs.promises.writeFile(a, bytes);
            },
            baseDir: env.METADATA_DIR,
          });

        const saveMetadata = async (input: SaveMetadataInput): Promise<void> => {
          // ~40 sequential queries (genres/keywords/cast upserts) in one
          // interactive transaction can exceed Prisma's 5s default on a slow
          // NAS, aborting enrichment. Raise the window generously.
          await prisma.$transaction(async (tx) => {
            // Update MediaItem scalars
            await tx.mediaItem.update({
              where: { id: input.itemId },
              data: {
                title: input.title,
                sortTitle: input.title.toLowerCase(),
                year: input.year ?? null,
                overview: input.overview ?? null,
                runtimeSec: input.runtimeSec ?? null,
                posterPath: input.posterPath ?? null,
                backdropPath: input.backdropPath ?? null,
                imdbId: input.imdbId ?? null,
                tmdbId: input.tmdbId,
                matchState: "matched",
                rating: input.rating ?? null,
              },
            });

            // Clear stale relational data before recreating
            await tx.mediaItemGenre.deleteMany({ where: { mediaItemId: input.itemId } });
            await tx.mediaItemKeyword.deleteMany({ where: { mediaItemId: input.itemId } });
            await tx.credit.deleteMany({ where: { mediaItemId: input.itemId } });

            // Genres
            for (const g of input.genres) {
              const genre = await tx.genre.upsert({
                where: { name: g.name },
                create: { name: g.name, tmdbId: g.tmdbId },
                update: {},
              });
              await tx.mediaItemGenre.create({
                data: { mediaItemId: input.itemId, genreId: genre.id },
              });
            }

            // Keywords
            for (const k of input.keywords) {
              const keyword = await tx.keyword.upsert({
                where: { name: k.name },
                create: { name: k.name, tmdbId: k.tmdbId },
                update: {},
              });
              await tx.mediaItemKeyword.create({
                data: { mediaItemId: input.itemId, keywordId: keyword.id },
              });
            }

            // Cast
            for (const c of input.cast) {
              const person = await tx.person.upsert({
                where: { tmdbId: c.tmdbId },
                create: { tmdbId: c.tmdbId, name: c.name },
                update: { name: c.name },
              });
              await tx.credit.create({
                data: {
                  mediaItemId: input.itemId,
                  personId: person.id,
                  role: c.character ?? "",
                  department: "cast",
                  order: c.order,
                },
              });
            }

            // Director
            if (input.director) {
              const dir = input.director;
              const person = await tx.person.upsert({
                where: { tmdbId: dir.tmdbId },
                create: { tmdbId: dir.tmdbId, name: dir.name },
                update: { name: dir.name },
              });
              await tx.credit.create({
                data: {
                  mediaItemId: input.itemId,
                  personId: person.id,
                  role: "Director",
                  department: "crew",
                  order: 0,
                },
              });
            }

            // Per-language metadata translations (additive; base row is en fallback)
            for (const tr of input.translations ?? []) {
              await tx.mediaItemTranslation.upsert({
                where: { mediaItemId_language: { mediaItemId: input.itemId, language: tr.language } },
                create: {
                  mediaItemId: input.itemId,
                  language: tr.language,
                  title: tr.title,
                  overview: tr.overview ?? null,
                },
                update: { title: tr.title, overview: tr.overview ?? null },
              });
            }
          }, { timeout: 20_000, maxWait: 10_000 });
        };

        // Build enrichment set: touched items UNION any still-unmatched in this section
        const enrichIds = new Set<string>(allItemIds);
        const unmatchedItems = await prisma.mediaItem.findMany({
          where: { sectionId, matchState: "unmatched" },
          select: { id: true },
        });
        for (const u of unmatchedItems) enrichIds.add(u.id);

        const enrichIdsArr = [...enrichIds];

        scanEvents.emit(jobId, {
          phase: "enriching",
          processed: 0,
          total: enrichIds.size,
        });

        for (let i = 0; i < enrichIdsArr.length; i++) {
          const itemId = enrichIdsArr[i]!;
          const item = await prisma.mediaItem.findUnique({
            where: { id: itemId },
            select: { id: true, title: true, year: true, tmdbId: true, matchState: true },
          });
          if (!item) continue;

          // Never overwrite admin-chosen metadata on rescan — skip manual items.
          if (item.matchState === "manual") continue;

          try {
            const result = await enrichItem(
              {
                id: item.id,
                title: item.title,
                year: item.year ?? undefined,
                tmdbId: item.tmdbId ?? undefined,
              },
              { client, cacheImage: boundCacheImage, saveMetadata, translateClients },
            );
            if (result.matched) matched++;
          } catch (err) {
            app.log.warn({ err, itemId }, "enrichItem failed — continuing with remaining items");
          }

          scanEvents.emit(jobId, {
            phase: "enriching",
            processed: i + 1,
            total: enrichIds.size,
          });
        }
      }

      // ── Done ──────────────────────────────────────────────────────────

      const doneEvent: Record<string, unknown> = {
        phase: "done",
        added: totalAdded,
        updated: totalUpdated,
        skipped: totalSkipped,
        matched,
      };
      // Cache so late SSE subscribers get the result even if they missed the event.
      // Evict after 5 min to prevent unbounded growth.
      scanDoneCache.set(jobId, doneEvent);
      const doneTimer = setTimeout(() => scanDoneCache.delete(jobId), 5 * 60 * 1000);
      doneTimer.unref?.();
      scanEvents.emit(jobId, doneEvent);
      } catch (err) {
        // Emit a terminal error event so SSE clients don't hang forever.
        const errEvt: Record<string, unknown> = {
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        scanDoneCache.set(jobId, errEvt);
        const errTimer = setTimeout(() => scanDoneCache.delete(jobId), 5 * 60 * 1000);
        errTimer.unref?.();
        scanEvents.emit(jobId, errEvt);
        throw err;
      }
    }

    // ── Worker ─────────────────────────────────────────────────────────────

    const worker = new Worker<ScanJobData, void>("scan", processor, { connection });
    worker.on("error", (err) => app.log.error({ err }, "scan worker error"));

    app.decorate("scanQueue", queue);

    // ── Metadata translation backfill ───────────────────────────────────────

    const translateQueue = new Queue<TranslateJobData>("translate-metadata", { connection });

    async function translateProcessor(job: Job<TranslateJobData>): Promise<void> {
      const { language } = job.data;
      const { prisma } = app;
      const tag = tmdbLanguageTag(language);
      const channel = `translate-${language}`;

      const token = await getSetting<string>("tmdbToken", {
        fallback: "",
        read: (k) => prisma.setting.findUnique({ where: { key: k } }),
      });
      if (!token) {
        app.log.warn({ language }, "No TMDB token — skipping metadata translation.");
        return;
      }

      const client = new TmdbClient(token, undefined, tag);

      // Localized genre names (fixed TMDB list per language).
      try {
        for (const kind of ["movie", "tv"] as const) {
          const genres = await client.genreList(kind);
          for (const g of genres) {
            if (g.tmdbId == null) continue;
            const local = await prisma.genre.findUnique({
              where: { tmdbId: g.tmdbId },
              select: { id: true },
            });
            if (!local) continue; // only translate genres we actually have
            await prisma.genreTranslation.upsert({
              where: { genreId_language: { genreId: local.id, language } },
              create: { genreId: local.id, language, name: g.name },
              update: { name: g.name },
            });
          }
        }
      } catch (err) {
        app.log.warn({ err, language }, "genre translation failed — continuing");
      }

      // Per-item localized title/overview for every matched item.
      const items = await prisma.mediaItem.findMany({
        where: { tmdbId: { not: null }, matchState: { not: "unmatched" } },
        select: { id: true, tmdbId: true },
      });

      let processed = 0;
      for (const item of items) {
        try {
          const m = await client.movie(item.tmdbId!);
          await prisma.mediaItemTranslation.upsert({
            where: { mediaItemId_language: { mediaItemId: item.id, language } },
            create: { mediaItemId: item.id, language, title: m.title, overview: m.overview ?? null },
            update: { title: m.title, overview: m.overview ?? null },
          });
        } catch (err) {
          app.log.warn({ err, itemId: item.id, language }, "item translation failed — continuing");
        }
        processed++;
        scanEvents.emit(channel, { phase: "translating", processed, total: items.length, language });
      }

      scanEvents.emit(channel, { phase: "done", processed, total: items.length, language });
    }

    const translateWorker = new Worker<TranslateJobData, void>(
      "translate-metadata",
      translateProcessor,
      { connection },
    );
    translateWorker.on("error", (err) => app.log.error({ err }, "translate worker error"));

    app.decorate("translateQueue", translateQueue);

    app.addHook("onClose", async () => {
      await worker.close();
      await queue.close();
      await translateWorker.close();
      await translateQueue.close();
    });
  });
}

// ── Fastify type augmentation ─────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyInstance {
    scanQueue: Queue<ScanJobData>;
    translateQueue: Queue<TranslateJobData>;
  }
}
