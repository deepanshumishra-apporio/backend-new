-- CreateEnum
CREATE TYPE "CartItemType" AS ENUM ('LUMPSUM', 'SIP');

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "schemeId" UUID NOT NULL,
    "type" "CartItemType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_checkouts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "mfInvestmentAccountId" UUID NOT NULL,
    "mandateId" UUID,
    "installmentDay" INTEGER,
    "consentedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cart_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_checkout_items" (
    "id" UUID NOT NULL,
    "checkoutId" UUID NOT NULL,
    "isin" VARCHAR(12) NOT NULL,
    "type" "CartItemType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "sourceRefId" VARCHAR(64) NOT NULL,
    "mfPurchaseId" UUID,
    "mfPurchasePlanId" UUID,
    "error" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_checkout_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cart_items_userId_idx" ON "cart_items"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_userId_schemeId_type_key" ON "cart_items"("userId", "schemeId", "type");

-- CreateIndex
CREATE INDEX "cart_checkouts_userId_createdAt_idx" ON "cart_checkouts"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "cart_checkout_items_sourceRefId_key" ON "cart_checkout_items"("sourceRefId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_checkout_items_mfPurchaseId_key" ON "cart_checkout_items"("mfPurchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_checkout_items_mfPurchasePlanId_key" ON "cart_checkout_items"("mfPurchasePlanId");

-- CreateIndex
CREATE INDEX "cart_checkout_items_checkoutId_idx" ON "cart_checkout_items"("checkoutId");

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "mf_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_checkouts" ADD CONSTRAINT "cart_checkouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_checkouts" ADD CONSTRAINT "cart_checkouts_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_checkout_items" ADD CONSTRAINT "cart_checkout_items_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "cart_checkouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
