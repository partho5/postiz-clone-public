-- AlterTable
ALTER TABLE "PlanInstantIdea" ADD COLUMN     "sessionId" TEXT;

-- CreateIndex
CREATE INDEX "PlanInstantIdea_sessionId_idx" ON "PlanInstantIdea"("sessionId");

-- AddForeignKey
ALTER TABLE "PlanInstantIdea" ADD CONSTRAINT "PlanInstantIdea_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PlanSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
