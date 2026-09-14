-- Mirror Cybrilla POA KYC forms.
--
-- A second, independent digital-KYC route alongside KycRequest. The two are not
-- interchangeable: KycRequest is FP's tenant-realm KYC and needs the tenant to
-- be provisioned for it, while a KYC form needs only the partner credentials.
-- On the sandbox tenant here, `/v2/kyc_requests` answers "Couldn't find Tenant"
-- and `/poa/kyc_forms` works — so both models exist and a deployment uses
-- whichever it has.
--
-- Additive only: a new table and two new enums.

-- CreateEnum
CREATE TYPE "kyc_form_type" AS ENUM ('fresh', 'modify');

-- CreateEnum
CREATE TYPE "kyc_form_status" AS ENUM ('under_review', 'created', 'awaiting_esign', 'awaiting_submission', 'submitted', 'failed', 'expired');

-- CreateTable
CREATE TABLE "kyc_forms" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "type" "kyc_form_type" NOT NULL,
    "status" "kyc_form_status" NOT NULL DEFAULT 'under_review',
    "reason" VARCHAR(120),
    "pan" VARCHAR(10) NOT NULL,
    "name" VARCHAR(70) NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "email" VARCHAR(255),
    "mobileIsd" VARCHAR(4),
    "mobileNumber" VARCHAR(20),
    "proofFetchUrl" VARCHAR(1000),
    "proofStatus" "document_fetch_status",
    "proofCallbackUrl" VARCHAR(1000),
    "esignCallbackUrl" VARCHAR(1000),
    "esignUrl" VARCHAR(1000),
    "esignStatus" "esign_status",
    "signatureProvided" BOOLEAN NOT NULL DEFAULT false,
    "fieldsNeeded" VARCHAR(60)[],
    "userId" UUID,
    "investorProfileId" UUID,
    "fpCreatedAt" TIMESTAMP(3),
    "fpUpdatedAt" TIMESTAMP(3),
    "reviewCompletedAt" TIMESTAMP(3),
    "awaitingEsignAt" TIMESTAMP(3),
    "awaitingSubmissionAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_forms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kyc_forms_fpId_key" ON "kyc_forms"("fpId");

-- CreateIndex
CREATE INDEX "kyc_forms_pan_createdAt_idx" ON "kyc_forms"("pan", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "kyc_forms_status_idx" ON "kyc_forms"("status");

-- CreateIndex
CREATE INDEX "kyc_forms_userId_idx" ON "kyc_forms"("userId");

-- AddForeignKey
ALTER TABLE "kyc_forms" ADD CONSTRAINT "kyc_forms_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_forms" ADD CONSTRAINT "kyc_forms_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
