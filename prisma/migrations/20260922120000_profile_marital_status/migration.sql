-- InvestorProfile.marital_status uses FP's *profile* vocabulary, where the
-- unmarried value is spelled `single`. The KYC vocabulary (`unmarried`), kept in
-- the existing "marital_status" enum, still serves kyc_requests and is left
-- untouched here. Previously both columns shared "marital_status", so mirroring
-- a profile whose value was `single` fell through fp-sync's enum mapping and was
-- silently stored as NULL.

-- New enum for the investor-profile side only.
CREATE TYPE "profile_marital_status" AS ENUM ('married', 'single', 'others');

-- Move the column onto it. Any legacy row that stored the KYC spelling
-- `unmarried` is normalised to `single`; `married`/`others`/NULL carry over
-- unchanged. Postgres cannot cast between two enum types directly, so the cast
-- routes through text.
ALTER TABLE "investor_profiles"
  ALTER COLUMN "maritalStatus" TYPE "profile_marital_status"
  USING (
    CASE "maritalStatus"::text
      WHEN 'unmarried' THEN 'single'
      ELSE "maritalStatus"::text
    END
  )::"profile_marital_status";
