-- Add the cybrillapoa gateway and bank account verification.
--
-- `cybrillapoa` is FP's ONDC implementation and the value its order APIs
-- actually take. It was missing from the enum, so an order routed that way was
-- silently mirrored as RTA — the wrong route recorded against real money.
--
-- The verification columns exist because that gateway refuses to submit an
-- order whose payout account has not passed a penny-drop: the order is
-- accepted, paid for, confirmed, and only then fails with
-- `payout_account_verification_pending`. Verifying during onboarding is the
-- only point at which that failure is cheap.
--
-- Additive: a new enum value and five nullable columns.

-- CreateEnum
CREATE TYPE "bav_status" AS ENUM ('pending', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "bav_confidence" AS ENUM ('very_high', 'high', 'uncertain', 'low', 'very_low', 'zero');

-- AlterEnum
ALTER TYPE "order_gateway" ADD VALUE 'cybrillapoa';

-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "verificationConfidence" "bav_confidence",
ADD COLUMN     "verificationFpId" VARCHAR(64),
ADD COLUMN     "verificationReason" VARCHAR(60),
ADD COLUMN     "verificationStatus" "bav_status",
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_verificationFpId_key" ON "bank_accounts"("verificationFpId");
