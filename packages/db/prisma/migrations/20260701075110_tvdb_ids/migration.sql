-- AlterTable
ALTER TABLE "Episode" ADD COLUMN     "tvdbEpisodeId" INTEGER;

-- AlterTable
ALTER TABLE "MediaItem" ADD COLUMN     "metadataSource" TEXT,
ADD COLUMN     "tvdbId" INTEGER;

-- AlterTable
ALTER TABLE "Season" ADD COLUMN     "tvdbSeasonId" INTEGER;

-- CreateIndex
CREATE INDEX "MediaItem_tvdbId_idx" ON "MediaItem"("tvdbId");
