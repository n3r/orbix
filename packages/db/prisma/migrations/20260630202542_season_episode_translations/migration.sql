-- CreateTable
CREATE TABLE "SeasonTranslation" (
    "seasonId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "name" TEXT,
    "overview" TEXT,

    CONSTRAINT "SeasonTranslation_pkey" PRIMARY KEY ("seasonId","language")
);

-- CreateTable
CREATE TABLE "EpisodeTranslation" (
    "episodeId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT,
    "overview" TEXT,

    CONSTRAINT "EpisodeTranslation_pkey" PRIMARY KEY ("episodeId","language")
);

-- CreateIndex
CREATE INDEX "SeasonTranslation_seasonId_idx" ON "SeasonTranslation"("seasonId");

-- CreateIndex
CREATE INDEX "EpisodeTranslation_episodeId_idx" ON "EpisodeTranslation"("episodeId");

-- AddForeignKey
ALTER TABLE "SeasonTranslation" ADD CONSTRAINT "SeasonTranslation_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeTranslation" ADD CONSTRAINT "EpisodeTranslation_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
