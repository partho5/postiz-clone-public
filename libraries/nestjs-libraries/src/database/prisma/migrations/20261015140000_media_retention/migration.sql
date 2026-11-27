-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "origin" TEXT,
ADD COLUMN     "purgedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Media_origin_purgedAt_idx" ON "Media"("origin", "purgedAt");
