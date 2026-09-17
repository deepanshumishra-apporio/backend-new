// Cybrilla POA KYC Forms — the digital KYC journey that a partner token
// actually unlocks.
//
// This is NOT the same thing as FP's `/v2/kyc_requests`. That lives on the
// tenant realm and is not provisioned on every tenant; this lives on the POA
// host with the partner credentials, and it is the route to use when the tenant
// side answers "Couldn't find Tenant".
//
// Lifecycle:
//   under_review  eligibility being checked (asynchronous — poll for it)
//   created       eligible; fill in requirements.fields_needed
//   awaiting_esign  everything present; send the investor to esign_url
//   awaiting_submission  esigned, going to the KRA
//   submitted     accepted by the KRA
//   failed        see `reason`
//   expired       no action within 7 days
//
// Eligibility is decided from the PAN's real KYC status and is the most common
// way this fails: `fresh` needs a PAN with no KYC ("unavailable"), `modify`
// needs one that is already validated/verified/registered/onhold. Ask for the
// wrong one and the form settles to failed with `ineligible_for_fresh_kyc` or
// `ineligible_for_kyc_modification`. Check with a pre-verification first.
import { fpRequest } from "../fp.http.ts";
import type { FpNonIndianTaxResidency, FpPhone } from "../fp.types.ts";

export type KycFormType = "fresh" | "modify";

export type KycFormStatus =
  | "under_review"
  | "created"
  | "awaiting_esign"
  | "awaiting_submission"
  | "submitted"
  | "failed"
  | "expired";

export interface FpKycForm {
  object: "kyc_form";
  id: string;
  type: KycFormType;
  status: KycFormStatus;
  /** Populated on failure, e.g. "ineligible_for_fresh_kyc". */
  reason: string | null;

  pan: string;
  name: string;
  date_of_birth: string;
  email_address: string | null;
  phone_number: FpPhone | null;

  /** DigiLocker fetch of the identity and address proof. */
  proof_details: { fetch_url: string | null; status: string | null } | null;
  proof_details_callback_url: string | null;
  esign_callback_url: string | null;
  identity: { proof_type: string | null } | null;
  address: { proof_type: string | null } | null;

  /** What FP still needs before the form can be esigned. Drive the UI off it. */
  requirements: { fields_needed: string[] } | null;
  signature_provided: boolean;

  gender: string | null;
  marital_status: string | null;
  /** Required when marital_status is unmarried or others. */
  father_name: string | null;
  /** Required when marital_status is married. */
  spouse_name: string | null;
  occupation_type: string | null;
  /** Last 4 digits. */
  aadhaar_number: string | null;
  citizenship_countries: string[] | null;
  nationality_country: string | null;
  country_of_birth: string | null;
  place_of_birth: string | null;
  income_slab: string | null;
  pep_details: string | null;
  residential_status: string | null;
  tax_residency_other_than_india: boolean | null;
  non_indian_tax_residency_1: FpNonIndianTaxResidency | null;
  non_indian_tax_residency_2: FpNonIndianTaxResidency | null;
  non_indian_tax_residency_3: FpNonIndianTaxResidency | null;
  geolocation: { latitude: number; longitude: number } | null;

  esign_details: { esign_url: string | null; status: string | null } | null;

  created_at: string;
  updated_at: string;
  review_completed_at: string | null;
  awaiting_esign_at: string | null;
  awaiting_submission_at: string | null;
  submitted_at: string | null;
  failed_at: string | null;
  expires_at: string | null;
}

export interface CreateKycFormPayload {
  type: KycFormType;
  pan: string;
  name: string;
  date_of_birth: string;
  /** Where to send the investor after DigiLocker. */
  proof_details_callback_url: string;
  /** Where to send the investor after esign. */
  esign_callback_url: string;
}

/** Everything the form needs before it can move to esign. */
export interface UpdateKycFormPayload {
  id: string;
  email_address?: string;
  phone_number?: FpPhone;
  residential_status?: string;
  gender?: string;
  marital_status?: string;
  father_name?: string;
  spouse_name?: string;
  occupation_type?: string;
  aadhaar_number?: string;
  country_of_birth?: string;
  place_of_birth?: string;
  income_slab?: string;
  pep_details?: string;
  citizenship_countries?: string[];
  nationality_country?: string;
  tax_residency_other_than_india?: boolean;
  non_indian_tax_residency_1?: FpNonIndianTaxResidency;
  non_indian_tax_residency_2?: FpNonIndianTaxResidency;
  non_indian_tax_residency_3?: FpNonIndianTaxResidency;
  /**
   * `geolocation`, not `geo_location`. FP rejects the whole body with a bare
   * "Invalid JSON payload" for an unknown key, so the wrong spelling failed
   * every PATCH that carried it and named no field.
   */
  geolocation?: { latitude: number; longitude: number };
}

