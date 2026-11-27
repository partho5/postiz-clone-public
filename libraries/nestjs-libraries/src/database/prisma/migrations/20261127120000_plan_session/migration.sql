-- CreateTable
CREATE TABLE "PlanSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ASKING',
    "sourceText" TEXT,
    "summary" TEXT,
    "options" JSONB,
    "proposal" JSONB,
    "proposalVersion" INTEGER NOT NULL DEFAULT 0,
    "proposalTurns" JSONB,
    "busy" TEXT,
    "notice" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanSessionRound" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "answers" JSONB,
    "readyForPlan" BOOLEAN NOT NULL DEFAULT false,
    "userTurn" TEXT NOT NULL,
    "assistantTurn" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanSessionRound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanSession_organizationId_kind_status_idx" ON "PlanSession"("organizationId", "kind", "status");

-- CreateIndex
CREATE INDEX "PlanSession_planId_idx" ON "PlanSession"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanSessionRound_sessionId_index_key" ON "PlanSessionRound"("sessionId", "index");

-- AddForeignKey
ALTER TABLE "PlanSession" ADD CONSTRAINT "PlanSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanSession" ADD CONSTRAINT "PlanSession_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ContentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanSessionRound" ADD CONSTRAINT "PlanSessionRound_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PlanSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

