-- Make MfSchemeThreshold.frequency NOT NULL.
--
-- (schemeId, type, frequency) is the natural key of a scheme threshold, but a
-- nullable frequency cannot be upserted: Prisma rejects a null inside a
-- compound-unique `where`, so every catalogue sync would have to read then
-- write, and two concurrent syncs could duplicate a row. A dedicated enum with
-- an explicit `not_applicable` member fixes that for the one-off threshold
-- types (lumpsum, additional, withdrawal, switch in/out), which have no cadence.
--
-- The column is dropped and recreated rather than cast, which is safe here:
-- mf_scheme_thresholds was created empty in the previous migration and no seed
-- had run against it yet.

-- CreateEnum
CREATE TYPE "scheme_threshold_frequency" AS ENUM ('not_applicable', 'daily', 'calendar_day_daily', 'day_in_a_week', 'four_times_a_month', 'day_in_a_fortnight', 'twice_a_month', 'monthly', 'quarterly', 'half_yearly', 'yearly');

-- AlterTable
ALTER TABLE "mf_scheme_thresholds" DROP COLUMN "frequency",
ADD COLUMN     "frequency" "scheme_threshold_frequency" NOT NULL DEFAULT 'not_applicable';

-- CreateIndex
CREATE UNIQUE INDEX "mf_scheme_thresholds_schemeId_type_frequency_key" ON "mf_scheme_thresholds"("schemeId", "type", "frequency");
