-- Capture the KRA demographics FP holds on an investor_profile.
--
-- These four are undocumented in FP's reference but the API returns AND accepts
-- them, write-once, verified against the sandbox. All additive and nullable, so
-- this migration is non-destructive.
--
-- They matter because the KYC-check API is not provisioned on every tenant. On
-- one where it is not, the profile is the only place this data exists, and
-- since FP refuses to modify a value once set it can only be captured at
-- profile creation.

-- AlterTable
ALTER TABLE "investor_profiles" ADD COLUMN     "aadhaarLast4" VARCHAR(4),
ADD COLUMN     "citizenshipCountries" VARCHAR(2)[],
ADD COLUMN     "fatherName" VARCHAR(70),
ADD COLUMN     "motherName" VARCHAR(70);
