/**
 * rebuild-metadata.ts
 *
 * Admin "Rebuild metadata" action. Unlike the periodic refresh job
 * (refresh-metadata.ts), this re-enriches EVERY item right now, ignoring the
 * staleness cadence and without requiring an existing tmdbId:
 *
 *   - matched / unmatched items   → (re-)matched against TMDB by tmdbId when
 *                                    present, otherwise by title + year search.
 *                                    On success the item becomes "matched" and
 *                                    its poster/backdrop are replaced with the
 *                                    freshly-cached TMDB artwork.
 *   - manual items                → textual fields are refreshed, but the
 *                                    admin-chosen poster/backdrop and the
 *                                    "manual" matchState are preserved.
 *
 * This is what turns directly-seeded or never-enriched items (matchState
 * "matched" but tmdbId null, placeholder posters) into real entries without
 * visiting each title's Fix-match page by hand.
 */

import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@orbix/db";
import {
  enrichItem,
  cacheImage,
  type TmdbLike,
  type ImageKind,
  type SaveMetadataInput,
} from "@orbix/core";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RebuildResult {
  /** Items successfully matched + enriched from TMDB. */
  rebuilt: number;
  /** Items TMDB returned no match for (left untouched). */
  unmatched: number;
  /** Items that errored during enrichment (left untouched). */
  skipped: number;
}

export interface RebuildOpts {
  metadataDir: string;
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function rebuildMetadata(
  prisma: PrismaClient,
  client: TmdbLike,
  opts: RebuildOpts,
): Promise<RebuildResult> {
  // Every item is a candidate — no cadence and no tmdbId requirement.
  const candidates = await prisma.mediaItem.findMany({
    select: {
      id: true,
      title: true,
      year: true,
      tmdbId: true,
      matchState: true,
      posterPath: true,
      backdropPath: true,
    },
  });

  // Bound cacheImage using the same adapter as queue.ts / refresh-metadata.ts.
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

  let rebuilt = 0;
  let unmatched = 0;
  let skipped = 0;

  for (const item of candidates) {
    const isManual = item.matchState === "manual";

    // Snapshot manual artwork so a manual item's admin-chosen poster/backdrop
    // survive even though enrichItem caches the TMDB images.
    const preservedPosterPath = item.posterPath;
    const preservedBackdropPath = item.backdropPath;

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
            // Manual items keep their matchState + admin artwork; everything
            // else is promoted to a real "matched" entry with fresh artwork.
            matchState: isManual ? "manual" : "matched",
            posterPath: isManual ? preservedPosterPath : (input.posterPath ?? null),
            backdropPath: isManual ? preservedBackdropPath : (input.backdropPath ?? null),
          },
        });

        // Refresh relational data.
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

    try {
      const result = await enrichItem(
        {
          id: item.id,
          title: item.title,
          year: item.year ?? undefined,
          tmdbId: item.tmdbId ?? undefined,
        },
        { client, cacheImage: boundCacheImage, saveMetadata },
      );
      if (result.matched) {
        rebuilt++;
      } else {
        unmatched++;
      }
    } catch {
      skipped++;
    }
  }

  return { rebuilt, unmatched, skipped };
}
