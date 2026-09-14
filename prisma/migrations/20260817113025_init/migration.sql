-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('INVESTOR', 'ADMIN', 'SUPPORT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FundCategory" AS ENUM ('EQUITY', 'DEBT', 'HYBRID', 'LIQUID', 'INDEX', 'ELSS', 'MONEY_MARKET');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'LOW_TO_MODERATE', 'MODERATE', 'MODERATELY_HIGH', 'HIGH', 'VERY_HIGH');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PURCHASE', 'REDEMPTION', 'SWITCH_IN', 'SWITCH_OUT', 'SIP_INSTALMENT', 'DIVIDEND_PAYOUT');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'AWAITING_PAYMENT', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "SipFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "SipStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20),
    "passwordHash" VARCHAR(255) NOT NULL,
    "fullName" VARCHAR(150) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'INVESTOR',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "emailVerifiedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_profiles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "panNumber" VARCHAR(10) NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "aadhaarLast4" VARCHAR(4),
    "bankAccountLast4" VARCHAR(4),
    "bankIfsc" VARCHAR(11),
    "addressLine1" VARCHAR(255),
    "addressLine2" VARCHAR(255),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "pincode" VARCHAR(10),
    "status" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "submittedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amc_houses" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "logoUrl" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amc_houses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funds" (
    "id" UUID NOT NULL,
    "amcId" UUID NOT NULL,
    "name" VARCHAR(250) NOT NULL,
    "schemeCode" VARCHAR(20) NOT NULL,
    "isin" VARCHAR(12),
    "category" "FundCategory" NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expenseRatio" DECIMAL(6,4) NOT NULL,
    "exitLoadPct" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "minInvestment" DECIMAL(18,2) NOT NULL,
    "minSipAmount" DECIMAL(18,2) NOT NULL,
    "lockInMonths" INTEGER NOT NULL DEFAULT 0,
    "latestNav" DECIMAL(12,4),
    "latestNavDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nav_history" (
    "id" UUID NOT NULL,
    "fundId" UUID NOT NULL,
    "navDate" DATE NOT NULL,
    "nav" DECIMAL(12,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nav_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holdings" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fundId" UUID NOT NULL,
    "folioNumber" VARCHAR(30) NOT NULL,
    "units" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "investedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "averageNav" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "realisedGain" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holdings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fundId" UUID NOT NULL,
    "sipMandateId" UUID,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "externalRef" VARCHAR(100),
    "amount" DECIMAL(18,2) NOT NULL,
    "units" DECIMAL(18,4),
    "nav" DECIMAL(12,4),
    "folioNumber" VARCHAR(30),
    "failureReason" VARCHAR(500),
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sip_mandates" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fundId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "frequency" "SipFrequency" NOT NULL DEFAULT 'MONTHLY',
    "dayOfMonth" INTEGER NOT NULL,
    "status" "SipStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "instalmentsPaid" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sip_mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist_items" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fundId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entityType" VARCHAR(60) NOT NULL,
    "entityId" VARCHAR(64),
    "metadata" JSONB,
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(300),
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_profiles_userId_key" ON "kyc_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_profiles_panNumber_key" ON "kyc_profiles"("panNumber");

-- CreateIndex
CREATE INDEX "kyc_profiles_status_idx" ON "kyc_profiles"("status");

-- CreateIndex
CREATE UNIQUE INDEX "amc_houses_name_key" ON "amc_houses"("name");

-- CreateIndex
CREATE UNIQUE INDEX "amc_houses_code_key" ON "amc_houses"("code");

-- CreateIndex
CREATE INDEX "amc_houses_isActive_idx" ON "amc_houses"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "funds_schemeCode_key" ON "funds"("schemeCode");

-- CreateIndex
CREATE UNIQUE INDEX "funds_isin_key" ON "funds"("isin");

-- CreateIndex
CREATE INDEX "funds_category_isActive_idx" ON "funds"("category", "isActive");

-- CreateIndex
CREATE INDEX "funds_amcId_idx" ON "funds"("amcId");

-- CreateIndex
CREATE INDEX "funds_riskLevel_idx" ON "funds"("riskLevel");

-- CreateIndex
CREATE INDEX "nav_history_navDate_idx" ON "nav_history"("navDate");

-- CreateIndex
CREATE UNIQUE INDEX "nav_history_fundId_navDate_key" ON "nav_history"("fundId", "navDate");

-- CreateIndex
CREATE INDEX "holdings_userId_idx" ON "holdings"("userId");

-- CreateIndex
CREATE INDEX "holdings_fundId_idx" ON "holdings"("fundId");

-- CreateIndex
CREATE UNIQUE INDEX "holdings_userId_fundId_key" ON "holdings"("userId", "fundId");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotencyKey_key" ON "transactions"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_externalRef_key" ON "transactions"("externalRef");

-- CreateIndex
CREATE INDEX "transactions_userId_placedAt_idx" ON "transactions"("userId", "placedAt" DESC);

-- CreateIndex
CREATE INDEX "transactions_status_placedAt_idx" ON "transactions"("status", "placedAt");

-- CreateIndex
CREATE INDEX "transactions_fundId_idx" ON "transactions"("fundId");

-- CreateIndex
CREATE INDEX "transactions_sipMandateId_idx" ON "transactions"("sipMandateId");

-- CreateIndex
CREATE INDEX "sip_mandates_status_nextRunAt_idx" ON "sip_mandates"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "sip_mandates_userId_idx" ON "sip_mandates"("userId");

-- CreateIndex
CREATE INDEX "sip_mandates_fundId_idx" ON "sip_mandates"("fundId");

-- CreateIndex
CREATE INDEX "watchlist_items_userId_idx" ON "watchlist_items"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_items_userId_fundId_key" ON "watchlist_items"("userId", "fundId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "kyc_profiles" ADD CONSTRAINT "kyc_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funds" ADD CONSTRAINT "funds_amcId_fkey" FOREIGN KEY ("amcId") REFERENCES "amc_houses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nav_history" ADD CONSTRAINT "nav_history_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_sipMandateId_fkey" FOREIGN KEY ("sipMandateId") REFERENCES "sip_mandates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sip_mandates" ADD CONSTRAINT "sip_mandates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sip_mandates" ADD CONSTRAINT "sip_mandates_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
