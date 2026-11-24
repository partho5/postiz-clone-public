-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "posterKey" TEXT;

-- CreateIndex
CREATE INDEX "Media_posterKey_idx" ON "Media"("posterKey");
