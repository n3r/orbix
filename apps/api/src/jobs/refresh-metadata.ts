/**
 * refresh-metadata.ts
 *
 * Periodic TMDB metadata refresh job.
 * Re-fetches movie details for matched/manual items whose metadata is older
 * than the configured cadence (default 90 days), per TMDB's 6-month caching rule.
 *
 * Manual items: textual fields are refreshed but posterPath/backdropPath are
 * preserved so the admin's poster choice is never overwritten.
 */

import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@orbix/db";
import {
  enrichItem,
  cacheImage,
  selectStaleItems,
  type TmdbLike,
  type ImageKind,
  type SaveMetadataInput,
} from "@orbix/core";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RefreshResult {
  refreshed: number;
  skipped: number;
  reason?: string;
}

export interface RefreshOpts {
  cadenceDays: number;
  metadataDir: string;
  now?: Date;
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function refreshMetadata(
  prisma: PrismaClient,
  client: TmdbLike,
  opts: RefreshOpts,
): Promise<RefreshResult> {
  const now = opts.now ?? new Date();

  // Load candidate items: matched or manual, with a tmdbId
  const candidates = await prisma.mediaItem.findMany({
    where: {
      matchState: { in: ["matched", "manual"] },
      tmdbId: { not: null },
    },
    select: {
      id: true,
      title: true,
      year: true,
      tmdbId: true,
      matchState: true,
      posterPath: true,
      backdropPath: true,
      updatedAt: true,
    },
  });

  const staleIds = new Set(selectStaleItems(candidates, opts.cadenceDays, now));

  if (staleIds.size === 0) {
    return { refreshed: 0, skipped: 0 };
  }

  const staleItems = candidates.filter((c) => staleIds.has(c.id));

  // Bound cacheImage using the same adapter as queue.ts / fix.ts
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
      baseDir: opts.metadataDir,
    });

  let refreshed = 0;
  let skipped = 0;

  for (const item of staleItems) {
    try {
      const isManual = item.matchState === "manual";

      // Snapshot the existing poster/backdrop before enrichment so we can
      // restore them for manual items even if enrichItem caches new images.
      const preservedPosterPath = item.posterPath;
      const preservedBackdropPath = item.backdropPath;

      // Build a per-item saveMetadata that:
      //   - Refreshes all textual fields
      //   - Preserves posterPath/backdropPath for manual items
      //   - Keeps the original matchState (never demote "manual" → "matched")
      const saveMetadata = async (input: SaveMetadataInput): Promise<void> => {
        await prisma.$transaction(async (tx) => {
          await tx.mediaItem.update({
            where: { id: input.itemId },
            data: {
              title: input.title,
              sortTitle: input.title.toLowerCase(),
              year: input.year ?? null,
              overview: input.overview ?? null,
              runtimeSec: input.runtimeSec ?? null,
              imdbId: input.imdbId ?? null,
              tmdbId: input.tmdbId,
              rating: input.rating ?? null,
              matchState: item.matchState as string,
              // Preserve manual poster / backdrop choices
              posterPath: isManual ? preservedPosterPath : (input.posterPath ?? null),
              backdropPath: isManual ? preservedBackdropPath : (input.backdropPath ?? null),
              // updatedAt is @updatedAt — Prisma bumps it automatically
            },
          });

          // Refresh relational data
          await tx.mediaItemGenre.deleteMany({ where: { mediaItemId: input.itemId } });
          await tx.mediaItemKeyword.deleteMany({ where: { mediaItemId: input.itemId } });
          await tx.credit.deleteMany({ where: { mediaItemId: input.itemId } });

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

      await enrichItem(
        {
          id: item.id,
          title: item.title,
          year: item.year ?? undefined,
          tmdbId: item.tmdbId as number,
        },
        { client, cacheImage: boundCacheImage, saveMetadata },
      );

      refreshed++;
    } catch {
      // Best-effort: log nothing here; callers may log if desired.
      skipped++;
    }
  }

  return { refreshed, skipped };
}
