-- Compliance coverage: ten more alert kinds (payouts, refunds, 2FA consent,
-- KYC compliance of active investors, PMLA monitoring, complaint timelines,
-- payout bank, contact details, and monitoring health), and review meetings,
-- which until now existed only as sample data in the admin portal.
--
-- The new enum values are only added here, never used, so PostgreSQL 12+ runs
-- this in one transaction.

-- CreateEnum
CREATE TYPE "ReviewMeetingMode" AS ENUM ('IN_PERSON', 'VIDEO', 'PHONE');

-- CreateEnum
CREATE TYPE "RiskProfile" AS ENUM ('CONSERVATIVE', 'MODERATE', 'AGGRESSIVE');

-- CreateEnum
CREATE TYPE "ReviewMeetingStatus" AS ENUM ('SCHEDULED', 'CAPTURED', 'PROFILE_UPDATED');

-- AlterEnum


ALTER TYPE "ComplianceAlertKind" ADD VALUE 'REDEMPTION_PAYOUT_PENDING';
ALTER TYPE "ComplianceAlertKind" ADD VALUE 'REFUND_PENDING';
ALTER TYPE "ComplianceAlertKind" ADD VALUE 'CONSENT_MISSING';
ALTER TYPE "ComplianceAlertKind" ADD VALUE 'KYC_NOT_COMPLIANT';
ALTER TYPE "ComplianceAlertKind" ADD VALUE 'PEP_INVESTOR';
ALTER TYPE "ComplianceAlertKind" ADD VALUE 'LARGE_TRANSACTION';
ALTER TYPE "ComplianceAlertKind" ADD VALUE 'RAPID_ROUND_TRIP';
ALTER TYPE "ComplianceAlertKind" ADD VALUE 'COMPLAINT_OVERDUE';
ALTER TYPE "ComplianceAlertKind" ADD VALUE 'PAYOUT_BANK_UNVERIFIED';
ALTER TYPE "ComplianceAlertKind" ADD VALUE 'CONTACT_MISSING';
ALTER TYPE "ComplianceAlertKind" ADD VALUE 'MONITORING_STALE';

-- CreateTable
CREATE TABLE "review_meetings" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "conductedByStaffId" UUID NOT NULL,
    "recordedByStaffId" UUID NOT NULL,
    "mode" "ReviewMeetingMode" NOT NULL,
    "meetingDate" DATE NOT NULL,
    "currentProfile" "RiskProfile" NOT NULL,
    "recommendedProfile" "RiskProfile" NOT NULL,
    "status" "ReviewMeetingStatus" NOT NULL DEFAULT 'CAPTURED',
    "notes" VARCHAR(4000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "review_meetings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_meetings_status_meetingDate_idx" ON "review_meetings"("status", "meetingDate" DESC);

-- CreateIndex
CREATE INDEX "review_meetings_userId_meetingDate_idx" ON "review_meetings"("userId", "meetingDate" DESC);

-- AddForeignKey
ALTER TABLE "review_meetings" ADD CONSTRAINT "review_meetings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_meetings" ADD CONSTRAINT "review_meetings_conductedByStaffId_fkey" FOREIGN KEY ("conductedByStaffId") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_meetings" ADD CONSTRAINT "review_meetings_recordedByStaffId_fkey" FOREIGN KEY ("recordedByStaffId") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

