-- Library rework: collapse Section into Library, add SMB source fields.
-- Non-destructive: each Section is promoted to a top-level Library (reusing the
-- section id as the new library id), so Source/MediaItem FKs repoint trivially
-- and item ids (and thus playback history, embeddings, files) are preserved.

-- 1. New columns (nullable first so existing rows survive)
ALTER TABLE "Library" ADD COLUMN "order" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Source" ADD COLUMN "libraryId" TEXT;
ALTER TABLE "Source" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "Source" ADD COLUMN "smbHost" TEXT;
ALTER TABLE "Source" ADD COLUMN "smbShare" TEXT;
ALTER TABLE "Source" ADD COLUMN "smbSubpath" TEXT;
ALTER TABLE "Source" ADD COLUMN "smbUsername" TEXT;
ALTER TABLE "Source" ADD COLUMN "smbPassword" TEXT;
ALTER TABLE "Source" ADD COLUMN "smbDomain" TEXT;
ALTER TABLE "Source" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE "Source" ADD COLUMN "statusMessage" TEXT;
ALTER TABLE "Source" ALTER COLUMN "path" DROP NOT NULL;

ALTER TABLE "MediaItem" ADD COLUMN "libraryId" TEXT;

ALTER TABLE "ProfileMenuEntry" ADD COLUMN "libraryId" TEXT;

-- 2. Promote each Section to a top-level Library, reusing the section id
INSERT INTO "Library" ("id", "name", "order", "createdAt")
SELECT "id", "name", "order", now() FROM "Section";

-- 3. Repoint Source + MediaItem + ProfileMenuEntry to the new library ids (== old section ids)
UPDATE "Source" SET "libraryId" = "sectionId";
UPDATE "MediaItem" SET "libraryId" = "sectionId";
UPDATE "ProfileMenuEntry" SET "libraryId" = "sectionId";

-- 4. Drop the old section FK constraints BEFORE deleting wrapper libraries, so the
--    Library -> Section -> Source/MediaItem -> MediaFile cascade can't wipe the
--    promoted rows. (Section_libraryId_fkey is left: its cascade only removes the
--    now-orphaned Section rows, which we drop anyway.)
ALTER TABLE "Source" DROP CONSTRAINT "Source_sectionId_fkey";
ALTER TABLE "MediaItem" DROP CONSTRAINT "MediaItem_sectionId_fkey";
ALTER TABLE "ProfileMenuEntry" DROP CONSTRAINT "ProfileMenuEntry_sectionId_fkey";
DROP INDEX IF EXISTS "Source_sectionId_idx";
DROP INDEX IF EXISTS "MediaItem_sectionId_sortTitle_idx";
DROP INDEX IF EXISTS "ProfileMenuEntry_profileId_sectionId_key";

-- 5. Drop the old wrapper libraries (those that had sections); empty libraries kept
DELETE FROM "Library" WHERE "id" IN (SELECT DISTINCT "libraryId" FROM "Section");

-- 6. Enforce NOT NULL + FKs, drop old columns/tables
ALTER TABLE "Source" ALTER COLUMN "libraryId" SET NOT NULL;
ALTER TABLE "MediaItem" ALTER COLUMN "libraryId" SET NOT NULL;
ALTER TABLE "ProfileMenuEntry" ALTER COLUMN "libraryId" SET NOT NULL;

ALTER TABLE "Source" DROP COLUMN "sectionId";
ALTER TABLE "MediaItem" DROP COLUMN "sectionId";
ALTER TABLE "ProfileMenuEntry" DROP COLUMN "sectionId";

ALTER TABLE "Library" DROP COLUMN "type";
DROP TABLE "Section";

CREATE INDEX "Source_libraryId_idx" ON "Source"("libraryId");
CREATE INDEX "MediaItem_libraryId_sortTitle_idx" ON "MediaItem"("libraryId", "sortTitle");
CREATE UNIQUE INDEX "ProfileMenuEntry_profileId_libraryId_key" ON "ProfileMenuEntry"("profileId", "libraryId");

ALTER TABLE "Source" ADD CONSTRAINT "Source_libraryId_fkey"
  FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaItem" ADD CONSTRAINT "MediaItem_libraryId_fkey"
  FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProfileMenuEntry" ADD CONSTRAINT "ProfileMenuEntry_libraryId_fkey"
  FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE;
