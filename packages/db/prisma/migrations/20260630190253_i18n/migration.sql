-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en';

-- CreateTable
CREATE TABLE "MediaItemTranslation" (
    "mediaItemId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT,
    "overview" TEXT,

    CONSTRAINT "MediaItemTranslation_pkey" PRIMARY KEY ("mediaItemId","language")
);

-- CreateTable
CREATE TABLE "GenreTranslation" (
    "genreId" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "GenreTranslation_pkey" PRIMARY KEY ("genreId","language")
);

-- CreateIndex
CREATE INDEX "MediaItemTranslation_mediaItemId_idx" ON "MediaItemTranslation"("mediaItemId");

-- AddForeignKey
ALTER TABLE "MediaItemTranslation" ADD CONSTRAINT "MediaItemTranslation_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenreTranslation" ADD CONSTRAINT "GenreTranslation_genreId_fkey" FOREIGN KEY ("genreId") REFERENCES "Genre"("id") ON DELETE CASCADE ON UPDATE CASCADE;
