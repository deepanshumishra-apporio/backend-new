import type { KycFormType } from "../../generated/prisma/enums.ts";

/** Verdict on one checked field. */
export interface KycCheckResult {
  /** "verified", "failed", or null while still running. */
  status: string | null;
  /** Machine-readable cause on failure, e.g. "aadhaar_not_linked". */
  code: string | null;
}

export interface KycReadinessDto {
  /** The pre-verification id — poll this while `readinessStatus` is null. */
  id: string;
  pan: string | null;
  /** The single gate: can this investor transact? */
  ready: boolean;
  readinessStatus: string | null;
  readinessCode: string | null;
  /** Non-null when the KRA already holds a record for this PAN. */
  modification: string | null;
  /** Per-field detail, for telling the investor what to fix. */
  checks: {
    pan: KycCheckResult;
    name: KycCheckResult;
    dateOfBirth: KycCheckResult;
    bankAccount?: KycCheckResult;
  };
  completedAt: string | null;
}

export interface StartKycInput {
  /**
   * FRESH for a PAN with no KYC, MODIFY for one already registered. The wrong
   * choice fails asynchronously — check readiness first.
   */
  type: KycFormType;
  pan: string;
  name: string;
  dateOfBirth: string;
  /** Where the investor returns after DigiLocker, and after esign. */
  proofCallbackUrl: string;
  esignCallbackUrl: string;
  userId?: string;
  investorProfileId?: string;
}

export interface UpdateKycFormInput {
  email?: string;
  mobile?: { isd: string; number: string };
  residentialStatus?: string;
  gender?: string;
  maritalStatus?: string;
  /** Required when marital status is unmarried or others. */
  fatherName?: string;
  /** Required when marital status is married. */
  spouseName?: string;
  occupationType?: string;
  /** Last 4 digits only. */
  aadhaarLast4?: string;
  countryOfBirth?: string;
  placeOfBirth?: string;
  incomeSlab?: string;
  pepDetails?: string;
  citizenshipCountries?: string[];
  nationalityCountry?: string;
  taxResidencyOtherThanIndia?: boolean;
  nonIndianTaxResidency1?: { country: string; taxIdNumber: string };
  nonIndianTaxResidency2?: { country: string; taxIdNumber: string };
  nonIndianTaxResidency3?: { country: string; taxIdNumber: string };
  geolocation?: { latitude: number; longitude: number };
}

export interface KycFormDto {
  id: string;
  fpId: string;
  type: string;
  status: string;
  /** Populated on failure, e.g. "ineligible_for_fresh_kyc". */
  reason: string | null;
  pan: string;
  name: string;
  dateOfBirth: string | null;
  /** What FP still wants. Drive the form off this, not a hardcoded list. */
  fieldsNeeded: string[];
  signatureProvided: boolean;
  /** Short-lived links the investor's browser must follow. */
  proofFetchUrl: string | null;
  proofStatus: string | null;
  esignUrl: string | null;
  esignStatus: string | null;
  /** Where to send the investor next, or null if it is FP's turn. */
  nextAction: "FETCH_PROOF" | "UPLOAD_SIGNATURE" | "PROVIDE_DETAILS" | "ESIGN" | null;
  expiresAt: string | null;
  submittedAt: string | null;
  failedAt: string | null;
  createdAt: string;
}
