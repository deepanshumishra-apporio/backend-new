// An investor's money, for the admin investor record: holdings, folios, every
// SIP / SWP / STP with its schedule, the instalments coming up, all orders
// (purchases, redemptions, switches) and the payments behind them.
//
// Read-only and mirror-only. Values come from the FP holdings report as last
// synced — never summed from our own orders, because allotment happens at the
// AMC net of stamp duty — and `asOf` says how old that report is.
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { instalmentsPerMonth } from "../utils/plan-frequency.ts";
import {
  day,
  dec,
  holdingSelect,
  instalmentCounts,
  paymentSelect,
  purchaseSelect,
  purchaseToOrder,
  redemptionSelect,
  redemptionToOrder,
  sipSelect,
  sipToPlan,
  stpSelect,
  stpToPlan,
  sum,
  swpSelect,
  swpToPlan,
  switchSelect,
  switchToOrder,
  toHolding,
  toPayment,
  type SipRow,
} from "./admin-money-mapping.ts";
import type { InvestorInvestmentsDto, OrderDto, UpcomingInstallmentDto } from "../types/admin-investor.types.ts";

const ORDER_LIMIT = 50;
const PAYMENT_LIMIT = 25;
const UPCOMING_LIMIT = 12;
const LIVE_PLAN_STATES = ["ACTIVE", "CONFIRMED", "SUBMITTED", "REVIEW_COMPLETED", "CREATED"];
const IN_FLIGHT_ORDER_STATES = ["UNDER_REVIEW", "PENDING", "CONFIRMED", "SUBMITTED"];

const EMPTY: InvestorInvestmentsDto = {
  portfolio: { currentValue: "0.00", investedValue: "0.00", gain: "0.00", gainPercent: null, asOf: null, holdings: [] },
  folios: [],
  plans: { sips: [], swps: [], stps: [] },
  summary: { activeSips: 0, sipMonthlyAmount: "0.00", activeSwps: 0, activeStps: 0, nextSip: null },
  upcoming: [],
  orders: [],
  orderTotals: { purchased: "0.00", redeemed: "0.00", switched: "0.00", inFlight: 0, failed: 0 },
  payments: [],
};

/** A pause covering today, and not itself cancelled or failed. */
export function isPausedToday(plan: Pick<SipRow, "pauseState" | "pauseFrom" | "pauseTo">): boolean {
  const today = new Date(new Date().toISOString().slice(0, 10));
  return Boolean(
    plan.pauseState && plan.pauseFrom && plan.pauseTo && plan.pauseFrom <= today && plan.pauseTo >= today &&
      !["cancelled", "failed"].includes(plan.pauseState.toLowerCase()),
  );
}

/** Payments are tied to the investor through the bank account they came from, or the mandate debited. */
export const paymentsOfProfile = (profileId: string): Prisma.PaymentWhereInput => ({
  OR: [
    { fromBankAccount: { investorProfileId: profileId } },
    { mandate: { bankAccount: { investorProfileId: profileId } } },
  ],
});

