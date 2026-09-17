import { beforeEach, expect, mock, test } from "bun:test";

let sandbox = true;
let state = "PENDING";
const calls: unknown[] = [];
const consent = { email: "investor@example.com", mobile: "9999999999", isd_code: "91" };
let consentAt: Date | null = null;
mock.module("../src/db/client.ts", () => ({ db: {
  mfInvestmentAccount: { findUniqueOrThrow: async () => ({ primaryInvestorProfileId: "profile" }) },
  bankAccount: { findFirst: async () => ({ fpId: "bank" }) },
  mfPurchase: {
  findUnique: async () => ({ fpId: "mfp_test", fpOldId: 227, state, amount: "100",
    consentAt, folioNumber: "existing-folio", mfInvestmentAccountId: "account" }),
  update: async () => { calls.push("save-consent"); },
}, mfRedemption: {
  findUnique: async () => ({ fpId: "mfr_test", fpOldId: 123, state,
    folioNumber: "folio", mfInvestmentAccountId: "account" }),
  update: async () => { calls.push("save-consent"); },
} } }));
mock.module("../src/integrations/fp/index.ts", () => ({
  fpConfig: () => ({ simulationEnabled: sandbox }),
  fpProfiles: { fetchBankAccount: async () => ({ account_number: "999900002222", ifsc_code: "UTIB0003098" }) },
  fpErrorToHttpError: (error: unknown) => { throw error; },
  fpOrders: {
    updatePurchase: async (body: unknown) => { calls.push(body); },
    fetchPurchase: async () => ({ id: "mfp_test", state: "successful", folio_number: "existing-folio" }),
    updateRedemption: async (body: unknown) => { calls.push(body); },
    fetchRedemption: async () => ({ id: "mfr_test", state: "successful" }),
  },
  fpSettlements: { createSettlementDetail: async (body: unknown) => { calls.push({ settlement: body }); } },
  fpSimulation: { simulateOrder: async (id: number, status: string) => { calls.push([id, status]); } },
}));
mock.module("../src/services/fp-sync/index.ts", () => ({
  syncPurchase: async () => {}, syncSwitch: async () => {},
  syncRedemption: async () => ({ id: "local" }),
}));
mock.module("../src/services/order.service.ts", () => ({
  resolveConsentContact: async () => ({ email: consent.email, mobile: consent.mobile, isdCode: "91" }),
  sendConsent: async (_contact: unknown, send: (value: typeof consent) => Promise<unknown>) => send(consent),
  pullRedemptionPayout: async () => { calls.push("payout"); },
  refreshOrder: async () => ({ state: "SUCCESSFUL" }),
  getOrder: async () => ({ state: "SUCCESSFUL" }),
}));
const { settleRedemption, settlePurchase } = await import("../src/services/sandbox-settle.service.ts");
beforeEach(() => { sandbox = true; state = "PENDING"; consentAt = null; calls.length = 0; });

test("purchase records consent alone, settlement, state alone, then allotment", async () => {
  expect((await settlePurchase("local")).state).toBe("SUCCESSFUL");
  expect(calls).toEqual([
    { id: "mfp_test", consent }, "save-consent",
    { settlement: { mf_purchase: "mfp_test", payment_type: "netbanking",
      bank_account_number: "999900002222", bank_ifsc: "UTIB0003098",
      beneficiary_account_number: "1233453", beneficiary_account_title: "Sandbox MF Collection A/c",
      beneficiary_bank_name: "Sandbox Bank", utr_number: "SBX227" } },
    { id: "mfp_test", state: "confirmed" },
    [227, "SUBMITTED"], [227, "SUCCESSFUL"],
  ]);
}, 10000);

test("purchase resumes submitted orders without repeating settlement or submission", async () => {
  state = "SUBMITTED";
  consentAt = new Date();
  await settlePurchase("local");
  expect(calls).toEqual([[227, "SUCCESSFUL"]]);
});

test("redemption sends combined consent and state, then simulates with old_id in order", async () => {
  expect((await settleRedemption("local")).state).toBe("SUCCESSFUL");
  expect(calls).toEqual([
    { id: "mfr_test", state: "confirmed", consent }, "save-consent",
    [123, "SUBMITTED"], [123, "SUCCESSFUL"], "payout",
  ]);
});

test("production refuses simulation before any order mutation", async () => {
  sandbox = false;
  await expect(settleRedemption("local")).rejects.toThrow("sandbox-only");
  expect(calls).toEqual([]);
});

test("successful redemptions are not simulated again", async () => {
  state = "SUCCESSFUL";
  await settleRedemption("local");
  expect(calls).toEqual([]);
});
