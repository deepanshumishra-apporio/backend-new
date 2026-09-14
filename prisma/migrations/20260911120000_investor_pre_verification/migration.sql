
-- CreateTable
CREATE TABLE "pre_verifications" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "status" VARCHAR(60) NOT NULL,
    "investorIdentifier" VARCHAR(10),
    "readinessStatus" VARCHAR(60),
    "readinessCode" VARCHAR(120),
    "readinessReason" TEXT,
    "readinessModification" VARCHAR(120),
    "pan" VARCHAR(10),
    "panStatus" VARCHAR(60),
    "panCode" VARCHAR(120),
    "panReason" TEXT,
    "name" TEXT,
    "nameStatus" VARCHAR(60),
    "nameCode" VARCHAR(120),
    "nameReason" TEXT,
    "dateOfBirth" DATE,
    "dateOfBirthStatus" VARCHAR(60),
    "dateOfBirthCode" VARCHAR(120),
    "dateOfBirthReason" TEXT,
    "userId" UUID,
    "investorProfileId" UUID,
    "fpCreatedAt" TIMESTAMPTZ(3),
    "fpUpdatedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "syncedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pre_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_verification_bank_results" (
    "id" UUID NOT NULL,
    "preVerificationId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" VARCHAR(60),
    "code" VARCHAR(120),
    "reason" TEXT,
    "accountNumber" TEXT NOT NULL,
    "ifscCode" VARCHAR(11) NOT NULL,
    "accountType" VARCHAR(60) NOT NULL,
    "bankAccountProofFpId" VARCHAR(64),
    "manualVerificationApproved" BOOLEAN,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pre_verification_bank_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pre_verifications_fpId_key" ON "pre_verifications"("fpId");

-- CreateIndex
CREATE INDEX "pre_verifications_investorIdentifier_createdAt_idx" ON "pre_verifications"("investorIdentifier", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "pre_verifications_userId_createdAt_idx" ON "pre_verifications"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "pre_verifications_investorProfileId_createdAt_idx" ON "pre_verifications"("investorProfileId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "pre_verifications_status_syncedAt_idx" ON "pre_verifications"("status", "syncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pre_verification_bank_results_preVerificationId_position_key" ON "pre_verification_bank_results"("preVerificationId", "position");

-- AddForeignKey
ALTER TABLE "pre_verifications" ADD CONSTRAINT "pre_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_verifications" ADD CONSTRAINT "pre_verifications_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_verification_bank_results" ADD CONSTRAINT "pre_verification_bank_results_preVerificationId_fkey" FOREIGN KEY ("preVerificationId") REFERENCES "pre_verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express this row-level invariant. Keep it in migration SQL.
ALTER TABLE "pre_verification_bank_results" ADD CONSTRAINT "pre_verification_bank_results_position_check" CHECK ("position" >= 0);
