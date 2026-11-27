-- CreateTable
CREATE TABLE "CreditSetting" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditSetting_pkey" PRIMARY KEY ("key","effectiveFrom")
);

