// Folios, holdings and returns.
//
// Everything here is a projection of what FP reports from the RTA feeds. Units
// are never derived from our own order rows: allotment happens at the AMC, net
// of stamp duty, and only the holdings report is authoritative. A purchase for
// ₹5,000 at a NAV of 9.7524 does not allot 512.6943 units because we computed
// it — it allots what the AMC says it allots.
import { Prisma } from "../../generated/prisma/client.ts";
import { MfOrderState } from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import { fpAccounts, fpErrorToHttpError } from "../integrations/fp/index.ts";
import { HttpError } from "../utils/http-error.ts";
import { asAmount, asDate, asNav, asUnits } from "../utils/money.ts";
import { syncFolio, syncHoldings } from "./fp-sync/index.ts";
import type {
  DividendReportDto,
  FolioDto,
  HoldingDto,
  PortfolioSummaryDto,
} from "../types/portfolio.types.ts";

async function requireAccount(id: string) {
  const account = await db.mfInvestmentAccount.findUnique({
    where: { id },
    select: { id: true, fpId: true, fpOldId: true },
  });
  if (!account) throw HttpError.notFound("No such investment account");
  return account;
}

/**
 * Re-read folios and holdings from FP.
 *
 * Folios first, then holdings: a holding row links to its folio, and syncing in
 * the other order would leave the link null until the next run.
 *
 * Worth knowing about the sandbox: the folio endpoint is simulated there and
 * returns nothing unless an investment account is supplied AND an order has
 * been driven to `successful`.
 */
