// Transaction plans: SIP (purchase), SWP (redemption) and STP (switch).
//
// `systematic` decides what the plan actually is. True registers it with the
// RTA as a real SIP/SWP/STP and installments are validated against the scheme's
// SIP/SWP/STP thresholds. False makes FP generate ordinary lumpsum orders on a
// schedule, validated against the lumpsum thresholds, and each installment then
// needs its own 2FA consent.
//
// Like orders, plan creation is not idempotent — pass a `source_ref_id`.
import { fpList, fpRequest } from "../fp.http.ts";
import type { FpConsent, FpPurchasePlan, FpRedemptionPlan, FpSwitchPlan } from "../fp.types.ts";

interface PlanContext {
  source_ref_id: string;
  user_ip: string;
  server_ip?: string;
  euin?: string;
  partner?: string;
  gateway?: string;
  initiated_by?: string;
  initiated_via?: string;
  consent?: FpConsent;
}

interface PlanSchedule {
  frequency: string;
  /** Null/absent for DAILY. 1-5 for weekly cadences, 1-28 for monthly and up. */
  installment_day?: number;
  number_of_installments: number;
  /** Delay activation to a future date. RTA route only. */
  activate_after?: string;
  /** Let FP generate the installments. Almost always what you want. */
  auto_generate_installments?: boolean;
}

// ---------------------------------------------------------------------------
// Purchase plans (SIP)
// ---------------------------------------------------------------------------

export interface CreatePurchasePlanPayload extends PlanContext, PlanSchedule {
  mf_investment_account: string;
  scheme: string;
  amount: number;
  systematic: boolean;
  folio_number?: string;
  /** "mandate" is the only supported method. */
  payment_method?: string;
  /** The mandate's numeric id, as a string. */
  payment_source?: string;
  purpose?: string;
  /**
   * Generate the first installment immediately instead of waiting out the
   * minimum gap. Purchase plans only, and FP creates no payment for that
   * installment even when the mandate is approved — collect it yourself.
   */
  generate_first_installment_now?: boolean;
}

export async function createPurchasePlan(
  payload: CreatePurchasePlanPayload,
  requestId?: string,
): Promise<FpPurchasePlan> {
  return fpRequest<FpPurchasePlan>({
    method: "POST",
    path: "/v2/mf_purchase_plans",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function updatePurchasePlan(
  payload: {
    id: string;
    state?: string;
    consent?: FpConsent;
    payment_method?: string;
    payment_source?: string;
  },
  requestId?: string,
): Promise<FpPurchasePlan> {
  return fpRequest<FpPurchasePlan>({
    method: "PATCH",
    path: "/v2/mf_purchase_plans",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchPurchasePlan(id: string, requestId?: string): Promise<FpPurchasePlan> {
  return fpRequest<FpPurchasePlan>({
    method: "GET",
    path: `/v2/mf_purchase_plans/${id}`,
    ...(requestId && { requestId }),
  });
}

export async function listPurchasePlans(
  query: { mf_investment_account?: string; states?: string },
  requestId?: string,
): Promise<FpPurchasePlan[]> {
  return fpList<FpPurchasePlan>("/v2/mf_purchase_plans", query, requestId);
}

/**
 * Cancel a plan.
 *
 * Installments already generated are unaffected; no further ones are created,
 * and a cancelled plan can never be modified or reactivated.
 * `cancellation_reason` is accepted only when the code is "custom_reason".
 */
export async function cancelPurchasePlan(
  payload: { id: string; cancellation_code: string; cancellation_reason?: string },
  requestId?: string,
): Promise<FpPurchasePlan> {
  return fpRequest<FpPurchasePlan>({
    method: "POST",
    path: "/v2/mf_purchase_plans/cancel",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

/** Sandbox only: generate the next installment now instead of on its due date. */
export async function generatePurchaseInstallment(
  plan: string,
  requestId?: string,
): Promise<{ id: string }> {
  return fpRequest<{ id: string }>({
    method: "POST",
    path: "/v2/mf_purchases",
    body: { plan },
    retry: false,
    ...(requestId && { requestId }),
  });
}

// ---------------------------------------------------------------------------
// Redemption plans (SWP)
// ---------------------------------------------------------------------------

export interface CreateRedemptionPlanPayload extends PlanContext, PlanSchedule {
  mf_investment_account: string;
  scheme: string;
  folio_number: string;
  /** Per-installment amount or units — one of the two. */
  amount?: number;
  units?: number;
  systematic: boolean;
}

export async function createRedemptionPlan(
  payload: CreateRedemptionPlanPayload,
  requestId?: string,
): Promise<FpRedemptionPlan> {
  return fpRequest<FpRedemptionPlan>({
    method: "POST",
    path: "/v2/mf_redemption_plans",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchRedemptionPlan(
  id: string,
  requestId?: string,
): Promise<FpRedemptionPlan> {
  return fpRequest<FpRedemptionPlan>({
    method: "GET",
    path: `/v2/mf_redemption_plans/${id}`,
    ...(requestId && { requestId }),
  });
}

export async function updateRedemptionPlan(payload: { id: string; state: "confirmed"; consent: FpConsent }): Promise<FpRedemptionPlan> {
  return fpRequest({ method: "PATCH", path: "/v2/mf_redemption_plans", body: payload, retry: false });
}

export async function listRedemptionPlans(
  query: { mf_investment_account?: string; states?: string },
  requestId?: string,
): Promise<FpRedemptionPlan[]> {
  return fpList<FpRedemptionPlan>("/v2/mf_redemption_plans", query, requestId);
}

export async function cancelRedemptionPlan(
  id: string,
  payload: { cancellation_code: string; cancellation_reason?: string },
  requestId?: string,
): Promise<FpRedemptionPlan> {
  return fpRequest<FpRedemptionPlan>({
    method: "POST",
    path: `/v2/mf_redemption_plans/${id}/cancel`,
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

// ---------------------------------------------------------------------------
// Switch plans (STP)
// ---------------------------------------------------------------------------

export interface CreateSwitchPlanPayload extends PlanContext, PlanSchedule {
  mf_investment_account: string;
  switch_out_scheme: string;
  switch_in_scheme: string;
  folio_number: string;
  amount?: number;
  units?: number;
  systematic: boolean;
}

export async function createSwitchPlan(
  payload: CreateSwitchPlanPayload,
  requestId?: string,
): Promise<FpSwitchPlan> {
  return fpRequest<FpSwitchPlan>({
    method: "POST",
    path: "/v2/mf_switch_plans",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchSwitchPlan(id: string, requestId?: string): Promise<FpSwitchPlan> {
  return fpRequest<FpSwitchPlan>({
    method: "GET",
    path: `/v2/mf_switch_plans/${id}`,
    ...(requestId && { requestId }),
  });
}

export async function updateSwitchPlan(payload: { id: string; state: "confirmed"; consent: FpConsent }): Promise<FpSwitchPlan> {
  return fpRequest({ method: "PATCH", path: "/v2/mf_switch_plans", body: payload, retry: false });
}

export async function listSwitchPlans(
  query: { mf_investment_account?: string; states?: string },
  requestId?: string,
): Promise<FpSwitchPlan[]> {
  return fpList<FpSwitchPlan>("/v2/mf_switch_plans", query, requestId);
}

export async function cancelSwitchPlan(
  id: string,
  payload: { cancellation_code: string; cancellation_reason?: string },
  requestId?: string,
): Promise<FpSwitchPlan> {
  return fpRequest<FpSwitchPlan>({
    method: "POST",
    path: `/v2/mf_switch_plans/${id}/cancel`,
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}
