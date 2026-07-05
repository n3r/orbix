-- AlterTable
ALTER TABLE "Profile" ADD COLUMN "isGroup" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProfileGroupMember" (
    "id" TEXT NOT NULL,
    "groupProfileId" TEXT NOT NULL,
    "memberProfileId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProfileGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfileGroupMember_groupProfileId_memberProfileId_key" ON "ProfileGroupMember"("groupProfileId", "memberProfileId");

-- CreateIndex
CREATE INDEX "ProfileGroupMember_groupProfileId_idx" ON "ProfileGroupMember"("groupProfileId");

-- CreateIndex
CREATE INDEX "ProfileGroupMember_memberProfileId_idx" ON "ProfileGroupMember"("memberProfileId");

-- AddForeignKey
ALTER TABLE "ProfileGroupMember" ADD CONSTRAINT "ProfileGroupMember_groupProfileId_fkey" FOREIGN KEY ("groupProfileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileGroupMember" ADD CONSTRAINT "ProfileGroupMember_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
