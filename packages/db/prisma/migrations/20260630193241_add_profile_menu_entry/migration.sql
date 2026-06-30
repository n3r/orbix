-- CreateTable
CREATE TABLE "ProfileMenuEntry" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ProfileMenuEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfileMenuEntry_profileId_idx" ON "ProfileMenuEntry"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileMenuEntry_profileId_sectionId_key" ON "ProfileMenuEntry"("profileId", "sectionId");

-- AddForeignKey
ALTER TABLE "ProfileMenuEntry" ADD CONSTRAINT "ProfileMenuEntry_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE CASCADE ON UPDATE CASCADE;
