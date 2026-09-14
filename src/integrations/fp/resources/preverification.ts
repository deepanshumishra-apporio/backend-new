// Pre-verification: is this investor ready to transact?
//
// Checks a PAN (including whether it is Aadhaar-linked), the name and date of
// birth against it, and optionally a bank account via penny-drop. On the
// sandbox tenant we hold, this is the KYC-readiness surface that actually
// works — `/api/kyc/check` and `/v2/kyc_requests` are not provisioned there.
//
// Different tenant, different client, different host: every call here passes
// realm "preverify" so the transport picks the right credentials and drops the
// `x-tenant-id` header, which this service rejects.
//
// Asynchronous by design. A create returns immediately with `status:
// "accepted"` and the per-field verdicts land later, so the flow is: create,
// store the id, then react to the result — poll it, or re-fetch when the
// investor returns.
import { fpRequest } from "../fp.http.ts";

/** Verdict on one checked field. */
export interface FpVerificationResult<T> {
  /** "verified", "failed", or null while the check is still running. */
  status: string | null;
  /** Machine-readable cause on failure, e.g. "aadhaar_not_linked". */
  code: string | null;
  reason: string | null;
  value: T;
}

export interface FpPreVerifyBankAccountValue {
  account_number: string;
  ifsc_code: string;
  /** savings, current, nre_savings or nro_savings. */
  account_type: string;
  bank_account_proof: string | null;
}

export interface FpPreVerification {
  object: "pre_verification";
  id: string;
  /** Acceptance of the REQUEST, not the verdict — read `readiness` for that. */
  status: string;
  investor_identifier: string | null;
  /**
   * The overall answer: can this investor transact? It can be "verified" even
   * when an individual field failed, so gate on this rather than on `pan`.
   */
  readiness: {
    status: string | null;
    code: string | null;
    reason: string | null;
    /**
     * Shape varies by record: null, a string, or a `{status, requested_at}`
     * object. Declared `unknown` so nothing downstream can assume otherwise —
     * `fpFlatText` normalises it.
     */
    modification: unknown;
  };
  name: FpVerificationResult<string> | null;
  pan: FpVerificationResult<string> | null;
  date_of_birth: FpVerificationResult<string> | null;
  bank_accounts: FpVerificationResult<FpPreVerifyBankAccountValue>[] | null;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
}

export interface CreatePreVerificationPayload {
  /** PAN, used to tie the checks together. */
  investor_identifier?: string;
  pan?: { value: string };
  name?: { value: string };
  date_of_birth?: { value: string };
  bank_accounts?: {
    value: {
      account_number: string;
      ifsc_code: string;
      account_type: string;
      bank_account_proof?: string;
    };
    /** Fall back to a manual check when the penny-drop is inconclusive. */
    verify_manually_if_required?: boolean;
  }[];
}

export async function createPreVerification(
  payload: CreatePreVerificationPayload,
  requestId?: string,
): Promise<FpPreVerification> {
  return fpRequest<FpPreVerification>({
    method: "POST",
    path: "/poa/pre_verifications",
    body: payload,
    realm: "preverify",
    // Creating twice costs a duplicate penny-drop, so never retry blind.
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchPreVerification(
  id: string,
  requestId?: string,
): Promise<FpPreVerification> {
  return fpRequest<FpPreVerification>({
    method: "GET",
    path: `/poa/pre_verifications/${id}`,
    realm: "preverify",
    ...(requestId && { requestId }),
  });
}

/** The investor cleared every check that matters and can transact. */
export function isReady(preVerification: FpPreVerification): boolean {
  return preVerification.readiness.status === "verified";
}

/** Still running — no verdict yet on the overall readiness. */
export function isPending(preVerification: FpPreVerification): boolean {
  return preVerification.readiness.status === null;
}
