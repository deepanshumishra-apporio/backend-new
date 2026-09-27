-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE 'MARKET';

-- CreateTable
CREATE TABLE "market_holidays" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "market_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_holidays_date_key" ON "market_holidays"("date");
