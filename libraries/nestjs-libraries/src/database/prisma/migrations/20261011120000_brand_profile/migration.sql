-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "slug" TEXT,
ADD COLUMN "color" TEXT,
ADD COLUMN "avatarUrl" TEXT,
ADD COLUMN "timezone" TEXT,
ADD COLUMN "locale" TEXT,
ADD COLUMN "profile" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_accountId_slug_key" ON "Organization"("accountId", "slug");

-- CreateIndex
CREATE INDEX "Organization_profile_idx" ON "Organization" USING GIN ("profile");
