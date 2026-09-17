import type { OnboardingStage } from "../../generated/prisma/enums.ts";

/**
 * The investor's own KYC answers, already translated into the profile's
 * vocabulary so a client can drop them straight into the create form.
 *
 * Every field is optional because the KYC form itself leaves them optional
 * until FP asks for them; `source` says how much to expect. There is no address
 * here — see `kyc-prefill.service.ts`.
 */
export interface KycProfilePrefillDto {
  source: "kyc_form" | "pre_verification";
  pan: string;
  name?: string;
  dateOfBirth?: string;
  taxStatus?: string;
  email?: string;
  mobile?: string;
  gender?: string;
  maritalStatus?: string;
  fatherName?: string;
  occupation?: string;
  incomeSlab?: string;
  pepDetails?: string;
  placeOfBirth?: string;
  countryOfBirth?: string;
  nationalityCountry?: string;
  citizenshipCountries?: string[];
  aadhaarLast4?: string;
}

/**
 * The three answers an MF investment account needs that a KYC form never
 * carries, plus the payout bank once one is linked.
 *
 * Every other fact is read back from the KYC form. Each field is optional
 * because the investor supplies them one screen at a time and provisioning is
 * called after each — see `investor-provisioning.service.ts`.
 */
export interface ProvisionInput {
  userId: string;
  sourceOfWealth?: string;
  countryOfBirth?: string;
  gender?: string;
  occupation?: string;
  incomeSlab?: string;
  pepDetails?: string;
  placeOfBirth?: string;
  maritalStatus?: string;
  fatherName?: string;
  address?: {
    line1: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode: string;
  };
  nominee?: {
    name: string;
    relationship: string;
    dateOfBirth?: string;
    pan?: string;
  };
  /** The investor declined to nominate. A choice, not the absence of one. */
  nominationOptOut?: boolean;
  bankAccountId?: string;
  ipAddress?: string;
}

export interface ProvisionResult {
  investorProfileId: string | null;
  mfInvestmentAccountId: string | null;
  /** What this call created. Empty when everything was already in place. */
  created: string[];
  /** What the investor still owes before an order can be placed. */
  missing: string[];
  canTransact: boolean;
}

export interface CreateInvestorProfileInput {
  /** The app account this profile belongs to. */
  userId: string;
  name: string;
  pan: string;
  /** yyyy-mm-dd. Write-once at FP. */
  dateOfBirth: string;
  taxStatus: string;
  gender?: string;
  occupation?: string;
  /**
   * KRA demographics. Undocumented on FP but accepted, and WRITE-ONCE — if
   * they are not sent now they can never be set, so collect them during
   * onboarding rather than later.
   */
  maritalStatus?: string;
  fatherName?: string;
  motherName?: string;
  /** Last 4 digits only. */
  aadhaarLast4?: string;
  citizenshipCountries?: string[];
  countryOfBirth?: string;
  placeOfBirth?: string;
  nationalityCountry?: string;
  sourceOfWealth?: string;
  incomeSlab?: string;
  pepDetails?: string;
  /** The investor's device IP, recorded by FP for audit. */
  ipAddress?: string;
}

export interface AddAddressInput {
  line1: string;
  line2?: string;
  line3?: string;
  /** FP derives city and state from an Indian postal code. */
  city?: string;
  state?: string;
  postalCode: string;
  country: string;
  nature?: string;
}

export interface AddPhoneInput {
  isd: string;
  number: string;
  belongsTo?: string;
}

export interface AddEmailInput {
  email: string;
  belongsTo?: string;
}

export interface AddBankAccountInput {
  accountNumber: string;
  accountHolderName: string;
  /** savings, current, nre or nro. */
  type: string;
  ifscCode: string;
}

