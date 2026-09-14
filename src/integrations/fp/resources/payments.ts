// Mandates and payments.
//
// These live behind FP's older /api/pg gateway, which differs from the v2 APIs
// in two ways that bite:
//   1. Everything is addressed by INTEGER id — a bank account's `old_id`, a
//      purchase's `old_id`. Passing a `bac_…` or `mfp_…` string fails.
//   2. Enum values are upper case (APPROVED, NETBANKING, E_MANDATE).
//   3. The two halves of it do not agree on what the ONDC gateway is called —
//      see ONDC_MANDATE_PROVIDER / ONDC_PAYMENT_PROVIDER below.
import { fpRequest } from "../fp.http.ts";
import type {
  FpMandate,
  FpMandateAuth,
  FpMandateCreated,
  FpPage,
  FpPayment,
  FpPaymentCreated,
} from "../fp.types.ts";

/**
 * What to call the ONDC gateway on this API. It is not one name.
 *
 * Both verified against the sandbox by making FP reject the alternative:
 *
 *   POST /api/pg/mandates        provider_name "CYBRILLAPOA"
 *                                "ONDC" → *Unexpected value: ONDC*
 *   POST /api/pg/payments/*      provider_name "ONDC"
 *                                "CYBRILLAPOA" → *Should be either RAZORPAY or
 *                                BILLDESK or CAMSPAY or ONDC or IDFC or NCDEX*
 *
 * So the mandate and the payment that debits it carry different provider names
 * for the same gateway. Do not unify them; sending either one to the wrong half
 * is a hard 400. Everything above this layer says CYBRILLAPOA — our name for
 * the gateway — and the translation happens here.
 */
export const ONDC_MANDATE_PROVIDER = "CYBRILLAPOA";
export const ONDC_PAYMENT_PROVIDER = "ONDC";

// ---------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------

export interface CreateMandatePayload {
  /** "E_MANDATE" for NACH, "UPI" for UPI autopay. */
  mandate_type: string;
  /** The bank account's NUMERIC id (`old_id`), not its `bac_…` string. */
  bank_account_id: number;
  /**
   * Per-debit ceiling. E_MANDATE caps at ₹1 Cr. UPI autopay caps at ₹1 Lakh,
   * with a floor of ₹10 on Razorpay and ₹1 on Billdesk — and Razorpay's limit
   * is per transaction where Billdesk's is per day.
   */
  mandate_limit: number;
  provider_name?: string;
  valid_from?: string;
  /** Defaults to valid_from + 30 years, which is also the ceiling. */
  valid_to?: string;
}

export async function createMandate(
  payload: CreateMandatePayload,
  requestId?: string,
): Promise<FpMandateCreated> {
  return fpRequest<FpMandateCreated>({
    method: "POST",
    path: "/api/pg/mandates",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

/**
 * Start mandate authorisation and get the URL the investor must complete.
 *
 * Several authorisations can run against one mandate while it is still in
 * CREATED, so an abandoned attempt is recoverable — ask for a new URL.
 */
export async function authorizeMandate(
  payload: { mandate_id: number; payment_postback_url?: string },
  requestId?: string,
): Promise<FpMandateAuth> {
  return fpRequest<FpMandateAuth>({
    method: "POST",
    path: "/api/pg/payments/emandate/auth",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchMandate(id: number, requestId?: string): Promise<FpMandate> {
  return fpRequest<FpMandate>({
    method: "GET",
    path: `/api/pg/mandates/${id}`,
    ...(requestId && { requestId }),
  });
}

export async function listMandates(
  query: { bank_account_id?: string; page?: number; size?: number },
  requestId?: string,
): Promise<FpMandate[]> {
  const page = await fpRequest<FpPage<FpMandate>>({
    method: "GET",
    path: "/api/pg/mandates",
    query,
    ...(requestId && { requestId }),
  });
  return page?.mandates ?? [];
}

/**
 * Cancel an APPROVED mandate.
 *
 * Irreversible, and not free of consequences: every SIP still funded by this
 * mandate will have its future payments marked FAILED. Cancel the plans first
 * if that is not what the investor wants.
 */
export async function cancelMandate(id: number, requestId?: string): Promise<FpMandate> {
  return fpRequest<FpMandate>({
    method: "POST",
    path: `/api/pg/mandates/${id}/cancel`,
    retry: false,
    ...(requestId && { requestId }),
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface CreateNetbankingPaymentPayload {
  /** Purchase `old_id`s. Up to 10, all on one investment account. */
  amc_order_ids: number[];
  method?: string;
  payment_postback_url?: string;
  /** Drives third-party verification of the paying account. */
  bank_account_id?: number;
  provider_name?: string;
}

/**
 * Collect payment by netbanking or UPI, returning a URL to redirect to.
 *
 * FP does NOT check whether a payment already exists for these orders, so
 * check before calling — the caller is responsible for not double-charging.
 */
export async function createNetbankingPayment(
  payload: CreateNetbankingPaymentPayload,
  requestId?: string,
): Promise<FpPaymentCreated> {
  return fpRequest<FpPaymentCreated>({
    method: "POST",
    path: "/api/pg/payments/netbanking",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

/**
 * Debit an approved mandate for one or more pending purchases.
 *
 * Every order must be pending and on the same investment account, and the
 * mandate must belong to that account's investor. A mandate that is not
 * APPROVED yields a payment that is immediately FAILED.
 */
export async function createMandatePayment(
  payload: { mandate_id: number; amc_order_ids: number[] },
  requestId?: string,
): Promise<FpPaymentCreated> {
  return fpRequest<FpPaymentCreated>({
    method: "POST",
    path: "/api/pg/payments/nach",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchPayment(id: number, requestId?: string): Promise<FpPayment> {
  return fpRequest<FpPayment>({
    method: "GET",
    path: `/api/pg/payments/${id}`,
    ...(requestId && { requestId }),
  });
}

export async function listPayments(
  query: {
    from?: string;
    to?: string;
    payment_type?: string;
    payment_status?: string;
    amc_order_ids?: string;
    direction?: string;
    page?: number;
    size?: number;
  },
  requestId?: string,
): Promise<FpPayment[]> {
  const page = await fpRequest<FpPage<FpPayment>>({
    method: "GET",
    path: "/api/pg/payments",
    query,
    ...(requestId && { requestId }),
  });
  return page?.payments ?? [];
}
