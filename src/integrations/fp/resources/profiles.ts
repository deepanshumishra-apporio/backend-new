// Investor profiles and everything hanging off them.
//
// A recurring rule across these endpoints: most fields are WRITE-ONCE. FP will
// accept a PATCH that adds a value that was absent, and reject one that changes
// a value already set. `tax_status`, `date_of_birth`, `pan` and
// `country_of_birth` on a profile, and effectively every field on an address,
// bank account or related party, behave this way. Callers should treat a
// correction as "create a new object", not "update this one".
import { fpList, fpRequest } from "../fp.http.ts";
import type {
  FpAddress,
  FpAddressHash,
  FpBankAccount,
  FpDematAccount,
  FpEmailAddress,
  FpInvestorProfile,
  FpPhone,
  FpPhoneNumber,
  FpRelatedParty,
  FpTaxResidency,
} from "../fp.types.ts";

// ---------------------------------------------------------------------------
// Investor profile
// ---------------------------------------------------------------------------

export interface CreateInvestorProfilePayload {
  type: string;
  tax_status?: string;
  name?: string;
  date_of_birth?: string;
  gender?: string;
  occupation?: string;
  pan?: string;
  guardian_name?: string;
  guardian_date_of_birth?: string;
  guardian_pan?: string;
  signature?: string;
  /**
   * Undocumented but accepted, and WRITE-ONCE — send at create or lose the
   * chance. These are the KRA demographics, worth capturing here because the
   * KYC-check API is not provisioned on every tenant.
   */
  marital_status?: string;
  father_name?: string;
  mother_name?: string;
  /** Last 4 digits only. */
  aadhaar_number?: string;
  citizenship_countries?: string[];
  country_of_birth?: string;
  place_of_birth?: string;
  nationality_country?: string;
  /**
   * true makes FP assume India + PAN for the first tax residency, which is all
   * a resident individual needs. It is an input flag only — it never comes back
   * on the object.
   */
  use_default_tax_residences?: boolean;
  first_tax_residency?: Partial<FpTaxResidency>;
  second_tax_residency?: Partial<FpTaxResidency>;
  third_tax_residency?: Partial<FpTaxResidency>;
  fourth_tax_residency?: Partial<FpTaxResidency>;
  source_of_wealth?: string;
  income_slab?: string;
  pep_details?: string;
  ip_address?: string;
}

export async function createInvestorProfile(
  payload: CreateInvestorProfilePayload,
  requestId?: string,
): Promise<FpInvestorProfile> {
  return fpRequest<FpInvestorProfile>({
    method: "POST",
    path: "/v2/investor_profiles",
    body: payload,
    ...(requestId && { requestId }),
  });
}

