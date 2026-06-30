-- TV series support: Season + Episode tables, episode file linkage, per-episode progress.

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "name" TEXT,
    "overview" TEXT,
    "posterPath" TEXT,
    "airYear" INTEGER,
    "tmdbSeasonId" INTEGER,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "title" TEXT,
    "overview" TEXT,
    "stillPath" TEXT,
    "runtimeSec" INTEGER,
    "airDate" TIMESTAMP(3),
    "tmdbEpisodeId" INTEGER,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Season_seriesId_seasonNumber_key" ON "Season"("seriesId", "seasonNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_seasonId_episodeNumber_key" ON "Episode"("seasonId", "episodeNumber");

-- CreateIndex
CREATE INDEX "Episode_seriesId_idx" ON "Episode"("seriesId");

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: episode linkage on MediaFile
ALTER TABLE "MediaFile" ADD COLUMN "episodeId" TEXT;
CREATE INDEX "MediaFile_episodeId_idx" ON "MediaFile"("episodeId");
ALTER TABLE "MediaFile" ADD CONSTRAINT "MediaFile_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: per-episode playback progress
ALTER TABLE "PlaybackState" ADD COLUMN "episodeId" TEXT NOT NULL DEFAULT '';
DROP INDEX "PlaybackState_profileId_mediaItemId_key";
CREATE UNIQUE INDEX "PlaybackState_profileId_mediaItemId_episodeId_key" ON "PlaybackState"("profileId", "mediaItemId", "episodeId");
