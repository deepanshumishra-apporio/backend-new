// Keep paid purchases moving until FP reports their outcome.
//
// On ONDC the folio number, units and NAV exist only once a purchase turns
// `successful` — in the sandbox seconds after the investor pays, in production
// possibly the next working day. Until now the mirror only learnt about it when
// the app happened to poll or an operator drained the webhook queue, so an
// investor who paid and closed the app could leave an allotted order recorded
// as `submitted`, with no folio, indefinitely. The next order at that AMC would
// then find no folio to reuse and be refused by the folio guard.
//
// This sweep closes that gap: every paid, in-flight purchase is re-read from FP
// on a schedule and fed through `applyPurchaseUpdate`, which is also what
// mirrors the folio and holdings the moment an order is allotted.
import { MfOrderState, OrderGateway, PaymentStatus, PlanState } from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import { fpOrders, fpPayments, fpPlans } from "../integrations/fp/index.ts";
import {
  syncPayment,
  syncPurchasePlan,
  syncRedemption,
  syncRedemptionPlan,
  syncSwitch,
  syncSwitchPlan,
} from "./fp-sync/index.ts";
import { applyPurchaseUpdate, pullRedemptionPayout } from "./order.service.ts";
import { debitInstallment } from "./payment.service.ts";

/** Paid and handed to the gateway, but not yet decided. */
const IN_FLIGHT = [MfOrderState.CONFIRMED, MfOrderState.SUBMITTED];

/** Re-read an order at most this often, whoever else is also refreshing it. */
const MIN_RESYNC_AGE_MS = 20_000;

/**
 * Stop sweeping an order after this long. FP expires an order that is not
 * processed; one still in flight after a fortnight needs a human, not a poll.
 */
const MAX_ORDER_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface ReconcileResult {
  checked: number;
  /** Reached a final state (successful, failed, reversed, cancelled) this run. */
  settled: number;
  failed: number;
}

/**
 * Re-read up to `limit` in-flight purchases from FP, least recently synced first.
 *
 * Safe to run from several processes at once: every write is an upsert on the
 * FP id, so two sweeps reading the same order apply the same state twice.
 */
