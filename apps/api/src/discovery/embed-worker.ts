/**
 * Embedding worker: embeds individual MediaItems and backfills the Embedding table.
 *
 * Uses raw SQL to write the vector(384) column because Prisma's type system
 * cannot bind pgvector values directly.
 */

import type { PrismaClient } from "@orbix/db";
import { embedText, embedItemText, EmbedderUnavailable } from "./embedder.js";

const EMBED_MODEL = "Xenova/bge-small-en-v1.5";

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
): Promise<void> {
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

  const vector = await embedText(text);
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

/**
 * Backfill: find all matched MediaItems that lack an Embedding row and embed them.
 *
 * Stops early (without throwing) if the embedder becomes unavailable.
 * Per-item errors are logged and skipped so the backfill continues best-effort.
 */
export async function backfillEmbeddings(prisma: PrismaClient): Promise<void> {
  const items = await prisma.$queryRaw<{ id: string }[]>`
    SELECT m.id
    FROM "MediaItem" m
    LEFT JOIN "Embedding" e ON e."mediaItemId" = m.id
    WHERE m."matchState" = 'matched'
      AND e."mediaItemId" IS NULL
  `;

  for (const { id } of items) {
    try {
      await embedItem(prisma, id);
    } catch (err) {
      if (err instanceof EmbedderUnavailable) {
        console.error(
          "[backfillEmbeddings] Embedder unavailable — stopping backfill:",
          err.message,
        );
        return;
      }
      console.error(`[backfillEmbeddings] embedItem failed for ${id}:`, err);
    }
  }
}
