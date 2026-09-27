-- AlterTable
ALTER TABLE "mf_purchase_plans" ADD COLUMN     "pauseFpId" VARCHAR(64),
ADD COLUMN     "pauseFrom" DATE,
ADD COLUMN     "pauseState" VARCHAR(40),
ADD COLUMN     "pauseSyncedAt" TIMESTAMPTZ(3),
ADD COLUMN     "pauseTo" DATE;
