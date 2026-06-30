import fp from "fastify-plugin";
import { Queue, Worker, type Job } from "bullmq";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import { Prisma } from "@orbix/db";
import {
  scanSource,
  probeFile,
  ffprobeRunner,
  enrichItem,
  cacheImage,
  cacheImageFromUrl,
  fetchOmdbRatings,
  fetchFanartLogoUrl,
  backdropFrameTimestampSec,
  TmdbClient,
  getSetting,
  type MediaFileTechnical,
  type ImageKind,
  type SaveMetadataInput,
} from "@orbix/core";

const execFileAsync = promisify(execFile);

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

      const probe = async (p: string): Promise<MediaFileTechnical & { probedOk: boolean }> => {
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
        // probe returns MediaFileTechnical & { probedOk: boolean } at runtime
        const probedOk = (input.tech as MediaFileTechnical & { probedOk?: boolean }).probedOk ?? true;
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

      const allItemIds: string[] = [];
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

        for (const id of result.itemIds) {
          if (!allItemIds.includes(id)) allItemIds.push(id);
        }

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

        const omdbKey = await getSetting<string>("omdbKey", {
          fallback: "",
          read: (k) => prisma.setting.findUnique({ where: { key: k } }),
        });
        const fanartKey = await getSetting<string>("fanartKey", {
          fallback: "",
          read: (k) => prisma.setting.findUnique({ where: { key: k } }),
        });

        const imageIo = {
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

        const boundCacheImage = (tmdbPath: string, kind: ImageKind): Promise<string> =>
          cacheImage(tmdbPath, kind, imageIo);

        // Resolve a hero logo: fanart.tv (transparent PNG, by likes) first, then
        // TMDB's own logo art. Returns a metadata-relative path or undefined.
        const resolveLogo = async (id: {
          tmdbId: number;
          imdbId?: string;
        }): Promise<string | undefined> => {
          if (fanartKey) {
            const url = await fetchFanartLogoUrl(id, { fetchImpl: fetch, apiKey: fanartKey });
            if (url) return cacheImageFromUrl(url, "logo", imageIo);
          }
          const tmdbLogo = await client.movieLogoPath(id.tmdbId);
          if (tmdbLogo) return boundCacheImage(tmdbLogo, "logo");
          return undefined;
        };

        const fetchRatings = omdbKey
          ? (imdbId: string) => fetchOmdbRatings(imdbId, { fetchImpl: fetch, apiKey: omdbKey })
          : undefined;

        const saveMetadata = async (input: SaveMetadataInput): Promise<void> => {
          await prisma.$transaction(async (tx) => {
            // Update MediaItem scalars. Optional artwork/ratings are only written
            // when present so a run without an OMDb/fanart key (or a TMDB backdrop)
            // never clobbers data a previous run cached — including frame backdrops.
            const data: Prisma.MediaItemUpdateInput = {
              title: input.title,
              sortTitle: input.title.toLowerCase(),
              year: input.year ?? null,
              overview: input.overview ?? null,
              tagline: input.tagline ?? null,
              runtimeSec: input.runtimeSec ?? null,
              posterPath: input.posterPath ?? null,
              imdbId: input.imdbId ?? null,
              tmdbId: input.tmdbId,
              tmdbScore: input.tmdbScore ?? null,
              matchState: "matched",
              rating: input.rating ?? null,
            };
            if (input.backdropPath !== undefined) {
              data.backdropPath = input.backdropPath;
              data.backdropSource = "tmdb";
            }
            if (input.logoPath !== undefined) data.logoPath = input.logoPath;
            if (input.imdbRating !== undefined) data.imdbRating = input.imdbRating;
            if (input.imdbVotes !== undefined) data.imdbVotes = input.imdbVotes;
            if (input.rtRating !== undefined) data.rtRating = input.rtRating;
            if (input.metacritic !== undefined) data.metacritic = input.metacritic;

            await tx.mediaItem.update({ where: { id: input.itemId }, data });

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
          });
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
              { client, cacheImage: boundCacheImage, saveMetadata, resolveLogo, fetchRatings },
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

        // ── Hero backdrop fallback ───────────────────────────────────────
        // For matched titles that still have no backdrop, grab a representative
        // frame from the video via ffmpeg. Best-effort: silently skip when
        // ffmpeg is missing or the file is unreadable.
        const needBackdrop = await prisma.mediaItem.findMany({
          where: { id: { in: enrichIdsArr }, backdropPath: null, matchState: "matched" },
          select: {
            id: true,
            files: {
              where: { probedOk: true },
              select: { path: true, durationSec: true },
              take: 1,
            },
          },
        });
        for (const it of needBackdrop) {
          const file = it.files[0];
          if (!file) continue;
          const rel = `backdrop/frame-${it.id}.jpg`;
          const outAbs = path.join(env.METADATA_DIR, rel);
          try {
            await fs.promises.mkdir(path.dirname(outAbs), { recursive: true });
            const ts = backdropFrameTimestampSec(file.durationSec);
            await execFileAsync("ffmpeg", [
              "-y",
              "-ss",
              String(ts),
              "-i",
              file.path,
              "-frames:v",
              "1",
              "-vf",
              "scale=1280:-2",
              "-q:v",
              "3",
              outAbs,
            ]);
            await prisma.mediaItem.update({
              where: { id: it.id },
              data: { backdropPath: rel, backdropSource: "frame" },
            });
          } catch (err) {
            app.log.debug(
              { err, itemId: it.id },
              "[scan] backdrop frame fallback failed (ffmpeg missing or unreadable file)",
            );
          }
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

    app.addHook("onClose", async () => {
      await worker.close();
      await queue.close();
    });
  });
}

// ── Fastify type augmentation ─────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyInstance {
    scanQueue: Queue<ScanJobData>;
  }
}
