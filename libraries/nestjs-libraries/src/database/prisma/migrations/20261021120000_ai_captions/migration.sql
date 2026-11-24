-- AlterTable
ALTER TABLE "AutoPublishPreset" ADD COLUMN     "textIntegrations" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "MobileUpload" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'media';

-- CreateTable
CREATE TABLE "AiCaption" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "audioUploadId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "title" TEXT,
    "userText" TEXT,
    "integrationIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "transcript" TEXT,
    "segments" JSONB,
    "language" TEXT,
    "audioSeconds" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCaption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCaptionOutput" (
    "id" TEXT NOT NULL,
    "captionId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "providerIdentifier" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "text" TEXT NOT NULL,
    "hashtags" TEXT[],
    "promptKey" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "promptSource" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "postId" TEXT,
    "postGroup" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCaptionOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptDefault" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "model" TEXT,
    "settings" JSONB,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptDefault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCaption_audioUploadId_key" ON "AiCaption"("audioUploadId");

-- CreateIndex
CREATE INDEX "AiCaption_organizationId_createdAt_idx" ON "AiCaption"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCaption_deletedAt_idx" ON "AiCaption"("deletedAt");

-- CreateIndex
CREATE INDEX "AiCaptionOutput_captionId_idx" ON "AiCaptionOutput"("captionId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptDefault_key_version_key" ON "PromptDefault"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PromptOverride_organizationId_key_version_key" ON "PromptOverride"("organizationId", "key", "version");

-- AddForeignKey
ALTER TABLE "AiCaption" ADD CONSTRAINT "AiCaption_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCaptionOutput" ADD CONSTRAINT "AiCaptionOutput_captionId_fkey" FOREIGN KEY ("captionId") REFERENCES "AiCaption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptOverride" ADD CONSTRAINT "PromptOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
