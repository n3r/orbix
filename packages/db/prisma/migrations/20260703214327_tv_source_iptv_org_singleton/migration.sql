-- One iptv-org source max. Prisma cannot express partial unique indexes, so
-- this exists only in SQL (same pattern as MediaItem_libraryId_tmdbId_movie_key).
CREATE UNIQUE INDEX "TvSource_iptv_org_singleton_key" ON "TvSource" ((1)) WHERE "kind" = 'iptv-org';
