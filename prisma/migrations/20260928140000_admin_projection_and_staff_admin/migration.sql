-- Admin read model, its checkpoint, and change-detection indexes; plus the
-- staff.manage permission for the staff management screens.

-- CreateTable
CREATE TABLE "investor_journey_snapshots" (
    "userId" UUID NOT NULL,
    "name" VARCHAR(150),
    "email" VARCHAR(255),
    "phone" VARCHAR(20) NOT NULL,
    "pan" VARCHAR(10),
    "userStatus" VARCHAR(30) NOT NULL,
    "stage" VARCHAR(30) NOT NULL,
    "kycStatus" VARCHAR(30) NOT NULL,
    "kycVia" VARCHAR(20),
    "kycFormStatus" VARCHAR(30),
    "kycProofStatus" VARCHAR(30),
    "kycSignatureProvided" BOOLEAN,
    "kycFieldsNeeded" VARCHAR(60)[],
    "kycMovedAt" TIMESTAMPTZ(3),
    "kycCompletedAt" TIMESTAMPTZ(3),
    "hasProfile" BOOLEAN NOT NULL,
    "hasAccount" BOOLEAN NOT NULL,
    "purchases" INTEGER NOT NULL,
    "investedAmount" DECIMAL(18,2) NOT NULL,
    "signedUpAt" TIMESTAMPTZ(3) NOT NULL,
    "lastLoginAt" TIMESTAMPTZ(3),
    "lastActivityAt" TIMESTAMPTZ(3) NOT NULL,
    "refreshedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "investor_journey_snapshots_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "projection_checkpoints" (
    "name" VARCHAR(60) NOT NULL,
    "watermark" TIMESTAMPTZ(3),
    "lastFullAt" TIMESTAMPTZ(3),
    "leaseUntil" TIMESTAMPTZ(3),
    "leaseHolder" VARCHAR(80),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projection_checkpoints_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "investor_journey_snapshots_signedUpAt_userId_idx" ON "investor_journey_snapshots"("signedUpAt" DESC, "userId" DESC);

-- CreateIndex
CREATE INDEX "investor_journey_snapshots_stage_signedUpAt_idx" ON "investor_journey_snapshots"("stage", "signedUpAt" DESC);

-- CreateIndex
CREATE INDEX "investor_journey_snapshots_kycStatus_signedUpAt_idx" ON "investor_journey_snapshots"("kycStatus", "signedUpAt" DESC);

-- CreateIndex
CREATE INDEX "investor_journey_snapshots_kycCompletedAt_idx" ON "investor_journey_snapshots"("kycCompletedAt");

-- CreateIndex
CREATE INDEX "bank_accounts_updatedAt_idx" ON "bank_accounts"("updatedAt");

-- CreateIndex
CREATE INDEX "investor_onboardings_updatedAt_idx" ON "investor_onboardings"("updatedAt");

-- CreateIndex
CREATE INDEX "investor_profiles_updatedAt_idx" ON "investor_profiles"("updatedAt");

-- CreateIndex
CREATE INDEX "kyc_forms_updatedAt_idx" ON "kyc_forms"("updatedAt");

-- CreateIndex
CREATE INDEX "mf_folio_defaults_updatedAt_idx" ON "mf_folio_defaults"("updatedAt");

-- CreateIndex
CREATE INDEX "mf_investment_accounts_updatedAt_idx" ON "mf_investment_accounts"("updatedAt");

-- CreateIndex
CREATE INDEX "mf_purchases_updatedAt_idx" ON "mf_purchases"("updatedAt");

-- CreateIndex
CREATE INDEX "pre_verifications_updatedAt_idx" ON "pre_verifications"("updatedAt");

-- CreateIndex
CREATE INDEX "user_investor_profiles_updatedAt_idx" ON "user_investor_profiles"("updatedAt");

-- CreateIndex
CREATE INDEX "users_updatedAt_idx" ON "users"("updatedAt");


-- Staff management. Held by SUPER_ADMIN only; a role that can manage staff
-- can hand out any role, so it is as powerful as the roles it can grant.
INSERT INTO "permissions" ("key", "description") VALUES
  ('staff.manage', 'Add staff, change their roles, suspend them and reset their credentials');
INSERT INTO "role_permissions" ("roleKey", "permissionKey") VALUES ('SUPER_ADMIN', 'staff.manage');
