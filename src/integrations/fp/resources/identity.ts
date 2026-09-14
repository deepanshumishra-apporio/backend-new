// KYC checks, digital KYC requests, esigns, identity documents and files.
import { fpList, fpRequest } from "../fp.http.ts";
import type {
  FpEsign,
  FpFile,
  FpIdentityDocument,
  FpKycCheck,
  FpKycRequest,
  FpNonIndianTaxResidency,
} from "../fp.types.ts";

// ---------------------------------------------------------------------------
// KYC checks — note the v1 /api/kyc prefix, not /v2
// ---------------------------------------------------------------------------

export interface CreateKycCheckPayload {
  pan: string;
  /**
   * Supplying a date of birth switches FP from a bare status check to a full
   * KRA data fetch, which returns the investor's demographics for prefill.
   * That variant needs an RIA/AMC licence — ARN-only distributors get a status
   * check regardless.
   */
  date_of_birth?: string;
}

export async function createKycCheck(
  payload: CreateKycCheckPayload,
  requestId?: string,
): Promise<FpKycCheck> {
  return fpRequest<FpKycCheck>({
    method: "POST",
    path: "/api/kyc/check",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function fetchKycCheck(id: string, requestId?: string): Promise<FpKycCheck> {
  return fpRequest<FpKycCheck>({
    method: "GET",
    path: `/api/kyc/${id}`,
    ...(requestId && { requestId }),
  });
}

/** Force a re-read from the KRAs, bypassing FP's cache of the last answer. */
export async function refetchKycCheck(id: string, requestId?: string): Promise<FpKycCheck> {
  return fpRequest<FpKycCheck>({
    method: "PUT",
    path: `/api/kyc/${id}/refetch`,
    ...(requestId && { requestId }),
  });
}

// ---------------------------------------------------------------------------
// KYC requests
// ---------------------------------------------------------------------------

export interface CreateKycRequestPayload {
  name: string;
  pan: string;
  date_of_birth: string;
  email: string;
  mobile: { isd: string; number: string };
  /** Last 4 digits only — FP accepts nothing more. */
  aadhaar_number?: string;
  father_name?: string;
  mother_name?: string;
  spouse_name?: string;
  gender?: string;
  marital_status?: string;
  residential_status?: string;
  occupation_type?: string;
  citizenship_countries?: string[];
  nationality_country?: string;
  country_of_birth?: string;
  place_of_birth?: string;
  income_slab?: string;
  pep_details?: string;
  tax_residency_other_than_india?: boolean;
  non_indian_tax_residency_1?: FpNonIndianTaxResidency;
  non_indian_tax_residency_2?: FpNonIndianTaxResidency;
  non_indian_tax_residency_3?: FpNonIndianTaxResidency;
  signature?: string;
  identity_proof?: string;
  address?: { proof: string; proof_type: string };
  geolocation?: { latitude: number; longitude: number };
}

export async function createKycRequest(
  payload: CreateKycRequestPayload,
  requestId?: string,
): Promise<FpKycRequest> {
  return fpRequest<FpKycRequest>({
    method: "POST",
    path: "/v2/kyc_requests",
    body: payload,
    ...(requestId && { requestId }),
  });
}

/**
 * Fill in the fields FP is still asking for.
 *
 * Drive this off `requirements.fields_needed` on the request rather than a
 * hardcoded list — FP changes what it asks for, and the request only reaches
 * `esign_required` once that array is empty.
 */
export async function updateKycRequest(
  payload: Partial<CreateKycRequestPayload> & { id: string },
  requestId?: string,
): Promise<FpKycRequest> {
  return fpRequest<FpKycRequest>({
    method: "PATCH",
    path: "/v2/kyc_requests",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function fetchKycRequest(id: string, requestId?: string): Promise<FpKycRequest> {
  return fpRequest<FpKycRequest>({
    method: "GET",
    path: `/v2/kyc_requests/${id}`,
    ...(requestId && { requestId }),
  });
}

export async function listKycRequests(
  query: { pan?: string; status?: string },
  requestId?: string,
): Promise<FpKycRequest[]> {
  return fpList<FpKycRequest>("/v2/kyc_requests", query, requestId);
}

/** Sandbox only: push a KYC request to a terminal status without a real KRA. */
export async function simulateKycRequest(
  id: string,
  status: string,
  requestId?: string,
): Promise<FpKycRequest> {
  return fpRequest<FpKycRequest>({
    method: "POST",
    path: `/v2/kyc_requests/${id}/simulate`,
    body: { status },
    ...(requestId && { requestId }),
  });
}

// ---------------------------------------------------------------------------
// Identity documents (DigiLocker) and esigns
// ---------------------------------------------------------------------------

export async function createIdentityDocument(
  payload: { kyc_request: string; type: string; postback_url: string },
  requestId?: string,
): Promise<FpIdentityDocument> {
  return fpRequest<FpIdentityDocument>({
    method: "POST",
    path: "/v2/identity_documents",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function fetchIdentityDocument(
  id: string,
  requestId?: string,
): Promise<FpIdentityDocument> {
  return fpRequest<FpIdentityDocument>({
    method: "GET",
    path: `/v2/identity_documents/${id}`,
    ...(requestId && { requestId }),
  });
}

/**
 * Start an esign. The investor completes it at `redirect_url`, after which FP
 * submits the KYC application itself.
 *
 * Several esigns may exist for one request: the link can be reused, but a fresh
 * esign is the safe answer to an abandoned attempt.
 */
export async function createEsign(
  payload: { kyc_request: string; postback_url: string },
  requestId?: string,
): Promise<FpEsign> {
  return fpRequest<FpEsign>({
    method: "POST",
    path: "/v2/esigns",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function fetchEsign(id: string, requestId?: string): Promise<FpEsign> {
  return fpRequest<FpEsign>({
    method: "GET",
    path: `/v2/esigns/${id}`,
    ...(requestId && { requestId }),
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Upload a file (signature, cancelled cheque, proof).
 *
 * multipart/form-data, so this bypasses the JSON helper and builds its own
 * request — but still through fpRequest, to inherit auth, retry and logging.
 * FP caps uploads at 10MB and accepts jpg, jpeg, png, mp4, webm, pdf and tiff.
 */
export async function uploadFile(
  file: Blob,
  filename: string,
  purpose?: string,
  requestId?: string,
): Promise<FpFile> {
  const form = new FormData();
  form.append("file", file, filename);
  if (purpose) form.append("purpose", purpose);

  return fpRequest<FpFile>({
    method: "POST",
    path: "/files",
    body: form,
    ...(requestId && { requestId }),
  });
}

export async function fetchFile(id: string, requestId?: string): Promise<FpFile> {
  return fpRequest<FpFile>({
    method: "GET",
    path: `/files/${id}`,
    ...(requestId && { requestId }),
  });
}
