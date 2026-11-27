-- CreateTable
CREATE TABLE "AiVideoEditTrace" (
    "id" TEXT NOT NULL,
    "editId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "step" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "attempt" INTEGER,
    "durationMs" INTEGER,
    "ok" BOOLEAN,
    "payload" JSONB NOT NULL,
    "payloadBytes" INTEGER NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiVideoEditTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiVideoEditTrace_editId_seq_key" ON "AiVideoEditTrace"("editId", "seq");

-- CreateIndex
CREATE INDEX "AiVideoEditTrace_createdAt_idx" ON "AiVideoEditTrace"("createdAt");

-- AddForeignKey
ALTER TABLE "AiVideoEditTrace" ADD CONSTRAINT "AiVideoEditTrace_editId_fkey" FOREIGN KEY ("editId") REFERENCES "AiVideoEdit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
