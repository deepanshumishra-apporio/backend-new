-- Record an investor's decision to decline nomination.
--
-- Declining creates no nominee row, so before this there was no way to tell
-- "declined" from "not asked yet": /investors/onboarding kept reporting
-- `nomination` as outstanding and the KYC resume route sent the investor back
-- to the nominee screen on every pass.
ALTER TABLE "investor_onboardings" ADD COLUMN "nominationOptOutAt" TIMESTAMP(3);