export async function refreshPortfolio(mfInvestmentAccountId: string): Promise<{
  folios: number;
  holdings: number;
}> {
  const account = await requireAccount(mfInvestmentAccountId);

  try {
    const folios = await fpAccounts.listFolios({ mf_investment_account: account.fpId });
    for (const folio of folios) {
      if (folio.number) await syncFolio(folio, account.id);
    }

    // The holdings report predates the v2 ids and takes the numeric one.
    if (account.fpOldId === null) {
      return { folios: folios.length, holdings: 0 };
    }
    const report = await fpAccounts.fetchHoldings({ investment_account_id: account.fpOldId });
    const holdings = await syncHoldings(report, account.id);

    return { folios: folios.length, holdings };
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

const holdingSelect = {
  id: true,
  folioNumber: true,
  schemeIsin: true,
  schemeName: true,
  units: true,
  redeemableUnits: true,
  unitsAsOn: true,
  marketValue: true,
  investedValue: true,
  nav: true,
  navAsOn: true,
  syncedAt: true,
} as const;

type HoldingRow = Prisma.MfHoldingGetPayload<{ select: typeof holdingSelect }>;

/**
 * Unrealised gain and return, computed here rather than stored.
 *
 * Derived values go stale the moment either input changes, so they are
 * calculated on read from the two figures FP gave us.
 */
function toHoldingDto(row: HoldingRow): HoldingDto {
  const market = row.marketValue ? new Prisma.Decimal(row.marketValue) : null;
  const invested = row.investedValue ? new Prisma.Decimal(row.investedValue) : null;
  const gain = market && invested ? market.minus(invested) : null;
  const returnPct =
    gain && invested && invested.greaterThan(0)
      ? gain.dividedBy(invested).times(100).toFixed(2)
      : null;

  return {
    id: row.id,
    folioNumber: row.folioNumber,
    isin: row.schemeIsin,
    schemeName: row.schemeName,
    units: asUnits(row.units) ?? "0.0000",
    redeemableUnits: asUnits(row.redeemableUnits),
    marketValue: asAmount(row.marketValue),
    investedValue: asAmount(row.investedValue),
    unrealisedGain: gain ? gain.toFixed(2) : null,
    absoluteReturnPct: returnPct,
    nav: asNav(row.nav),
    navAsOn: asDate(row.navAsOn),
    asOn: asDate(row.unitsAsOn),
    syncedAt: row.syncedAt.toISOString(),
  };
}

/**
 * The holding a successful purchase landed in: its folio, its scheme.
 *
 * The last step of a lumpsum. An order's own `allottedUnits` is what this one
 * purchase bought; the holding is what the folio now holds in the scheme, from
 * FP's holdings report — the only authoritative figure. Null until the order is
 * `successful`, because nothing before that carries a folio.
 *
 * `applyPurchaseUpdate` pulls holdings on the transition to successful, so the
 * row is normally already here. When that best-effort pull failed, one more is
 * tried now; if FP still has nothing — the report can lag the allotment — the
 * answer is null and the caller asks again later.
 */
export async function getPurchaseHolding(mfPurchaseId: string): Promise<HoldingDto | null> {
  const purchase = await db.mfPurchase.findUnique({
    where: { id: mfPurchaseId },
    select: { state: true, folioNumber: true, schemeIsin: true, mfInvestmentAccountId: true },
  });
  if (!purchase) throw HttpError.notFound("No such purchase");
  const { folioNumber, schemeIsin, mfInvestmentAccountId } = purchase;
  if (purchase.state !== MfOrderState.SUCCESSFUL || !folioNumber) return null;

  const find = () =>
    db.mfHolding.findFirst({
      where: { mfInvestmentAccountId, folioNumber, schemeIsin },
      select: holdingSelect,
    });
  let row = await find();
  if (!row) {
    try {
      await refreshPortfolio(mfInvestmentAccountId);
      row = await find();
    } catch (error) {
      console.warn(
        `[portfolio] holdings pull for purchase ${mfPurchaseId} failed; the next read retries it`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return row ? toHoldingDto(row) : null;
}

export async function listHoldings(mfInvestmentAccountId: string): Promise<HoldingDto[]> {
  const rows = await db.mfHolding.findMany({
    where: { mfInvestmentAccountId },
    select: holdingSelect,
    orderBy: [{ folioNumber: "asc" }, { schemeIsin: "asc" }],
  });
  return rows.map(toHoldingDto);
}

/** Account-level totals, summed from the same projection the list uses. */
export async function getPortfolioSummary(
  mfInvestmentAccountId: string,
): Promise<PortfolioSummaryDto> {
  await requireAccount(mfInvestmentAccountId);

  const rows = await db.mfHolding.findMany({
    where: { mfInvestmentAccountId },
    select: { marketValue: true, investedValue: true, syncedAt: true },
  });

  let market = new Prisma.Decimal(0);
  let invested = new Prisma.Decimal(0);
  let syncedAt: Date | null = null;

  for (const row of rows) {
    if (row.marketValue) market = market.plus(row.marketValue);
    if (row.investedValue) invested = invested.plus(row.investedValue);
    if (!syncedAt || row.syncedAt > syncedAt) syncedAt = row.syncedAt;
  }

  const gain = market.minus(invested);
  return {
    mfInvestmentAccountId,
    schemeCount: rows.length,
    investedValue: invested.toFixed(2),
    marketValue: market.toFixed(2),
    unrealisedGain: gain.toFixed(2),
    absoluteReturnPct: invested.greaterThan(0)
      ? gain.dividedBy(invested).times(100).toFixed(2)
      : null,
    syncedAt: syncedAt?.toISOString() ?? null,
  };
}

export async function listFolios(mfInvestmentAccountId: string): Promise<FolioDto[]> {
  const rows = await db.mfFolio.findMany({
    where: { mfInvestmentAccountId },
    select: {
      id: true,
      number: true,
      amcCode: true,
      holdingPattern: true,
      primaryInvestorName: true,
      emailAddresses: true,
      mobileNumbers: true,
      syncedAt: true,
      _count: { select: { holdings: true } },
    },
    orderBy: { number: "asc" },
  });

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    amcCode: row.amcCode,
    holdingPattern: row.holdingPattern,
    primaryInvestorName: row.primaryInvestorName,
    // These decide where an order's 2FA OTP has to be sent, so the client
    // needs to see them — masked, because a folio can carry someone else's.
    registeredEmail: row.emailAddresses[0] ? maskEmail(row.emailAddresses[0]) : null,
    registeredMobile: row.mobileNumbers[0] ? maskMobile(row.mobileNumbers[0]) : null,
    schemeCount: row._count.holdings,
    syncedAt: row.syncedAt.toISOString(),
  }));
}

/** "tony.soprano@example.com" -> "to***@example.com". */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  return `${local.slice(0, 2)}***@${domain}`;
}

/** "+919998886665" -> "+91******6665". */
function maskMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, "");
  if (digits.length < 4) return mobile;
  return `${mobile.startsWith("+") ? "+" : ""}${digits.slice(0, 2)}******${digits.slice(-4)}`;
}

/**
 * Dividends paid out, per folio and scheme.
 *
 * Read from our own holdings projection rather than from a report call: FP's
 * holdings feed already carries `payout.amount` per position, which
 * `syncHoldings` stores, so there is no separate dividend report to fetch and
 * no reason to spend an upstream call on one.
 *
 * It is a running total per position, not a list of payout events — the RTA
 * feed does not give us the individual credits — so the DTO says "how much, as
 * of when" and never implies a payment history. Positions that have never paid
 * out are left out entirely rather than listed as zero.
 */
