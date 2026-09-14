import type { OnboardingStage } from "../../generated/prisma/enums.ts";

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
