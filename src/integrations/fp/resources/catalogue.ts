// Scheme catalogue and master data.
//
// This is the v1 surface (/api/oms, /api/onb). Its enums are UPPER CASE where
// the v2 object APIs use lower case, so the sync layer lower-cases on ingest.
import { fpRequest } from "../fp.http.ts";

export interface FpFundScheme {
  fund_scheme_id: number;
  isin: string;
  name: string;
  amc_id: number;
  rta_id: number | null;
  scheme_code: string | null;
  amfi_code: string | null;
  fund_category: string;
  plan_type: string;
  sub_category: string | null;
  investment_option: string;
  delivery_mode: string | null;
  active: boolean;
  close_ended: boolean;
  lock_in: boolean;
  lock_in_period: number | null;
  long_term_period: number | null;
  purchase_allowed: boolean;
  redemption_allowed: boolean;
  insta_redemption_allowed: boolean;
  switch_in_allowed: boolean;
  switch_out_allowed: boolean;
  sip_allowed: boolean;
  swp_allowed: boolean;
  stp_in_allowed: boolean;
  stp_out_allowed: boolean;
  min_initial_investment: number | null;
  max_initial_investment: number | null;
  initial_investment_multiples: number | null;
  min_additional_investment: number | null;
  max_additional_investment: number | null;
  additional_investment_multiples: number | null;
  min_withdrawal_amount: number | null;
  max_withdrawal_amount: number | null;
  withdrawal_multiples: number | null;
  min_withdrawal_units: number | null;
  max_withdrawal_units: number | null;
  withdrawal_multiples_units: number | null;
  min_instant_withdrawal_amount: number | null;
  instant_withdrawal_multiples: number | null;
  min_switch_in_amount: number | null;
  max_switch_in_amount: number | null;
  switch_in_amount_multiples: number | null;
  min_switch_out_amount: number | null;
  max_switch_out_amount: number | null;
  switch_out_amount_multiples: number | null;
  min_switch_out_units: number | null;
  max_switch_out_units: number | null;
  switch_out_unit_multiples: number | null;
  merged: boolean;
  merged_to_isin: string | null;
  merger_date: string | null;
  /** Keyed by frequency. Empty on schemes with no per-cadence limits. */
  sip_frequency_specific_data: Record<string, FpFrequencyLimits> | null;
  swp_frequency_specific_data: Record<string, FpFrequencyLimits> | null;
  stp_frequency_specific_data: Record<string, FpFrequencyLimits> | null;
}

export interface FpFrequencyLimits {
  dates: number[] | string | null;
  min_installment_amount: number | null;
  max_installment_amount: number | null;
  amount_multiples: number | null;
  min_installments: number | null;
}

export async function fetchFundScheme(isin: string, requestId?: string): Promise<FpFundScheme> {
  return fpRequest<FpFundScheme>({
    method: "GET",
    path: `/api/oms/fund_schemes/${isin}`,
    ...(requestId && { requestId }),
  });
}

/** Paged, 20 per page by default and 100 at most. */
export async function listFundSchemes(
  query: {
    page?: number;
    size?: number;
    amc_id?: number;
    investment_option?: string;
    plan_type?: string;
    delivery_mode?: string;
  },
  requestId?: string,
): Promise<FpFundScheme[]> {
  const response = await fpRequest<FpFundScheme[] | { fund_schemes?: FpFundScheme[] }>({
    method: "GET",
    path: "/api/oms/fund_schemes",
    query,
    ...(requestId && { requestId }),
  });
  if (Array.isArray(response)) return response;
  return response?.fund_schemes ?? [];
}

export interface FpAmc {
  /** This endpoint returns `amc_id`, not `id` as the reference implies. */
  amc_id: number;
  name: string;
  amc_code: string | null;
  active: boolean;
}

export async function listAmcs(requestId?: string): Promise<FpAmc[]> {
  const response = await fpRequest<{ amcs?: FpAmc[] }>({
    method: "GET",
    path: "/api/oms/amcs",
    ...(requestId && { requestId }),
  });
  return response?.amcs ?? [];
}

// ---------------------------------------------------------------------------
// Master data used during onboarding
// ---------------------------------------------------------------------------

export interface FpPincode {
  code: string;
  city: string | null;
  district: string | null;
  state_name: string | null;
  country_ansi_code: string | null;
}

/** Powers city/state autofill on the address form. */
export async function fetchPincode(pincode: string, requestId?: string): Promise<FpPincode> {
  return fpRequest<FpPincode>({
    method: "GET",
    path: `/api/onb/pincodes/${pincode}`,
    ...(requestId && { requestId }),
  });
}

export interface FpIfsc {
  ifsc_code: string;
  micr_code: string | null;
  branch_name: string | null;
  branch_address: string | null;
  bank_name: string | null;
  contact: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
}

/** Confirms a branch before the investor commits to a bank account. */
export async function fetchIfsc(ifsc: string, requestId?: string): Promise<FpIfsc> {
  return fpRequest<FpIfsc>({
    method: "GET",
    path: `/api/onb/ifsc_codes/${ifsc}`,
    ...(requestId && { requestId }),
  });
}