/**
 * Start a KYC form.
 *
 * Returns immediately in `under_review`; eligibility is decided asynchronously,
 * so poll `fetchKycForm` before asking the investor for anything.
 */
export async function createKycForm(
  payload: CreateKycFormPayload,
  requestId?: string,
): Promise<FpKycForm> {
  return fpRequest<FpKycForm>({
    method: "POST",
    path: "/poa/kyc_forms",
    body: payload,
    realm: "preverify",
    retry: false,
    ...(requestId && { requestId }),
  });
}

/** Fill in the fields named by `requirements.fields_needed`. */
export async function updateKycForm(
  payload: UpdateKycFormPayload,
  requestId?: string,
): Promise<FpKycForm> {
  return fpRequest<FpKycForm>({
    method: "PATCH",
    path: "/poa/kyc_forms",
    body: payload,
    realm: "preverify",
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchKycForm(id: string, requestId?: string): Promise<FpKycForm> {
  return fpRequest<FpKycForm>({
    method: "GET",
    path: `/poa/kyc_forms/${id}`,
    realm: "preverify",
    ...(requestId && { requestId }),
  });
}

/**
 * Upload the investor's signature. png, jpg, jpeg or pdf, up to 5MB.
 *
 * Multipart, so the transport passes the FormData through untouched.
 */
export async function uploadSignature(
  id: string,
  file: Blob,
  filename: string,
  requestId?: string,
): Promise<FpKycForm> {
  const form = new FormData();
  form.append("file", file, filename);
  return fpRequest<FpKycForm>({
    method: "POST",
    path: `/poa/kyc_forms/${id}/signature`,
    body: form,
    realm: "preverify",
    retry: false,
    ...(requestId && { requestId }),
  });
}

/**
 * Issue a new DigiLocker link after a failed fetch.
 *
 * Only valid while `proof_details.status` is "failed".
 */
export async function retryProofDetailsFetch(
  id: string,
  requestId?: string,
): Promise<FpKycForm> {
  return fpRequest<FpKycForm>({
    method: "POST",
    path: `/poa/kyc_forms/${id}/retry_proof_details_fetch`,
    realm: "preverify",
    retry: false,
    ...(requestId && { requestId }),
  });
}

// ---------------------------------------------------------------------------
// Lookups (same partner token)
// ---------------------------------------------------------------------------

/**
 * Consent block the lookup APIs require.
 *
 * `mode` must be exactly "checkbox" — anything else is rejected with
 * *"Consent mode must be 'checkbox'"*.
 */
export interface LookupConsent {
  collected_at: string;
  text: string;
  mode: "checkbox";
  ip_address: string;
}

export interface FpBankAccountLookup {
  object: "bank_account_lookup";
  id: string;
  source_ref_id: string | null;
  phone_number: string;
  // The current API examples return `success`; older responses and the
  // attribute table say `successful`. Accept both at this boundary.
  status: "pending" | "success" | "successful" | "failed";
  data: {
    account_holder_name: string | null;
    account_number: string | null;
    ifsc_code: string | null;
    type: string | null;
  } | null;
  created_at: string;
  successful_at: string | null;
  failed_at: string | null;
}

/**
 * Find the bank account behind an investor's UPI number, so onboarding can
 * prefill it instead of asking them to type an account number.
 *
 * Asynchronous: comes back `pending`, then poll.
 */
export async function createBankAccountLookup(
  payload: { phone_number: string; consent: LookupConsent; source_ref_id?: string },
  requestId?: string,
): Promise<FpBankAccountLookup> {
  return fpRequest<FpBankAccountLookup>({
    method: "POST",
    path: "/v2/bank_account_lookups",
    body: payload,
    realm: "preverify",
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchBankAccountLookup(
  id: string,
  requestId?: string,
): Promise<FpBankAccountLookup> {
  return fpRequest<FpBankAccountLookup>({
    method: "GET",
    path: `/v2/bank_account_lookups/${id}`,
    realm: "preverify",
    ...(requestId && { requestId }),
  });
}

/** Terminal states — stop polling. */
export function isSettled(form: FpKycForm): boolean {
  return form.status !== "under_review";
}

/** The investor has to do something: DigiLocker, signature, or esign. */
export function nextInvestorAction(form: FpKycForm): "proof" | "signature" | "esign" | null {
  if (form.status === "created") {
    if (form.proof_details?.status !== "fetched") return "proof";
    if (!form.signature_provided) return "signature";
    return null;
  }
  if (form.status === "awaiting_esign") return "esign";
  return null;
}
