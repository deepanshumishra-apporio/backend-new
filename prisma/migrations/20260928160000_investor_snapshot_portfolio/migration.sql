-- Portfolio columns on the admin read model (current value, SIPs, next SIP),
-- and change-detection indexes for the two tables they come from.

-- AlterTable
ALTER TABLE "investor_journey_snapshots" ADD COLUMN     "activeSips" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "currentValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "nextSipDate" DATE,
ADD COLUMN     "sipMonthlyAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "investor_journey_snapshots_nextSipDate_idx" ON "investor_journey_snapshots"("nextSipDate");

-- CreateIndex
CREATE INDEX "mf_holdings_updatedAt_idx" ON "mf_holdings"("updatedAt");

-- CreateIndex
CREATE INDEX "mf_purchase_plans_updatedAt_idx" ON "mf_purchase_plans"("updatedAt");

