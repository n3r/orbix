-- CreateTable
CREATE TABLE "TvSource" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "filePath" TEXT,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "epgUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "statusMessage" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TvSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TvChannel" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "extId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rawName" TEXT,
    "altNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "number" INTEGER NOT NULL,
    "country" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "logoUrl" TEXT,
    "logoPath" TEXT,
    "website" TEXT,
    "epgId" TEXT,
    "quality" TEXT,
    "kidsAllowed" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TvChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TvStream" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "feedId" TEXT,
    "quality" TEXT,
    "label" TEXT,
    "referrer" TEXT,
    "userAgent" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "protocol" TEXT NOT NULL DEFAULT 'hls',
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastOkAt" TIMESTAMP(3),
    "lastCheckAt" TIMESTAMP(3),

    CONSTRAINT "TvStream_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TvProgramme" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "stop" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "lang" TEXT,

    CONSTRAINT "TvProgramme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TvEpgSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "offsetMin" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "statusMessage" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TvEpgSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TvFavorite" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TvFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TvPlayEvent" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TvPlayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TvChannel_country_idx" ON "TvChannel"("country");

-- CreateIndex
CREATE INDEX "TvChannel_number_idx" ON "TvChannel"("number");

-- CreateIndex
CREATE UNIQUE INDEX "TvChannel_sourceId_extId_key" ON "TvChannel"("sourceId", "extId");

-- CreateIndex
CREATE INDEX "TvStream_channelId_priority_idx" ON "TvStream"("channelId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "TvStream_channelId_url_key" ON "TvStream"("channelId", "url");

-- CreateIndex
CREATE INDEX "TvProgramme_channelId_stop_idx" ON "TvProgramme"("channelId", "stop");

-- CreateIndex
CREATE UNIQUE INDEX "TvProgramme_channelId_start_key" ON "TvProgramme"("channelId", "start");

-- CreateIndex
CREATE INDEX "TvFavorite_profileId_position_idx" ON "TvFavorite"("profileId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "TvFavorite_profileId_channelId_key" ON "TvFavorite"("profileId", "channelId");

-- CreateIndex
CREATE INDEX "TvPlayEvent_profileId_at_idx" ON "TvPlayEvent"("profileId", "at");

-- AddForeignKey
ALTER TABLE "TvChannel" ADD CONSTRAINT "TvChannel_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TvSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TvStream" ADD CONSTRAINT "TvStream_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TvChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TvProgramme" ADD CONSTRAINT "TvProgramme_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TvChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TvFavorite" ADD CONSTRAINT "TvFavorite_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TvChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TvPlayEvent" ADD CONSTRAINT "TvPlayEvent_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TvChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
