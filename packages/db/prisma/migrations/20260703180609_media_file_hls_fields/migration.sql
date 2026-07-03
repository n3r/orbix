-- AlterTable
ALTER TABLE "MediaFile" ADD COLUMN     "colorTransfer" TEXT,
ADD COLUMN     "frameRate" DOUBLE PRECISION,
ADD COLUMN     "keyframes" JSONB,
ADD COLUMN     "videoLevel" INTEGER,
ADD COLUMN     "videoProfile" TEXT;
