-- CreateTable
CREATE TABLE "TopupOrder" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paypalOrderId" TEXT NOT NULL,
    "captureId" TEXT,
    "packKey" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopupOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TopupOrder_paypalOrderId_key" ON "TopupOrder"("paypalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "TopupOrder_captureId_key" ON "TopupOrder"("captureId");

-- CreateIndex
CREATE INDEX "TopupOrder_accountId_idx" ON "TopupOrder"("accountId");
