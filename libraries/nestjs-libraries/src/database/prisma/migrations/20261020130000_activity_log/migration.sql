-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT NOT NULL,
    "appVersion" TEXT,
    "device" TEXT,
    "eventCount" INTEGER NOT NULL,
    "firstEventAt" TIMESTAMP(3) NOT NULL,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "log" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivityLog_batchId_key" ON "ActivityLog"("batchId");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_firstEventAt_idx" ON "ActivityLog"("userId", "firstEventAt");

-- CreateIndex
CREATE INDEX "ActivityLog_deviceId_firstEventAt_idx" ON "ActivityLog"("deviceId", "firstEventAt");

-- CreateIndex
CREATE INDEX "ActivityLog_receivedAt_idx" ON "ActivityLog"("receivedAt");

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
