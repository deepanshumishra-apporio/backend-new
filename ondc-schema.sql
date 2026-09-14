-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('INVESTOR', 'DISTRIBUTOR', 'ADMIN', 'SUPPORT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "UserProfileRelationship" AS ENUM ('SELF', 'GUARDIAN', 'JOINT_HOLDER', 'POA', 'ADVISOR');

-- CreateEnum
CREATE TYPE "OnboardingStage" AS ENUM ('KYC_CHECK', 'KYC_REQUEST', 'PROFILE', 'CONTACT_DETAILS', 'BANK_ACCOUNT', 'NOMINEE', 'FATCA', 'INVESTMENT_ACCOUNT', 'MANDATE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "FilePurpose" AS ENUM ('SIGNATURE', 'CANCELLED_CHEQUE', 'PHOTO', 'IPV_VIDEO', 'IDENTITY_PROOF', 'ADDRESS_PROOF', 'OTHER');

-- CreateEnum
CREATE TYPE "RelatedPartyContactSubject" AS ENUM ('SELF', 'GUARDIAN');

-- CreateEnum
CREATE TYPE "scheme_threshold_frequency" AS ENUM ('not_applicable', 'daily', 'calendar_day_daily', 'day_in_a_week', 'four_times_a_month', 'day_in_a_fortnight', 'twice_a_month', 'monthly', 'quarterly', 'half_yearly', 'yearly');

-- CreateEnum
CREATE TYPE "SchemeThresholdType" AS ENUM ('LUMPSUM', 'ADDITIONAL', 'WITHDRAWAL', 'SWITCH_IN', 'SWITCH_OUT', 'SIP', 'SWP', 'STP');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('PHONE_VERIFICATION', 'LOGIN', 'TRANSACTION_APPROVAL');

-- CreateEnum
CREATE TYPE "OtpStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "investor_profile_type" AS ENUM ('individual');

-- CreateEnum
CREATE TYPE "tax_status" AS ENUM ('resident_individual', 'nri', 'resident_minor', 'non_resident_minor_nro');

-- CreateEnum
CREATE TYPE "gender" AS ENUM ('male', 'female', 'transgender');

-- CreateEnum
CREATE TYPE "marital_status" AS ENUM ('married', 'unmarried', 'others');

-- CreateEnum
CREATE TYPE "occupation" AS ENUM ('business', 'professional', 'retired', 'house_wife', 'student', 'public_sector_service', 'private_sector_service', 'government_service', 'agriculture', 'doctor', 'forex_dealer', 'service', 'others');

-- CreateEnum
CREATE TYPE "kyc_occupation_type" AS ENUM ('business', 'professional', 'retired', 'housewife', 'student', 'public_sector', 'private_sector', 'government_sector', 'others');

-- CreateEnum
CREATE TYPE "source_of_wealth" AS ENUM ('salary', 'business', 'gift', 'ancestral_property', 'rental_income', 'prize_money', 'royalty', 'others');

-- CreateEnum
CREATE TYPE "income_slab" AS ENUM ('upto_1lakh', 'above_1lakh_upto_5lakh', 'above_5lakh_upto_10lakh', 'above_10lakh_upto_25lakh', 'above_25lakh_upto_1cr', 'above_1cr');

-- CreateEnum
CREATE TYPE "pep_details" AS ENUM ('pep_exposed', 'pep_related', 'not_applicable');

-- CreateEnum
CREATE TYPE "residential_status" AS ENUM ('resident_individual');

-- CreateEnum
CREATE TYPE "tax_id_type" AS ENUM ('passport', 'election_id', 'pan', 'id_card', 'driving_license', 'aadhaar_letter', 'nrega_job_card', 'tin', 'not_categorized', 'others');

-- CreateEnum
CREATE TYPE "address_nature" AS ENUM ('residential', 'business_location', 'registered_office');

-- CreateEnum
CREATE TYPE "contact_belongs_to" AS ENUM ('self', 'spouse', 'dependent_children', 'dependent_siblings', 'dependent_parents', 'guardian', 'pms', 'custodian', 'poa');

-- CreateEnum
CREATE TYPE "bav_status" AS ENUM ('pending', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "bav_confidence" AS ENUM ('very_high', 'high', 'uncertain', 'low', 'very_low', 'zero');

-- CreateEnum
CREATE TYPE "bank_account_type" AS ENUM ('savings', 'current', 'nre', 'nro');

-- CreateEnum
CREATE TYPE "related_party_relationship" AS ENUM ('father', 'mother', 'court_appointed_legal_guardian', 'aunt', 'brother', 'brother_in_law', 'daughter', 'daughter_in_law', 'father_in_law', 'grand_daughter', 'grand_father', 'grand_mother', 'grand_son', 'mother_in_law', 'nephew', 'niece', 'sister', 'sister_in_law', 'son', 'son_in_law', 'spouse', 'uncle', 'others');

-- CreateEnum
CREATE TYPE "identity_proof_type" AS ENUM ('pan', 'aadhaar', 'driving_licence', 'passport');

-- CreateEnum
CREATE TYPE "nominations_info_visibility" AS ENUM ('show_all_nominee_names', 'show_nomination_status');

-- CreateEnum
CREATE TYPE "kyc_form_type" AS ENUM ('fresh', 'modify');

-- CreateEnum
CREATE TYPE "kyc_form_status" AS ENUM ('under_review', 'created', 'awaiting_esign', 'awaiting_submission', 'submitted', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "kyc_request_status" AS ENUM ('pending', 'esign_required', 'submitted', 'successful', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "identity_document_type" AS ENUM ('aadhaar');

-- CreateEnum
CREATE TYPE "document_fetch_status" AS ENUM ('pending', 'successful', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "esign_status" AS ENUM ('pending', 'successful', 'failed');

-- CreateEnum
CREATE TYPE "scheme_category" AS ENUM ('equity', 'debt', 'liquid', 'hybrid', 'others');

-- CreateEnum
CREATE TYPE "scheme_plan_type" AS ENUM ('regular', 'direct');

-- CreateEnum
CREATE TYPE "scheme_investment_option" AS ENUM ('growth', 'div_payout', 'div_reinvestment');

-- CreateEnum
CREATE TYPE "scheme_delivery_mode" AS ENUM ('physical', 'demat', 'demat_physical');

-- CreateEnum
CREATE TYPE "holding_pattern" AS ENUM ('single', 'joint', 'either_or_survivor', 'anyone_or_survivor', 'first_or_survivor');

-- CreateEnum
CREATE TYPE "order_gateway" AS ENUM ('rta', 'cybrillapoa', 'ondc');

-- CreateEnum
CREATE TYPE "mf_order_state" AS ENUM ('under_review', 'pending', 'confirmed', 'submitted', 'successful', 'failed', 'cancelled', 'reversed');

-- CreateEnum
CREATE TYPE "mf_purchase_type" AS ENUM ('purchase', 'additional_purchase');

-- CreateEnum
CREATE TYPE "redemption_mode" AS ENUM ('normal', 'instant');

-- CreateEnum
CREATE TYPE "order_initiated_by" AS ENUM ('investor', 'distributor');

-- CreateEnum
CREATE TYPE "order_initiated_via" AS ENUM ('web', 'mobile_app', 'mobile_app_android', 'mobile_app_ios', 'mobile_web', 'mobile_web_android', 'mobile_web_ios');

-- CreateEnum
CREATE TYPE "plan_state" AS ENUM ('created', 'review_completed', 'confirmed', 'submitted', 'active', 'cancelled', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "plan_frequency" AS ENUM ('daily', 'calendar_day_daily', 'day_in_a_week', 'four_times_a_month', 'day_in_a_fortnight', 'twice_a_month', 'monthly', 'quarterly', 'half_yearly', 'yearly');

-- CreateEnum
CREATE TYPE "plan_purpose" AS ENUM ('children_education', 'children_marriage', 'house', 'car', 'travel', 'retirement', 'others');

-- CreateEnum
CREATE TYPE "plan_payment_method" AS ENUM ('mandate');

-- CreateEnum
CREATE TYPE "mandate_type" AS ENUM ('E_MANDATE', 'NACH', 'UPI');

-- CreateEnum
CREATE TYPE "mandate_status" AS ENUM ('CREATED', 'RECEIVED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "payment_provider" AS ENUM ('RAZORPAY', 'BILLDESK', 'CYBRILLAPOA', 'ONDC');

-- CreateEnum
CREATE TYPE "payment_type" AS ENUM ('NETBANKING', 'NACH', 'ECS', 'CHEQUE', 'AUTH_TRANSACTION');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('NETBANKING', 'UPI', 'EMANDATE');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('INITIATED', 'PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('CREATED', 'SUCCESSFUL', 'FAILED');

-- CreateEnum
CREATE TYPE "settlement_payment_type" AS ENUM ('netbanking', 'nach', 'neft', 'rtgs');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "fullName" VARCHAR(150),
    "role" "UserRole" NOT NULL DEFAULT 'INVESTOR',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "passwordHash" VARCHAR(255),
    "emailVerifiedAt" TIMESTAMP(3),
    "phoneVerifiedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_investor_profiles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "investorProfileId" UUID NOT NULL,
    "relationship" "UserProfileRelationship" NOT NULL DEFAULT 'SELF',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_investor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investor_onboardings" (
    "id" UUID NOT NULL,
    "investorProfileId" UUID NOT NULL,
    "stage" "OnboardingStage" NOT NULL DEFAULT 'KYC_CHECK',
    "lastError" VARCHAR(500),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investor_onboardings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fp_files" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "purpose" "FilePurpose" NOT NULL DEFAULT 'OTHER',
    "filename" VARCHAR(255),
    "contentType" VARCHAR(120),
    "byteSize" INTEGER,
    "fpUrl" VARCHAR(1000),
    "uploadedByUserId" UUID,
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fp_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_checks" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "pan" VARCHAR(10) NOT NULL,
    "dateOfBirth" DATE,
    "isCompliant" BOOLEAN NOT NULL,
    "action" VARCHAR(60),
    "reason" VARCHAR(120),
    "entityDetails" JSONB,
    "constraints" JSONB,
    "sources" JSONB,
    "sourceRefId" VARCHAR(120),
    "userId" UUID,
    "investorProfileId" UUID,
    "fpCreatedAt" TIMESTAMP(3),
    "fpUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_verifications" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "status" VARCHAR(60) NOT NULL,
    "investorIdentifier" VARCHAR(10),
    "readinessStatus" VARCHAR(60),
    "readinessCode" VARCHAR(120),
    "readinessReason" TEXT,
    "readinessModification" VARCHAR(120),
    "pan" VARCHAR(10),
    "panStatus" VARCHAR(60),
    "panCode" VARCHAR(120),
    "panReason" TEXT,
    "name" TEXT,
    "nameStatus" VARCHAR(60),
    "nameCode" VARCHAR(120),
    "nameReason" TEXT,
    "dateOfBirth" DATE,
    "dateOfBirthStatus" VARCHAR(60),
    "dateOfBirthCode" VARCHAR(120),
    "dateOfBirthReason" TEXT,
    "userId" UUID,
    "investorProfileId" UUID,
    "fpCreatedAt" TIMESTAMPTZ(3),
    "fpUpdatedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "syncedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pre_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_verification_bank_results" (
    "id" UUID NOT NULL,
    "preVerificationId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" VARCHAR(60),
    "code" VARCHAR(120),
    "reason" TEXT,
    "accountNumber" TEXT NOT NULL,
    "accountNumberFingerprint" VARCHAR(64),
    "ifscCode" VARCHAR(11) NOT NULL,
    "accountType" VARCHAR(60) NOT NULL,
    "bankAccountProofFpId" VARCHAR(64),
    "manualVerificationApproved" BOOLEAN,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pre_verification_bank_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_requests" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "status" "kyc_request_status" NOT NULL DEFAULT 'pending',
    "name" VARCHAR(70) NOT NULL,
    "pan" VARCHAR(10) NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "aadhaarLast4" VARCHAR(4),
    "fatherName" VARCHAR(70),
    "motherName" VARCHAR(70),
    "spouseName" VARCHAR(70),
    "gender" "gender",
    "maritalStatus" "marital_status",
    "residentialStatus" "residential_status",
    "occupationType" "kyc_occupation_type",
    "email" VARCHAR(255) NOT NULL,
    "mobileIsd" VARCHAR(4) NOT NULL,
    "mobileNumber" VARCHAR(20) NOT NULL,
    "citizenshipCountries" VARCHAR(2)[],
    "nationalityCountry" VARCHAR(2),
    "countryOfBirth" VARCHAR(2),
    "placeOfBirth" VARCHAR(120),
    "incomeSlab" "income_slab",
    "pepDetails" "pep_details",
    "taxResidencyOtherThanIndia" BOOLEAN,
    "signatureFileId" UUID,
    "identityProofId" UUID,
    "addressProofId" UUID,
    "addressProofType" "identity_proof_type",
    "geoLatitude" DECIMAL(9,6),
    "geoLongitude" DECIMAL(9,6),
    "fieldsNeeded" VARCHAR(60)[],
    "verificationStatus" "kyc_request_status",
    "verificationDetails" JSONB,
    "userId" UUID,
    "investorProfileId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "esignRequiredAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "successfulAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "fpCreatedAt" TIMESTAMP(3),
    "fpUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_request_tax_residencies" (
    "id" UUID NOT NULL,
    "kycRequestId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "taxIdNumber" VARCHAR(60) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_request_tax_residencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_forms" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "type" "kyc_form_type" NOT NULL,
    "status" "kyc_form_status" NOT NULL DEFAULT 'under_review',
    "reason" VARCHAR(120),
    "pan" VARCHAR(10) NOT NULL,
    "name" VARCHAR(70) NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "email" VARCHAR(255),
    "mobileIsd" VARCHAR(4),
    "mobileNumber" VARCHAR(20),
    "proofFetchUrl" VARCHAR(1000),
    "proofStatus" "document_fetch_status",
    "proofCallbackUrl" VARCHAR(1000),
    "esignCallbackUrl" VARCHAR(1000),
    "esignUrl" VARCHAR(1000),
    "esignStatus" "esign_status",
    "signatureProvided" BOOLEAN NOT NULL DEFAULT false,
    "fieldsNeeded" VARCHAR(60)[],
    "userId" UUID,
    "investorProfileId" UUID,
    "fpCreatedAt" TIMESTAMP(3),
    "fpUpdatedAt" TIMESTAMP(3),
    "reviewCompletedAt" TIMESTAMP(3),
    "awaitingEsignAt" TIMESTAMP(3),
    "awaitingSubmissionAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_documents" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "type" "identity_document_type" NOT NULL DEFAULT 'aadhaar',
    "kycRequestId" UUID,
    "fetchStatus" "document_fetch_status" NOT NULL DEFAULT 'pending',
    "fetchRedirectUrl" VARCHAR(1000),
    "fetchPostbackUrl" VARCHAR(1000),
    "numberLast4" VARCHAR(4),
    "line1" VARCHAR(255),
    "city" VARCHAR(100),
    "pincode" VARCHAR(10),
    "country" VARCHAR(2),
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esigns" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "kycRequestId" UUID NOT NULL,
    "type" VARCHAR(30),
    "status" "esign_status" NOT NULL DEFAULT 'pending',
    "redirectUrl" VARCHAR(1000),
    "postbackUrl" VARCHAR(1000),
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "esigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investor_profiles" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "type" "investor_profile_type" NOT NULL DEFAULT 'individual',
    "taxStatus" "tax_status",
    "name" VARCHAR(70),
    "dateOfBirth" DATE,
    "gender" "gender",
    "maritalStatus" "marital_status",
    "occupation" "occupation",
    "pan" VARCHAR(10),
    "aadhaarLast4" VARCHAR(4),
    "fatherName" VARCHAR(70),
    "motherName" VARCHAR(70),
    "citizenshipCountries" VARCHAR(2)[],
    "guardianName" VARCHAR(80),
    "guardianDateOfBirth" DATE,
    "guardianPan" VARCHAR(10),
    "countryOfBirth" VARCHAR(2),
    "placeOfBirth" VARCHAR(120),
    "nationalityCountry" VARCHAR(2),
    "sourceOfWealth" "source_of_wealth",
    "incomeSlab" "income_slab",
    "pepDetails" "pep_details",
    "signatureFileId" UUID,
    "employerProfileId" UUID,
    "ipAddress" VARCHAR(45),
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_residencies" (
    "id" UUID NOT NULL,
    "investorProfileId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "taxIdType" "tax_id_type" NOT NULL,
    "taxIdNumber" VARCHAR(60) NOT NULL,
    "applicableFrom" DATE,
    "applicableTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_residencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "investorProfileId" UUID NOT NULL,
    "line1" VARCHAR(255) NOT NULL,
    "line2" VARCHAR(255),
    "line3" VARCHAR(255),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "postalCode" VARCHAR(10) NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "nature" "address_nature",
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "investorProfileId" UUID NOT NULL,
    "isd" VARCHAR(4) NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "belongsTo" "contact_belongs_to",
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_addresses" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "investorProfileId" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "belongsTo" "contact_belongs_to",
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "fpOldId" INTEGER,
    "investorProfileId" UUID NOT NULL,
    "primaryAccountHolderName" VARCHAR(150) NOT NULL,
    "accountNumberLast4" VARCHAR(4) NOT NULL,
    "accountNumberFingerprint" VARCHAR(64) NOT NULL,
    "type" "bank_account_type" NOT NULL,
    "ifscCode" VARCHAR(11) NOT NULL,
    "bankName" VARCHAR(150),
    "branchName" VARCHAR(150),
    "branchAddress" VARCHAR(300),
    "branchCity" VARCHAR(100),
    "branchDistrict" VARCHAR(100),
    "branchState" VARCHAR(100),
    "branchContactNumber" VARCHAR(30),
    "cancelledChequeFileId" UUID,
    "verificationFpId" VARCHAR(64),
    "verificationStatus" "bav_status",
    "verificationConfidence" "bav_confidence",
    "verificationReason" VARCHAR(60),
    "verifiedAt" TIMESTAMP(3),
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "related_parties" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "investorProfileId" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "relationship" "related_party_relationship" NOT NULL,
    "dateOfBirth" DATE,
    "pan" VARCHAR(10),
    "guardianName" VARCHAR(35),
    "guardianPan" VARCHAR(10),
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "related_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "related_party_contacts" (
    "id" UUID NOT NULL,
    "relatedPartyId" UUID NOT NULL,
    "subject" "RelatedPartyContactSubject" NOT NULL,
    "aadhaarLast4" VARCHAR(4),
    "passportNumber" VARCHAR(30),
    "drivingLicenceNumber" VARCHAR(30),
    "emailAddress" VARCHAR(255),
    "phoneIsd" VARCHAR(4),
    "phoneNumber" VARCHAR(20),
    "line1" VARCHAR(255),
    "line2" VARCHAR(255),
    "line3" VARCHAR(255),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "postalCode" VARCHAR(10),
    "country" VARCHAR(2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "related_party_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demat_accounts" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "investorProfileId" UUID NOT NULL,
    "dpId" VARCHAR(20) NOT NULL,
    "clientId" VARCHAR(20) NOT NULL,
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demat_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "arn" VARCHAR(20),
    "euin" VARCHAR(10),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_amcs" (
    "id" UUID NOT NULL,
    "fpAmcId" INTEGER,
    "name" VARCHAR(200) NOT NULL,
    "code" VARCHAR(20),
    "logoUrl" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_amcs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_schemes" (
    "id" UUID NOT NULL,
    "isin" VARCHAR(12) NOT NULL,
    "fpSchemeId" INTEGER,
    "amcId" UUID NOT NULL,
    "name" VARCHAR(250) NOT NULL,
    "schemeCode" VARCHAR(20),
    "amfiCode" VARCHAR(20),
    "fpRtaId" INTEGER,
    "category" "scheme_category" NOT NULL,
    "planType" "scheme_plan_type" NOT NULL,
    "investmentOption" "scheme_investment_option" NOT NULL,
    "subCategory" VARCHAR(120),
    "deliveryMode" "scheme_delivery_mode",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "closeEnded" BOOLEAN NOT NULL DEFAULT false,
    "lockIn" BOOLEAN NOT NULL DEFAULT false,
    "lockInPeriodDays" INTEGER,
    "longTermPeriodDays" INTEGER,
    "purchaseAllowed" BOOLEAN NOT NULL DEFAULT true,
    "redemptionAllowed" BOOLEAN NOT NULL DEFAULT true,
    "instantRedemptionAllowed" BOOLEAN NOT NULL DEFAULT false,
    "switchInAllowed" BOOLEAN NOT NULL DEFAULT false,
    "switchOutAllowed" BOOLEAN NOT NULL DEFAULT false,
    "sipAllowed" BOOLEAN NOT NULL DEFAULT false,
    "swpAllowed" BOOLEAN NOT NULL DEFAULT false,
    "stpInAllowed" BOOLEAN NOT NULL DEFAULT false,
    "stpOutAllowed" BOOLEAN NOT NULL DEFAULT false,
    "minInitialInvestment" DECIMAL(18,2),
    "maxInitialInvestment" DECIMAL(18,2),
    "initialInvestmentMultiples" DECIMAL(18,2),
    "minAdditionalInvestment" DECIMAL(18,2),
    "maxAdditionalInvestment" DECIMAL(18,2),
    "additionalInvestmentMultiples" DECIMAL(18,2),
    "minWithdrawalAmount" DECIMAL(18,4),
    "maxWithdrawalAmount" DECIMAL(18,2),
    "withdrawalMultiples" DECIMAL(18,4),
    "minWithdrawalUnits" DECIMAL(18,4),
    "maxWithdrawalUnits" DECIMAL(18,4),
    "withdrawalUnitMultiples" DECIMAL(18,4),
    "minInstantWithdrawalAmount" DECIMAL(18,4),
    "instantWithdrawalMultiples" DECIMAL(18,4),
    "minSwitchInAmount" DECIMAL(18,4),
    "maxSwitchInAmount" DECIMAL(18,2),
    "switchInAmountMultiples" DECIMAL(18,4),
    "minSwitchOutAmount" DECIMAL(18,4),
    "maxSwitchOutAmount" DECIMAL(18,2),
    "switchOutAmountMultiples" DECIMAL(18,4),
    "minSwitchOutUnits" DECIMAL(18,4),
    "maxSwitchOutUnits" DECIMAL(18,4),
    "switchOutUnitMultiples" DECIMAL(18,4),
    "merged" BOOLEAN NOT NULL DEFAULT false,
    "mergedToIsin" VARCHAR(12),
    "mergerDate" DATE,
    "expenseRatio" DECIMAL(6,4),
    "exitLoadPct" DECIMAL(6,4),
    "latestNav" DECIMAL(12,4),
    "latestNavDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_scheme_thresholds" (
    "id" UUID NOT NULL,
    "schemeId" UUID NOT NULL,
    "type" "SchemeThresholdType" NOT NULL,
    "frequency" "scheme_threshold_frequency" NOT NULL DEFAULT 'not_applicable',
    "amountMin" DECIMAL(18,2),
    "amountMax" DECIMAL(18,2),
    "amountMultiples" DECIMAL(18,2),
    "unitsMin" DECIMAL(18,4),
    "unitsMax" DECIMAL(18,4),
    "unitsMultiples" DECIMAL(18,4),
    "installmentsMin" INTEGER,
    "allowedDates" INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_scheme_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nav_history" (
    "id" UUID NOT NULL,
    "schemeId" UUID NOT NULL,
    "navDate" DATE NOT NULL,
    "nav" DECIMAL(12,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nav_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist_items" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "schemeId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_investment_accounts" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "fpOldId" INTEGER,
    "primaryInvestorProfileId" UUID NOT NULL,
    "secondInvestorProfileId" UUID,
    "thirdInvestorProfileId" UUID,
    "primaryInvestorPan" VARCHAR(10),
    "secondInvestorPan" VARCHAR(10),
    "thirdInvestorPan" VARCHAR(10),
    "holdingPattern" "holding_pattern" NOT NULL DEFAULT 'single',
    "servicingPartnerId" UUID,
    "fpCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_investment_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_folio_defaults" (
    "id" UUID NOT NULL,
    "mfInvestmentAccountId" UUID NOT NULL,
    "communicationEmailAddressId" UUID,
    "communicationPhoneNumberId" UUID,
    "communicationAddressId" UUID,
    "overseasCommunicationAddressId" UUID,
    "payoutBankAccountId" UUID,
    "dematAccountId" UUID,
    "nominationsInfoVisibility" "nominations_info_visibility",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_folio_defaults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_investment_account_nominees" (
    "id" UUID NOT NULL,
    "mfInvestmentAccountId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "relatedPartyId" UUID NOT NULL,
    "allocationPercentage" DECIMAL(5,2) NOT NULL,
    "identityProofType" "identity_proof_type",
    "guardianIdentityProofType" "identity_proof_type",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_investment_account_nominees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_folios" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64),
    "number" VARCHAR(30) NOT NULL,
    "amcCode" VARCHAR(20),
    "mfInvestmentAccountId" UUID NOT NULL,
    "holdingPattern" "holding_pattern",
    "dpId" VARCHAR(20),
    "clientId" VARCHAR(20),
    "primaryInvestorName" VARCHAR(150),
    "primaryInvestorPan" VARCHAR(10),
    "primaryInvestorDob" DATE,
    "primaryInvestorGender" VARCHAR(20),
    "secondaryInvestorName" VARCHAR(150),
    "secondaryInvestorPan" VARCHAR(10),
    "secondaryInvestorDob" DATE,
    "secondaryInvestorGender" VARCHAR(20),
    "thirdInvestorName" VARCHAR(150),
    "thirdInvestorPan" VARCHAR(10),
    "thirdInvestorDob" DATE,
    "thirdInvestorGender" VARCHAR(20),
    "primaryInvestorTaxStatus" VARCHAR(60),
    "primaryInvestorOccupation" VARCHAR(60),
    "guardianName" VARCHAR(150),
    "guardianPan" VARCHAR(10),
    "guardianDob" DATE,
    "guardianGender" VARCHAR(20),
    "guardianRelationship" VARCHAR(60),
    "emailAddresses" VARCHAR(255)[],
    "mobileNumbers" VARCHAR(20)[],
    "annexure" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_folios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_folio_nominees" (
    "id" UUID NOT NULL,
    "mfFolioId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "name" VARCHAR(150),
    "dateOfBirth" DATE,
    "relationship" VARCHAR(60),
    "guardianName" VARCHAR(150),
    "guardianRelationship" VARCHAR(60),
    "allocationPercentage" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_folio_nominees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_folio_scheme_payouts" (
    "id" UUID NOT NULL,
    "mfFolioId" UUID NOT NULL,
    "schemeIsin" VARCHAR(12) NOT NULL,
    "schemeCode" VARCHAR(20),
    "bankAccountName" VARCHAR(150),
    "bankAccountNumberMasked" VARCHAR(40),
    "bankAccountType" "bank_account_type",
    "bankIfsc" VARCHAR(11),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_folio_scheme_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_holdings" (
    "id" UUID NOT NULL,
    "mfInvestmentAccountId" UUID NOT NULL,
    "mfFolioId" UUID,
    "folioNumber" VARCHAR(30) NOT NULL,
    "schemeIsin" VARCHAR(12) NOT NULL,
    "schemeName" VARCHAR(250),
    "units" DECIMAL(18,4) NOT NULL,
    "redeemableUnits" DECIMAL(18,4),
    "unitsAsOn" DATE,
    "marketValue" DECIMAL(18,2),
    "redeemableMarketValue" DECIMAL(18,2),
    "marketValueAsOn" DATE,
    "investedValue" DECIMAL(18,2),
    "investedValueAsOn" DATE,
    "payoutAmount" DECIMAL(18,2),
    "payoutAsOn" DATE,
    "nav" DECIMAL(12,4),
    "navAsOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_holdings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_purchases" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "fpOldId" INTEGER,
    "mfInvestmentAccountId" UUID NOT NULL,
    "schemeIsin" VARCHAR(12) NOT NULL,
    "folioNumber" VARCHAR(30),
    "mfFolioId" UUID,
    "planId" UUID,
    "type" "mf_purchase_type",
    "state" "mf_order_state" NOT NULL DEFAULT 'pending',
    "gateway" "order_gateway" NOT NULL DEFAULT 'rta',
    "amount" DECIMAL(18,2) NOT NULL,
    "allottedUnits" DECIMAL(18,4),
    "purchasedAmount" DECIMAL(18,2),
    "purchasedPrice" DECIMAL(12,4),
    "allottedNavDate" DATE,
    "sourceRefId" VARCHAR(64),
    "userIp" VARCHAR(45),
    "serverIp" VARCHAR(45),
    "euin" VARCHAR(10),
    "partnerId" UUID,
    "initiatedBy" "order_initiated_by",
    "initiatedVia" "order_initiated_via",
    "consentEmail" VARCHAR(255),
    "consentIsdCode" VARCHAR(4),
    "consentMobile" VARCHAR(20),
    "consentAt" TIMESTAMP(3),
    "failureCode" VARCHAR(60),
    "failureReason" VARCHAR(500),
    "scheduledOn" DATE,
    "tradedOn" DATE,
    "fpCreatedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "retriedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_redemptions" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "fpOldId" INTEGER,
    "mfInvestmentAccountId" UUID NOT NULL,
    "schemeIsin" VARCHAR(12) NOT NULL,
    "folioNumber" VARCHAR(30),
    "mfFolioId" UUID,
    "planId" UUID,
    "state" "mf_order_state" NOT NULL DEFAULT 'pending',
    "gateway" "order_gateway" NOT NULL DEFAULT 'rta',
    "redemptionMode" "redemption_mode" NOT NULL DEFAULT 'normal',
    "amount" DECIMAL(18,2),
    "units" DECIMAL(18,4),
    "redeemedAmount" DECIMAL(18,2),
    "redeemedUnits" DECIMAL(18,4),
    "redeemedPrice" DECIMAL(12,4),
    "redeemedNavDate" DATE,
    "redemptionBankAccountNumber" VARCHAR(20),
    "redemptionBankAccountIfsc" VARCHAR(11),
    "sourceRefId" VARCHAR(64),
    "userIp" VARCHAR(45),
    "serverIp" VARCHAR(45),
    "euin" VARCHAR(10),
    "partnerId" UUID,
    "initiatedBy" "order_initiated_by",
    "initiatedVia" "order_initiated_via",
    "consentEmail" VARCHAR(255),
    "consentIsdCode" VARCHAR(4),
    "consentMobile" VARCHAR(20),
    "consentAt" TIMESTAMP(3),
    "failureCode" VARCHAR(60),
    "failureReason" VARCHAR(500),
    "scheduledOn" DATE,
    "tradedOn" DATE,
    "fpCreatedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_switches" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "fpOldId" INTEGER,
    "mfInvestmentAccountId" UUID NOT NULL,
    "switchOutSchemeIsin" VARCHAR(12) NOT NULL,
    "switchInSchemeIsin" VARCHAR(12) NOT NULL,
    "folioNumber" VARCHAR(30),
    "mfFolioId" UUID,
    "planId" UUID,
    "state" "mf_order_state" NOT NULL DEFAULT 'pending',
    "gateway" "order_gateway" NOT NULL DEFAULT 'rta',
    "amount" DECIMAL(18,2),
    "units" DECIMAL(18,4),
    "switchedOutUnits" DECIMAL(18,4),
    "switchedOutAmount" DECIMAL(18,2),
    "switchedOutPrice" DECIMAL(12,4),
    "switchedInUnits" DECIMAL(18,4),
    "switchedInAmount" DECIMAL(18,2),
    "switchedInPrice" DECIMAL(12,4),
    "sourceRefId" VARCHAR(64),
    "userIp" VARCHAR(45),
    "serverIp" VARCHAR(45),
    "euin" VARCHAR(10),
    "partnerId" UUID,
    "initiatedBy" "order_initiated_by",
    "initiatedVia" "order_initiated_via",
    "consentEmail" VARCHAR(255),
    "consentIsdCode" VARCHAR(4),
    "consentMobile" VARCHAR(20),
    "consentAt" TIMESTAMP(3),
    "failureCode" VARCHAR(60),
    "failureReason" VARCHAR(500),
    "scheduledOn" DATE,
    "tradedOn" DATE,
    "fpCreatedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_switches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_purchase_plans" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "fpOldId" INTEGER,
    "mfInvestmentAccountId" UUID NOT NULL,
    "schemeIsin" VARCHAR(12) NOT NULL,
    "folioNumber" VARCHAR(30),
    "amount" DECIMAL(18,2) NOT NULL,
    "systematic" BOOLEAN NOT NULL DEFAULT true,
    "frequency" "plan_frequency" NOT NULL,
    "installmentDay" INTEGER,
    "numberOfInstallments" INTEGER NOT NULL,
    "remainingInstallments" INTEGER,
    "state" "plan_state" NOT NULL DEFAULT 'created',
    "gateway" "order_gateway" NOT NULL DEFAULT 'rta',
    "autoGenerateInstallments" BOOLEAN NOT NULL DEFAULT true,
    "generateFirstInstallmentNow" BOOLEAN NOT NULL DEFAULT false,
    "paymentMethod" "plan_payment_method",
    "paymentSourceRef" VARCHAR(64),
    "mandateId" UUID,
    "purpose" "plan_purpose",
    "requestedActivationDate" DATE,
    "startDate" DATE,
    "endDate" DATE,
    "nextInstallmentDate" DATE,
    "previousInstallmentDate" DATE,
    "sourceRefId" VARCHAR(64),
    "userIp" VARCHAR(45),
    "serverIp" VARCHAR(45),
    "euin" VARCHAR(10),
    "partnerId" UUID,
    "initiatedBy" "order_initiated_by",
    "initiatedVia" "order_initiated_via",
    "consentEmail" VARCHAR(255),
    "consentIsdCode" VARCHAR(4),
    "consentMobile" VARCHAR(20),
    "consentAt" TIMESTAMP(3),
    "autoCancelled" BOOLEAN,
    "cancellationCode" VARCHAR(60),
    "cancellationScheduledOn" DATE,
    "reason" VARCHAR(500),
    "fpCreatedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_purchase_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_redemption_plans" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "fpOldId" INTEGER,
    "mfInvestmentAccountId" UUID NOT NULL,
    "schemeIsin" VARCHAR(12) NOT NULL,
    "folioNumber" VARCHAR(30),
    "amount" DECIMAL(18,2),
    "units" DECIMAL(18,4),
    "systematic" BOOLEAN NOT NULL DEFAULT true,
    "frequency" "plan_frequency" NOT NULL,
    "installmentDay" INTEGER,
    "numberOfInstallments" INTEGER NOT NULL,
    "remainingInstallments" INTEGER,
    "state" "plan_state" NOT NULL DEFAULT 'created',
    "gateway" "order_gateway" NOT NULL DEFAULT 'rta',
    "autoGenerateInstallments" BOOLEAN NOT NULL DEFAULT true,
    "requestedActivationDate" DATE,
    "startDate" DATE,
    "endDate" DATE,
    "nextInstallmentDate" DATE,
    "previousInstallmentDate" DATE,
    "sourceRefId" VARCHAR(64),
    "userIp" VARCHAR(45),
    "serverIp" VARCHAR(45),
    "euin" VARCHAR(10),
    "partnerId" UUID,
    "initiatedBy" "order_initiated_by",
    "initiatedVia" "order_initiated_via",
    "consentEmail" VARCHAR(255),
    "consentIsdCode" VARCHAR(4),
    "consentMobile" VARCHAR(20),
    "consentAt" TIMESTAMP(3),
    "autoCancelled" BOOLEAN,
    "cancellationCode" VARCHAR(60),
    "cancellationScheduledOn" DATE,
    "reason" VARCHAR(500),
    "fpCreatedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_redemption_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_switch_plans" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "fpOldId" INTEGER,
    "mfInvestmentAccountId" UUID NOT NULL,
    "switchOutSchemeIsin" VARCHAR(12) NOT NULL,
    "switchInSchemeIsin" VARCHAR(12) NOT NULL,
    "folioNumber" VARCHAR(30),
    "amount" DECIMAL(18,2),
    "units" DECIMAL(18,4),
    "systematic" BOOLEAN NOT NULL DEFAULT true,
    "frequency" "plan_frequency" NOT NULL,
    "installmentDay" INTEGER,
    "numberOfInstallments" INTEGER NOT NULL,
    "remainingInstallments" INTEGER,
    "state" "plan_state" NOT NULL DEFAULT 'created',
    "gateway" "order_gateway" NOT NULL DEFAULT 'rta',
    "autoGenerateInstallments" BOOLEAN NOT NULL DEFAULT true,
    "requestedActivationDate" DATE,
    "startDate" DATE,
    "endDate" DATE,
    "nextInstallmentDate" DATE,
    "previousInstallmentDate" DATE,
    "sourceRefId" VARCHAR(64),
    "userIp" VARCHAR(45),
    "serverIp" VARCHAR(45),
    "euin" VARCHAR(10),
    "partnerId" UUID,
    "initiatedBy" "order_initiated_by",
    "initiatedVia" "order_initiated_via",
    "consentEmail" VARCHAR(255),
    "consentIsdCode" VARCHAR(4),
    "consentMobile" VARCHAR(20),
    "consentAt" TIMESTAMP(3),
    "autoCancelled" BOOLEAN,
    "cancellationCode" VARCHAR(60),
    "cancellationScheduledOn" DATE,
    "reason" VARCHAR(500),
    "fpCreatedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_switch_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mandates" (
    "id" UUID NOT NULL,
    "fpId" INTEGER NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "mandateType" "mandate_type" NOT NULL,
    "mandateStatus" "mandate_status" NOT NULL DEFAULT 'CREATED',
    "mandateLimit" DECIMAL(18,2) NOT NULL,
    "mandateRef" VARCHAR(64),
    "mandateToken" VARCHAR(120),
    "umrn" VARCHAR(40),
    "validFrom" DATE,
    "validTo" DATE,
    "providerName" "payment_provider",
    "providerId" INTEGER,
    "rejectedReason" VARCHAR(500),
    "fpCreatedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "fpId" INTEGER NOT NULL,
    "paymentType" "payment_type" NOT NULL,
    "method" "payment_method",
    "status" "payment_status" NOT NULL DEFAULT 'INITIATED',
    "amount" DECIMAL(18,2) NOT NULL,
    "mandateId" UUID,
    "fromBankAccountId" UUID,
    "provider" "payment_provider",
    "debitDate" DATE,
    "tokenUrl" VARCHAR(1000),
    "postbackReceivedAt" TIMESTAMP(3),
    "failureCode" VARCHAR(60),
    "failedReason" VARCHAR(500),
    "lateAuth" BOOLEAN,
    "refundReference" VARCHAR(120),
    "refundReason" VARCHAR(200),
    "refundStatus" "refund_status",
    "refundCreatedAt" TIMESTAMP(3),
    "fpCreatedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "debitConfirmedAt" TIMESTAMP(3),
    "transferInitiatedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_purchases" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "mfPurchaseId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_settlement_details" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64) NOT NULL,
    "mfPurchaseId" UUID NOT NULL,
    "paymentType" "settlement_payment_type" NOT NULL,
    "utrNumber" VARCHAR(60),
    "bankAccountNumber" VARCHAR(20),
    "bankIfsc" VARCHAR(11),
    "bankName" VARCHAR(150),
    "bankAccountType" "bank_account_type",
    "beneficiaryAccountNumber" VARCHAR(30),
    "beneficiaryAccountTitle" VARCHAR(150),
    "beneficiaryBankName" VARCHAR(150),
    "settlementProcessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_settlement_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mf_payout_details" (
    "id" UUID NOT NULL,
    "fpId" VARCHAR(64),
    "mfRedemptionId" UUID NOT NULL,
    "amount" DECIMAL(18,2),
    "utrNumber" VARCHAR(60),
    "bankAccountNumberMasked" VARCHAR(40),
    "bankIfsc" VARCHAR(11),
    "bankName" VARCHAR(150),
    "status" VARCHAR(40),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mf_payout_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_verifications" (
    "id" UUID NOT NULL,
    "context" VARCHAR(200),
    "phone" VARCHAR(20) NOT NULL,
    "purpose" "OtpPurpose" NOT NULL DEFAULT 'PHONE_VERIFICATION',
    "status" "OtpStatus" NOT NULL DEFAULT 'PENDING',
    "providerRequestId" VARCHAR(100),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sendCount" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "tokenHash" VARCHAR(64),
    "tokenExpiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fp_webhook_events" (
    "id" UUID NOT NULL,
    "fpEventId" VARCHAR(64) NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "objectType" VARCHAR(40),
    "objectFpId" VARCHAR(64),
    "payload" JSONB NOT NULL,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(1000),
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "fp_webhook_events_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "actorRole" "UserRole",
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
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE INDEX "user_investor_profiles_investorProfileId_idx" ON "user_investor_profiles"("investorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "user_investor_profiles_userId_investorProfileId_key" ON "user_investor_profiles"("userId", "investorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "investor_onboardings_investorProfileId_key" ON "investor_onboardings"("investorProfileId");

-- CreateIndex
CREATE INDEX "investor_onboardings_stage_idx" ON "investor_onboardings"("stage");

-- CreateIndex
CREATE UNIQUE INDEX "fp_files_fpId_key" ON "fp_files"("fpId");

-- CreateIndex
CREATE INDEX "fp_files_purpose_idx" ON "fp_files"("purpose");

-- CreateIndex
CREATE INDEX "fp_files_uploadedByUserId_idx" ON "fp_files"("uploadedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_checks_fpId_key" ON "kyc_checks"("fpId");

-- CreateIndex
CREATE INDEX "kyc_checks_pan_createdAt_idx" ON "kyc_checks"("pan", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "kyc_checks_userId_idx" ON "kyc_checks"("userId");

-- CreateIndex
CREATE INDEX "kyc_checks_investorProfileId_idx" ON "kyc_checks"("investorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "pre_verifications_fpId_key" ON "pre_verifications"("fpId");

-- CreateIndex
CREATE INDEX "pre_verifications_investorIdentifier_createdAt_idx" ON "pre_verifications"("investorIdentifier", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "pre_verifications_userId_createdAt_idx" ON "pre_verifications"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "pre_verifications_investorProfileId_createdAt_idx" ON "pre_verifications"("investorProfileId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "pre_verifications_status_syncedAt_idx" ON "pre_verifications"("status", "syncedAt");

-- CreateIndex
CREATE INDEX "pre_verification_bank_results_accountNumberFingerprint_idx" ON "pre_verification_bank_results"("accountNumberFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "pre_verification_bank_results_preVerificationId_position_key" ON "pre_verification_bank_results"("preVerificationId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_requests_fpId_key" ON "kyc_requests"("fpId");

-- CreateIndex
CREATE INDEX "kyc_requests_pan_createdAt_idx" ON "kyc_requests"("pan", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "kyc_requests_status_idx" ON "kyc_requests"("status");

-- CreateIndex
CREATE INDEX "kyc_requests_status_expiresAt_idx" ON "kyc_requests"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "kyc_requests_userId_idx" ON "kyc_requests"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_request_tax_residencies_kycRequestId_slot_key" ON "kyc_request_tax_residencies"("kycRequestId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_forms_fpId_key" ON "kyc_forms"("fpId");

-- CreateIndex
CREATE INDEX "kyc_forms_pan_createdAt_idx" ON "kyc_forms"("pan", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "kyc_forms_status_idx" ON "kyc_forms"("status");

-- CreateIndex
CREATE INDEX "kyc_forms_userId_idx" ON "kyc_forms"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "identity_documents_fpId_key" ON "identity_documents"("fpId");

-- CreateIndex
CREATE INDEX "identity_documents_kycRequestId_idx" ON "identity_documents"("kycRequestId");

-- CreateIndex
CREATE INDEX "identity_documents_fetchStatus_idx" ON "identity_documents"("fetchStatus");

-- CreateIndex
CREATE UNIQUE INDEX "esigns_fpId_key" ON "esigns"("fpId");

-- CreateIndex
CREATE INDEX "esigns_kycRequestId_idx" ON "esigns"("kycRequestId");

-- CreateIndex
CREATE INDEX "esigns_status_idx" ON "esigns"("status");

-- CreateIndex
CREATE UNIQUE INDEX "investor_profiles_fpId_key" ON "investor_profiles"("fpId");

-- CreateIndex
CREATE INDEX "investor_profiles_pan_idx" ON "investor_profiles"("pan");

-- CreateIndex
CREATE INDEX "investor_profiles_type_idx" ON "investor_profiles"("type");

-- CreateIndex
CREATE INDEX "investor_profiles_createdAt_idx" ON "investor_profiles"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tax_residencies_investorProfileId_slot_key" ON "tax_residencies"("investorProfileId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "addresses_fpId_key" ON "addresses"("fpId");

-- CreateIndex
CREATE INDEX "addresses_investorProfileId_idx" ON "addresses"("investorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_fpId_key" ON "phone_numbers"("fpId");

-- CreateIndex
CREATE INDEX "phone_numbers_investorProfileId_idx" ON "phone_numbers"("investorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "email_addresses_fpId_key" ON "email_addresses"("fpId");

-- CreateIndex
CREATE INDEX "email_addresses_investorProfileId_idx" ON "email_addresses"("investorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_fpId_key" ON "bank_accounts"("fpId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_fpOldId_key" ON "bank_accounts"("fpOldId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_verificationFpId_key" ON "bank_accounts"("verificationFpId");

-- CreateIndex
CREATE INDEX "bank_accounts_investorProfileId_idx" ON "bank_accounts"("investorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_investorProfileId_accountNumberFingerprint_key" ON "bank_accounts"("investorProfileId", "accountNumberFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "related_parties_fpId_key" ON "related_parties"("fpId");

-- CreateIndex
CREATE INDEX "related_parties_investorProfileId_idx" ON "related_parties"("investorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "related_party_contacts_relatedPartyId_subject_key" ON "related_party_contacts"("relatedPartyId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "demat_accounts_fpId_key" ON "demat_accounts"("fpId");

-- CreateIndex
CREATE INDEX "demat_accounts_investorProfileId_idx" ON "demat_accounts"("investorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "demat_accounts_investorProfileId_dpId_clientId_key" ON "demat_accounts"("investorProfileId", "dpId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "partners_fpId_key" ON "partners"("fpId");

-- CreateIndex
CREATE INDEX "partners_isActive_idx" ON "partners"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "mf_amcs_fpAmcId_key" ON "mf_amcs"("fpAmcId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_amcs_name_key" ON "mf_amcs"("name");

-- CreateIndex
CREATE UNIQUE INDEX "mf_amcs_code_key" ON "mf_amcs"("code");

-- CreateIndex
CREATE INDEX "mf_amcs_isActive_idx" ON "mf_amcs"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "mf_schemes_isin_key" ON "mf_schemes"("isin");

-- CreateIndex
CREATE UNIQUE INDEX "mf_schemes_fpSchemeId_key" ON "mf_schemes"("fpSchemeId");

-- CreateIndex
CREATE INDEX "mf_schemes_amcId_idx" ON "mf_schemes"("amcId");

-- CreateIndex
CREATE INDEX "mf_schemes_category_isActive_idx" ON "mf_schemes"("category", "isActive");

-- CreateIndex
CREATE INDEX "mf_schemes_planType_investmentOption_idx" ON "mf_schemes"("planType", "investmentOption");

-- CreateIndex
CREATE INDEX "mf_schemes_isActive_sipAllowed_idx" ON "mf_schemes"("isActive", "sipAllowed");

-- CreateIndex
CREATE UNIQUE INDEX "mf_scheme_thresholds_schemeId_type_frequency_key" ON "mf_scheme_thresholds"("schemeId", "type", "frequency");

-- CreateIndex
CREATE INDEX "nav_history_navDate_idx" ON "nav_history"("navDate");

-- CreateIndex
CREATE UNIQUE INDEX "nav_history_schemeId_navDate_key" ON "nav_history"("schemeId", "navDate");

-- CreateIndex
CREATE INDEX "watchlist_items_userId_idx" ON "watchlist_items"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_items_userId_schemeId_key" ON "watchlist_items"("userId", "schemeId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_investment_accounts_fpId_key" ON "mf_investment_accounts"("fpId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_investment_accounts_fpOldId_key" ON "mf_investment_accounts"("fpOldId");

-- CreateIndex
CREATE INDEX "mf_investment_accounts_primaryInvestorProfileId_idx" ON "mf_investment_accounts"("primaryInvestorProfileId");

-- CreateIndex
CREATE INDEX "mf_investment_accounts_primaryInvestorPan_idx" ON "mf_investment_accounts"("primaryInvestorPan");

-- CreateIndex
CREATE INDEX "mf_investment_accounts_holdingPattern_idx" ON "mf_investment_accounts"("holdingPattern");

-- CreateIndex
CREATE UNIQUE INDEX "mf_folio_defaults_mfInvestmentAccountId_key" ON "mf_folio_defaults"("mfInvestmentAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_investment_account_nominees_mfInvestmentAccountId_slot_key" ON "mf_investment_account_nominees"("mfInvestmentAccountId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "mf_investment_account_nominees_mfInvestmentAccountId_relate_key" ON "mf_investment_account_nominees"("mfInvestmentAccountId", "relatedPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_folios_fpId_key" ON "mf_folios"("fpId");

-- CreateIndex
CREATE INDEX "mf_folios_number_idx" ON "mf_folios"("number");

-- CreateIndex
CREATE INDEX "mf_folios_primaryInvestorPan_idx" ON "mf_folios"("primaryInvestorPan");

-- CreateIndex
CREATE UNIQUE INDEX "mf_folios_mfInvestmentAccountId_number_key" ON "mf_folios"("mfInvestmentAccountId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "mf_folio_nominees_mfFolioId_slot_key" ON "mf_folio_nominees"("mfFolioId", "slot");

-- CreateIndex
CREATE INDEX "mf_folio_scheme_payouts_schemeIsin_idx" ON "mf_folio_scheme_payouts"("schemeIsin");

-- CreateIndex
CREATE UNIQUE INDEX "mf_folio_scheme_payouts_mfFolioId_schemeIsin_key" ON "mf_folio_scheme_payouts"("mfFolioId", "schemeIsin");

-- CreateIndex
CREATE INDEX "mf_holdings_mfInvestmentAccountId_idx" ON "mf_holdings"("mfInvestmentAccountId");

-- CreateIndex
CREATE INDEX "mf_holdings_schemeIsin_idx" ON "mf_holdings"("schemeIsin");

-- CreateIndex
CREATE UNIQUE INDEX "mf_holdings_mfInvestmentAccountId_folioNumber_schemeIsin_key" ON "mf_holdings"("mfInvestmentAccountId", "folioNumber", "schemeIsin");

-- CreateIndex
CREATE UNIQUE INDEX "mf_purchases_fpId_key" ON "mf_purchases"("fpId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_purchases_fpOldId_key" ON "mf_purchases"("fpOldId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_purchases_sourceRefId_key" ON "mf_purchases"("sourceRefId");

-- CreateIndex
CREATE INDEX "mf_purchases_mfInvestmentAccountId_fpCreatedAt_idx" ON "mf_purchases"("mfInvestmentAccountId", "fpCreatedAt" DESC);

-- CreateIndex
CREATE INDEX "mf_purchases_state_scheduledOn_idx" ON "mf_purchases"("state", "scheduledOn");

-- CreateIndex
CREATE INDEX "mf_purchases_schemeIsin_idx" ON "mf_purchases"("schemeIsin");

-- CreateIndex
CREATE INDEX "mf_purchases_planId_idx" ON "mf_purchases"("planId");

-- CreateIndex
CREATE INDEX "mf_purchases_folioNumber_idx" ON "mf_purchases"("folioNumber");

-- CreateIndex
CREATE UNIQUE INDEX "mf_redemptions_fpId_key" ON "mf_redemptions"("fpId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_redemptions_fpOldId_key" ON "mf_redemptions"("fpOldId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_redemptions_sourceRefId_key" ON "mf_redemptions"("sourceRefId");

-- CreateIndex
CREATE INDEX "mf_redemptions_mfInvestmentAccountId_fpCreatedAt_idx" ON "mf_redemptions"("mfInvestmentAccountId", "fpCreatedAt" DESC);

-- CreateIndex
CREATE INDEX "mf_redemptions_state_scheduledOn_idx" ON "mf_redemptions"("state", "scheduledOn");

-- CreateIndex
CREATE INDEX "mf_redemptions_schemeIsin_idx" ON "mf_redemptions"("schemeIsin");

-- CreateIndex
CREATE INDEX "mf_redemptions_planId_idx" ON "mf_redemptions"("planId");

-- CreateIndex
CREATE INDEX "mf_redemptions_folioNumber_idx" ON "mf_redemptions"("folioNumber");

-- CreateIndex
CREATE UNIQUE INDEX "mf_switches_fpId_key" ON "mf_switches"("fpId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_switches_fpOldId_key" ON "mf_switches"("fpOldId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_switches_sourceRefId_key" ON "mf_switches"("sourceRefId");

-- CreateIndex
CREATE INDEX "mf_switches_mfInvestmentAccountId_fpCreatedAt_idx" ON "mf_switches"("mfInvestmentAccountId", "fpCreatedAt" DESC);

-- CreateIndex
CREATE INDEX "mf_switches_state_scheduledOn_idx" ON "mf_switches"("state", "scheduledOn");

-- CreateIndex
CREATE INDEX "mf_switches_switchOutSchemeIsin_idx" ON "mf_switches"("switchOutSchemeIsin");

-- CreateIndex
CREATE INDEX "mf_switches_switchInSchemeIsin_idx" ON "mf_switches"("switchInSchemeIsin");

-- CreateIndex
CREATE INDEX "mf_switches_planId_idx" ON "mf_switches"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_purchase_plans_fpId_key" ON "mf_purchase_plans"("fpId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_purchase_plans_fpOldId_key" ON "mf_purchase_plans"("fpOldId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_purchase_plans_sourceRefId_key" ON "mf_purchase_plans"("sourceRefId");

-- CreateIndex
CREATE INDEX "mf_purchase_plans_mfInvestmentAccountId_idx" ON "mf_purchase_plans"("mfInvestmentAccountId");

-- CreateIndex
CREATE INDEX "mf_purchase_plans_state_nextInstallmentDate_idx" ON "mf_purchase_plans"("state", "nextInstallmentDate");

-- CreateIndex
CREATE INDEX "mf_purchase_plans_schemeIsin_idx" ON "mf_purchase_plans"("schemeIsin");

-- CreateIndex
CREATE INDEX "mf_purchase_plans_mandateId_idx" ON "mf_purchase_plans"("mandateId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_redemption_plans_fpId_key" ON "mf_redemption_plans"("fpId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_redemption_plans_fpOldId_key" ON "mf_redemption_plans"("fpOldId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_redemption_plans_sourceRefId_key" ON "mf_redemption_plans"("sourceRefId");

-- CreateIndex
CREATE INDEX "mf_redemption_plans_mfInvestmentAccountId_idx" ON "mf_redemption_plans"("mfInvestmentAccountId");

-- CreateIndex
CREATE INDEX "mf_redemption_plans_state_nextInstallmentDate_idx" ON "mf_redemption_plans"("state", "nextInstallmentDate");

-- CreateIndex
CREATE INDEX "mf_redemption_plans_schemeIsin_idx" ON "mf_redemption_plans"("schemeIsin");

-- CreateIndex
CREATE UNIQUE INDEX "mf_switch_plans_fpId_key" ON "mf_switch_plans"("fpId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_switch_plans_fpOldId_key" ON "mf_switch_plans"("fpOldId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_switch_plans_sourceRefId_key" ON "mf_switch_plans"("sourceRefId");

-- CreateIndex
CREATE INDEX "mf_switch_plans_mfInvestmentAccountId_idx" ON "mf_switch_plans"("mfInvestmentAccountId");

-- CreateIndex
CREATE INDEX "mf_switch_plans_state_nextInstallmentDate_idx" ON "mf_switch_plans"("state", "nextInstallmentDate");

-- CreateIndex
CREATE INDEX "mf_switch_plans_switchOutSchemeIsin_idx" ON "mf_switch_plans"("switchOutSchemeIsin");

-- CreateIndex
CREATE UNIQUE INDEX "mandates_fpId_key" ON "mandates"("fpId");

-- CreateIndex
CREATE INDEX "mandates_bankAccountId_idx" ON "mandates"("bankAccountId");

-- CreateIndex
CREATE INDEX "mandates_mandateStatus_idx" ON "mandates"("mandateStatus");

-- CreateIndex
CREATE UNIQUE INDEX "payments_fpId_key" ON "payments"("fpId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_mandateId_idx" ON "payments"("mandateId");

-- CreateIndex
CREATE INDEX "payments_fromBankAccountId_idx" ON "payments"("fromBankAccountId");

-- CreateIndex
CREATE INDEX "payments_fpCreatedAt_idx" ON "payments"("fpCreatedAt" DESC);

-- CreateIndex
CREATE INDEX "payment_purchases_mfPurchaseId_idx" ON "payment_purchases"("mfPurchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_purchases_paymentId_mfPurchaseId_key" ON "payment_purchases"("paymentId", "mfPurchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_settlement_details_fpId_key" ON "mf_settlement_details"("fpId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_settlement_details_mfPurchaseId_key" ON "mf_settlement_details"("mfPurchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_payout_details_fpId_key" ON "mf_payout_details"("fpId");

-- CreateIndex
CREATE UNIQUE INDEX "mf_payout_details_mfRedemptionId_key" ON "mf_payout_details"("mfRedemptionId");

-- CreateIndex
CREATE UNIQUE INDEX "phone_verifications_tokenHash_key" ON "phone_verifications"("tokenHash");

-- CreateIndex
CREATE INDEX "phone_verifications_phone_purpose_createdAt_idx" ON "phone_verifications"("phone", "purpose", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "phone_verifications_status_expiresAt_idx" ON "phone_verifications"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "fp_webhook_events_fpEventId_key" ON "fp_webhook_events"("fpEventId");

-- CreateIndex
CREATE INDEX "fp_webhook_events_status_receivedAt_idx" ON "fp_webhook_events"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "fp_webhook_events_type_receivedAt_idx" ON "fp_webhook_events"("type", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "fp_webhook_events_objectType_objectFpId_idx" ON "fp_webhook_events"("objectType", "objectFpId");

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

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "user_investor_profiles" ADD CONSTRAINT "user_investor_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_investor_profiles" ADD CONSTRAINT "user_investor_profiles_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investor_onboardings" ADD CONSTRAINT "investor_onboardings_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fp_files" ADD CONSTRAINT "fp_files_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_checks" ADD CONSTRAINT "kyc_checks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_checks" ADD CONSTRAINT "kyc_checks_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_verifications" ADD CONSTRAINT "pre_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_verifications" ADD CONSTRAINT "pre_verifications_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_verification_bank_results" ADD CONSTRAINT "pre_verification_bank_results_preVerificationId_fkey" FOREIGN KEY ("preVerificationId") REFERENCES "pre_verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_signatureFileId_fkey" FOREIGN KEY ("signatureFileId") REFERENCES "fp_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_identityProofId_fkey" FOREIGN KEY ("identityProofId") REFERENCES "identity_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_addressProofId_fkey" FOREIGN KEY ("addressProofId") REFERENCES "identity_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_request_tax_residencies" ADD CONSTRAINT "kyc_request_tax_residencies_kycRequestId_fkey" FOREIGN KEY ("kycRequestId") REFERENCES "kyc_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_forms" ADD CONSTRAINT "kyc_forms_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_forms" ADD CONSTRAINT "kyc_forms_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_documents" ADD CONSTRAINT "identity_documents_kycRequestId_fkey" FOREIGN KEY ("kycRequestId") REFERENCES "kyc_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "esigns" ADD CONSTRAINT "esigns_kycRequestId_fkey" FOREIGN KEY ("kycRequestId") REFERENCES "kyc_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investor_profiles" ADD CONSTRAINT "investor_profiles_signatureFileId_fkey" FOREIGN KEY ("signatureFileId") REFERENCES "fp_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investor_profiles" ADD CONSTRAINT "investor_profiles_employerProfileId_fkey" FOREIGN KEY ("employerProfileId") REFERENCES "investor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_residencies" ADD CONSTRAINT "tax_residencies_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_addresses" ADD CONSTRAINT "email_addresses_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_cancelledChequeFileId_fkey" FOREIGN KEY ("cancelledChequeFileId") REFERENCES "fp_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "related_parties" ADD CONSTRAINT "related_parties_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "related_party_contacts" ADD CONSTRAINT "related_party_contacts_relatedPartyId_fkey" FOREIGN KEY ("relatedPartyId") REFERENCES "related_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demat_accounts" ADD CONSTRAINT "demat_accounts_investorProfileId_fkey" FOREIGN KEY ("investorProfileId") REFERENCES "investor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_schemes" ADD CONSTRAINT "mf_schemes_amcId_fkey" FOREIGN KEY ("amcId") REFERENCES "mf_amcs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_scheme_thresholds" ADD CONSTRAINT "mf_scheme_thresholds_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "mf_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nav_history" ADD CONSTRAINT "nav_history_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "mf_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "mf_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_investment_accounts" ADD CONSTRAINT "mf_investment_accounts_primaryInvestorProfileId_fkey" FOREIGN KEY ("primaryInvestorProfileId") REFERENCES "investor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_investment_accounts" ADD CONSTRAINT "mf_investment_accounts_secondInvestorProfileId_fkey" FOREIGN KEY ("secondInvestorProfileId") REFERENCES "investor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_investment_accounts" ADD CONSTRAINT "mf_investment_accounts_thirdInvestorProfileId_fkey" FOREIGN KEY ("thirdInvestorProfileId") REFERENCES "investor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_investment_accounts" ADD CONSTRAINT "mf_investment_accounts_servicingPartnerId_fkey" FOREIGN KEY ("servicingPartnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_folio_defaults" ADD CONSTRAINT "mf_folio_defaults_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_folio_defaults" ADD CONSTRAINT "mf_folio_defaults_communicationEmailAddressId_fkey" FOREIGN KEY ("communicationEmailAddressId") REFERENCES "email_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_folio_defaults" ADD CONSTRAINT "mf_folio_defaults_communicationPhoneNumberId_fkey" FOREIGN KEY ("communicationPhoneNumberId") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_folio_defaults" ADD CONSTRAINT "mf_folio_defaults_communicationAddressId_fkey" FOREIGN KEY ("communicationAddressId") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_folio_defaults" ADD CONSTRAINT "mf_folio_defaults_overseasCommunicationAddressId_fkey" FOREIGN KEY ("overseasCommunicationAddressId") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_folio_defaults" ADD CONSTRAINT "mf_folio_defaults_payoutBankAccountId_fkey" FOREIGN KEY ("payoutBankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_folio_defaults" ADD CONSTRAINT "mf_folio_defaults_dematAccountId_fkey" FOREIGN KEY ("dematAccountId") REFERENCES "demat_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_investment_account_nominees" ADD CONSTRAINT "mf_investment_account_nominees_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_investment_account_nominees" ADD CONSTRAINT "mf_investment_account_nominees_relatedPartyId_fkey" FOREIGN KEY ("relatedPartyId") REFERENCES "related_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_folios" ADD CONSTRAINT "mf_folios_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_folio_nominees" ADD CONSTRAINT "mf_folio_nominees_mfFolioId_fkey" FOREIGN KEY ("mfFolioId") REFERENCES "mf_folios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_folio_scheme_payouts" ADD CONSTRAINT "mf_folio_scheme_payouts_mfFolioId_fkey" FOREIGN KEY ("mfFolioId") REFERENCES "mf_folios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_holdings" ADD CONSTRAINT "mf_holdings_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_holdings" ADD CONSTRAINT "mf_holdings_mfFolioId_fkey" FOREIGN KEY ("mfFolioId") REFERENCES "mf_folios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_purchases" ADD CONSTRAINT "mf_purchases_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_purchases" ADD CONSTRAINT "mf_purchases_schemeIsin_fkey" FOREIGN KEY ("schemeIsin") REFERENCES "mf_schemes"("isin") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_purchases" ADD CONSTRAINT "mf_purchases_mfFolioId_fkey" FOREIGN KEY ("mfFolioId") REFERENCES "mf_folios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_purchases" ADD CONSTRAINT "mf_purchases_planId_fkey" FOREIGN KEY ("planId") REFERENCES "mf_purchase_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_purchases" ADD CONSTRAINT "mf_purchases_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_redemptions" ADD CONSTRAINT "mf_redemptions_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_redemptions" ADD CONSTRAINT "mf_redemptions_schemeIsin_fkey" FOREIGN KEY ("schemeIsin") REFERENCES "mf_schemes"("isin") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_redemptions" ADD CONSTRAINT "mf_redemptions_mfFolioId_fkey" FOREIGN KEY ("mfFolioId") REFERENCES "mf_folios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_redemptions" ADD CONSTRAINT "mf_redemptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "mf_redemption_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_redemptions" ADD CONSTRAINT "mf_redemptions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_switches" ADD CONSTRAINT "mf_switches_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_switches" ADD CONSTRAINT "mf_switches_switchOutSchemeIsin_fkey" FOREIGN KEY ("switchOutSchemeIsin") REFERENCES "mf_schemes"("isin") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_switches" ADD CONSTRAINT "mf_switches_switchInSchemeIsin_fkey" FOREIGN KEY ("switchInSchemeIsin") REFERENCES "mf_schemes"("isin") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_switches" ADD CONSTRAINT "mf_switches_mfFolioId_fkey" FOREIGN KEY ("mfFolioId") REFERENCES "mf_folios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_switches" ADD CONSTRAINT "mf_switches_planId_fkey" FOREIGN KEY ("planId") REFERENCES "mf_switch_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_switches" ADD CONSTRAINT "mf_switches_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_purchase_plans" ADD CONSTRAINT "mf_purchase_plans_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_purchase_plans" ADD CONSTRAINT "mf_purchase_plans_schemeIsin_fkey" FOREIGN KEY ("schemeIsin") REFERENCES "mf_schemes"("isin") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_purchase_plans" ADD CONSTRAINT "mf_purchase_plans_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "mandates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_purchase_plans" ADD CONSTRAINT "mf_purchase_plans_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_redemption_plans" ADD CONSTRAINT "mf_redemption_plans_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_redemption_plans" ADD CONSTRAINT "mf_redemption_plans_schemeIsin_fkey" FOREIGN KEY ("schemeIsin") REFERENCES "mf_schemes"("isin") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_redemption_plans" ADD CONSTRAINT "mf_redemption_plans_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_switch_plans" ADD CONSTRAINT "mf_switch_plans_mfInvestmentAccountId_fkey" FOREIGN KEY ("mfInvestmentAccountId") REFERENCES "mf_investment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_switch_plans" ADD CONSTRAINT "mf_switch_plans_switchOutSchemeIsin_fkey" FOREIGN KEY ("switchOutSchemeIsin") REFERENCES "mf_schemes"("isin") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_switch_plans" ADD CONSTRAINT "mf_switch_plans_switchInSchemeIsin_fkey" FOREIGN KEY ("switchInSchemeIsin") REFERENCES "mf_schemes"("isin") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_switch_plans" ADD CONSTRAINT "mf_switch_plans_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "mandates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_fromBankAccountId_fkey" FOREIGN KEY ("fromBankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_purchases" ADD CONSTRAINT "payment_purchases_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_purchases" ADD CONSTRAINT "payment_purchases_mfPurchaseId_fkey" FOREIGN KEY ("mfPurchaseId") REFERENCES "mf_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_settlement_details" ADD CONSTRAINT "mf_settlement_details_mfPurchaseId_fkey" FOREIGN KEY ("mfPurchaseId") REFERENCES "mf_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mf_payout_details" ADD CONSTRAINT "mf_payout_details_mfRedemptionId_fkey" FOREIGN KEY ("mfRedemptionId") REFERENCES "mf_redemptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investor_sessions" ADD CONSTRAINT "investor_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investor_commands" ADD CONSTRAINT "investor_commands_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
