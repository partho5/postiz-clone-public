-- CreateTable
CREATE TABLE "AutoPublishPreset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "timing" TEXT NOT NULL DEFAULT 'now',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoPublishPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutoPublishPreset_organizationId_key" ON "AutoPublishPreset"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AutoPublishPreset_setId_key" ON "AutoPublishPreset"("setId");

-- AddForeignKey
ALTER TABLE "AutoPublishPreset" ADD CONSTRAINT "AutoPublishPreset_setId_fkey" FOREIGN KEY ("setId") REFERENCES "Sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
