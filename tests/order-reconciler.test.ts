// The sweeps that keep paid purchases moving until FP decides them, and that
// collect SIP installments. Offline: database, FP and services are stubbed.
import { beforeEach, expect, mock, test } from "bun:test";

let rows: { fpId: string; mfInvestmentAccountId: string }[] = [];
let plans: { id: string; fpId: string; mfInvestmentAccountId: string }[] = [];
let unpaid: { id: string }[] = [];
let lastWhere: Record<string, unknown> | undefined;
const fpStates: Record<string, string> = {};
const installmentsByPlan: Record<string, { id: string; state: string }[]> = {};
const applied: string[] = [];
const debited: string[] = [];
const payoutsPulled: string[] = [];
let redemptions: { id: string; fpId: string; mfInvestmentAccountId: string }[] = [];
let awaitingPayout: { id: string; fpId: string; mfInvestmentAccountId: string }[] = [];
let switches: { id: string; fpId: string; mfInvestmentAccountId: string }[] = [];
let swps: { id: string; fpId: string; mfInvestmentAccountId: string }[] = [];
let stps: { id: string; fpId: string; mfInvestmentAccountId: string }[] = [];
const exitInstallmentsByPlan: Record<string, { id: string; state: string }[]> = {};
const synced: string[] = [];
let openPayments: { fpId: number }[] = [];
const paymentStates: Record<number, string> = {};
const syncedPayments: number[] = [];

mock.module("../src/db/client.ts", () => ({ db: {
  mfPurchase: {
    findMany: async (args: { where: Record<string, unknown> }) => {
      if ("planId" in args.where) return unpaid;
      lastWhere = args.where;
      return rows;
    },
  },
  mfPurchasePlan: { findMany: async () => plans },
  mfRedemption: {
    findMany: async (args: { where: Record<string, unknown> }) => ("payoutDetail" in args.where ? awaitingPayout : redemptions),
  },
  mfSwitch: { findMany: async () => switches },
  mfRedemptionPlan: { findMany: async () => swps },
  payment: { findMany: async () => openPayments },
  mfSwitchPlan: { findMany: async () => stps },
} }));
mock.module("../src/integrations/fp/index.ts", () => ({
  fpOrders: {
    fetchPurchase: async (id: string) => {
      if (fpStates[id] === "boom") throw new Error("FP timed out");
      return { id, state: fpStates[id] };
    },
    listPurchases: async (query: { plan: string }) => installmentsByPlan[query.plan] ?? [],
    fetchRedemption: async (id: string) => ({ id, state: fpStates[id] }),
    fetchSwitch: async (id: string) => ({ id, state: fpStates[id] }),
    listRedemptions: async (query: { plan: string }) => exitInstallmentsByPlan[query.plan] ?? [],
    listSwitches: async (query: { plan: string }) => exitInstallmentsByPlan[query.plan] ?? [],
  },
  fpPayments: {
    fetchPayment: async (id: number) => {
      if (paymentStates[id] === "boom") throw new Error("FP timed out");
      return { id, status: paymentStates[id] };
    },
  },
  fpPlans: {
    fetchPurchasePlan: async (id: string) => {
      if (id === "mfpp_broken") throw new Error("FP timed out");
      return { id, state: "active" };
    },
    fetchRedemptionPlan: async (id: string) => {
      if (id === "mfrp_broken") throw new Error("FP timed out");
      return { id, state: "active" };
    },
    fetchSwitchPlan: async (id: string) => ({ id, state: "active" }),
  },
}));
mock.module("../src/services/fp-sync/index.ts", () => ({
  syncPurchasePlan: async () => ({ id: "plan-row" }),
  syncRedemption: async (order: { id: string }) => { synced.push(order.id); return { id: `local-${order.id}` }; },
  syncSwitch: async (order: { id: string }) => { synced.push(order.id); return { id: `local-${order.id}` }; },
  syncRedemptionPlan: async () => ({ id: "swp-row" }),
  syncPayment: async (payment: { id: number }) => { syncedPayments.push(payment.id); return { id: `pay-${payment.id}` }; },
  syncSwitchPlan: async () => ({ id: "stp-row" }),
}));
mock.module("../src/services/order.service.ts", () => ({
  applyPurchaseUpdate: async (order: { id: string }) => { applied.push(order.id); },
  pullRedemptionPayout: async (localId: string) => { payoutsPulled.push(localId); },
}));
mock.module("../src/services/payment.service.ts", () => ({
  debitInstallment: async (id: string) => { debited.push(id); return "debited"; },
}));

const { collectExitPlanInstallments, collectSipInstallments, reconcileExits, reconcileInFlightPurchases, reconcileOpenPayments } = await import("../src/services/order-reconciler.service.ts");

beforeEach(() => {
  rows = []; plans = []; unpaid = []; lastWhere = undefined;
  applied.length = 0; debited.length = 0; payoutsPulled.length = 0;
  redemptions = []; awaitingPayout = []; switches = []; swps = []; stps = []; synced.length = 0; openPayments = []; syncedPayments.length = 0;
  for (const key of Object.keys(exitInstallmentsByPlan)) delete exitInstallmentsByPlan[key];
  for (const key of Object.keys(installmentsByPlan)) delete installmentsByPlan[key];
});

