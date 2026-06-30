/**
 * Embedding worker: embeds individual MediaItems and backfills the Embedding table.
 *
 * Uses raw SQL to write the vector(384) column because Prisma's type system
 * cannot bind pgvector values directly.
 */

import type { PrismaClient } from "@orbix/db";
import { embedText, embedItemText, EmbedderUnavailable } from "./embedder.js";

const EMBED_MODEL = "Xenova/bge-small-en-v1.5";

/** Embed a passage string → vector. Injectable so callers/tests run offline. */
export type EmbedFn = (text: string) => Promise<number[]>;

interface EmbedDeps {
  embed?: EmbedFn;
}

const defaultEmbed: EmbedFn = (text) => embedText(text);

/**
 * Format a number[] as a pgvector literal that PostgreSQL accepts.
 * e.g. [0.1, -0.2, 0.3] → '[0.1,-0.2,0.3]'
 */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Embed a single MediaItem and UPSERT its row into the `Embedding` table.
 *
 * Loads the item's title, overview, genres and keywords, builds a passage
 * string, embeds it, then writes (or updates) the Embedding row via raw SQL.
 *
 * @throws {EmbedderUnavailable} propagated from embedText
 * @throws {Error} if the MediaItem is not found or the DB write fails
 */
export async function embedItem(
  prisma: PrismaClient,
  mediaItemId: string,
  deps: EmbedDeps = {},
): Promise<void> {
  const embed = deps.embed ?? defaultEmbed;
  const item = await prisma.mediaItem.findUnique({
    where: { id: mediaItemId },
    select: {
      id: true,
      title: true,
      overview: true,
      genres: { select: { genre: { select: { name: true } } } },
      keywords: { select: { keyword: { select: { name: true } } } },
    },
  });

  if (!item) throw new Error(`MediaItem ${mediaItemId} not found`);

  const genres = item.genres.map((g) => g.genre.name);
  const keywords = item.keywords.map((k) => k.keyword.name);

  const text = embedItemText({
    title: item.title,
    overview: item.overview ?? undefined,
    genres,
    keywords,
  });

  const vector = await embed(text);
  // Guard: a non-finite element would make the ::vector cast throw at the DB
  // (or silently corrupt the row). Skip this item rather than 500 the backfill.
  if (!vector.every(Number.isFinite)) {
    throw new Error(`non-finite embedding vector for MediaItem ${mediaItemId}`);
  }
  const vectorStr = toVectorLiteral(vector);

  // Raw SQL upsert — Prisma cannot bind the vector(384) type directly.
  // $2 is passed as text and cast to vector via the ::vector operator.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Embedding" ("mediaItemId", "vector", "text", "model", "updatedAt")
     VALUES ($1, $2::vector, $3, $4, now())
     ON CONFLICT ("mediaItemId") DO UPDATE
       SET "vector"    = $2::vector,
           "text"      = $3,
           "model"     = $4,
           "updatedAt" = now()`,
    mediaItemId,
    vectorStr,
    text,
    EMBED_MODEL,
  );
}

/** Outcome of a backfill run. */
export interface BackfillResult {
  processed: number;
  skipped: number;
}

/**
 * Backfill: find all matched MediaItems that lack an Embedding row and embed them.
 *
 * Stops early (without throwing) if the embedder becomes unavailable.
 * Per-item errors are logged and skipped so the backfill continues best-effort.
 * Returns the processed/skipped counts (also logged on completion).
 */
export async function backfillEmbeddings(
  prisma: PrismaClient,
  deps: EmbedDeps = {},
): Promise<BackfillResult> {
  const items = await prisma.$queryRaw<{ id: string }[]>`
    SELECT m.id
    FROM "MediaItem" m
    LEFT JOIN "Embedding" e ON e."mediaItemId" = m.id
    WHERE m."matchState" = 'matched'
      AND e."mediaItemId" IS NULL
  `;

  let processed = 0;
  let skipped = 0;

  for (const { id } of items) {
    try {
      await embedItem(prisma, id, deps);
      processed++;
    } catch (err) {
      if (err instanceof EmbedderUnavailable) {
        console.error(
          "[backfillEmbeddings] Embedder unavailable — stopping backfill:",
          err.message,
        );
        return { processed, skipped };
      }
      skipped++;
      console.error(`[backfillEmbeddings] embedItem failed for ${id}:`, err);
    }
  }

  console.log(
    `[backfillEmbeddings] done — processed=${processed} skipped=${skipped}`,
  );
  return { processed, skipped };
}
