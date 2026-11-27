-- CreateTable
CREATE TABLE "RecurringCharge" (
    "postId" TEXT NOT NULL,
    "occurrence" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "flaggedAt" TIMESTAMP(3),

    CONSTRAINT "RecurringCharge_pkey" PRIMARY KEY ("postId")
);

