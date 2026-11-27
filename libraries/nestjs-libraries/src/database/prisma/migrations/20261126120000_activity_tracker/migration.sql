-- Activity tracker (api.activity-tracker): creates the device, session and activity tables. The old ActivityLog table is kept.

-- CreateTable
CREATE TABLE "TrackerDevice" (
    "deviceId" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appVersion" TEXT,
    "appBuild" INTEGER,
    "os" TEXT,
    "sdk" INTEGER,
    "manufacturer" TEXT,
    "model" TEXT,
    "locale" TEXT,
    "activityCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TrackerDevice_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "TrackerSession" (
    "key" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT,
    "session" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "entrySource" TEXT,
    "firstScreen" TEXT,
    "lastScreen" TEXT,
    "activityCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "appBuild" INTEGER,

    CONSTRAINT "TrackerSession_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TrackerActivity" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionKey" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "tz" INTEGER NOT NULL DEFAULT 0,
    "appBuild" INTEGER,
    "screen" TEXT,
    "source" TEXT,
    "meta" JSONB,
    "errorType" TEXT,
    "errorMessage" TEXT,
    "errorStack" TEXT,
    "errorCauses" JSONB,
    "errorThread" TEXT,
    "fatal" BOOLEAN,
    "lastActivity" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackerActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackerDevice_userId_idx" ON "TrackerDevice"("userId");

-- CreateIndex
CREATE INDEX "TrackerDevice_lastSeenAt_idx" ON "TrackerDevice"("lastSeenAt");

-- CreateIndex
CREATE INDEX "TrackerDevice_email_idx" ON "TrackerDevice"("email");

-- CreateIndex
CREATE INDEX "TrackerSession_deviceId_startedAt_idx" ON "TrackerSession"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "TrackerSession_userId_startedAt_idx" ON "TrackerSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "TrackerSession_startedAt_idx" ON "TrackerSession"("startedAt");

-- CreateIndex
CREATE INDEX "TrackerActivity_deviceId_startedAt_idx" ON "TrackerActivity"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "TrackerActivity_sessionKey_seq_idx" ON "TrackerActivity"("sessionKey", "seq");

-- CreateIndex
CREATE INDEX "TrackerActivity_userId_startedAt_idx" ON "TrackerActivity"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "TrackerActivity_name_description_idx" ON "TrackerActivity"("name", "description");

-- CreateIndex
CREATE INDEX "TrackerActivity_kind_startedAt_idx" ON "TrackerActivity"("kind", "startedAt");

-- CreateIndex
CREATE INDEX "TrackerActivity_receivedAt_idx" ON "TrackerActivity"("receivedAt");

-- AddForeignKey
ALTER TABLE "TrackerDevice" ADD CONSTRAINT "TrackerDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackerActivity" ADD CONSTRAINT "TrackerActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
