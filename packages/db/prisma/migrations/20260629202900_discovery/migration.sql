-- CreateTable
CREATE TABLE "PlayEvent" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Embedding" (
    "mediaItemId" TEXT NOT NULL,
    "vector" vector(384) NOT NULL,
    "text" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Embedding_pkey" PRIMARY KEY ("mediaItemId")
);

-- CreateIndex
CREATE INDEX "PlayEvent_profileId_at_idx" ON "PlayEvent"("profileId", "at");
