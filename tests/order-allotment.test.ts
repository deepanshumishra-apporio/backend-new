// What happens when FP reports a purchase: the folio and holdings are pulled
// exactly when the order first turns successful, and never before. Offline.
import { beforeEach, expect, mock, test } from "bun:test";

let linkedFolioId: string | null = null;
let previousState: string | null = null;
let portfolioFails = false;
const calls: string[] = [];

mock.module("../src/db/client.ts", () => ({ db: {
  mfPurchase: { findUnique: async () => ({ state: previousState, mfFolioId: linkedFolioId }) },
} }));
mock.module("../src/services/fp-sync/index.ts", () => ({
  syncPurchase: async () => { calls.push("sync"); return { id: "local" }; },
  syncRedemption: async () => ({ id: "local" }),
  syncSwitch: async () => ({ id: "local" }),
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

const { applyPurchaseUpdate } = await import("../src/services/order.service.ts");
const order = (state: string, folio: string | null) =>
  ({ id: "mfp_1", state, folio_number: folio }) as Parameters<typeof applyPurchaseUpdate>[0];

beforeEach(() => { linkedFolioId = null; previousState = null; portfolioFails = false; calls.length = 0; });

test("no folio pull while the order is still on its way", async () => {
  for (const state of ["under_review", "pending", "confirmed", "submitted"]) {
    await applyPurchaseUpdate(order(state, null), "acc");
  }
  expect(calls).toEqual(["sync", "sync", "sync", "sync"]);
});

test("first successful sync pulls folio + holdings, then re-links the order", async () => {
  await applyPurchaseUpdate(order("successful", "J3T1HYHW9CHKT"), "acc");
  expect(calls).toEqual(["sync", "portfolio", "sync"]);
});

test("an order already successful and linked is not pulled again", async () => {
  linkedFolioId = "folio-row";
  previousState = "SUCCESSFUL";
  await applyPurchaseUpdate(order("successful", "J3T1HYHW9CHKT"), "acc");
  expect(calls).toEqual(["sync"]);
});

test("a failed portfolio pull does not fail the status check", async () => {
  portfolioFails = true;
  await expect(applyPurchaseUpdate(order("successful", "J3T1HYHW9CHKT"), "acc")).resolves.toBeUndefined();
});

test("a top-up into a folio we already know still refreshes holdings once, on success", async () => {
  linkedFolioId = "folio-row";
  previousState = "SUBMITTED";
  await applyPurchaseUpdate(order("successful", "ULYVG0HO483VV"), "acc");
  expect(calls).toEqual(["sync", "portfolio", "sync"]);
});