/** Note the id travels in the BODY, not the path — FP patches the collection. */
export async function updateInvestorProfile(
  payload: Partial<CreateInvestorProfilePayload> & { id: string },
  requestId?: string,
): Promise<FpInvestorProfile> {
  return fpRequest<FpInvestorProfile>({
    method: "PATCH",
    path: "/v2/investor_profiles",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function fetchInvestorProfile(
  id: string,
  requestId?: string,
): Promise<FpInvestorProfile> {
  return fpRequest<FpInvestorProfile>({
    method: "GET",
    path: `/v2/investor_profiles/${id}`,
    ...(requestId && { requestId }),
  });
}

/**
 * List profiles. FP requires either `pan` or `type` — an unfiltered call is
 * rejected. A PAN can legitimately return several profiles.
 */
export async function listInvestorProfiles(
  query: { pan?: string; type?: string },
  requestId?: string,
): Promise<FpInvestorProfile[]> {
  return fpList<FpInvestorProfile>("/v2/investor_profiles", query, requestId);
}

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

export interface CreateAddressPayload {
  profile: string;
  line1: string;
  line2?: string;
  line3?: string;
  city?: string;
  state?: string;
  postal_code: string;
  country: string;
  nature?: string;
}

/** For country = IN, FP fills in city and state from the postal code. */
export async function createAddress(
  payload: CreateAddressPayload,
  requestId?: string,
): Promise<FpAddress> {
  return fpRequest<FpAddress>({
    method: "POST",
    path: "/v2/addresses",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function listAddresses(profile: string, requestId?: string): Promise<FpAddress[]> {
  return fpList<FpAddress>("/v2/addresses", { profile }, requestId);
}

export async function createPhoneNumber(
  payload: { profile: string; isd: string; number: string; belongs_to?: string },
  requestId?: string,
): Promise<FpPhoneNumber> {
  return fpRequest<FpPhoneNumber>({
    method: "POST",
    path: "/v2/phone_numbers",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function listPhoneNumbers(
  profile: string,
  requestId?: string,
): Promise<FpPhoneNumber[]> {
  return fpList<FpPhoneNumber>("/v2/phone_numbers", { profile }, requestId);
}

export async function createEmailAddress(
  payload: { profile: string; email: string; belongs_to?: string },
  requestId?: string,
): Promise<FpEmailAddress> {
  return fpRequest<FpEmailAddress>({
    method: "POST",
    path: "/v2/email_addresses",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function listEmailAddresses(
  profile: string,
  requestId?: string,
): Promise<FpEmailAddress[]> {
  return fpList<FpEmailAddress>("/v2/email_addresses", { profile }, requestId);
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

export interface CreateBankAccountPayload {
  profile: string;
  /** Digits only, 9-18 characters. */
  account_number: string;
  primary_account_holder_name: string;
  type: string;
  ifsc_code: string;
  cancelled_cheque?: string;
}

export async function createBankAccount(
  payload: CreateBankAccountPayload,
  requestId?: string,
): Promise<FpBankAccount> {
  return fpRequest<FpBankAccount>({
    method: "POST",
    path: "/v2/bank_accounts",
    body: payload,
    ...(requestId && { requestId }),
  });
}

/** The ONLY mutable field on a bank account. Everything else is write-once. */
export async function attachCancelledCheque(
  payload: { id: string; cancelled_cheque: string },
  requestId?: string,
): Promise<FpBankAccount> {
  return fpRequest<FpBankAccount>({
    method: "PATCH",
    path: "/v2/bank_accounts",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function listBankAccounts(
  profile: string,
  requestId?: string,
): Promise<FpBankAccount[]> {
  return fpList<FpBankAccount>("/v2/bank_accounts", { profile }, requestId);
}

export async function fetchBankAccount(id: string): Promise<FpBankAccount> {
  return fpRequest({ method: "GET", path: `/v2/bank_accounts/${id}` });
}

// ---------------------------------------------------------------------------
// Related parties (nominees) and demat accounts
// ---------------------------------------------------------------------------

export interface CreateRelatedPartyPayload {
  profile: string;
  name: string;
  relationship: string;
  date_of_birth?: string;
  /** Only if the party is 18 or older. */
  pan?: string;
  /** Only if the party is under 18. */
  guardian_name?: string;
  guardian_pan?: string;
  aadhaar_number?: string;
  passport_number?: string;
  driving_licence_number?: string;
  email_address?: string;
  phone_number?: FpPhone;
  address?: Partial<FpAddressHash>;
  guardian_aadhaar_number?: string;
  guardian_passport_number?: string;
  guardian_driving_licence_number?: string;
  guardian_email_address?: string;
  guardian_phone_number?: FpPhone;
  guardian_address?: Partial<FpAddressHash>;
}

/**
 * Create a nominee.
 *
 * FP needs at least one identity proof on the party (or on the guardian, if
 * the party is a minor) before a new folio can be opened against them.
 */
export async function createRelatedParty(
  payload: CreateRelatedPartyPayload,
  requestId?: string,
): Promise<FpRelatedParty> {
  return fpRequest<FpRelatedParty>({
    method: "POST",
    path: "/v2/related_parties",
    body: payload,
    ...(requestId && { requestId }),
  });
}

/** Adds values that were absent. It cannot change one already set. */
export async function updateRelatedParty(
  payload: Partial<CreateRelatedPartyPayload> & { id: string },
  requestId?: string,
): Promise<FpRelatedParty> {
  return fpRequest<FpRelatedParty>({
    method: "PATCH",
    path: "/v2/related_parties",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function listRelatedParties(
  profile: string,
  requestId?: string,
): Promise<FpRelatedParty[]> {
  return fpList<FpRelatedParty>("/v2/related_parties", { profile }, requestId);
}

export async function createDematAccount(
  payload: { profile: string; dp_id: string; client_id: string },
  requestId?: string,
): Promise<FpDematAccount> {
  return fpRequest<FpDematAccount>({
    method: "POST",
    path: "/v2/demat_accounts",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function listDematAccounts(
  profile: string,
  requestId?: string,
): Promise<FpDematAccount[]> {
  return fpList<FpDematAccount>("/v2/demat_accounts", { profile }, requestId);
}
