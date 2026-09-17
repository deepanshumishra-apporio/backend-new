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

export function isVerified(bav: FpBankAccountVerification): boolean {
  return (
    bav.status === "completed" &&
    (bav.confidence === "very_high" || bav.confidence === "high")
  );
}
