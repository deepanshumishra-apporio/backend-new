// MF purchases, redemptions and switches on the ONDC route, plus payout details.
//
// IDEMPOTENCY — the single most important thing on this file:
//
// FP's order-creation APIs are NOT idempotent. Posting the same body twice
// creates two orders and debits the investor twice. The only protection is
// `source_ref_id`: FP rejects a second create carrying a value it has already
// seen. So every create here REQUIRES one, and the transport layer is told not
// to auto-retry these calls — a retry after a response we never saw would
// otherwise be indistinguishable from a fresh order.
import { fpList, fpRequest } from "../fp.http.ts";
import type {
  FpConsent,
  FpPayoutDetail,
  FpPurchase,
  FpRedemption,
  FpSwitch,
} from "../fp.types.ts";

/** Attribution and provenance fields every order create accepts. */
interface OrderContext {
  /** Our idempotency key. Required — see the file header. */
  source_ref_id: string;
  /** The investor's device IP, in IPv4 form. Reported to the RTA. */
  user_ip: string;
  server_ip?: string;
  euin?: string;
  partner?: string;
  gateway?: string;
  initiated_by?: string;
  initiated_via?: string;
  /** Future-dated submission. */
  scheduled_on?: string;
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

export interface CreatePurchasePayload extends OrderContext {
  mf_investment_account: string;
  /** ISIN. */
  scheme: string;
  amount: number;
  /**
   * Omit to have the AMC open a new folio. Doing so requires that nomination
   * consent was already collected, because the folio is created with the
   * account's folio defaults.
   */
  folio_number?: string;
}

export async function createPurchase(
  payload: CreatePurchasePayload,
  requestId?: string,
): Promise<FpPurchase> {
  return fpRequest<FpPurchase>({
    method: "POST",
    path: "/v2/mf_purchases",
    body: payload,
    // Never auto-retry: see the file header.
    retry: false,
    ...(requestId && { requestId }),
  });
}

/**
 * Attach 2FA consent, or move the order to `confirmed` — never both.
 *
 * On ONDC, FP rejects a body carrying `state` and `consent` together, so the
 * consent PATCH always travels alone. The order only reaches the RTA once
 * confirmed, and only confirms once a payment stands behind it.
 */
export async function updatePurchase(
  payload: { id: string; state?: "confirmed"; consent?: FpConsent },
  requestId?: string,
): Promise<FpPurchase> {
  return fpRequest<FpPurchase>({
    method: "PATCH",
    path: "/v2/mf_purchases",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchPurchase(id: string, requestId?: string): Promise<FpPurchase> {
  return fpRequest<FpPurchase>({
    method: "GET",
    path: `/v2/mf_purchases/${id}`,
    ...(requestId && { requestId }),
  });
}

export async function listPurchases(
  query: { mf_investment_account?: string; plan?: string; states?: string },
  requestId?: string,
): Promise<FpPurchase[]> {
  return fpList<FpPurchase>("/v2/mf_purchases", query, requestId);
}

/**
 * Reopen a failed purchase for another payment attempt.
 *
 * Only valid when the failure was `payment_failure` inside the expiry window,
 * or `order_expiry` on an order that is not a plan installment. The order goes
 * back to `pending`.
 *
 * **Unreachable on this platform.** FP documents retry as "an upcoming facility
 * for ondc gateway purchases … not available in sandbox or production yet", and
 * we run exclusively on ONDC. Calling it answers
 * `400 "Order is not eligible for retry"` whatever the failure code, so
 * `order.service.ts` refuses before we get here. Kept wired for the day it
 * ships.
 */
export async function retryPurchase(id: string, requestId?: string): Promise<FpPurchase> {
  return fpRequest<FpPurchase>({
    method: "POST",
    path: `/v2/mf_purchases/${id}/retry`,
    retry: false,
    ...(requestId && { requestId }),
  });
}

/**
 * Withdraw a pending purchase.
 *
 * Works on ONDC — verified against the sandbox, a consented `pending` order
 * goes straight to `cancelled`. Only while no payment is in progress, and only
 * while the order is still pending: once confirmed it is with the AMC.
 */
export async function cancelPurchase(id: string, requestId?: string): Promise<FpPurchase> {
  return fpRequest<FpPurchase>({
    method: "POST",
    path: `/v2/mf_purchases/${id}/cancel`,
    retry: false,
    ...(requestId && { requestId }),
  });
}

// ---------------------------------------------------------------------------
// Redemptions
// ---------------------------------------------------------------------------

export interface CreateRedemptionPayload extends OrderContext {
  mf_investment_account: string;
  scheme: string;
  folio_number: string;
  /**
   * Give an amount, or units, or neither. Neither means redeem the entire
   * holding — which is a real instruction, not a missing field.
   */
  amount?: number;
  units?: number;
  redemption_mode?: string;
}

export async function createRedemption(
  payload: CreateRedemptionPayload,
  requestId?: string,
): Promise<FpRedemption> {
  return fpRequest<FpRedemption>({
    method: "POST",
    path: "/v2/mf_redemptions",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function updateRedemption(
  payload: { id: string; state?: "confirmed"; consent?: FpConsent },
  requestId?: string,
): Promise<FpRedemption> {
  return fpRequest<FpRedemption>({
    method: "PATCH",
    path: "/v2/mf_redemptions",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchRedemption(id: string, requestId?: string): Promise<FpRedemption> {
  return fpRequest<FpRedemption>({
    method: "GET",
    path: `/v2/mf_redemptions/${id}`,
    ...(requestId && { requestId }),
  });
}

export async function listRedemptions(
  query: { mf_investment_account?: string; plan?: string; states?: string },
  requestId?: string,
): Promise<FpRedemption[]> {
  return fpList<FpRedemption>("/v2/mf_redemptions", query, requestId);
}

// ---------------------------------------------------------------------------
// Switches
// ---------------------------------------------------------------------------

export interface CreateSwitchPayload extends OrderContext {
  mf_investment_account: string;
  switch_out_scheme: string;
  switch_in_scheme: string;
  folio_number: string;
  amount?: number;
  units?: number;
}

export async function createSwitch(
  payload: CreateSwitchPayload,
  requestId?: string,
): Promise<FpSwitch> {
  return fpRequest<FpSwitch>({
    method: "POST",
    path: "/v2/mf_switches",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function updateSwitch(
  payload: { id: string; state?: "confirmed"; consent?: FpConsent },
  requestId?: string,
): Promise<FpSwitch> {
  return fpRequest<FpSwitch>({
    method: "PATCH",
    path: "/v2/mf_switches",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchSwitch(id: string, requestId?: string): Promise<FpSwitch> {
  return fpRequest<FpSwitch>({
    method: "GET",
    path: `/v2/mf_switches/${id}`,
    ...(requestId && { requestId }),
  });
}

export async function listSwitches(
  query: { mf_investment_account?: string; plan?: string; states?: string },
  requestId?: string,
): Promise<FpSwitch[]> {
  return fpList<FpSwitch>("/v2/mf_switches", query, requestId);
}

// ---------------------------------------------------------------------------
// Payout
// ---------------------------------------------------------------------------
//
// There is no settlement counterpart here on purpose. `/v2/mf_settlement_details`
// reports money collected outside FP, which is an RTA-route idea: ONDC always
// collects through FP's own Payments API. The transport refuses to write to that
// path at all, so the wrapper would be unreachable as well as wrong.

/** Only ever populated for successful instant-redemption payouts. */
export async function listPayoutDetails(
  mfRedemption: string,
  requestId?: string,
): Promise<FpPayoutDetail[]> {
  return fpList<FpPayoutDetail>(
    "/v2/mf_payout_details",
    { mf_redemption: mfRedemption },
    requestId,
  );
}
