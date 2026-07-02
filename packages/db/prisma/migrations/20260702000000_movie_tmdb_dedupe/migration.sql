-- Movie duplicate reconciliation + backstop.
--
-- The scanner creates one MediaItem per file, keyed on the parsed filename, so a
-- movie present on disk as several differently-named files (e.g. "I Robot.mkv" and
-- "I.Robot.2004.1080p.mkv", or an English vs a foreign-language copy) becomes
-- several MediaItems that only later enrich to a single TMDB id. This migration
-- (1) collapses any such pre-existing movie duplicates onto one canonical item and
-- (2) adds a partial UNIQUE index so the database refuses to hold two matched movies
-- with the same tmdbId in one library. Scoped to movies only: series merging (which
-- would have to reconcile seasons/episodes) is intentionally out of scope, so series
-- rows are excluded from the constraint and are unaffected.

-- Identify each duplicate movie and the canonical (earliest-added) item to keep.
CREATE TEMP TABLE _movie_dupes AS
SELECT id AS dup_id, canonical_id
FROM (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY "libraryId", "tmdbId"
      ORDER BY "addedAt", id
    ) AS canonical_id
  FROM "MediaItem"
  WHERE kind = 'movie' AND "tmdbId" IS NOT NULL
) ranked
WHERE id <> canonical_id;

-- Reattach the duplicates' files to the canonical item (movie files are not
-- episode-linked, so this is a plain owner change).
UPDATE "MediaFile" f
   SET "mediaItemId" = d.canonical_id
  FROM _movie_dupes d
 WHERE f."mediaItemId" = d.dup_id;

-- Drop rows that reference the duplicate but carry no FK cascade.
DELETE FROM "PlaybackState" p USING _movie_dupes d WHERE p."mediaItemId" = d.dup_id;
DELETE FROM "PlayEvent"     e USING _movie_dupes d WHERE e."mediaItemId" = d.dup_id;
DELETE FROM "Embedding"     m USING _movie_dupes d WHERE m."mediaItemId" = d.dup_id;

-- Delete the duplicate items (cascades genres, keywords, credits, translations).
DELETE FROM "MediaItem" i USING _movie_dupes d WHERE i.id = d.dup_id;

DROP TABLE _movie_dupes;

-- Backstop: at most one matched movie per (library, tmdbId). Unmatched movies
-- (tmdbId NULL) are exempt. Partial index → not representable in schema.prisma;
-- see the note above the MediaItem model.
CREATE UNIQUE INDEX "MediaItem_libraryId_tmdbId_movie_key"
  ON "MediaItem" ("libraryId", "tmdbId")
  WHERE kind = 'movie' AND "tmdbId" IS NOT NULL;
