-- AlterTable
ALTER TABLE "MediaFile" ADD COLUMN     "probedOk" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "PlaybackState" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "positionSec" INTEGER NOT NULL DEFAULT 0,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "finished" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaybackState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlaybackState_profileId_updatedAt_idx" ON "PlaybackState"("profileId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlaybackState_profileId_mediaItemId_key" ON "PlaybackState"("profileId", "mediaItemId");
