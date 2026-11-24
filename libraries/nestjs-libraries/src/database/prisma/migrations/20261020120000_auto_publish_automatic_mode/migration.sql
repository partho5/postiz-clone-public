-- DropForeignKey
ALTER TABLE "AutoPublishPreset" DROP CONSTRAINT "AutoPublishPreset_setId_fkey";

-- AlterTable
ALTER TABLE "AutoPublishPreset" ADD COLUMN     "excludedIntegrations" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "setId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "AutoPublishPreset" ADD CONSTRAINT "AutoPublishPreset_setId_fkey" FOREIGN KEY ("setId") REFERENCES "Sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
