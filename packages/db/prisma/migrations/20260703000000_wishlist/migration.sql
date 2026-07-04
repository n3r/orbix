-- CreateTable
CREATE TABLE "WishlistEntry" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WishlistEntry_profileId_addedAt_idx" ON "WishlistEntry"("profileId", "addedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WishlistEntry_profileId_mediaItemId_key" ON "WishlistEntry"("profileId", "mediaItemId");
