// Contracts for transaction monitoring: every order across investors, with
// what needs someone's attention flagged.

export const ORDER_TYPES = [
  "PURCHASE", "SIP_INSTALLMENT", "REDEMPTION", "SWP_INSTALLMENT", "SWITCH", "STP_INSTALLMENT",
] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATES = [
  "UNDER_REVIEW", "PENDING", "CONFIRMED", "SUBMITTED", "SUCCESSFUL", "FAILED", "CANCELLED", "REVERSED",
] as const;
export type MonitorOrderState = (typeof ORDER_STATES)[number];

/**
 * Why an order is worth a look.
 * - FAILED              failed or reversed at FP / the RTA
 * - PAID_NOT_CONFIRMED  a purchase whose payment succeeded but which never moved on
 * - NOT_SUBMITTED       confirmed a day ago and still not sent to the RTA
 * - STUCK_AT_RTA        with the RTA for three days without an outcome
 * - AWAITING_INVESTOR   placed a day ago and still waiting on the investor's consent or payment
 */
export const ORDER_FLAGS = ["FAILED", "PAID_NOT_CONFIRMED", "NOT_SUBMITTED", "STUCK_AT_RTA", "AWAITING_INVESTOR"] as const;
export type OrderFlag = (typeof ORDER_FLAGS)[number];

export type OrderKind = "purchase" | "redemption" | "switch";

export interface MonitoredOrderDto {
  id: string;
  kind: OrderKind;
  type: OrderType;
  investor: { id: string | null; name: string | null; pan: string | null };
  scheme: string;
  toScheme: string | null;
  folio: string | null;
  amount: string | null;
  units: string | null;
  state: MonitorOrderState;
  gateway: string;
  payment: { status: string; at: string | null } | null;
  flag: OrderFlag | null;
  failureReason: string | null;
  placedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TransactionListQuery {
  limit: number;
  type?: OrderType[];
  state?: MonitorOrderState[];
  flag?: OrderFlag[];
  /** Any flag at all. */
  attention?: boolean;
  from?: string;
  to?: string;
  search?: string;
  cursor?: { at: Date; id: string };
}

export interface TransactionListDto {
  items: MonitoredOrderDto[];
  nextCursor: string | null;
}

export interface CountByKey<K extends string> {
  key: K;
  label: string;
  count: number;
}

export interface TransactionSummaryDto {
  generatedAt: string;
  today: {
    placed: number;
    successful: number;
    failed: number;
    /** Purchases placed today, in rupees: the day's inflow asked for. */
    purchaseAmount: string;
    redemptionAmount: string;
  };
  inFlight: number;
  /** Open problems now; failures count for the last 7 days. */
  attention: CountByKey<OrderFlag>[];
  paymentsToday: { successful: number; failed: number; pending: number; amountCollected: string };
  /** The commonest failure reasons in the last 30 days. */
  topFailures: { reason: string; count: number }[];
  /** Orders per India-local day for the last 14 days. */
  daily: { date: string; placed: number; successful: number; failed: number }[];
}
