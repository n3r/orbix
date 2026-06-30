-- Title hero media (logo art, frame-fallback source) + external ratings.
ALTER TABLE "MediaItem" ADD COLUMN "tagline" TEXT;
ALTER TABLE "MediaItem" ADD COLUMN "status" TEXT;
ALTER TABLE "MediaItem" ADD COLUMN "backdropSource" TEXT;
ALTER TABLE "MediaItem" ADD COLUMN "logoPath" TEXT;
ALTER TABLE "MediaItem" ADD COLUMN "tmdbScore" DOUBLE PRECISION;
ALTER TABLE "MediaItem" ADD COLUMN "imdbRating" DOUBLE PRECISION;
ALTER TABLE "MediaItem" ADD COLUMN "imdbVotes" INTEGER;
ALTER TABLE "MediaItem" ADD COLUMN "rtRating" INTEGER;
ALTER TABLE "MediaItem" ADD COLUMN "metacritic" INTEGER;
