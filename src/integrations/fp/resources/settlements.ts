// MF settlement details: money collected outside FP.
//
// The right-hand branch of FP's order lifecycle — "Pay for purchases outside
// FP → Create settlement & Confirm order". A settlement tells FP the money is
// already in the AMC's account, so the order can be confirmed without FP having
// run the payment itself.
//
// This is an RTA-route idea and has no ONDC counterpart: ONDC always collects
// through FP's own Payments API. It exists here only so a sandbox order can be
// carried to an allotment, which the ONDC route cannot do at all. The transport
// refuses these writes outside the sandbox.
import { fpRequest } from "../fp.http.ts";
import { fpConfig } from "../fp.config.ts";

export interface CreateSettlementPayload {
  mf_purchase: string;
  payment_type: "netbanking" | "nach" | "neft" | "rtgs";
  bank_account_number: string;
  bank_ifsc: string;
  beneficiary_account_number: string;
  beneficiary_account_title: string;
  beneficiary_bank_name: string;
  utr_number?: string;
  settlement_processed_at?: string;
}

export interface FpSettlementDetail extends CreateSettlementPayload {
  object: "mf_settlement_detail";
  id: string;
}
export async function createSettlementDetail(
  payload: CreateSettlementPayload,
  requestId?: string,
): Promise<FpSettlementDetail> {
  if (!fpConfig().simulationEnabled) {
    throw new Error("Settlement details are a sandbox-only facility on this platform");
  }
  return fpRequest<FpSettlementDetail>({
    method: "POST",
    path: "/v2/mf_settlement_details",
    body: payload,
    // Posting twice would record the money as arriving twice.
    retry: false,
    ...(requestId && { requestId }),
  });
}