export interface BankAccountLookupDto {
  id: string;
  status: "PENDING" | "SUCCESSFUL" | "FAILED";
  phoneLast4: string;
  /** Present only after a successful lookup; never expose the full number. */
  accountNumberLast4: string | null;
  accountHolderName: string | null;
  ifscCode: string | null;
  accountType: string | null;
  bankAccountId: string | null;
}

export interface AddNomineeInput {
  name: string;
  relationship: string;
  dateOfBirth?: string;
  /** Only for a nominee aged 18 or over. */
  pan?: string;
  /** Only for a minor nominee. */
  guardianName?: string;
  guardianPan?: string;
}

export interface FolioDefaultsInput {
  emailAddressId?: string;
  phoneNumberId?: string;
  addressId?: string;
  bankAccountId?: string;
  dematAccountId?: string;
  nominees?: { relatedPartyId: string; allocationPercentage: string; identityProofType?: string }[];
  /**
   * Required by FP whenever a nominee is set. The reference marks it
   * "upcoming"; the sandbox rejects the first order without it.
   */
  nominationsInfoVisibility?: string;
}

export interface InvestorProfileDto {
  id: string;
  fpId: string;
  name: string | null;
  /** Masked — never echo a full PAN back to a client. */
  panMasked: string | null;
  dateOfBirth: string | null;
  taxStatus: string | null;
  gender: string | null;
  occupation: string | null;
  createdAt: string;
}

export interface ContactDto {
  id: string;
  fpId: string;
  label: string;
  isDefault: boolean;
}

export interface BankAccountDto {
  id: string;
  fpId: string;
  bankName: string | null;
  branchName: string | null;
  ifscCode: string;
  /** Only ever the last four digits — the full number is FP's to hold. */
  accountNumberLast4: string;
  type: string;
  accountHolderName: string;
  isPayoutDefault: boolean;
  /** Penny-drop outcome. Null until a verification is started. */
  verificationStatus: string | null;
  verificationConfidence: string | null;
  verificationReason: string | null;
  /** COMPLETED *and* high confidence. Anything else must not fund an order. */
  usableForPayout: boolean;
  /** True on the cybrillapoa gateway, where FP rejects unverified payouts. */
  verificationRequired: boolean;
}

export interface NomineeDto {
  id: string;
  fpId: string;
  name: string;
  relationship: string;
  dateOfBirth: string | null;
  allocationPercentage: string | null;
  slot: number | null;
}

export interface InvestmentAccountDto {
  id: string;
  fpId: string;
  holdingPattern: string;
  primaryInvestorPan: string | null;
  folioDefaultsComplete: boolean;
  nominees: NomineeDto[];
  createdAt: string;
}

/** What the app needs to resume a half-finished signup in one read. */
export interface OnboardingStatusDto {
  investorProfileId: string | null;
  stage: OnboardingStage | null;
  completedAt: string | null;
  lastError: string | null;
  /**
   * The KYC form, or null when none was ever opened. `outstanding` is what a
   * client routes off: false means the identity journey is done with and the
   * next step is the investor profile.
   */
  kyc: {
    formId: string;
    status: string;
    nextAction: string | null;
    outstanding: boolean;
  } | null;
  /**
   * What the investor still owes before an order can be placed, in the same
   * vocabulary `ProvisionResult.missing` uses — `address`, `nomination`,
   * `bankAccount`. Derived from the rows that exist, so it needs no write.
   */
  accountMissing: string[];
  readiness: {
    hasProfile: boolean;
    hasAddress: boolean;
    hasPhone: boolean;
    hasEmail: boolean;
    hasBankAccount: boolean;
    hasNominee: boolean;
    hasInvestmentAccount: boolean;
    folioDefaultsComplete: boolean;
    /** PAN, name and date of birth cleared a recent pre-verification. */
    identityVerified: boolean;
    /** The payout bank account cleared a recent penny-drop. */
    payoutAccountVerified: boolean;
    /**
     * The same answer the order endpoints assert. When this is false the two
     * flags above say which step is outstanding.
     */
    canTransact: boolean;
  };
}
