-- CreateTable
CREATE TABLE "MobileUpload" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "partSize" INTEGER NOT NULL,
    "partCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mediaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MobileUpload_organizationId_status_idx" ON "MobileUpload"("organizationId", "status");

-- CreateIndex
CREATE INDEX "MobileUpload_status_createdAt_idx" ON "MobileUpload"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "MobileUpload" ADD CONSTRAINT "MobileUpload_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
