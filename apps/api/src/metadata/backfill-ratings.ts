import type { PrismaClient } from "@orbix/db";
import type { TmdbLike } from "@orbix/core";

/**
 * Backfill `MediaItem.rating` for matched items that currently have no rating.
 *
 * - Best-effort: failures for individual items are logged and skipped.
 * - DI-friendly: accepts prisma and a TmdbLike client so it can be unit-tested
 *   without a real DB or network.
 * - No TMDB token check here — callers are responsible for not passing a client
 *   that will immediately fail due to an empty token.
 */
export async function backfillRatings(
  prisma: PrismaClient,
  client: TmdbLike,
): Promise<{ updated: number; skipped: number }> {
  const items = await prisma.mediaItem.findMany({
    where: {
      matchState: "matched",
      tmdbId: { not: null },
      rating: null,
    },
    select: { id: true, tmdbId: true },
  });

  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    if (item.tmdbId == null) {
      skipped++;
      continue;
    }
    try {
      const rating = await client.releaseCertification(item.tmdbId);
      if (rating) {
        await prisma.mediaItem.update({
          where: { id: item.id },
          data: { rating },
        });
        updated++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  return { updated, skipped };
}