export async function getDividends(
  mfInvestmentAccountId: string,
): Promise<DividendReportDto> {
  await requireAccount(mfInvestmentAccountId);

  const rows = await db.mfHolding.findMany({
    where: { mfInvestmentAccountId, payoutAmount: { gt: 0 } },
    select: {
      folioNumber: true,
      schemeIsin: true,
      schemeName: true,
      payoutAmount: true,
      payoutAsOn: true,
      syncedAt: true,
    },
    orderBy: [{ payoutAmount: "desc" }, { schemeIsin: "asc" }],
  });

  let total = new Prisma.Decimal(0);
  let syncedAt: Date | null = null;
  for (const row of rows) {
    if (row.payoutAmount) total = total.plus(row.payoutAmount);
    if (!syncedAt || row.syncedAt > syncedAt) syncedAt = row.syncedAt;
  }

  return {
    rows: rows.map((row) => ({
      folioNumber: row.folioNumber,
      isin: row.schemeIsin,
      schemeName: row.schemeName,
      // Non-null by the `gt: 0` filter, but read through the same helper the
      // rest of this file uses rather than asserted.
      payoutAmount: asAmount(row.payoutAmount) ?? "0.00",
      payoutAsOn: asDate(row.payoutAsOn),
      syncedAt: row.syncedAt.toISOString(),
    })),
    totalPayout: total.toFixed(2),
    syncedAt: syncedAt?.toISOString() ?? null,
  };
}

/**
 * Returns computed by FP rather than by us — XIRR and CAGR need the full
 * transaction history, which lives on FP's side.
 */
export async function getSchemeReturns(
  mfInvestmentAccountId: string,
): Promise<Record<string, unknown>[]> {
  const account = await requireAccount(mfInvestmentAccountId);
  try {
    const report = await fpAccounts.fetchSchemeWiseReturns({
      mf_investment_account: account.fpId,
    });
    return fpAccounts.rowsToObjects(report);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function getCapitalGains(
  mfInvestmentAccountId: string,
  filters: { isin?: string; folio?: string; from?: string; to?: string } = {},
): Promise<Record<string, unknown>[]> {
  const account = await requireAccount(mfInvestmentAccountId);
  try {
    const report = await fpAccounts.fetchCapitalGains({
      mf_investment_account: account.fpId,
      ...(filters.isin && { scheme: filters.isin }),
      ...(filters.folio && { folios: [filters.folio] }),
      ...(filters.from && { traded_on_from: filters.from }),
      ...(filters.to && { traded_on_to: filters.to }),
    });
    return fpAccounts.rowsToObjects(report);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Account-level returns — the Portfolio Performance summary.
 *
 * Total invested, current value, unrealised gain, absolute return, CAGR and
 * XIRR, all computed by FP from the full transaction history. Kept separate
 * from `getSchemeReturns` (the per-scheme breakdown) because the two are
 * different report endpoints; a screen that wants both asks for both.
 */
export async function getAccountReturns(
  mfInvestmentAccountId: string,
): Promise<Record<string, unknown>[]> {
  const account = await requireAccount(mfInvestmentAccountId);
  try {
    const report = await fpAccounts.fetchAccountReturns({
      mf_investment_account: account.fpId,
    });
    return fpAccounts.rowsToObjects(report);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * The Transaction Statement — every trade the registrar has reported.
 *
 * A `type` filter narrows it to one bucket, which is how the same endpoint
 * serves the IDCW statement (`dividend_payout` / `dividend_reinvestment`).
 * Figures are FP's and are returned as-is.
 */
export async function getTransactions(
  mfInvestmentAccountId: string,
  filters: { isin?: string; folio?: string; type?: string; from?: string; to?: string } = {},
): Promise<Record<string, unknown>[]> {
  const account = await requireAccount(mfInvestmentAccountId);
  try {
    const report = await fpAccounts.fetchTransactionList({
      mf_investment_account: account.fpId,
      ...(filters.isin && { scheme: filters.isin }),
      ...(filters.folio && { folios: [filters.folio] }),
      ...(filters.type && { type: filters.type }),
      ...(filters.from && { traded_on_from: filters.from }),
      ...(filters.to && { traded_on_to: filters.to }),
    });
    return fpAccounts.rowsToObjects(report);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}
