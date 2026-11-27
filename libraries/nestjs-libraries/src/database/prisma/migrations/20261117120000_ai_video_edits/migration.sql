-- CreateTable
CREATE TABLE "AiVideoEdit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "aiCaptionId" TEXT,
    "audioUploadId" TEXT,
    "proxyUploadIds" TEXT[],
    "request" JSONB NOT NULL,
    "words" JSONB,
    "scores" JSONB,
    "plan" JSONB,
    "assets" JSONB,
    "log" JSONB,
    "language" TEXT,
    "sourceSeconds" INTEGER NOT NULL,
    "cost" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiVideoEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiVideoEdit_organizationId_createdAt_idx" ON "AiVideoEdit"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiVideoEdit_organizationId_sessionId_level_key" ON "AiVideoEdit"("organizationId", "sessionId", "level");

-- AddForeignKey
ALTER TABLE "AiVideoEdit" ADD CONSTRAINT "AiVideoEdit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
