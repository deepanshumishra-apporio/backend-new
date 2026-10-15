-- Apple / Google sign-in (linked after the phone OTP) and the self-declared
-- investment experience on the profile screen. Additive only.

CREATE TYPE "SocialProvider" AS ENUM ('APPLE', 'GOOGLE');

CREATE TYPE "InvestmentExperience" AS ENUM ('NONE', 'LESS_THAN_1_YEAR', 'ONE_TO_3_YEARS', 'THREE_TO_5_YEARS', 'MORE_THAN_5_YEARS');

ALTER TABLE "users"
  ADD COLUMN "investmentExperience" "InvestmentExperience",
  ADD COLUMN "investmentExperienceUpdatedAt" TIMESTAMPTZ(3);

CREATE TABLE "user_identities" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "SocialProvider" NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_identities_provider_subject_key" ON "user_identities"("provider", "subject");
CREATE UNIQUE INDEX "user_identities_userId_provider_key" ON "user_identities"("userId", "provider");

ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "social_sign_ins" (
    "id" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "provider" "SocialProvider" NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_sign_ins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "social_sign_ins_tokenHash_key" ON "social_sign_ins"("tokenHash");
CREATE INDEX "social_sign_ins_expiresAt_idx" ON "social_sign_ins"("expiresAt");
