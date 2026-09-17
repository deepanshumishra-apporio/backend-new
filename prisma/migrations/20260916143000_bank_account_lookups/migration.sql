-- CreateTable
CREATE TABLE "bank_account_lookups" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "userId" UUID NOT NULL,
    "investorProfileId" UUID NOT NULL,
    "sourceRefId" VARCHAR(64) NOT NULL,
    "phoneLast4" VARCHAR(4) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "bankAccountId" UUID,
    "consentedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "syncedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_account_lookups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bank_account_lookups_fpId_key" ON "bank_account_lookups"("fpId");
CREATE UNIQUE INDEX "bank_account_lookups_sourceRefId_key" ON "bank_account_lookups"("sourceRefId");
CREATE UNIQUE INDEX "bank_account_lookups_bankAccountId_key" ON "bank_account_lookups"("bankAccountId");
CREATE INDEX "bank_account_lookups_userId_createdAt_idx" ON "bank_account_lookups"("userId", "createdAt" DESC);
CREATE INDEX "bank_account_lookups_investorProfileId_createdAt_idx" ON "bank_account_lookups"("investorProfileId", "createdAt" DESC);

ALTER TABLE "bank_account_lookups" ADD CONSTRAINT "bank_account_lookups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_account_lookups" ADD CONSTRAINT "bank_account_lookups_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bank_account_lookups" ADD CONSTRAINT "bank_account_lookups_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
