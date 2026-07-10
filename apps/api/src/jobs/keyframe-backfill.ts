import type { FastifyBaseLogger } from "fastify";

export interface KeyframeBackfillDeps {
  prisma: {
    mediaFile: {
      findMany: (args: unknown) => Promise<{ id: string; keyframes: unknown }[]>;
    };
  };
  queue: {
    add: (
      name: string,
      data: { fileId: string },
      opts: { jobId: string },
    ) => Promise<unknown>;
  };
  log: Pick<FastifyBaseLogger, "info" | "warn">;
  libraryId: string;
}

/**
 * End-of-scan sweep for a just-scanned library: `enqueueKeyframesIfNeeded`
 * (in the scan worker) only fires for files that were just (up)serted, but
 * the scanner skips files that are unchanged since the last scan — so a
 * library that predates keyframe pre-extraction (or that had it briefly
 * disabled) never backfills on its own, and first play of a large file then
 * blocks the HLS playlist on an inline multi-minute extraction. This sweep
 * closes that gap: after every scan, find probed video files in the library
 * that still lack an index and enqueue extraction for them too. Cheap (one
 * query + a loop of dedup-safe queue adds — no inline probing/spawning) and
 * best-effort: any failure here must never fail the scan itself.
 */
export async function sweepKeyframeBackfill(deps: KeyframeBackfillDeps): Promise<void> {
  const { prisma, queue, log, libraryId } = deps;
  try {
    const files = await prisma.mediaFile.findMany({
      where: {
        mediaItem: { libraryId },
        videoCodec: { not: null },
      },
      select: { id: true, keyframes: true },
    });

    let enqueued = 0;
    for (const f of files) {
      // Mirrors enqueueKeyframesIfNeeded's gate: null or empty-array both
      // mean "not indexed yet" (Prisma.DbNull on reset vs. a fresh row).
      if (Array.isArray(f.keyframes) && f.keyframes.length > 0) continue;
      await queue.add("keyframes", { fileId: f.id }, { jobId: f.id });
      enqueued++;
    }

    log.info({ libraryId, enqueued }, `keyframe backfill: ${enqueued} files enqueued`);
  } catch (err) {
    log.warn({ err, libraryId }, "keyframe backfill sweep failed");
  }
}