export async function reconcileInFlightPurchases(limit = 25): Promise<ReconcileResult> {
  const now = Date.now();
  const rows = await db.mfPurchase.findMany({
    where: {
      state: { in: IN_FLIGHT },
      syncedAt: { lt: new Date(now - MIN_RESYNC_AGE_MS) },
      createdAt: { gt: new Date(now - MAX_ORDER_AGE_MS) },
    },
    orderBy: { syncedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 100),
    select: { fpId: true, mfInvestmentAccountId: true },
  });

  const result: ReconcileResult = { checked: 0, settled: 0, failed: 0 };
  for (const row of rows) {
    result.checked++;
    try {
      const fresh = await fpOrders.fetchPurchase(row.fpId);
      await applyPurchaseUpdate(fresh, row.mfInvestmentAccountId);
      if (!["confirmed", "submitted"].includes(fresh.state)) result.settled++;
    } catch (error) {
      // One unreadable order must not starve the rest of the batch.
      result.failed++;
      console.warn(
        `[reconcile] purchase ${row.fpId} could not be refreshed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Redemptions and switches
// ---------------------------------------------------------------------------

/**
 * How often a successful redemption is asked for its payout. The registrar
 * files it a day or two after the units go, so there is no hurry, and the
 * payout (with the UTR on the investor's bank statement) is otherwise never
 * seen: it is looked up once, at success, when it is almost never there yet.
 */
const PAYOUT_RECHECK_AGE_MS = 30 * 60 * 1000;
const PAYOUT_WATCH_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * The same sweep for money leaving: in-flight redemptions and switches until
 * FP decides them, then each successful redemption until its payout is filed.
 */
export async function reconcileExits(limit = 25): Promise<ReconcileResult> {
  const now = Date.now();
  const take = Math.min(Math.max(limit, 1), 100);
  const inFlight = {
    state: { in: IN_FLIGHT },
    syncedAt: { lt: new Date(now - MIN_RESYNC_AGE_MS) },
    createdAt: { gt: new Date(now - MAX_ORDER_AGE_MS) },
  };
  const select = { id: true, fpId: true, mfInvestmentAccountId: true } as const;

  const [redemptions, awaitingPayout, switches] = await Promise.all([
    db.mfRedemption.findMany({ where: inFlight, orderBy: { syncedAt: "asc" }, take, select }),
    db.mfRedemption.findMany({
      where: {
        state: MfOrderState.SUCCESSFUL,
        payoutDetail: null,
        succeededAt: { gt: new Date(now - PAYOUT_WATCH_MS) },
        syncedAt: { lt: new Date(now - PAYOUT_RECHECK_AGE_MS) },
      },
      orderBy: { syncedAt: "asc" },
      take,
      select,
    }),
    db.mfSwitch.findMany({ where: inFlight, orderBy: { syncedAt: "asc" }, take, select }),
  ]);

  const result: ReconcileResult = { checked: 0, settled: 0, failed: 0 };
  const attempt = async (fpId: string, work: () => Promise<boolean>) => {
    result.checked++;
    try {
      if (await work()) result.settled++;
    } catch (error) {
      result.failed++;
      console.warn(`[reconcile] ${fpId} could not be refreshed:`, error instanceof Error ? error.message : error);
    }
  };

  for (const row of [...redemptions, ...awaitingPayout]) {
    await attempt(row.fpId, async () => {
      const fresh = await fpOrders.fetchRedemption(row.fpId);
      // Also bumps `syncedAt`, which is what spaces out the payout re-checks.
      const local = await syncRedemption(fresh, row.mfInvestmentAccountId);
      if (fresh.state === "successful") await pullRedemptionPayout(local.id, row.fpId);
      return !["confirmed", "submitted"].includes(fresh.state);
    });
  }
  for (const row of switches) {
    await attempt(row.fpId, async () => {
      const fresh = await fpOrders.fetchSwitch(row.fpId);
      await syncSwitch(fresh, row.mfInvestmentAccountId);
      return !["confirmed", "submitted"].includes(fresh.state);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// SIP installments
// ---------------------------------------------------------------------------

/** Plans that can still generate installments. */
const LIVE_PLAN_STATES = [PlanState.CONFIRMED, PlanState.SUBMITTED, PlanState.ACTIVE];

/**
 * How often one plan is re-read. Installments appear on their dates, so a few
 * minutes' delay costs nothing, and it keeps FP traffic proportional to plans,
 * not to ticks.
 */
const PLAN_RESYNC_AGE_MS = 5 * 60 * 1000;

/** Installment states still waiting for money (see `debitInstallment`). */
const UNPAID_INSTALLMENT_STATES = [MfOrderState.PENDING, MfOrderState.CONFIRMED, MfOrderState.SUBMITTED];

export interface InstallmentCollectResult {
  plans: number;
  installmentsSeen: number;
  debited: number;
  failed: number;
}

/**
 * Find each live SIP's installments at FP and debit the ones nobody has paid.
 *
 * FP generates an installment as a purchase on its date but never collects it
 * — the mandate debit is ours to create, one per installment, or the
 * installment expires unpaid. Installments are also only announced by webhook,
 * so without this they would not even appear in the mirror. Per plan:
 *
 *   1. re-read the plan (next date, remaining count, state);
 *   2. list its installments at FP and apply each, which mirrors it with its
 *      `planId` and, once allotted, its folio and holdings;
 *   3. debit every unpaid installment that has no payment claim yet.
 */
export async function collectSipInstallments(limit = 10): Promise<InstallmentCollectResult> {
  const plans = await db.mfPurchasePlan.findMany({
    where: {
      state: { in: LIVE_PLAN_STATES },
      gateway: { in: [OrderGateway.ONDC, OrderGateway.CYBRILLAPOA] },
      syncedAt: { lt: new Date(Date.now() - PLAN_RESYNC_AGE_MS) },
    },
    orderBy: { syncedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 50),
    select: { id: true, fpId: true, mfInvestmentAccountId: true },
  });

  const result: InstallmentCollectResult = { plans: 0, installmentsSeen: 0, debited: 0, failed: 0 };
  for (const plan of plans) {
    result.plans++;
    try {
      await syncPurchasePlan(await fpPlans.fetchPurchasePlan(plan.fpId), plan.mfInvestmentAccountId);
      for (const installment of await fpOrders.listPurchases({ plan: plan.fpId })) {
        result.installmentsSeen++;
        await applyPurchaseUpdate(installment, plan.mfInvestmentAccountId);
      }

      const unpaid = await db.mfPurchase.findMany({
        where: {
          planId: plan.id,
          state: { in: UNPAID_INSTALLMENT_STATES },
          paymentSubmission: null,
          payments: { none: {} },
        },
        select: { id: true },
      });
      for (const installment of unpaid) {
        if ((await debitInstallment(installment.id)) === "debited") result.debited++;
      }
    } catch (error) {
      // One broken plan must not stop the others being collected.
      result.failed++;
      console.warn(
        `[reconcile] SIP ${plan.fpId} could not be collected:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// SWP and STP installments
// ---------------------------------------------------------------------------

export interface ExitPlanCollectResult {
  plans: number;
  installmentsSeen: number;
  failed: number;
}

/**
 * Mirror each live SWP's and STP's installments, and settle what they paid.
 *
 * FP generates an SWP installment as a redemption and an STP installment as a
 * switch, and announces them only by webhook. Nothing needs collecting — no
 * money comes in — but without this an installment whose webhook was lost
 * never appears, "what has my SWP paid out" answers nothing, and its payout is
 * never looked up. Once mirrored, an in-flight installment is carried the rest
 * of the way by `reconcileExits` like any other redemption or switch; this
 * sweep also pulls the payout of an installment it first sees already
 * successful, since `reconcileExits` only watches for it afterwards.
 */
export async function collectExitPlanInstallments(limit = 10): Promise<ExitPlanCollectResult> {
  const where = {
    state: { in: LIVE_PLAN_STATES },
    gateway: { in: [OrderGateway.ONDC, OrderGateway.CYBRILLAPOA] },
    syncedAt: { lt: new Date(Date.now() - PLAN_RESYNC_AGE_MS) },
  };
  const take = Math.min(Math.max(limit, 1), 50);
  const select = { id: true, fpId: true, mfInvestmentAccountId: true } as const;
  const orderBy = { syncedAt: "asc" } as const;
  const [swps, stps] = await Promise.all([
    db.mfRedemptionPlan.findMany({ where, orderBy, take, select }),
    db.mfSwitchPlan.findMany({ where, orderBy, take, select }),
  ]);

  const result: ExitPlanCollectResult = { plans: 0, installmentsSeen: 0, failed: 0 };
  const collect = async (kind: "SWP" | "STP", fpId: string, work: () => Promise<void>) => {
    result.plans++;
    try {
      await work();
    } catch (error) {
      // One broken plan must not stop the others being collected.
      result.failed++;
      console.warn(`[reconcile] ${kind} ${fpId} could not be collected:`, error instanceof Error ? error.message : error);
    }
  };

  for (const plan of swps) {
    await collect("SWP", plan.fpId, async () => {
      await syncRedemptionPlan(await fpPlans.fetchRedemptionPlan(plan.fpId), plan.mfInvestmentAccountId);
      for (const installment of await fpOrders.listRedemptions({ plan: plan.fpId })) {
        result.installmentsSeen++;
        const local = await syncRedemption(installment, plan.mfInvestmentAccountId);
        if (installment.state === "successful") await pullRedemptionPayout(local.id, installment.id);
      }
    });
  }
  for (const plan of stps) {
    await collect("STP", plan.fpId, async () => {
      await syncSwitchPlan(await fpPlans.fetchSwitchPlan(plan.fpId), plan.mfInvestmentAccountId);
      for (const installment of await fpOrders.listSwitches({ plan: plan.fpId })) {
        result.installmentsSeen++;
        await syncSwitch(installment, plan.mfInvestmentAccountId);
      }
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/** Statuses from which FP may still move a payment on. */
const UNSETTLED_PAYMENT_STATUSES = [
  PaymentStatus.INITIATED,
  PaymentStatus.PENDING,
  PaymentStatus.SUBMITTED,
  PaymentStatus.APPROVED,
];

/**
 * Re-read payments FP has not finished with.
 *
 * Nothing else refreshes a payment row. The order sweep follows the purchase,
 * and on ONDC the purchase is often `successful` — allotted, with its folio —
 * while our copy of the UPI payment that funded it still says PENDING, because
 * the investor never came back through the payment-return redirect. The app
 * then shows "payment pending" on an order that is already invested.
 */
export async function reconcileOpenPayments(limit = 25): Promise<ReconcileResult> {
  const now = Date.now();
  const rows = await db.payment.findMany({
    where: {
      status: { in: UNSETTLED_PAYMENT_STATUSES },
      syncedAt: { lt: new Date(now - MIN_RESYNC_AGE_MS) },
      createdAt: { gt: new Date(now - MAX_ORDER_AGE_MS) },
    },
    orderBy: { syncedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 100),
    select: { fpId: true },
  });

  const result: ReconcileResult = { checked: 0, settled: 0, failed: 0 };
  for (const row of rows) {
    result.checked++;
    try {
      const fresh = await fpPayments.fetchPayment(row.fpId);
      await syncPayment(fresh);
      if (!(UNSETTLED_PAYMENT_STATUSES as string[]).includes(String(fresh.status).toUpperCase())) result.settled++;
    } catch (error) {
      result.failed++;
      console.warn(`[reconcile] payment ${row.fpId} could not be refreshed:`, error instanceof Error ? error.message : error);
    }
  }
  return result;
}
