import type { FastifyBaseLogger } from "fastify";
import { Prisma } from "@orbix/db";

export interface KeyframeBackfillDeps {
  prisma: {
    mediaFile: {
      findMany: (args: unknown) => Promise<{ id: string }[]>;
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
 * closes that gap: after every scan, find successfully-probed video files in
 * the library that still lack a keyframe index and enqueue extraction for
 * them too.
 *
 * - The `probedOk: true` gate mirrors enqueueKeyframesIfNeeded's per-file
 *   check: a failed reprobe can leave a stale non-null videoCodec behind
 *   with probedOk=false, and that file's technical data (hence any
 *   extraction) can't be trusted.
 * - The missing-index predicate (`keyframes` is DB NULL or `[]`) is
 *   evaluated DB-side so already-indexed files' (potentially large) JSON
 *   blobs are never fetched — only `id` is selected.
 * - Rows are queued largest-file-first: the keyframes worker runs at
 *   concurrency 1 (serial), and big files are the ones that hit player
 *   timeouts on first play, so healing them first has the highest payoff.
 * - Each `queue.add` is isolated in its own try/catch: one transient queue
 *   failure (e.g. a Redis blip) is logged and skipped rather than aborting
 *   the rest of the batch.
 *
 * Cheap (one query + a loop of dedup-safe queue adds — no inline
 * probing/spawning) and best-effort end to end: any failure here must never
 * fail the scan itself.
 */
export async function sweepKeyframeBackfill(deps: KeyframeBackfillDeps): Promise<void> {
  const { prisma, queue, log, libraryId } = deps;
  try {
    const files = await prisma.mediaFile.findMany({
      where: {
        mediaItem: { libraryId },
        videoCodec: { not: null },
        probedOk: true,
        // Null or empty-array both mean "not indexed yet" (Prisma.DbNull on
        // reset vs. a fresh row) — filtered DB-side, see doc comment above.
        OR: [{ keyframes: { equals: Prisma.DbNull } }, { keyframes: { equals: [] } }],
      },
      select: { id: true },
      orderBy: { size: "desc" },
    });

    let enqueued = 0;
    let failed = 0;
    for (const f of files) {
      try {
        await queue.add("keyframes", { fileId: f.id }, { jobId: f.id });
        enqueued++;
      } catch (err) {
        failed++;
        log.warn({ err, libraryId, fileId: f.id }, "keyframe backfill: failed to enqueue file");
      }
    }

    log.info(
      { libraryId, enqueued, ...(failed > 0 ? { failed } : {}) },
      `keyframe backfill: ${enqueued} files enqueued`,
    );
  } catch (err) {
    log.warn({ err, libraryId }, "keyframe backfill sweep failed");
  }
}
