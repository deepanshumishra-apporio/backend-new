// What happens when FP reports a redemption or switch: holdings are pulled
// exactly when the order first turns successful — a sale that never refreshed
// holdings left Holdings offering units already sold. Offline.
import { beforeEach, expect, mock, test } from "bun:test";

let previousState: string | null = null;
let portfolioFails = false;
const calls: string[] = [];

mock.module("../src/db/client.ts", () => ({ db: {
  mfRedemption: { findUnique: async () => (previousState ? { state: previousState } : null) },
  mfSwitch: { findUnique: async () => (previousState ? { state: previousState } : null) },
} }));
mock.module("../src/services/fp-sync/index.ts", () => ({
  syncPurchase: async () => ({ id: "local" }),
  syncRedemption: async () => { calls.push("sync"); return { id: "local" }; },
  syncSwitch: async () => { calls.push("sync"); return { id: "local" }; },
  syncPayoutDetail: async () => {},
  syncFolio: async () => ({ id: "folio-row" }),
}));
mock.module("../src/services/portfolio.service.ts", () => ({
  refreshPortfolio: async () => {
    calls.push("portfolio");
    if (portfolioFails) throw new Error("report timed out");
    return { folios: 1, holdings: 1 };
  },
}));

const { applyRedemptionUpdate, applySwitchUpdate } = await import("../src/services/order.service.ts");
const redemption = (state: string) => ({ id: "mfr_1", state }) as Parameters<typeof applyRedemptionUpdate>[0];
const switchOrder = (state: string) => ({ id: "mfs_1", state }) as Parameters<typeof applySwitchUpdate>[0];

beforeEach(() => { previousState = null; portfolioFails = false; calls.length = 0; });

test("no holdings pull while a redemption is on its way", async () => {
  for (const state of ["under_review", "pending", "confirmed", "submitted"]) {
    await applyRedemptionUpdate(redemption(state), "acc");
  }
  expect(calls).toEqual(["sync", "sync", "sync", "sync"]);
});

test("a redemption turning successful pulls holdings once", async () => {
  previousState = "SUBMITTED";
  await applyRedemptionUpdate(redemption("successful"), "acc");
  expect(calls).toEqual(["sync", "portfolio"]);
});

test("a redemption already successful is not pulled again on every poll", async () => {
  previousState = "SUCCESSFUL";
  await applyRedemptionUpdate(redemption("successful"), "acc");
  expect(calls).toEqual(["sync"]);
});

test("a switch turning successful pulls holdings — units moved between schemes", async () => {
  previousState = "SUBMITTED";
  await applySwitchUpdate(switchOrder("successful"), "acc");
  expect(calls).toEqual(["sync", "portfolio"]);
});

test("a failed holdings pull does not fail the status check", async () => {
  previousState = "SUBMITTED";
  portfolioFails = true;
  await expect(applyRedemptionUpdate(redemption("successful"), "acc")).resolves.toEqual({ id: "local" });
});
