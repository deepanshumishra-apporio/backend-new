
-- CreateTable
CREATE TABLE "investor_sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_rate_limits" (
    "key" VARCHAR(64) NOT NULL,
    "count" INTEGER NOT NULL,
    "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_rate_limits_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "investor_commands" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "route" VARCHAR(250) NOT NULL,
    "statusCode" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "investor_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_submissions" (
    "orderId" UUID NOT NULL,
    "fpPaymentId" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_submissions_pkey" PRIMARY KEY ("orderId")
);

-- CreateIndex
CREATE UNIQUE INDEX "investor_sessions_tokenHash_key" ON "investor_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "investor_sessions_userId_expiresAt_idx" ON "investor_sessions"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "api_rate_limits_windowStartedAt_idx" ON "api_rate_limits"("windowStartedAt");

-- CreateIndex
CREATE INDEX "investor_commands_completedAt_createdAt_idx" ON "investor_commands"("completedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "investor_commands_userId_key_key" ON "investor_commands"("userId", "key");

-- CreateIndex
CREATE INDEX "payment_submissions_fpPaymentId_idx" ON "payment_submissions"("fpPaymentId");

-- AddForeignKey
ALTER TABLE "investor_sessions" ADD CONSTRAINT "investor_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investor_commands" ADD CONSTRAINT "investor_commands_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "phone_verifications" ADD COLUMN "context" VARCHAR(200);
ALTER TABLE "pre_verification_bank_results" ADD COLUMN "accountNumberFingerprint" VARCHAR(64);
CREATE INDEX "pre_verification_bank_results_accountNumberFingerprint_idx" ON "pre_verification_bank_results"("accountNumberFingerprint");
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "mf_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
