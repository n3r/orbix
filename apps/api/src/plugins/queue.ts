import fp from "fastify-plugin";
import { Queue, Worker, type Job } from "bullmq";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Env } from "@orbix/config";
import { Prisma, type PrismaClient } from "@orbix/db";
import { buildMountRuntime, type MountRuntime } from "../lib/mount-runtime";
import { extractKeyframes, keyframeProbeRunner } from "../jobs/extract-keyframes";
import { sweepKeyframeBackfill } from "../jobs/keyframe-backfill";
import { extractSubtitles, subtitleExtractRunner } from "../jobs/extract-subtitles";
import type { ScanProgress } from "../lib/scan-status";
import {
  scanSource,
  probeFile,
  ffprobeRunner,
  enrichItem,
  enrichSeries,
  cacheImage,
  cacheImageFromUrl,
  fetchOmdbRatings,
  fetchFanartLogoUrl,
  backdropFrameTimestampSec,
  episodeFrameTimestampSec,
  TmdbClient,
  tmdbLanguageTag,
  getSetting,
  TvdbClient,
  enrichSeriesTvdb,
  tvdbLanguageTag,
  planTmdbDedup,
  planSeriesDedup,
  selectTextSubtitleTracks,
  parseMediaPath,
  matchSpecialEpisode,
  PROVISIONAL_SPECIAL_BASE,
  type LocalSeasonShape,
  type EnrichResult,
  type MediaFileTechnical,
  type ImageKind,
  type SaveMetadataInput,
  type SaveSeriesInput,
} from "@orbix/core";

const execFileAsync = promisify(execFile);

// ── Module-level in-process EventEmitter for SSE progress ──────────────────

export const scanEvents = new EventEmitter();
scanEvents.setMaxListeners(200);

/**
 * Cache of "done" events keyed by jobId so late SSE subscribers can get the
 * result even if the scan finished before they connected.
 */
export const scanDoneCache = new Map<string, ScanProgress>();

// ── listFiles walker ─────────────────────────────────────────────────────────

// .ts/.m2ts are MPEG-TS broadcast/Blu-ray captures — common for documentary
// HDTV rips; ffprobe/ffmpeg handle them natively. BDMV disc trees that contain
// .m2ts fragments are skipped by the parser (DISC_STRUCTURE_RE).
const VIDEO_EXTS = new Set([
  ".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm",
  ".ts", ".m2ts", ".mts", ".mpg", ".mpeg", ".wmv",
]);

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

export interface ScanSourceRow {
  id: string;
  kind: string;
  path: string | null;
  smbHost: string | null;
  smbShare: string | null;
  smbSubpath: string | null;
  smbUsername: string | null;
  smbPassword: string | null;
  smbDomain: string | null;
}

export interface ScanJobData {
  jobId: string;
  libraryId: string;
  sources: ScanSourceRow[];
}

export interface TranslateJobData {
  language: string;
}

export interface KeyframesJobData {
  fileId: string;
}

