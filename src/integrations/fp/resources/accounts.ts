// MF investment accounts, folios and the holdings report.
import { fpList, fpRequest } from "../fp.http.ts";
import type {
  FpFolio,
  FpFolioDefaults,
  FpHoldingsReport,
  FpInvestmentAccount,
  FpTabularReport,
} from "../fp.types.ts";

export interface CreateInvestmentAccountPayload {
  /** Investor profile id of the first holder. */
  primary_investor: string;
  /** Defaults to "single". FP only accepts "single" on create today. */
  holding_pattern?: string;
  folio_defaults?: Partial<FpFolioDefaults>;
}

export async function createInvestmentAccount(
  payload: CreateInvestmentAccountPayload,
  requestId?: string,
): Promise<FpInvestmentAccount> {
  return fpRequest<FpInvestmentAccount>({
    method: "POST",
    path: "/v2/mf_investment_accounts",
    body: payload,
    ...(requestId && { requestId }),
  });
}

/**
 * Set or change folio defaults, or attach an investor to a migrated account.
 *
 * Folio defaults only work when `primary_investor` holds an investor profile
 * id; accounts created from a legacy investor id ignore them entirely.
 */
export async function updateInvestmentAccount(
  payload: { id: string; primary_investor?: string; folio_defaults?: Partial<FpFolioDefaults> },
  requestId?: string,
): Promise<FpInvestmentAccount> {
  return fpRequest<FpInvestmentAccount>({
    method: "PATCH",
    path: "/v2/mf_investment_accounts",
    body: payload,
    ...(requestId && { requestId }),
  });
}

export async function fetchInvestmentAccount(
  id: string,
  requestId?: string,
): Promise<FpInvestmentAccount> {
  return fpRequest<FpInvestmentAccount>({
    method: "GET",
    path: `/v2/mf_investment_accounts/${id}`,
    ...(requestId && { requestId }),
  });
}

/**
 * Search investment accounts.
 *
 * `investor` matches a PAN in any holder slot, which is how you find accounts
 * created by folio migration before the investor was onboarded. Capped at 100
 * rows, newest first.
 */
export async function listInvestmentAccounts(
  query: {
    primary_investor_pan?: string;
    second_investor_pan?: string;
    third_investor_pan?: string;
    holding_pattern?: string;
    investor?: string;
  },
  requestId?: string,
): Promise<FpInvestmentAccount[]> {
  return fpList<FpInvestmentAccount>("/v2/mf_investment_accounts", query, requestId);
}

// ---------------------------------------------------------------------------
// Folios
// ---------------------------------------------------------------------------

/**
 * Fetch folios.
 *
 * In the sandbox this is simulated: without an `mf_investment_account` in the
 * query you get an empty array, and a folio only appears once an order against
 * it has been driven to `successful`. Capped at 100 rows.
 */
export async function listFolios(
  query: { mf_investment_account?: string; folio_number?: string },
  requestId?: string,
): Promise<FpFolio[]> {
  return fpList<FpFolio>("/v2/mf_folios", query, requestId);
}

// ---------------------------------------------------------------------------
// Holdings and returns
// ---------------------------------------------------------------------------

/**
 * Current holdings for an investment account.
 *
 * Note the `investment_account_id` here is FP's legacy NUMERIC id (`old_id`),
 * not the `mfia_…` string — this endpoint predates the v2 object ids.
 *
 * This report is the only authority on units. Never derive them by summing
 * order rows: allotment happens at the AMC, net of stamp duty.
 */
export async function fetchHoldings(
  query: { investment_account_id?: number; folios?: string; as_on?: string },
  requestId?: string,
): Promise<FpHoldingsReport> {
  return fpRequest<FpHoldingsReport>({
    method: "GET",
    path: "/api/oms/reports/holdings",
    query,
    ...(requestId && { requestId }),
  });
}

export async function fetchSchemeWiseReturns(
  payload: { mf_investment_account: string; traded_on_to?: string },
  requestId?: string,
): Promise<FpTabularReport> {
  return fpRequest<FpTabularReport>({
    method: "POST",
    path: "/v2/transactions/reports/scheme_wise_returns",
    body: payload,
    // A report is a read; retrying one is safe.
    retry: true,
    ...(requestId && { requestId }),
  });
}

export async function fetchAccountReturns(
  payload: { mf_investment_account: string; traded_on_to?: string },
  requestId?: string,
): Promise<FpTabularReport> {
  return fpRequest<FpTabularReport>({
    method: "POST",
    path: "/v2/transactions/reports/investment_account_wise_returns",
    body: payload,
    retry: true,
    ...(requestId && { requestId }),
  });
}

export async function fetchCapitalGains(
  payload: {
    mf_investment_account: string;
    folios?: string[];
    scheme?: string;
    traded_on_from?: string;
    traded_on_to?: string;
  },
  requestId?: string,
): Promise<FpTabularReport> {
  return fpRequest<FpTabularReport>({
    method: "POST",
    path: "/v2/transactions/reports/capital_gains",
    body: payload,
    retry: true,
    ...(requestId && { requestId }),
  });
}

/** Turn FP's column/row matrix into objects keyed by column name. */
export function rowsToObjects(report: FpTabularReport): Record<string, unknown>[] {
  const columns = report.data.columns.map((column) => column.trim());
  return report.data.rows.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null])),
  );
}