export async function getInvestorInvestments(accountId: string | null, profileId: string | null): Promise<InvestorInvestmentsDto> {
  if (!accountId) return EMPTY;
  const account = { mfInvestmentAccountId: accountId };
  const newest = { orderBy: { createdAt: "desc" as const }, take: ORDER_LIMIT };

  const [holdings, folios, sips, swps, stps, purchases, redemptions, switches, payments, purchased, redemptionTotals, switchTotals, stateCounts] =
    await Promise.all([
      db.mfHolding.findMany({ where: account, orderBy: [{ marketValue: { sort: "desc", nulls: "last" } }], select: holdingSelect }),
      db.mfFolio.findMany({
        where: account,
        orderBy: { number: "asc" },
        select: { number: true, amcCode: true, holdingPattern: true, _count: { select: { holdings: true } } },
      }),
      db.mfPurchasePlan.findMany({ where: account, orderBy: { createdAt: "desc" }, select: sipSelect }),
      db.mfRedemptionPlan.findMany({ where: account, orderBy: { createdAt: "desc" }, select: swpSelect }),
      db.mfSwitchPlan.findMany({ where: account, orderBy: { createdAt: "desc" }, select: stpSelect }),
      db.mfPurchase.findMany({ where: account, ...newest, select: purchaseSelect }),
      db.mfRedemption.findMany({ where: account, ...newest, select: redemptionSelect }),
      db.mfSwitch.findMany({ where: account, ...newest, select: switchSelect }),
      profileId
        ? db.payment.findMany({ where: paymentsOfProfile(profileId), orderBy: { createdAt: "desc" }, take: PAYMENT_LIMIT, select: paymentSelect })
        : [],
      // Per row: allotted amount when known, else the amount ordered.
      db.$queryRaw<{ total: Prisma.Decimal | null }[]>`
        SELECT sum(COALESCE("purchasedAmount", amount)) AS total FROM mf_purchases
        WHERE "mfInvestmentAccountId" = ${accountId}::uuid AND state = 'successful'`,
      db.mfRedemption.aggregate({ where: { ...account, state: "SUCCESSFUL" }, _sum: { redeemedAmount: true } }),
      db.mfSwitch.aggregate({ where: { ...account, state: "SUCCESSFUL" }, _sum: { switchedOutAmount: true } }),
      Promise.all([
        db.mfPurchase.groupBy({ by: ["state"], where: account, _count: { _all: true } }),
        db.mfRedemption.groupBy({ by: ["state"], where: account, _count: { _all: true } }),
        db.mfSwitch.groupBy({ by: ["state"], where: account, _count: { _all: true } }),
      ]),
    ]);

  const [sipCounts, swpCounts, stpCounts] = await Promise.all([
    instalmentCounts("mf_purchases", sips.map((plan) => plan.id)),
    instalmentCounts("mf_redemptions", swps.map((plan) => plan.id)),
    instalmentCounts("mf_switches", stps.map((plan) => plan.id)),
  ]);

  // --- portfolio ---
  const currentValue = sum(holdings.map((holding) => holding.marketValue));
  const investedValue = sum(holdings.map((holding) => holding.investedValue));
  const gain = currentValue.minus(investedValue);
  const valuedOn = holdings.map((holding) => holding.marketValueAsOn).filter((date): date is Date => date !== null);

  // --- plans ---
  const live = (state: string) => LIVE_PLAN_STATES.includes(state);
  const activeSips = sips.filter((plan) => plan.state === "ACTIVE");
  const sipMonthly = activeSips.reduce(
    (acc, plan) => acc.plus(new Prisma.Decimal(plan.amount).times(instalmentsPerMonth(plan.frequency))),
    new Prisma.Decimal(0),
  );

  // --- what is due next, across every live plan ---
  const upcoming: UpcomingInstallmentDto[] = [
    ...sips.filter((plan) => live(plan.state) && plan.nextInstallmentDate).map((plan) => ({
      planId: plan.id, kind: "SIP" as const, scheme: plan.scheme.name, toScheme: null,
      date: day(plan.nextInstallmentDate)!, amount: dec(plan.amount), units: null,
      mandateReady: plan.mandate ? plan.mandate.mandateStatus === "APPROVED" : false,
      paused: isPausedToday(plan),
    })),
    ...swps.filter((plan) => live(plan.state) && plan.nextInstallmentDate).map((plan) => ({
      planId: plan.id, kind: "SWP" as const, scheme: plan.scheme.name, toScheme: null,
      date: day(plan.nextInstallmentDate)!, amount: dec(plan.amount), units: dec(plan.units, 4),
      mandateReady: null, paused: false,
    })),
    ...stps.filter((plan) => live(plan.state) && plan.nextInstallmentDate).map((plan) => ({
      planId: plan.id, kind: "STP" as const, scheme: plan.switchOutScheme.name, toScheme: plan.switchInScheme.name,
      date: day(plan.nextInstallmentDate)!, amount: dec(plan.amount), units: dec(plan.units, 4),
      mandateReady: null, paused: false,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, UPCOMING_LIMIT);

  const dueSips = upcoming.filter((item) => item.kind === "SIP" && !item.paused);
  const nextSipDate = dueSips[0]?.date;
  const onNextDate = dueSips.filter((item) => item.date === nextSipDate);

  // --- orders, newest first across all three kinds ---
  const orders: OrderDto[] = [
    ...purchases.map(purchaseToOrder),
    ...redemptions.map(redemptionToOrder),
    ...switches.map(switchToOrder),
  ].sort((a, b) => b.placedAt.localeCompare(a.placedAt)).slice(0, ORDER_LIMIT);

  const states = stateCounts.flat();
  const countWhere = (predicate: (state: string) => boolean) =>
    states.filter((row) => predicate(row.state)).reduce((acc, row) => acc + row._count._all, 0);

  return {
    portfolio: {
      currentValue: currentValue.toFixed(2),
      investedValue: investedValue.toFixed(2),
      gain: gain.toFixed(2),
      gainPercent: investedValue.isZero() ? null : gain.div(investedValue).times(100).toFixed(2),
      asOf: valuedOn.length ? new Date(Math.min(...valuedOn.map((date) => date.getTime()))).toISOString() : null,
      holdings: holdings.map(toHolding),
    },
    folios: folios.map((folio) => ({
      number: folio.number, amcCode: folio.amcCode, holdingPattern: folio.holdingPattern, schemes: folio._count.holdings,
    })),
    plans: {
      sips: sips.map((plan) => sipToPlan(plan, sipCounts)),
      swps: swps.map((plan) => swpToPlan(plan, swpCounts)),
      stps: stps.map((plan) => stpToPlan(plan, stpCounts)),
    },
    summary: {
      activeSips: activeSips.length,
      sipMonthlyAmount: sipMonthly.toFixed(2),
      activeSwps: swps.filter((plan) => plan.state === "ACTIVE").length,
      activeStps: stps.filter((plan) => plan.state === "ACTIVE").length,
      nextSip: nextSipDate
        ? {
            date: nextSipDate,
            amount: sum(onNextDate.map((item) => (item.amount ? new Prisma.Decimal(item.amount) : null))).toFixed(2),
            count: onNextDate.length,
          }
        : null,
    },
    upcoming,
    orders,
    orderTotals: {
      purchased: new Prisma.Decimal(purchased[0]?.total ?? 0).toFixed(2),
      redeemed: new Prisma.Decimal(redemptionTotals._sum.redeemedAmount ?? 0).toFixed(2),
      switched: new Prisma.Decimal(switchTotals._sum.switchedOutAmount ?? 0).toFixed(2),
      inFlight: countWhere((state) => IN_FLIGHT_ORDER_STATES.includes(state)),
      failed: countWhere((state) => state === "FAILED"),
    },
    payments: payments.map(toPayment),
  };
}
