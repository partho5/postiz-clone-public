-- CreateTable
CREATE TABLE "ContentPlan" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SETUP',
    "sourceText" TEXT,
    "direction" TEXT,
    "directionVersion" INTEGER NOT NULL DEFAULT 0,
    "videosPerWeek" INTEGER NOT NULL DEFAULT 3,
    "facts" JSONB,
    "proposal" JSONB,
    "proposalVersion" INTEGER NOT NULL DEFAULT 0,
    "proposalTurns" JSONB,
    "busy" TEXT,
    "notice" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPlanRound" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "answers" JSONB,
    "readyForPlan" BOOLEAN NOT NULL DEFAULT false,
    "userTurn" TEXT NOT NULL,
    "assistantTurn" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentPlanRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanTheme" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "PlanTheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanCluster" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "rotationIndex" INTEGER NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "PlanCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanWeek" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "idea" TEXT NOT NULL,
    "ideaEdited" BOOLEAN NOT NULL DEFAULT false,
    "outline" JSONB,
    "brief" TEXT,
    "briefEdited" BOOLEAN NOT NULL DEFAULT false,
    "urgentNote" TEXT,
    "carryIn" JSONB,
    "status" TEXT NOT NULL DEFAULT 'IDEA',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanWeek_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanInstantIdea" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "idea" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "beats" JSONB NOT NULL,
    "closingLine" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "recordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanInstantIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanDay" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "beats" JSONB NOT NULL,
    "closingLine" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "busy" BOOLEAN NOT NULL DEFAULT false,
    "recordedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContentPlan_organizationId_key" ON "ContentPlan"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPlanRound_planId_index_key" ON "ContentPlanRound"("planId", "index");

-- CreateIndex
CREATE INDEX "PlanCluster_planId_rotationIndex_idx" ON "PlanCluster"("planId", "rotationIndex");

-- CreateIndex
CREATE INDEX "PlanWeek_planId_status_idx" ON "PlanWeek"("planId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlanWeek_planId_weekStart_key" ON "PlanWeek"("planId", "weekStart");

-- CreateIndex
CREATE INDEX "PlanInstantIdea_organizationId_date_idx" ON "PlanInstantIdea"("organizationId", "date");

-- CreateIndex
CREATE INDEX "PlanDay_organizationId_date_idx" ON "PlanDay"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PlanDay_weekId_dayIndex_key" ON "PlanDay"("weekId", "dayIndex");

-- AddForeignKey
ALTER TABLE "ContentPlan" ADD CONSTRAINT "ContentPlan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPlanRound" ADD CONSTRAINT "ContentPlanRound_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ContentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanTheme" ADD CONSTRAINT "PlanTheme_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ContentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanCluster" ADD CONSTRAINT "PlanCluster_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ContentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanCluster" ADD CONSTRAINT "PlanCluster_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "PlanTheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanWeek" ADD CONSTRAINT "PlanWeek_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ContentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanWeek" ADD CONSTRAINT "PlanWeek_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "PlanCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanInstantIdea" ADD CONSTRAINT "PlanInstantIdea_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ContentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanInstantIdea" ADD CONSTRAINT "PlanInstantIdea_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanDay" ADD CONSTRAINT "PlanDay_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "PlanWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanDay" ADD CONSTRAINT "PlanDay_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
