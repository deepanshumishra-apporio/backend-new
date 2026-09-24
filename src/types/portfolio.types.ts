export interface HoldingDto {
  id: string;
  folioNumber: string;
  isin: string;
  schemeName: string | null;
  units: string;
  /** Units free of lock-in and pending orders — what can actually be redeemed. */
  redeemableUnits: string | null;
  marketValue: string | null;
  investedValue: string | null;
  /** Computed on read from the two values above, never stored. */
  unrealisedGain: string | null;
  absoluteReturnPct: string | null;
  nav: string | null;
  navAsOn: string | null;
  /** Units, market value and NAV can each be as of a different day. */
  asOn: string | null;
  syncedAt: string;
}

/**
 * One scheme's dividend payouts, as the RTA has reported them.
 *
 * A projection of `MfHolding.payoutAmount`, not a ledger of individual payouts:
 * FP's holdings report gives a running total per (folio, scheme), so this says
 * how much has been paid out and as of when — never which dates it arrived on.
 */
export interface DividendDto {
  folioNumber: string;
  isin: string;
  schemeName: string | null;
  /** Total paid out on this position so far. */
  payoutAmount: string;
  /** The date FP's figure is as of. */
  payoutAsOn: string | null;
  syncedAt: string;
}

export interface DividendReportDto {
  rows: DividendDto[];
  /** Sum of every row, so the screen does not add money up itself. */
  totalPayout: string;
  /** When the underlying holdings projection was last reconciled with FP. */
  syncedAt: string | null;
}

export interface PortfolioSummaryDto {
  mfInvestmentAccountId: string;
  schemeCount: number;
  investedValue: string;
  marketValue: string;
  unrealisedGain: string;
  absoluteReturnPct: string | null;
  /** When the projection was last reconciled with FP. Null means never. */
  syncedAt: string | null;
}

export interface FolioDto {
  id: string;
  number: string;
  amcCode: string | null;
  holdingPattern: string | null;
  primaryInvestorName: string | null;
  /** Masked. These decide where an order's 2FA OTP must be sent. */
  registeredEmail: string | null;
  registeredMobile: string | null;
  schemeCount: number;
  syncedAt: string;
}

/**
 * The folio a new lumpsum or SIP into a scheme will go into.
 *
 * One investor has one folio per fund house. `existing` means that folio is
 * already open and the order must carry it; `new` means this is the first
 * investment at the fund house and the AMC opens the folio at allotment;
 * `awaiting_allotment` means the first order there is paid for but not yet
 * allotted — no folio number exists yet, and placing another order now would
 * open a duplicate, so the app must wait (`pendingOrderId`).
 */
export interface PurchaseFolioDto {
  status: "existing" | "new" | "awaiting_allotment";
  folioNumber: string | null;
  pendingOrderId: string | null;
}