test("only paid, in-flight orders are swept", async () => {
  await reconcileInFlightPurchases();
  expect(lastWhere?.["state"]).toEqual({ in: ["CONFIRMED", "SUBMITTED"] });
});

test("every row is re-read and applied; allotted ones count as settled", async () => {
  rows = [{ fpId: "mfp_a", mfInvestmentAccountId: "acc" }, { fpId: "mfp_b", mfInvestmentAccountId: "acc" }];
  fpStates["mfp_a"] = "successful";
  fpStates["mfp_b"] = "submitted";
  expect(await reconcileInFlightPurchases()).toEqual({ checked: 2, settled: 1, failed: 0 });
  expect(applied).toEqual(["mfp_a", "mfp_b"]);
});

test("one failing order does not stop the batch", async () => {
  rows = [{ fpId: "mfp_x", mfInvestmentAccountId: "acc" }, { fpId: "mfp_a", mfInvestmentAccountId: "acc" }];
  fpStates["mfp_x"] = "boom";
  fpStates["mfp_a"] = "successful";
  expect(await reconcileInFlightPurchases()).toEqual({ checked: 2, settled: 1, failed: 1 });
  expect(applied).toEqual(["mfp_a"]);
});

test("a SIP's installments are mirrored from FP and each unpaid one is debited", async () => {
  plans = [{ id: "plan-1", fpId: "mfpp_1", mfInvestmentAccountId: "acc" }];
  installmentsByPlan["mfpp_1"] = [{ id: "mfp_i1", state: "submitted" }];
  unpaid = [{ id: "local-i1" }];
  expect(await collectSipInstallments()).toEqual({ plans: 1, installmentsSeen: 1, debited: 1, failed: 0 });
  expect(applied).toEqual(["mfp_i1"]);
  expect(debited).toEqual(["local-i1"]);
});

test("a broken plan does not stop the others being collected", async () => {
  plans = [
    { id: "plan-x", fpId: "mfpp_broken", mfInvestmentAccountId: "acc" },
    { id: "plan-1", fpId: "mfpp_1", mfInvestmentAccountId: "acc" },
  ];
  unpaid = [{ id: "local-i1" }];
  const result = await collectSipInstallments();
  expect(result.failed).toBe(1);
  expect(debited).toEqual(["local-i1"]);
});

test("redemptions and switches are swept; a successful redemption's payout is looked up", async () => {
  redemptions = [{ id: "r1", fpId: "mfr_1", mfInvestmentAccountId: "acc" }];
  awaitingPayout = [{ id: "r2", fpId: "mfr_2", mfInvestmentAccountId: "acc" }];
  switches = [{ id: "s1", fpId: "mfs_1", mfInvestmentAccountId: "acc" }];
  fpStates["mfr_1"] = "submitted";
  fpStates["mfr_2"] = "successful";
  fpStates["mfs_1"] = "successful";
  expect(await reconcileExits()).toEqual({ checked: 3, settled: 2, failed: 0 });
  // Only the successful redemption asks for its payout.
  expect(payoutsPulled).toEqual(["local-mfr_2"]);
});
test("SWP and STP installments are mirrored from FP; a paid-out SWP installment pulls its payout", async () => {
  swps = [{ id: "swp-1", fpId: "mfrp_1", mfInvestmentAccountId: "acc" }];
  stps = [{ id: "stp-1", fpId: "mfsp_1", mfInvestmentAccountId: "acc" }];
  exitInstallmentsByPlan["mfrp_1"] = [{ id: "mfr_i1", state: "successful" }, { id: "mfr_i2", state: "submitted" }];
  exitInstallmentsByPlan["mfsp_1"] = [{ id: "mfs_i1", state: "submitted" }];
  expect(await collectExitPlanInstallments()).toEqual({ plans: 2, installmentsSeen: 3, failed: 0 });
  expect(synced).toEqual(["mfr_i1", "mfr_i2", "mfs_i1"]);
  // Nothing is debited on the way out; only the successful redemption asks for a payout.
  expect(debited).toEqual([]);
  expect(payoutsPulled).toEqual(["local-mfr_i1"]);
});

test("a broken SWP does not stop the STPs being collected", async () => {
  swps = [{ id: "swp-x", fpId: "mfrp_broken", mfInvestmentAccountId: "acc" }];
  stps = [{ id: "stp-1", fpId: "mfsp_1", mfInvestmentAccountId: "acc" }];
  exitInstallmentsByPlan["mfsp_1"] = [{ id: "mfs_i1", state: "submitted" }];
  expect(await collectExitPlanInstallments()).toEqual({ plans: 2, installmentsSeen: 1, failed: 1 });
  expect(synced).toEqual(["mfs_i1"]);
});

test("unsettled payments are re-read; one that reached SUCCESS counts as settled", async () => {
  openPayments = [{ fpId: 1 }, { fpId: 2 }, { fpId: 3 }];
  paymentStates[1] = "SUCCESS";
  paymentStates[2] = "PENDING";
  paymentStates[3] = "boom";
  expect(await reconcileOpenPayments()).toEqual({ checked: 3, settled: 1, failed: 1 });
  expect(syncedPayments).toEqual([1, 2]);
});