export interface SubtitlesJobData {
  fileId: string;
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

export function queuePlugin(env: Env, deps?: { runtime?: MountRuntime }) {
  return fp(async (app: FastifyInstance) => {
    // Tests never enqueue jobs and point REDIS_URL at a bogus host. Creating real
    // BullMQ queues/workers opens ioredis connections whose DNS failures (EAI_AGAIN
    // under a retry storm) leak as unhandled rejections and fail the run. Decorate
    // inert stubs and skip all Redis setup; production behaviour is unchanged.
    if (env.NODE_ENV === "test") {
      const stub = { add: async () => undefined, close: async () => undefined };
      app.decorate("scanQueue", stub as unknown as Queue<ScanJobData>);
      app.decorate("translateQueue", stub as unknown as Queue<TranslateJobData>);
      app.decorate("keyframesQueue", stub as unknown as Queue<KeyframesJobData>);
      app.decorate("subtitlesQueue", stub as unknown as Queue<SubtitlesJobData>);
      return;
    }

    const connection = { url: env.REDIS_URL };
    const runtime = deps?.runtime ?? buildMountRuntime(env);

    const queue = new Queue<ScanJobData>("scan", { connection });

    // ── Processor ─────────────────────────────────────────────────────────

    async function processor(job: Job<ScanJobData>): Promise<void> {
      const { jobId, libraryId, sources } = job.data;
      const { prisma } = app;
      const publish = async (event: ScanProgress): Promise<void> => {
        await job.updateProgress(event);
        scanEvents.emit(jobId, event);
      };

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

      // Best-effort keyframe-index enqueue for a just-(up)serted file. Only
      // probed video files without an existing index need the (expensive,
      // full-file) scan; failures here must never fail the scan itself. This
      // only fires for files the scan just touched — the scanner skips files
      // that are unchanged since the last scan, so it can never backfill a
      // library that predates keyframe pre-extraction on its own. The
      // end-of-scan keyframe backfill sweep (sweepKeyframeBackfill, below)
      // closes that gap by re-checking every probed video file in the library,
      // changed or not.
      const enqueueKeyframesIfNeeded = async (
        filePath: string,
        tech: MediaFileTechnical,
      ): Promise<void> => {
        if (!(tech.probedOk && tech.videoCodec)) return;
        try {
          const f = await prisma.mediaFile.findUnique({
            where: { path: filePath },
            select: { id: true, keyframes: true },
          });
          if (f && !(Array.isArray(f.keyframes) && f.keyframes.length > 0)) {
            await app.keyframesQueue.add("keyframes", { fileId: f.id }, { jobId: f.id });
          }
        } catch (err) {
          app.log.warn({ err }, "keyframes enqueue failed");
        }
      };

      // Best-effort pre-extraction of TEXT subtitle tracks for a just-(up)serted
      // file. Runs as a background job (per-track ffmpeg demux is tens of
      // seconds for a feature film) so the persisted WebVTT is ready before a
      // client ever selects it — and so the master playlist can safely
      // AUTOSELECT it. The job itself skips tracks already on disk, so a rescan
      // only extracts what's missing. Image-only / un-probed files enqueue
      // nothing; failures must never fail the scan.
      const enqueueSubtitlesIfNeeded = async (
        filePath: string,
        tech: MediaFileTechnical,
      ): Promise<void> => {
        if (!tech.probedOk) return;
        if (selectTextSubtitleTracks(tech.subtitleTracks).length === 0) return;
        try {
          const f = await prisma.mediaFile.findUnique({
            where: { path: filePath },
            select: { id: true },
          });
          if (f) {
            await app.subtitlesQueue.add("subtitles", { fileId: f.id }, { jobId: f.id });
          }
        } catch (err) {
          app.log.warn({ err }, "subtitles enqueue failed");
        }
      };

      const upsertItemAndFile = async (input: {
        libraryId: string;
        file: { path: string; mtime: Date; size: number };
        parsed: {
          title: string;
          year?: number;
          tmdbId?: number;
          imdbId?: string;
          seasonNumber?: number;
          episodeNumber?: number;
          episodeTitleHint?: string;
        };
        tech: MediaFileTechnical;
      }): Promise<{ itemId: string; created: boolean }> => {
        const probedOk = input.tech.probedOk ?? true;
        // Check if the file already exists
        const existing = await prisma.mediaFile.findUnique({
          where: { path: input.file.path },
          select: { id: true, mediaItemId: true },
        });

        const fileData = {
          mtime: input.file.mtime,
          size: BigInt(input.file.size),
          container: input.tech.container,
          videoCodec: input.tech.videoCodec,
          audioCodecs: input.tech.audioCodecs,
          width: input.tech.width,
          height: input.tech.height,
          durationSec: input.tech.durationSec,
          bitrate: input.tech.bitrate,
          videoProfile: input.tech.videoProfile,
          videoLevel: input.tech.videoLevel,
          colorTransfer: input.tech.colorTransfer,
          frameRate: input.tech.frameRate,
          // Prisma accepts Json as unknown[]
          subtitleTracks: input.tech.subtitleTracks as unknown as Prisma.InputJsonValue,
          audioTracks: input.tech.audioTracks as unknown as Prisma.InputJsonValue,
          probedOk,
          // Reset on every (re)scan of a new-or-changed file: a stale index from
          // a previous file at this path would otherwise survive an in-place
          // replacement (this object isn't re-derived from tech) and permanently
          // skip re-extraction, since extractKeyframes treats any non-empty
          // array as already-indexed. enqueueKeyframesIfNeeded repopulates it.
          // Prisma.DbNull (not a plain `null`) is required for a nullable Json
          // column — matches the SQL NULL a fresh row gets when the field is
          // omitted from create.
          keyframes: Prisma.DbNull,
        };

        if (existing) {
          await prisma.mediaFile.update({ where: { id: existing.id }, data: fileData });
          await enqueueKeyframesIfNeeded(input.file.path, input.tech);
          await enqueueSubtitlesIfNeeded(input.file.path, input.tech);
          return { itemId: existing.mediaItemId, created: false };
        }

        const isEpisode =
          input.parsed.seasonNumber != null && input.parsed.episodeNumber != null;

        // ── TV episode: series → season → episode → file ──────────────────
        if (isEpisode) {
          const seasonNumber = input.parsed.seasonNumber!;

          // Parsed titles are NFC-composed; rows scanned before that change may
          // hold NFD sortTitles (macOS filenames) — match either form so a new
          // episode attaches to the existing series instead of duplicating it.
          const titleForms = {
            in: [
              input.parsed.title.toLowerCase(),
              input.parsed.title.normalize("NFD").toLowerCase(),
            ],
          };
          let series = await prisma.mediaItem.findFirst({
            where: {
              libraryId: input.libraryId,
              kind: "series",
              sortTitle: titleForms,
              year: input.parsed.year ?? null,
            },
            select: { id: true },
          });
          if (!series) {
            // Sibling-year adoption: packs of one show differ in whether they
            // carry a year ("Doctor.Who.2005.S01" vs "Doctor Who 14"). Title-
            // equal rows must converge on one series — a year-less twin would
            // resolve blind and can land on a namesake (Doctor Who 1963).
            // STRICTLY a pre-enrich grouping aid: only UNMATCHED rows are
            // adopted into. A matched row keeps its identity — a same-titled
            // remake added later must become its own item and let resolution
            // (season shape) arbitrate, not silently fuse into the other show.
            if (input.parsed.year != null) {
              // A season straddling New Year yields per-file years one apart
              // (Billions S5: 2020+2021) — an adjacent-year row is the same
              // show. Remakes sharing a title are never a single year apart.
              const adjacent = await prisma.mediaItem.findFirst({
                where: {
                  libraryId: input.libraryId,
                  kind: "series",
                  matchState: "unmatched",
                  sortTitle: titleForms,
                  year: { in: [input.parsed.year - 1, input.parsed.year + 1] },
                },
                orderBy: { addedAt: "asc" },
                select: { id: true },
              });
              if (adjacent) {
                series = adjacent;
              } else {
                const yearless = await prisma.mediaItem.findFirst({
                  where: {
                    libraryId: input.libraryId,
                    kind: "series",
                    matchState: "unmatched",
                    sortTitle: titleForms,
                    year: null,
                  },
                  orderBy: { addedAt: "asc" },
                  select: { id: true },
                });
                if (yearless) {
                  await prisma.mediaItem.update({ where: { id: yearless.id }, data: { year: input.parsed.year } });
                  series = yearless;
                }
              }
            } else {
              series = await prisma.mediaItem.findFirst({
                where: {
                  libraryId: input.libraryId,
                  kind: "series",
                  matchState: "unmatched",
                  sortTitle: titleForms,
                  year: { not: null },
                },
                orderBy: { addedAt: "asc" },
                select: { id: true },
              });
            }
          }
          if (!series) {
            series = await prisma.mediaItem.create({
              data: {
                libraryId: input.libraryId,
                kind: "series",
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

          const season = await prisma.season.upsert({
            where: { seriesId_seasonNumber: { seriesId: series.id, seasonNumber } },
            create: { seriesId: series.id, seasonNumber },
            update: {},
            select: { id: true },
          });

          // Unnumbered specials carry a provisional 900+yy number (enrichment
          // renumbers them via the provider's specials list). Same-year
          // specials collide on it — bump past slots held by a DIFFERENT one.
          let episodeNumber = input.parsed.episodeNumber!;
          if (seasonNumber === 0 && episodeNumber >= PROVISIONAL_SPECIAL_BASE) {
            for (;;) {
              const occupied = await prisma.episode.findUnique({
                where: { seasonId_episodeNumber: { seasonId: season.id, episodeNumber } },
                select: { title: true },
              });
              if (!occupied) break;
              // Only a matching non-empty hint identifies the same special —
              // two hint-less same-year specials are distinct episodes.
              if (
                occupied.title != null &&
                input.parsed.episodeTitleHint != null &&
                occupied.title === input.parsed.episodeTitleHint
              ) {
                break;
              }
              episodeNumber++;
            }
          }

          const episode = await prisma.episode.upsert({
            where: { seasonId_episodeNumber: { seasonId: season.id, episodeNumber } },
            create: {
              seasonId: season.id,
              seriesId: series.id,
              episodeNumber,
              // The local name doubles as the display title until enrichment
              // resolves the real one — and as the title-match hint doing so.
              ...(input.parsed.episodeTitleHint ? { title: input.parsed.episodeTitleHint } : {}),
            },
            update: {},
            select: { id: true },
          });

          await prisma.mediaFile.create({
            data: {
              mediaItemId: series.id,
              episodeId: episode.id,
              path: input.file.path,
              ...fileData,
            },
          });

          await enqueueKeyframesIfNeeded(input.file.path, input.tech);
          await enqueueSubtitlesIfNeeded(input.file.path, input.tech);
          return { itemId: series.id, created: true };
        }

        // ── Movie: find or create the parent MediaItem ────────────────────
        // NFC/NFD dual lookup — see the series lookup above.
        let item = await prisma.mediaItem.findFirst({
          where: {
            libraryId: input.libraryId,
            kind: "movie",
            sortTitle: {
              in: [
                input.parsed.title.toLowerCase(),
                input.parsed.title.normalize("NFD").toLowerCase(),
              ],
            },
            year: input.parsed.year ?? null,
          },
          select: { id: true },
        });

        if (!item) {
          item = await prisma.mediaItem.create({
            data: {
              libraryId: input.libraryId,
              kind: "movie",
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
            ...fileData,
          },
        });

        await enqueueKeyframesIfNeeded(input.file.path, input.tech);
        await enqueueSubtitlesIfNeeded(input.file.path, input.tech);
        return { itemId: item.id, created: true };
      };

      // ── Scan phase ─────────────────────────────────────────────────────

      const allItemIds = new Set<string>();
      let totalAdded = 0;
      let totalUpdated = 0;
      let totalSkipped = 0;

      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]!;

        await publish({ phase: "scanning", processed: i, total: sources.length });

        // Resolve each source to a local root (mounting SMB if needed). A
        // per-source failure is reported and skipped; remaining sources proceed.
        let root: string;
        try {
          root = await runtime.resolve(source);
        } catch (err) {
          const message = err instanceof Error ? err.message : "source unavailable";
          await prisma.source.update({ where: { id: source.id }, data: { status: "error", statusMessage: message } });
          await publish({ phase: "scanning", processed: i, total: sources.length, message: `skipped source: ${message}` });
          continue;
        }
        await prisma.source.update({ where: { id: source.id }, data: { status: "ok", statusMessage: null } });

        const result = await scanSource(
          { libraryId, root },
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
        // One language-configured client per active language; satisfies both the
        // movie (movie) and series (tv/tvSeason) translate-client surfaces.
        const translateClients = new Map<string, TmdbClient>();
        for (const lang of activeLanguages) {
          translateClients.set(lang, new TmdbClient(token, undefined, tmdbLanguageTag(lang)));
        }

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

        // TVDB is optional; when configured, series enrich TVDB-first.
        const tvdbApiKey = await getSetting<string>("tvdbApiKey", {
          fallback: "",
          read: (k) => prisma.setting.findUnique({ where: { key: k } }),
        });
        const tvdbPin = await getSetting<string>("tvdbPin", {
          fallback: "",
          read: (k) => prisma.setting.findUnique({ where: { key: k } }),
        });
        const tvdb = tvdbApiKey ? new TvdbClient(tvdbApiKey, fetch, tvdbPin || undefined) : null;
        const tvdbTranslateClients = new Map<string, TvdbClient>();
        if (tvdbApiKey) {
          for (const lang of activeLanguages) {
            tvdbTranslateClients.set(lang, new TvdbClient(tvdbApiKey, fetch, tvdbPin || undefined, tvdbLanguageTag(lang)));
          }
        }

        const boundCacheImageUrl = (url: string, kind: ImageKind): Promise<string> =>
          cacheImageFromUrl(url, kind, imageIo);

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

        // TV logo: prefer the TVDB clearlogo art (absolute URL) when present,
        // else TMDB's own logo art keyed by the cross-referenced tmdbId.
        const resolveLogoTv = async (id: {
          tvdbId?: number;
          tmdbId?: number;
          logoUrl?: string;
        }): Promise<string | undefined> => {
          if (id.logoUrl) return cacheImageFromUrl(id.logoUrl, "logo", imageIo);
          if (id.tmdbId != null) {
            const tmdbLogo = await client.tvLogoPath(id.tmdbId);
            if (tmdbLogo) return boundCacheImage(tmdbLogo, "logo");
          }
          return undefined;
        };

        const fetchRatings = omdbKey
          ? (imdbId: string) => fetchOmdbRatings(imdbId, { fetchImpl: fetch, apiKey: omdbKey })
          : undefined;

        const saveMetadata = async (input: SaveMetadataInput): Promise<void> => {
          // ~40 sequential queries (genres/keywords/cast upserts) in one
          // interactive transaction can exceed Prisma's 5s default on a slow
          // NAS, aborting enrichment. Raise the window generously.
          await prisma.$transaction(async (tx) => {
            // Duplicate reconciliation. The scan creates one MediaItem per file,
            // keyed on the parsed filename, so a movie that exists as several
            // files (different naming, missing year, or a foreign-language copy)
            // becomes multiple items. Enrichment is the first point we know their
            // shared TMDB identity — collapse the collision onto one canonical
            // item (earliest-added), reattaching the others' files. Reaping the
            // duplicate before writing the tmdbId also keeps the partial-unique
            // index on (libraryId, kind, tmdbId) satisfied.
            const cur = await tx.mediaItem.findUnique({
              where: { id: input.itemId },
              select: { libraryId: true, kind: true, addedAt: true },
            });
            if (cur) {
              const siblings = await tx.mediaItem.findMany({
                where: {
                  libraryId: cur.libraryId,
                  kind: cur.kind,
                  tmdbId: input.tmdbId,
                  id: { not: input.itemId },
                },
                select: { id: true, libraryId: true, kind: true, tmdbId: true, addedAt: true },
              });
              const plan = planTmdbDedup(
                {
                  id: input.itemId,
                  libraryId: cur.libraryId,
                  kind: cur.kind,
                  tmdbId: input.tmdbId,
                  addedAt: cur.addedAt.getTime(),
                },
                siblings.map((s) => ({
                  id: s.id,
                  libraryId: s.libraryId,
                  kind: s.kind,
                  tmdbId: s.tmdbId,
                  addedAt: s.addedAt.getTime(),
                })),
              );
              if (plan.action === "merge") {
                for (const obsoleteId of plan.obsoleteIds) {
                  // Reattach files to the survivor; drop rows that reference the
                  // duplicate but have no FK cascade (playback state, play
                  // events, embedding). The item delete cascades the rest.
                  await tx.mediaFile.updateMany({
                    where: { mediaItemId: obsoleteId },
                    data: { mediaItemId: plan.canonicalId },
                  });
                  await tx.playbackState.deleteMany({ where: { mediaItemId: obsoleteId } });
                  await tx.playEvent.deleteMany({ where: { mediaItemId: obsoleteId } });
                  await tx.embedding.deleteMany({ where: { mediaItemId: obsoleteId } });
                  await tx.mediaItem.delete({ where: { id: obsoleteId } });
                }
                if (plan.canonicalId !== input.itemId) {
                  // This item was folded into an existing canonical entry whose
                  // metadata is already written — nothing left to do.
                  return;
                }
              }
            }

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
                // Genre.tmdbId is @unique. TVDB genres have no TMDB id and arrive
                // as the sentinel 0; a 2nd such genre would violate the unique
                // constraint (P2002). Coerce any non-positive id to null so
                // multiple TVDB genres coexist (Postgres allows many NULLs).
                create: { name: g.name, tmdbId: g.tmdbId && g.tmdbId > 0 ? g.tmdbId : null },
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

            // Per-language metadata translations — REPLACE (not additive) so a
            // translation that is no longer real (e.g. a previously-stored
            // original-language fallback) is removed on re-enrich. base = en.
            await tx.mediaItemTranslation.deleteMany({ where: { mediaItemId: input.itemId } });
            for (const tr of input.translations ?? []) {
              await tx.mediaItemTranslation.create({
                data: {
                  mediaItemId: input.itemId,
                  language: tr.language,
                  title: tr.title,
                  overview: tr.overview ?? null,
                },
              });
            }
          }, { timeout: 20_000, maxWait: 10_000 });
        };

        /**
         * Fold an obsolete duplicate series row into the canonical: move each
         * episode row across (or just its files when the canonical already has
         * that episode from provider metadata), then delete the husk. Every
         * file's episodeId must be re-pointed BEFORE the delete — Episode
         * cascades MediaFile, so a file left on an obsolete episode row would
         * be lost with it.
         */
        const mergeSeriesInto = async (
          tx: Prisma.TransactionClient,
          canonicalId: string,
          obsoleteId: string,
        ): Promise<void> => {
          const seasons = await tx.season.findMany({
            where: { seriesId: obsoleteId },
            select: {
              id: true,
              seasonNumber: true,
              episodes: { select: { id: true, episodeNumber: true } },
            },
          });
          for (const season of seasons) {
            if (!season.episodes.length) continue;
            const target = await tx.season.upsert({
              where: { seriesId_seasonNumber: { seriesId: canonicalId, seasonNumber: season.seasonNumber } },
              create: { seriesId: canonicalId, seasonNumber: season.seasonNumber },
              update: {},
              select: { id: true },
            });
            // One read of the canonical season, then grouped writes — a
            // 300-episode merge must not issue per-episode round trips inside
            // this transaction.
            const canonicalEpisodes = await tx.episode.findMany({
              where: { seasonId: target.id },
              select: { id: true, episodeNumber: true },
            });
            const canonicalByNumber = new Map(canonicalEpisodes.map((e) => [e.episodeNumber, e.id]));
            const movedIds: string[] = [];
            for (const ep of season.episodes) {
              const existingId = canonicalByNumber.get(ep.episodeNumber);
              if (existingId) {
                // Canonical already has this episode (provider metadata) —
                // move the files only; the duplicate row dies with the husk.
                await tx.mediaFile.updateMany({
                  where: { episodeId: ep.id },
                  data: { episodeId: existingId, mediaItemId: canonicalId },
                });
              } else {
                movedIds.push(ep.id);
              }
            }
            if (movedIds.length) {
              await tx.episode.updateMany({
                where: { id: { in: movedIds } },
                data: { seasonId: target.id, seriesId: canonicalId },
              });
              await tx.mediaFile.updateMany({
                where: { episodeId: { in: movedIds } },
                data: { mediaItemId: canonicalId },
              });
            }
          }
          await tx.mediaFile.updateMany({
            where: { mediaItemId: obsoleteId, episodeId: null },
            data: { mediaItemId: canonicalId },
          });
          await tx.playbackState.deleteMany({ where: { mediaItemId: obsoleteId } });
          await tx.playEvent.deleteMany({ where: { mediaItemId: obsoleteId } });
          await tx.embedding.deleteMany({ where: { mediaItemId: obsoleteId } });
          await tx.mediaItem.delete({ where: { id: obsoleteId } });
        };

        const saveSeries = async (input: SaveSeriesInput): Promise<void> => {
          // Series scalars + genres atomically; seasons/episodes are idempotent
          // upserts done after, so a long show doesn't hold one big transaction.
          // When this item folds into an existing canonical, all writes retarget
          // to it — the metadata was fetched for the SAME provider identity
          // (that's why they merged) and the canonical, being matched, would
          // otherwise never receive the new seasons' titles/stills.
          let targetId = input.itemId;
          await prisma.$transaction(async (tx) => {
            // Duplicate reconciliation, series flavor: season packs of one show
            // parse to different pre-enrich titles/years, each its own row —
            // enrichment is the first point their shared provider identity is
            // known. Collapse onto the earliest-added row (see planSeriesDedup).
            const cur = await tx.mediaItem.findUnique({
              where: { id: input.itemId },
              select: { libraryId: true, addedAt: true },
            });
            if (cur && (input.tvdbId != null || input.tmdbId != null)) {
              const siblings = await tx.mediaItem.findMany({
                where: {
                  libraryId: cur.libraryId,
                  kind: "series",
                  id: { not: input.itemId },
                  OR: [
                    ...(input.tvdbId != null ? [{ tvdbId: input.tvdbId }] : []),
                    ...(input.tmdbId != null ? [{ tmdbId: input.tmdbId }] : []),
                  ],
                },
                select: { id: true, libraryId: true, tvdbId: true, tmdbId: true, addedAt: true },
              });
              const plan = planSeriesDedup(
                {
                  id: input.itemId,
                  libraryId: cur.libraryId,
                  tvdbId: input.tvdbId ?? null,
                  tmdbId: input.tmdbId ?? null,
                  addedAt: cur.addedAt.getTime(),
                },
                siblings.map((s) => ({
                  id: s.id,
                  libraryId: s.libraryId,
                  tvdbId: s.tvdbId,
                  tmdbId: s.tmdbId,
                  addedAt: s.addedAt.getTime(),
                })),
              );
              if (plan.action === "merge") {
                for (const obsoleteId of plan.obsoleteIds) {
                  if (obsoleteId === input.itemId) continue;
                  await mergeSeriesInto(tx, plan.canonicalId, obsoleteId);
                }
                if (plan.canonicalId !== input.itemId) {
                  await mergeSeriesInto(tx, plan.canonicalId, input.itemId);
                  targetId = plan.canonicalId;
                }
              }
            }

            const data: Prisma.MediaItemUpdateInput = {
              title: input.title,
              sortTitle: input.title.toLowerCase(),
              kind: "series",
              year: input.year ?? null,
              overview: input.overview ?? null,
              tagline: input.tagline ?? null,
              status: input.status ?? null,
              posterPath: input.posterPath ?? null,
              imdbId: input.imdbId ?? null,
              tmdbId: input.tmdbId ?? null,
              tvdbId: input.tvdbId ?? null,
              metadataSource: input.metadataSource ?? "tmdb",
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

            await tx.mediaItem.update({ where: { id: targetId }, data });

            await tx.mediaItemGenre.deleteMany({ where: { mediaItemId: targetId } });
            for (const g of input.genres) {
              const genre = await tx.genre.upsert({
                where: { name: g.name },
                // Genre.tmdbId is @unique. TVDB genres have no TMDB id and arrive
                // as the sentinel 0; a 2nd such genre would violate the unique
                // constraint (P2002). Coerce any non-positive id to null so
                // multiple TVDB genres coexist (Postgres allows many NULLs).
                create: { name: g.name, tmdbId: g.tmdbId && g.tmdbId > 0 ? g.tmdbId : null },
                update: {},
              });
              await tx.mediaItemGenre.create({
                data: { mediaItemId: targetId, genreId: genre.id },
              });
            }

            // Series-level title/overview translations — REPLACE (not additive)
            // so a no-longer-real translation (e.g. an old original-language
            // fallback) is removed on re-enrich. base = en.
            await tx.mediaItemTranslation.deleteMany({ where: { mediaItemId: targetId } });
            for (const tr of input.translations ?? []) {
              await tx.mediaItemTranslation.create({
                data: {
                  mediaItemId: targetId,
                  language: tr.language,
                  title: tr.title,
                  overview: tr.overview ?? null,
                },
              });
            }
          }, { timeout: 20_000, maxWait: 10_000 });

          for (const s of input.seasons) {
            const seasonData = {
              name: s.name ?? null,
              overview: s.overview ?? null,
              posterPath: s.posterPath ?? null,
              airYear: s.airYear ?? null,
              tmdbSeasonId: s.tmdbSeasonId ?? null,
              tvdbSeasonId: s.tvdbSeasonId ?? null,
            };
            const season = await prisma.season.upsert({
              where: {
                seriesId_seasonNumber: { seriesId: targetId, seasonNumber: s.seasonNumber },
              },
              create: { seriesId: targetId, seasonNumber: s.seasonNumber, ...seasonData },
              update: seasonData,
              select: { id: true },
            });

            for (const tr of s.translations ?? []) {
              await prisma.seasonTranslation.upsert({
                where: { seasonId_language: { seasonId: season.id, language: tr.language } },
                create: { seasonId: season.id, language: tr.language, name: tr.name ?? null, overview: tr.overview ?? null },
                update: { name: tr.name ?? null, overview: tr.overview ?? null },
              });
            }

            for (const e of s.episodes) {
              const epBase = {
                title: e.title ?? null,
                overview: e.overview ?? null,
                runtimeSec: e.runtimeSec ?? null,
                airDate: e.airDate ? new Date(e.airDate) : null,
                tmdbEpisodeId: e.tmdbEpisodeId ?? null,
                tvdbEpisodeId: e.tvdbEpisodeId ?? null,
              };
              // Only (re)write stillPath when TMDB provides one; otherwise leave
              // the existing value so a frame still from the fallback survives.
              const epUpdate = e.stillPath != null ? { ...epBase, stillPath: e.stillPath } : epBase;
              const episode = await prisma.episode.upsert({
                where: {
                  seasonId_episodeNumber: { seasonId: season.id, episodeNumber: e.episodeNumber },
                },
                create: {
                  seasonId: season.id,
                  seriesId: targetId,
                  episodeNumber: e.episodeNumber,
                  ...epBase,
                  stillPath: e.stillPath ?? null,
                },
                update: epUpdate,
                select: { id: true },
              });

              for (const tr of e.translations ?? []) {
                await prisma.episodeTranslation.upsert({
                  where: { episodeId_language: { episodeId: episode.id, language: tr.language } },
                  create: { episodeId: episode.id, language: tr.language, title: tr.title ?? null, overview: tr.overview ?? null },
                  update: { title: tr.title ?? null, overview: tr.overview ?? null },
                });
              }
            }
          }
        };

        /**
         * Move files from provisional (900+) season-0 episode rows onto the
         * provider's real specials, matched by the local title hint, the
         * episode's own air year, or a christmas-date tiebreak. Unresolvable
         * ones keep their provisional number (still browsable/playable).
         */
        async function resolveProvisionalSpecials(seriesId: string): Promise<void> {
          const provisional = await prisma.episode.findMany({
            where: { seriesId, episodeNumber: { gte: PROVISIONAL_SPECIAL_BASE }, season: { seasonNumber: 0 }, files: { some: {} } },
            select: { id: true, title: true, files: { select: { path: true } } },
          });
          if (!provisional.length) return;
          const official = await prisma.episode.findMany({
            where: { seriesId, episodeNumber: { lt: PROVISIONAL_SPECIAL_BASE }, season: { seasonNumber: 0 } },
            select: { id: true, episodeNumber: true, title: true, airDate: true },
          });
          if (!official.length) return;
          const candidates = official.map((e) => ({
            episodeNumber: e.episodeNumber,
            ...(e.title ? { title: e.title } : {}),
            ...(e.airDate ? { airDate: e.airDate.toISOString().slice(0, 10) } : {}),
          }));
          for (const p of provisional) {
            const filePath = p.files[0]?.path ?? "";
            const reparsed = filePath ? parseMediaPath(filePath) : undefined;
            const n = matchSpecialEpisode(
              {
                ...(p.title ? { title: p.title } : {}),
                ...(reparsed?.episodeYear != null ? { year: reparsed.episodeYear } : {}),
                christmas: /christmas/i.test(filePath),
              },
              candidates,
            );
            const target = n != null ? official.find((e) => e.episodeNumber === n) : undefined;
            if (!target) continue;
            await prisma.mediaFile.updateMany({ where: { episodeId: p.id }, data: { episodeId: target.id } });
            await prisma.episode.delete({ where: { id: p.id } });
          }
        }

        // Build enrichment set: touched items UNION any still-unmatched in this library
        const enrichIds = new Set<string>(allItemIds);
        const unmatchedItems = await prisma.mediaItem.findMany({
          where: { libraryId, matchState: "unmatched" },
          select: { id: true },
        });
        for (const u of unmatchedItems) enrichIds.add(u.id);

        const enrichIdsArr = [...enrichIds];

        await publish({
          phase: "enriching",
          processed: 0,
          total: enrichIds.size,
        });

        for (let i = 0; i < enrichIdsArr.length; i++) {
          const itemId = enrichIdsArr[i]!;
          const item = await prisma.mediaItem.findUnique({
            where: { id: itemId },
            select: { id: true, kind: true, title: true, year: true, tmdbId: true, tvdbId: true, matchState: true },
          });
          if (!item) continue;

          // Never overwrite admin-chosen metadata on rescan — skip manual items.
          if (item.matchState === "manual") continue;

          try {
            const base = {
              id: item.id,
              title: item.title,
              year: item.year ?? undefined,
              tmdbId: item.tmdbId ?? undefined,
            };
            let result: EnrichResult;
            if (item.kind === "series") {
              // File-backed local structure only: which seasons the FILES span
              // and how many episodes each holds. Metadata-only rows (from a
              // previous enrich) must not count — a wrong earlier match would
              // poison shape verification and re-fetch phantom seasons.
              const fileEpisodes = await prisma.episode.findMany({
                where: { seriesId: item.id, files: { some: {} } },
                select: { episodeNumber: true, season: { select: { seasonNumber: true } } },
              });
              const shapeBySeason = new Map<number, { episodeCount: number; maxEpisode: number }>();
              for (const e of fileEpisodes) {
                const n = e.season.seasonNumber;
                const cur = shapeBySeason.get(n) ?? { episodeCount: 0, maxEpisode: 0 };
                cur.episodeCount++;
                // Provisional specials numbers are not real positions.
                if (e.episodeNumber < PROVISIONAL_SPECIAL_BASE && e.episodeNumber > cur.maxEpisode) {
                  cur.maxEpisode = e.episodeNumber;
                }
                shapeBySeason.set(n, cur);
              }
              const localShape: LocalSeasonShape[] = [...shapeBySeason].map(([seasonNumber, v]) => ({
                seasonNumber,
                episodeCount: v.episodeCount,
                maxEpisode: v.maxEpisode || v.episodeCount,
              }));
              const localSeasonNumbers = localShape.map((s) => s.seasonNumber);

              // Faithful title variants from the actual file paths — the folder
              // vs filename vs pack disagreements (umbrella folders, typos)
              // the parser surfaced. Resolution is skipped entirely once both
              // provider ids are pinned, so don't re-parse paths for nothing.
              let titleVariants: string[] | undefined;
              if (item.tvdbId == null || item.tmdbId == null) {
                const firstFile = await prisma.mediaFile.findFirst({
                  where: { mediaItemId: item.id },
                  orderBy: { path: "asc" },
                  select: { path: true },
                });
                if (firstFile) {
                  const reparsed = parseMediaPath(firstFile.path);
                  // A single-path re-parse has no sibling context, so an
                  // ordinal-run episode ("001 - Title.mkv") parses as a movie
                  // carrying the EPISODE's title — never a faithful series
                  // name. Only trust the re-parse when it independently
                  // recognized the episode (explicit SxxExx / season folder),
                  // which is exactly the umbrella-folder case variants target.
                  if (reparsed.seasonNumber != null) {
                    const extra = [reparsed.title, ...(reparsed.titleVariants ?? [])].filter(
                      (t) => t && t.toLowerCase() !== item.title.toLowerCase(),
                    );
                    if (extra.length) titleVariants = [...new Set(extra)].slice(0, 3);
                  }
                }
              }

              // TVDB first (when configured); fall back to TMDB on no match.
              if (tvdb) {
                try {
                  result = await enrichSeriesTvdb(
                    {
                      id: item.id,
                      title: item.title,
                      year: item.year ?? undefined,
                      tvdbId: item.tvdbId ?? undefined,
                      ...(titleVariants ? { titleVariants } : {}),
                    },
                    {
                      client: tvdb,
                      cacheImageUrl: boundCacheImageUrl,
                      saveSeries,
                      resolveLogo: resolveLogoTv,
                      fetchRatings,
                      localSeasonNumbers,
                      localShape,
                      translateClients: tvdbTranslateClients,
                    },
                  );
                } catch (err) {
                  app.log.warn({ err, itemId: item.id }, "TVDB enrichment failed — falling back to TMDB");
                  result = { matched: false };
                }
              } else {
                result = { matched: false };
              }

              if (!result.matched) {
                result = await enrichSeries(
                  { ...base, ...(titleVariants ? { titleVariants } : {}) },
                  {
                    client,
                    cacheImage: boundCacheImage,
                    saveSeries,
                    resolveLogo: resolveLogoTv,
                    fetchRatings,
                    localSeasonNumbers,
                    localShape,
                    translateClients,
                  },
                );
              }

              // Unnumbered specials went in with provisional numbers — now
              // that the provider's season-0 list is saved, resolve them onto
              // the real episodes (title hint → air year → christmas). The
              // item may have FOLDED into a canonical during save: renumber
              // wherever its episodes now live.
              if (result.matched) {
                try {
                  const ownerId =
                    (await prisma.mediaItem.findUnique({ where: { id: item.id }, select: { id: true } }))?.id ??
                    (
                      await prisma.mediaItem.findFirst({
                        where: {
                          libraryId,
                          kind: "series",
                          OR: [
                            ...(result.tvdbId != null ? [{ tvdbId: result.tvdbId }] : []),
                            ...(result.tmdbId != null ? [{ tmdbId: result.tmdbId }] : []),
                          ],
                        },
                        select: { id: true },
                      })
                    )?.id;
                  if (ownerId) await resolveProvisionalSpecials(ownerId);
                } catch (err) {
                  app.log.warn({ err, itemId: item.id }, "[scan] specials renumbering failed — provisional numbers kept");
                }
              }
            } else {
              result = await enrichItem(base, {
                client,
                cacheImage: boundCacheImage,
                saveMetadata,
                resolveLogo,
                fetchRatings,
                translateClients,
              });
            }

            if (result.matched) matched++;
          } catch (err) {
            app.log.warn({ err, itemId }, "enrich failed — continuing with remaining items");
          }

          await publish({
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

        // ── Episode still fallback ───────────────────────────────────────
        // Episodes TMDB has no still for: grab an early frame from the local
        // file via ffmpeg. Best-effort; skip silently when ffmpeg/file is absent.
        const needStill = await prisma.episode.findMany({
          where: {
            seriesId: { in: enrichIdsArr },
            stillPath: null,
            files: { some: { probedOk: true } },
          },
          select: {
            id: true,
            files: {
              where: { probedOk: true },
              select: { path: true, durationSec: true },
              take: 1,
            },
          },
        });
        for (const ep of needStill) {
          const file = ep.files[0];
          if (!file) continue;
          const rel = `still/frame-${ep.id}.jpg`;
          const outAbs = path.join(env.METADATA_DIR, rel);
          try {
            await fs.promises.mkdir(path.dirname(outAbs), { recursive: true });
            const ts = episodeFrameTimestampSec(file.durationSec);
            await execFileAsync("ffmpeg", [
              "-y",
              "-ss",
              String(ts),
              "-i",
              file.path,
              "-frames:v",
              "1",
              "-vf",
              "scale=640:-2",
              "-q:v",
              "3",
              outAbs,
            ]);
            await prisma.episode.update({ where: { id: ep.id }, data: { stillPath: rel } });
          } catch (err) {
            app.log.debug(
              { err, episodeId: ep.id },
              "[scan] episode still frame fallback failed (ffmpeg missing or unreadable file)",
            );
          }
        }
      }

      // ── Keyframe backfill sweep ──────────────────────────────────────
      // Guarantees this scan (fresh or a rescan of an unchanged library)
      // leaves no probed video file without a keyframe index, closing the
      // gap left by enqueueKeyframesIfNeeded only covering just-(up)serted
      // files. Best-effort internally — never throws.
      await sweepKeyframeBackfill({
        prisma: { mediaFile: { findMany: (args) => prisma.mediaFile.findMany(args as never) } },
        queue: app.keyframesQueue,
        log: app.log,
        libraryId,
      });

      // ── Done ──────────────────────────────────────────────────────────

      const doneEvent: ScanProgress = {
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
      await publish(doneEvent);
      } catch (err) {
        // Emit a terminal error event so SSE clients don't hang forever.
        const errEvt: ScanProgress = {
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        scanDoneCache.set(jobId, errEvt);
        const errTimer = setTimeout(() => scanDoneCache.delete(jobId), 5 * 60 * 1000);
        errTimer.unref?.();
        await publish(errEvt);
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

      const tvdbApiKey = await getSetting<string>("tvdbApiKey", {
        fallback: "",
        read: (k) => prisma.setting.findUnique({ where: { key: k } }),
      });
      const tvdbPin = await getSetting<string>("tvdbPin", {
        fallback: "",
        read: (k) => prisma.setting.findUnique({ where: { key: k } }),
      });
      const tvdbClient = tvdbApiKey
        ? new TvdbClient(tvdbApiKey, fetch, tvdbPin || undefined, tvdbLanguageTag(language))
        : null;

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

      // Backfill a series: localized title/overview (series), season names, and
      // episode titles/overviews — matched to local rows by season/episode number.
      async function translateSeries(seriesId: string, tmdbId: number): Promise<void> {
        const tv = await client.tv(tmdbId);
        await prisma.mediaItemTranslation.upsert({
          where: { mediaItemId_language: { mediaItemId: seriesId, language } },
          create: { mediaItemId: seriesId, language, title: tv.title, overview: tv.overview ?? null },
          update: { title: tv.title, overview: tv.overview ?? null },
        });

        const localSeasons = await prisma.season.findMany({
          where: { seriesId },
          select: { id: true, seasonNumber: true },
        });
        const tvSeasonByNumber = new Map(tv.seasons.map((s) => [s.seasonNumber, s]));

        for (const ls of localSeasons) {
          const ts = tvSeasonByNumber.get(ls.seasonNumber);
          if (ts && (ts.name != null || ts.overview != null)) {
            await prisma.seasonTranslation.upsert({
              where: { seasonId_language: { seasonId: ls.id, language } },
              create: { seasonId: ls.id, language, name: ts.name ?? null, overview: ts.overview ?? null },
              update: { name: ts.name ?? null, overview: ts.overview ?? null },
            });
          }

          let tmdbEpisodes: Awaited<ReturnType<typeof client.tvSeason>> = [];
          try {
            tmdbEpisodes = await client.tvSeason(tmdbId, ls.seasonNumber);
          } catch {
            tmdbEpisodes = [];
          }
          if (tmdbEpisodes.length === 0) continue;

          const localEpisodes = await prisma.episode.findMany({
            where: { seasonId: ls.id },
            select: { id: true, episodeNumber: true },
          });
          const tmdbEpByNumber = new Map(tmdbEpisodes.map((e) => [e.episodeNumber, e]));
          for (const le of localEpisodes) {
            const te = tmdbEpByNumber.get(le.episodeNumber);
            if (!te || (te.title == null && te.overview == null)) continue;
            await prisma.episodeTranslation.upsert({
              where: { episodeId_language: { episodeId: le.id, language } },
              create: { episodeId: le.id, language, title: te.title ?? null, overview: te.overview ?? null },
              update: { title: te.title ?? null, overview: te.overview ?? null },
            });
          }
        }
      }

      // Backfill a TVDB-sourced series: localized title/overview (series) and
      // episode titles/overviews — matched to local rows by season/episode number.
      async function translateSeriesTvdb(seriesId: string, tvdbId: number): Promise<void> {
        if (!tvdbClient) return;
        const tr = await tvdbClient.seriesTranslated(tvdbId);
        if (tr.title) {
          await prisma.mediaItemTranslation.upsert({
            where: { mediaItemId_language: { mediaItemId: seriesId, language } },
            create: { mediaItemId: seriesId, language, title: tr.title, overview: tr.overview ?? null },
            update: { title: tr.title, overview: tr.overview ?? null },
          });
        }
        const localEpisodes = await prisma.episode.findMany({
          where: { seriesId },
          select: { id: true, seasonId: true, episodeNumber: true, season: { select: { seasonNumber: true } } },
        });
        for (const le of localEpisodes) {
          const t = tr.episodes.get(`${le.season.seasonNumber}:${le.episodeNumber}`);
          if (!t || (t.title == null && t.overview == null)) continue;
          await prisma.episodeTranslation.upsert({
            where: { episodeId_language: { episodeId: le.id, language } },
            create: { episodeId: le.id, language, title: t.title ?? null, overview: t.overview ?? null },
            update: { title: t.title ?? null, overview: t.overview ?? null },
          });
        }
      }

      // Per-item localized text for every matched item (movie or series).
      const items = await prisma.mediaItem.findMany({
        where: {
          matchState: { not: "unmatched" },
          OR: [{ tmdbId: { not: null } }, { tvdbId: { not: null } }],
        },
        select: { id: true, kind: true, tmdbId: true, tvdbId: true, metadataSource: true },
      });

      let processed = 0;
      for (const item of items) {
        try {
          if (item.kind === "series" && (item.metadataSource === "tvdb" || (item.tvdbId != null && item.tmdbId == null))) {
            await translateSeriesTvdb(item.id, item.tvdbId!);
          } else if (item.kind === "series" && item.tmdbId != null) {
            await translateSeries(item.id, item.tmdbId);
          } else if (item.tmdbId != null) {
            const m = await client.movie(item.tmdbId);
            await prisma.mediaItemTranslation.upsert({
              where: { mediaItemId_language: { mediaItemId: item.id, language } },
              create: { mediaItemId: item.id, language, title: m.title, overview: m.overview ?? null },
              update: { title: m.title, overview: m.overview ?? null },
            });
          }
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

    // ── Keyframe extraction ──────────────────────────────────────────────────

    // removeOnComplete/removeOnFail: the jobId=fileId dedup (see
    // enqueueKeyframesIfNeeded / playback.ts) means a finished job's record
    // would otherwise permanently block re-enqueue for that file (and grow
    // Redis without bound) — remove it once it settles so a later rescan (or
    // a subsequent remux negotiation) can re-extract.
    const keyframesQueue = new Queue<KeyframesJobData>("keyframes", {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
    });

    const keyframesWorker = new Worker<KeyframesJobData, void>(
      "keyframes",
      async (job) => {
        const res = await extractKeyframes(job.data.fileId, {
          run: keyframeProbeRunner,
          prisma: app.prisma as never,
        });
        app.log.info({ fileId: job.data.fileId, res }, "keyframe extraction done");
      },
      { connection, concurrency: 1 },
    );
    keyframesWorker.on("error", (err) => app.log.error({ err }, "keyframes worker error"));
    app.decorate("keyframesQueue", keyframesQueue);

    // ── Subtitle pre-extraction ──────────────────────────────────────────────

    // Pre-extract text subtitle tracks to durable WebVTT (METADATA_DIR) so a
    // selected subtitle serves instantly and the master playlist can safely
    // AUTOSELECT it. jobId=fileId dedups concurrent enqueues (scan + backfill);
    // removeOnComplete/removeOnFail keeps Redis bounded and lets a later rescan
    // re-enqueue. Concurrency 1: extraction is a slow full-file demux — run it
    // steadily in the background, never in a burst that starves playback ffmpeg.
    const subtitlesQueue = new Queue<SubtitlesJobData>("subtitles", {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
    });

    const subtitlesWorker = new Worker<SubtitlesJobData, void>(
      "subtitles",
      async (job) => {
        const res = await extractSubtitles(job.data.fileId, {
          run: subtitleExtractRunner,
          exists: (a) => fs.promises.access(a).then(() => true, () => false),
          writeFile: async (a, content) => {
            await fs.promises.mkdir(path.dirname(a), { recursive: true });
            await fs.promises.writeFile(a, content, "utf8");
          },
          metadataDir: env.METADATA_DIR,
          prisma: app.prisma as never,
        });
        app.log.info({ fileId: job.data.fileId, res }, "subtitle extraction done");
      },
      { connection, concurrency: 1 },
    );
    subtitlesWorker.on("error", (err) => app.log.error({ err }, "subtitles worker error"));
    app.decorate("subtitlesQueue", subtitlesQueue);

    app.addHook("onClose", async () => {
      await worker.close();
      await queue.close();
      await translateWorker.close();
      await translateQueue.close();
      await keyframesWorker.close();
      await keyframesQueue.close();
      await subtitlesWorker.close();
      await subtitlesQueue.close();
    });
  });
}

// ── Fastify type augmentation ─────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyInstance {
    scanQueue: Queue<ScanJobData>;
    translateQueue: Queue<TranslateJobData>;
    keyframesQueue: Queue<KeyframesJobData>;
    subtitlesQueue: Queue<SubtitlesJobData>;
  }
}
