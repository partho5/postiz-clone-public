-- DropIndex
DROP INDEX "PaypalPlan_tierKey_key";

-- AlterTable
ALTER TABLE "PaypalPlan" ADD COLUMN     "environment" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PaypalPlan_tierKey_environment_key" ON "PaypalPlan"("tierKey", "environment");
