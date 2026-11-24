-- The cached Lottie JSON files of the first asset cache (kind 'lottie') are not used any more: overlays are mp4
-- clips and png icons. They were development data only, so the rows go; their files stay in R2 (nothing lists them
-- after this) and are deleted by hand.
DELETE FROM "AiEditAsset" WHERE "kind" = 'lottie';

-- AlterTable
ALTER TABLE "AiEditAsset" ADD COLUMN     "colorCodes" JSONB,
ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ADD COLUMN     "meta" JSONB,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "price" INTEGER,
ADD COLUMN     "query" TEXT,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "source" TEXT;
