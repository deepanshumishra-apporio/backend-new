// How the admin portal reads an investor's orders, plans, holdings and
// payments: one `select` and one mapper per entity, shared by the investor
// record (lists) and the side panel (one item in full), so the two can never
// describe the same order differently.
//
// No queries run here except `instalmentCounts`; the services that import this
// decide what to fetch.
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { maskAccountNumber, maskEmail, maskTail } from "../utils/mask.ts";
import type {
  HoldingDto,
  ItemEvent,
  OrderDto,
  PaymentDto,
  PlanDto,
  SchemeFactsDto,
} from "../types/admin-investor.types.ts";

// --- formatting --------------------------------------------------------------------

type Decimalish = Prisma.Decimal | null | undefined;
export const dec = (value: Decimalish, dp = 2): string | null => (value == null ? null : new Prisma.Decimal(value).toFixed(dp));
export const sum = (values: Decimalish[]): Prisma.Decimal =>
  values.reduce<Prisma.Decimal>((acc, value) => (value == null ? acc : acc.plus(value)), new Prisma.Decimal(0));
export const day = (value: Date | null | undefined): string | null => value?.toISOString().slice(0, 10) ?? null;
export const iso = (value: Date | null | undefined): string | null => value?.toISOString() ?? null;

/** Timestamped steps, dropping the ones that never happened, in order. */
export function events(steps: [Date | null | undefined, string][]): ItemEvent[] {
  return steps
    .filter((step): step is [Date, string] => step[0] instanceof Date)
    .map(([at, label]) => ({ at: at.toISOString(), label }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

// --- schemes -------------------------------------------------------------------------

export const schemeFactsSelect = {
  isin: true, name: true, category: true, subCategory: true, planType: true, investmentOption: true,
  latestNav: true, latestNavDate: true, expenseRatio: true, exitLoadPct: true, lockInPeriodDays: true,
  amc: { select: { name: true } },
} as const satisfies Prisma.MfSchemeSelect;

export function toSchemeFacts(scheme: Prisma.MfSchemeGetPayload<{ select: typeof schemeFactsSelect }>): SchemeFactsDto {
  return {
    isin: scheme.isin,
    name: scheme.name,
    amc: scheme.amc.name,
    category: scheme.category,
    subCategory: scheme.subCategory,
    planType: scheme.planType,
    option: scheme.investmentOption,
    latestNav: dec(scheme.latestNav, 4),
    latestNavDate: day(scheme.latestNavDate),
    expenseRatio: dec(scheme.expenseRatio),
    exitLoadPercent: dec(scheme.exitLoadPct),
    lockInDays: scheme.lockInPeriodDays,
  };
}

// --- orders --------------------------------------------------------------------------

const orderCommon = {
  id: true, fpId: true, planId: true, folioNumber: true, state: true, gateway: true, sourceRefId: true,
  failureCode: true, failureReason: true, scheduledOn: true, tradedOn: true, initiatedBy: true, initiatedVia: true,
  consentAt: true, consentEmail: true, consentIsdCode: true, consentMobile: true,
  createdAt: true, fpCreatedAt: true, confirmedAt: true, submittedAt: true, succeededAt: true, failedAt: true,
  reversedAt: true, cancelledAt: true,
} as const;

export const purchaseSelect = {
  ...orderCommon, type: true, amount: true, purchasedAmount: true, allottedUnits: true, purchasedPrice: true,
  allottedNavDate: true, retriedAt: true, scheme: { select: schemeFactsSelect },
} as const satisfies Prisma.MfPurchaseSelect;

export const redemptionSelect = {
  ...orderCommon, redemptionMode: true, amount: true, units: true, redeemedAmount: true, redeemedUnits: true,
  redeemedPrice: true, redeemedNavDate: true, redemptionBankAccountNumber: true, redemptionBankAccountIfsc: true,
  scheme: { select: schemeFactsSelect },
} as const satisfies Prisma.MfRedemptionSelect;

export const switchSelect = {
  ...orderCommon, amount: true, units: true, switchedOutAmount: true, switchedOutUnits: true, switchedOutPrice: true,
  switchedInAmount: true, switchedInUnits: true, switchedInPrice: true,
  switchOutScheme: { select: schemeFactsSelect }, switchInScheme: { select: schemeFactsSelect },
} as const satisfies Prisma.MfSwitchSelect;

export type PurchaseRow = Prisma.MfPurchaseGetPayload<{ select: typeof purchaseSelect }>;
export type RedemptionRow = Prisma.MfRedemptionGetPayload<{ select: typeof redemptionSelect }>;
export type SwitchRow = Prisma.MfSwitchGetPayload<{ select: typeof switchSelect }>;

export function purchaseToOrder(order: PurchaseRow): OrderDto {
  return {
    id: order.id, kind: "PURCHASE", source: order.planId ? "SIP" : "ONE_TIME",
    scheme: order.scheme.name, toScheme: null, amount: dec(order.amount), units: null,
    processedAmount: dec(order.purchasedAmount), processedUnits: dec(order.allottedUnits, 4), price: dec(order.purchasedPrice, 4),
    folioNumber: order.folioNumber, state: order.state, failureReason: order.failureReason,
    placedAt: order.createdAt.toISOString(), completedAt: iso(order.succeededAt ?? order.failedAt),
  };
}

export function redemptionToOrder(order: RedemptionRow): OrderDto {
  return {
    id: order.id, kind: "REDEMPTION", source: order.planId ? "SWP" : "ONE_TIME",
    scheme: order.scheme.name, toScheme: null, amount: dec(order.amount), units: dec(order.units, 4),
    processedAmount: dec(order.redeemedAmount), processedUnits: dec(order.redeemedUnits, 4), price: dec(order.redeemedPrice, 4),
    folioNumber: order.folioNumber, state: order.state, failureReason: order.failureReason,
    placedAt: order.createdAt.toISOString(), completedAt: iso(order.succeededAt ?? order.failedAt),
  };
}

export function switchToOrder(order: SwitchRow): OrderDto {
  return {
    id: order.id, kind: "SWITCH", source: order.planId ? "STP" : "ONE_TIME",
    scheme: order.switchOutScheme.name, toScheme: order.switchInScheme.name, amount: dec(order.amount), units: dec(order.units, 4),
    processedAmount: dec(order.switchedOutAmount), processedUnits: dec(order.switchedOutUnits, 4), price: dec(order.switchedInPrice, 4),
    folioNumber: order.folioNumber, state: order.state, failureReason: order.failureReason,
    placedAt: order.createdAt.toISOString(), completedAt: iso(order.succeededAt ?? order.failedAt),
  };
}

/** The lifecycle every order shares, in FP's own timestamps. */
export function orderEvents(order: PurchaseRow | RedemptionRow | SwitchRow, extra: [Date | null | undefined, string][] = []): ItemEvent[] {
  return events([
    [order.createdAt, "Placed"],
    [order.consentAt, "Investor consented (2FA)"],
    [order.confirmedAt, "Confirmed"],
    [order.submittedAt, "Submitted to the RTA"],
    [order.succeededAt, "Successful"],
    [order.failedAt, "Failed"],
    [order.reversedAt, "Reversed"],
    [order.cancelledAt, "Cancelled"],
    ...extra,
  ]);
}

export function orderConsent(order: PurchaseRow | RedemptionRow | SwitchRow) {
  if (!order.consentAt) return null;
  return {
    at: order.consentAt.toISOString(),
    email: maskEmail(order.consentEmail),
    mobile: order.consentMobile ? `${order.consentIsdCode ? `+${order.consentIsdCode.replace(/^\+/, "")} ` : ""}${maskTail(order.consentMobile)}` : null,
  };
}

// --- holdings -----------------------------------------------------------------------

export const holdingSelect = {
  id: true, schemeIsin: true, schemeName: true, folioNumber: true, units: true, redeemableUnits: true, unitsAsOn: true,
  nav: true, navAsOn: true, marketValue: true, marketValueAsOn: true, investedValue: true, investedValueAsOn: true,
  payoutAmount: true,
} as const satisfies Prisma.MfHoldingSelect;

export function toHolding(holding: Prisma.MfHoldingGetPayload<{ select: typeof holdingSelect }>): HoldingDto {
  return {
    id: holding.id,
    scheme: holding.schemeName ?? holding.schemeIsin,
    isin: holding.schemeIsin,
    folioNumber: holding.folioNumber,
    units: dec(holding.units, 4)!,
    redeemableUnits: dec(holding.redeemableUnits, 4),
    nav: dec(holding.nav, 4),
    navAsOn: day(holding.navAsOn),
    currentValue: dec(holding.marketValue),
    investedValue: dec(holding.investedValue),
    gain: holding.marketValue != null && holding.investedValue != null ? dec(holding.marketValue.minus(holding.investedValue)) : null,
  };
}

// --- plans ---------------------------------------------------------------------------

const planCommon = {
  id: true, fpId: true, frequency: true, installmentDay: true, state: true, gateway: true, startDate: true, endDate: true,
  nextInstallmentDate: true, previousInstallmentDate: true, numberOfInstallments: true, remainingInstallments: true,
  folioNumber: true, requestedActivationDate: true, consentAt: true, autoCancelled: true, cancellationCode: true,
  cancellationScheduledOn: true, reason: true, createdAt: true, activatedAt: true, cancelledAt: true, failedAt: true,
  completedAt: true,
} as const;

export const sipSelect = {
  ...planCommon, amount: true, pauseState: true, pauseFrom: true, pauseTo: true, paymentMethod: true, purpose: true,
  scheme: { select: schemeFactsSelect },
  mandate: { select: { mandateType: true, mandateStatus: true } },
} as const satisfies Prisma.MfPurchasePlanSelect;

export const swpSelect = {
  ...planCommon, amount: true, units: true, scheme: { select: schemeFactsSelect },
} as const satisfies Prisma.MfRedemptionPlanSelect;

export const stpSelect = {
  ...planCommon, amount: true, units: true,
  switchOutScheme: { select: schemeFactsSelect }, switchInScheme: { select: schemeFactsSelect },
} as const satisfies Prisma.MfSwitchPlanSelect;

export type SipRow = Prisma.MfPurchasePlanGetPayload<{ select: typeof sipSelect }>;
export type SwpRow = Prisma.MfRedemptionPlanGetPayload<{ select: typeof swpSelect }>;
export type StpRow = Prisma.MfSwitchPlanGetPayload<{ select: typeof stpSelect }>;
type Counts = Map<string, { placed: number; succeeded: number }>;

function planBase(plan: SipRow | SwpRow | StpRow, counts: Counts) {
  return {
    id: plan.id,
    frequency: plan.frequency,
    installmentDay: plan.installmentDay,
    state: plan.state,
    startDate: day(plan.startDate),
    endDate: day(plan.endDate),
    nextInstallmentDate: day(plan.nextInstallmentDate),
    previousInstallmentDate: day(plan.previousInstallmentDate),
    totalInstallments: plan.numberOfInstallments,
    remainingInstallments: plan.remainingInstallments,
    installmentsPlaced: counts.get(plan.id)?.placed ?? 0,
    installmentsSucceeded: counts.get(plan.id)?.succeeded ?? 0,
    folioNumber: plan.folioNumber,
    createdAt: plan.createdAt.toISOString(),
    cancelledAt: iso(plan.cancelledAt),
    reason: plan.reason,
  };
}

export const sipToPlan = (plan: SipRow, counts: Counts): PlanDto => ({
  ...planBase(plan, counts),
  kind: "SIP", scheme: plan.scheme.name, toScheme: null, amount: dec(plan.amount), units: null,
  pause: plan.pauseState ? { state: plan.pauseState, from: day(plan.pauseFrom), to: day(plan.pauseTo) } : null,
  mandate: plan.mandate ? { type: plan.mandate.mandateType, status: plan.mandate.mandateStatus } : null,
});

export const swpToPlan = (plan: SwpRow, counts: Counts): PlanDto => ({
  ...planBase(plan, counts),
  kind: "SWP", scheme: plan.scheme.name, toScheme: null, amount: dec(plan.amount), units: dec(plan.units, 4), pause: null, mandate: null,
});

export const stpToPlan = (plan: StpRow, counts: Counts): PlanDto => ({
  ...planBase(plan, counts),
  kind: "STP", scheme: plan.switchOutScheme.name, toScheme: plan.switchInScheme.name,
  amount: dec(plan.amount), units: dec(plan.units, 4), pause: null, mandate: null,
});

export function planEvents(plan: SipRow | SwpRow | StpRow): ItemEvent[] {
  return events([
    [plan.createdAt, "Set up"],
    [plan.consentAt, "Investor consented (2FA)"],
    [plan.activatedAt, "Activated"],
    [plan.previousInstallmentDate, "Last instalment"],
    [plan.cancellationScheduledOn, "Cancellation scheduled"],
    [plan.cancelledAt, "Cancelled"],
    [plan.failedAt, "Failed"],
    [plan.completedAt, "Completed"],
  ]);
}

/** Instalments placed and succeeded, per plan, from the order rows that point at it. */
export async function instalmentCounts(table: "mf_purchases" | "mf_redemptions" | "mf_switches", planIds: string[]): Promise<Counts> {
  const counts: Counts = new Map();
  if (planIds.length === 0) return counts;
  // The table name is one of three literals above, never input.
  const rows = await db.$queryRaw<{ planId: string | null; state: string; n: number }[]>`
    SELECT "planId", upper(state::text) AS state, count(*)::int AS n FROM ${Prisma.raw(table)}
    WHERE "planId" = ANY(${planIds}::uuid[]) GROUP BY 1, 2`;
  for (const row of rows) {
    if (!row.planId) continue;
    const entry = counts.get(row.planId) ?? { placed: 0, succeeded: 0 };
    entry.placed += row.n;
    if (row.state === "SUCCESSFUL") entry.succeeded += row.n;
    counts.set(row.planId, entry);
  }
  return counts;
}

// --- payments --------------------------------------------------------------------

export const paymentSelect = {
  id: true, fpId: true, paymentType: true, method: true, status: true, amount: true, provider: true, debitDate: true,
  failureCode: true, failedReason: true, lateAuth: true, refundReference: true, refundReason: true, refundStatus: true,
  refundCreatedAt: true, createdAt: true, submittedAt: true, debitConfirmedAt: true, transferInitiatedAt: true,
  settledAt: true, failedAt: true, rejectedAt: true,
} as const satisfies Prisma.PaymentSelect;

export type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

export function toPayment(payment: PaymentRow): PaymentDto {
  return {
    id: payment.id,
    type: payment.paymentType,
    method: payment.method,
    status: payment.status,
    amount: new Prisma.Decimal(payment.amount).toFixed(2),
    failureReason: payment.failedReason,
    createdAt: payment.createdAt.toISOString(),
    settledAt: iso(payment.settledAt),
  };
}

export const maskedAccount = (last4OrFull: string | null | undefined): string | null =>
  last4OrFull ? maskAccountNumber(last4OrFull.slice(-4)) : null;
