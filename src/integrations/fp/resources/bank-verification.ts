// Bank account verification (BAV) — does this account exist, and does it belong
// to this investor?
//
// Not optional on the cybrillapoa gateway. An order whose payout account has
// not been verified is submitted, then fails with
// `payout_account_verification_pending` — after the payment has already been
// taken. So verification belongs in onboarding, before the first order, not as
// a reaction to a failed one.
//
// Asynchronous: a create comes back `pending` and settles a moment later.
//
// Sandbox simulation: an account number matching `31XX` fails; anything else
// succeeds.
import { fpList, fpRequest } from "../fp.http.ts";

export type BavStatus = "pending" | "completed" | "failed";

/** How sure FP is that the account belongs to this investor. */
export type BavConfidence = "very_high" | "high" | "uncertain" | "low" | "very_low" | "zero";

export interface FpBankAccountVerification {
  object: "bank_account_verification";
  id: string;
  bank_account: string;
  status: BavStatus;
  /** Null until the verification completes. */
  confidence: BavConfidence | null;
  /** digital_verification, expiry, digital_verification_failure. */
  reason: string | null;
  created_at: string;
  updated_at: string | null;
  failed_at: string | null;
  completed_at: string | null;
}

export async function createBankAccountVerification(
  bankAccountFpId: string,
  requestId?: string,
): Promise<FpBankAccountVerification> {
  return fpRequest<FpBankAccountVerification>({
    method: "POST",
    path: "/v2/bank_account_verifications",
    body: { bank_account: bankAccountFpId },
    // A penny-drop costs money and is not idempotent at FP.
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchBankAccountVerification(
  id: string,
  requestId?: string,
): Promise<FpBankAccountVerification> {
  return fpRequest<FpBankAccountVerification>({
    method: "GET",
    path: `/v2/bank_account_verifications/${id}`,
    ...(requestId && { requestId }),
  });
}

export async function listBankAccountVerifications(
  query: { bank_accounts?: string; status?: string; confidence?: string },
  requestId?: string,
): Promise<FpBankAccountVerification[]> {
  return fpList<FpBankAccountVerification>("/v2/bank_account_verifications", query, requestId);
}

/**
 * Is this account good enough to transact against?
 *
 * Completion alone is not enough — a completed verification can still come back
 * `low` or `zero`, meaning the account probably is not the investor's. Only
 * high confidence is treated as verified.
 */
export function isVerified(bav: FpBankAccountVerification): boolean {
  return (
    bav.status === "completed" &&
    (bav.confidence === "very_high" || bav.confidence === "high")
  );
}
