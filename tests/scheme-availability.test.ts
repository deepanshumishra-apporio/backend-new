// FP's live scheme flags: refused on what FP reports closed, and written back
// to the catalogue so a closed fund leaves the fund list. Offline: FP and the
// database are stubbed.
import { beforeEach, expect, mock, test } from "bun:test";

type Live = Record<string, unknown>;
const open = (isin: string): Live => ({
  isin, name: `Fund ${isin}`, active: true, merged: false, merged_to_isin: null,
  purchase_allowed: true, redemption_allowed: true, sip_allowed: true,
  switch_in_allowed: true, switch_out_allowed: true, swp_allowed: true, stp_in_allowed: true, stp_out_allowed: true,
});

let live: Record<string, Live> = {};
/** The ONDC scheme plan's threshold types per ISIN; absent means lumpsum + sip. */
let plans: Record<string, string[] | "missing" | "down"> = {};
let failing = new Set<string>();
const written: { isin: string; data: Record<string, unknown> }[] = [];
let stale: { isin: string }[] = [];
/** Full ONDC limit blocks per ISIN, when a test cares about their values. */
let blocks: Record<string, Record<string, unknown>[]> = {};
/** Periodic limit rows as the mirror holds them, keyed `TYPE/FREQUENCY`. */
let thresholds = new Map<string, Record<string, unknown>>();

mock.module("../src/db/client.ts", () => ({ db: {
  mfScheme: {
    updateMany: async ({ where, data }: { where: { isin: string }; data: Record<string, unknown> }) => {
      written.push({ isin: where.isin, data });
      return { count: 1 };
    },
    findMany: async () => stale,
    findUnique: async ({ where }: { where: { isin: string } }) => ({ id: `scheme-${where.isin}` }),
  },
  mfSchemeThreshold: {
    deleteMany: ({ where }: { where: { NOT: { type: string; frequency: string }[] } }) => {
      const keep = new Set(where.NOT.map((row) => `${row.type}/${row.frequency}`));
      for (const key of [...thresholds.keys()]) if (!keep.has(key)) thresholds.delete(key);
    },
    upsert: ({ create }: { create: Record<string, unknown> }) => {
      thresholds.set(`${create["type"]}/${create["frequency"]}`, create);
    },
  },
  $transaction: async (operations: unknown[]) => operations,
} }));
class FpApiError extends Error {
  constructor(readonly status: number) { super(`FP ${status}`); }
  get isClientError() { return this.status >= 400 && this.status < 500 && this.status !== 429; }
}
mock.module("../src/integrations/fp/index.ts", () => ({
  FpApiError,
  fpCatalogue: {
    fetchOndcSchemePlan: async (isin: string) => {
      const plan = plans[isin] ?? ["lumpsum", "withdrawal", "sip"];
      if (plan === "missing") throw new FpApiError(404);
      if (plan === "down") throw new FpApiError(503);
      return { object: "mf_scheme_plan", gateway: "cybrillapoa", isin, active: true, thresholds: blocks[isin] ?? plan.map((type) => ({ type })) };
    },
    fetchFundScheme: async (isin: string) => {
      if (failing.has(isin)) throw new Error("FP timed out");
      return live[isin];
    },
  },
  fpErrorToHttpError: (error: unknown) => { throw error; },
}));

const { assertLiveCapability, refreshCatalogueFlags, refreshIfStale } = await import(
  "../src/services/scheme-availability.service.ts"
);

beforeEach(() => {
  live = {}; plans = {}; failing = new Set(); written.length = 0; stale = [];
  blocks = {}; thresholds = new Map();
});

test("an open fund passes, and its flags are written back", async () => {
  live["INF1"] = open("INF1");
  await expect(assertLiveCapability("INF1", "purchase")).resolves.toBeUndefined();
  expect(written[0]?.data).toMatchObject({ isActive: true, purchaseAllowed: true, sipAllowed: true });
});

test("a fund the AMC closed is refused by name, and marked closed in the catalogue", async () => {
  live["INF1"] = { ...open("INF1"), active: false, purchase_allowed: false, sip_allowed: false };
  await expect(assertLiveCapability("INF1", "purchase")).rejects.toThrow("Fund INF1 is no longer available");
  expect(written[0]?.data).toMatchObject({ isActive: false, purchaseAllowed: false });
});

test("a closed capability names what is closed", async () => {
  live["INF1"] = { ...open("INF1"), sip_allowed: false };
  await expect(assertLiveCapability("INF1", "sip")).rejects.toThrow("not accepting new SIPs");
  await expect(assertLiveCapability("INF1", "purchase")).resolves.toBeUndefined();
});

test("a merged fund points at its successor", async () => {
  live["INF1"] = { ...open("INF1"), merged: true, merged_to_isin: "INF2" };
  await expect(assertLiveCapability("INF1", "redemption")).rejects.toThrow("merged into INF2");
});

test("an FP failure at order time is an error, never a silent pass", async () => {
  failing.add("INF1");
  await expect(assertLiveCapability("INF1", "purchase")).rejects.toThrow("FP timed out");
  expect(written).toEqual([]);
});

test("a detail read refreshes only stale flags, and survives FP being down", async () => {
  live["INF1"] = open("INF1");
  expect(await refreshIfStale("INF1", new Date())).toBe(false);
  expect(await refreshIfStale("INF1", new Date(Date.now() - 2 * 60 * 60 * 1000))).toBe(true);
  failing.add("INF1");
  expect(await refreshIfStale("INF1", new Date(0))).toBe(false);
});

test("the catalogue sweep refreshes stale schemes; a failing one is pushed back, not retried in a loop", async () => {
  stale = [{ isin: "INF1" }, { isin: "INF2" }];
  live["INF1"] = open("INF1");
  failing.add("INF2");
  expect(await refreshCatalogueFlags()).toEqual({ checked: 2, failed: 1 });
  expect(written.map((w) => w.isin)).toEqual(["INF1", "INF2"]);
  expect(Object.keys(written[1]!.data)).toEqual(["syncedAt"]);
});

test("a fund whose ONDC plan offers no lumpsum or SIP is refused and marked closed for both", async () => {
  // INF109KC11U2 in the sandbox: fund_schemes says purchase_allowed, the ONDC
  // plan has only withdrawal/switch/swp/stp, and FP refuses the order.
  live["INF1"] = open("INF1");
  plans["INF1"] = ["withdrawal", "switch_in", "switch_out", "swp", "stp_in", "stp_out"];
  await expect(assertLiveCapability("INF1", "purchase")).rejects.toThrow("not open for purchases");
  expect(written[0]?.data).toMatchObject({ purchaseAllowed: false, sipAllowed: false, redemptionAllowed: true });
  await expect(assertLiveCapability("INF1", "redemption")).resolves.toBeUndefined();
});

test("a scheme the ONDC route does not carry cannot be bought there", async () => {
  live["INF1"] = open("INF1");
  plans["INF1"] = "missing";
  await expect(assertLiveCapability("INF1", "purchase")).rejects.toThrow("not open for purchases");
});

test("an ONDC plan outage is an error at order time, not a guess either way", async () => {
  live["INF1"] = open("INF1");
  plans["INF1"] = "down";
  await expect(assertLiveCapability("INF1", "purchase")).rejects.toThrow("FP 503");
  expect(written).toEqual([]);
});

test("the ONDC plan's SIP, SWP and STP limits replace whatever the seed had", async () => {
  // INF109KC19T7 in the sandbox: seeded from fund_schemes with no SIP/SWP/STP
  // limits at all, while its ONDC plan offers all three monthly — so every SIP
  // on it was refused locally before FP was ever asked.
  thresholds.set("SIP/QUARTERLY", { type: "SIP", frequency: "QUARTERLY" });
  live["INF1"] = open("INF1");
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  blocks["INF1"] = [
    { type: "lumpsum", amount_min: 5000 },
    { type: "sip", frequency: "monthly", amount_min: 100, amount_max: 999999999, amount_multiples: 1, installments_min: 6, dates: days },
    { type: "sip", frequency: "daily", amount_min: 100, installments_min: 6, dates: [] },
    { type: "swp", frequency: "monthly", amount_min: 1, installments_min: 2, dates: days },
    { type: "stp_in", frequency: "monthly", amount_min: 1000, installments_min: 6, dates: days },
    { type: "stp_out", frequency: "monthly", amount_min: 1000, installments_min: 6, dates: days },
    { type: "sip", frequency: "fortnightly_someday", amount_min: 1 },
  ];
  await expect(assertLiveCapability("INF1", "sip")).resolves.toBeUndefined();
  expect([...thresholds.keys()].sort()).toEqual(["SIP/DAILY", "SIP/MONTHLY", "STP/MONTHLY", "SWP/MONTHLY"]);
  expect(thresholds.get("SIP/MONTHLY")).toMatchObject({
    schemeId: "scheme-INF1", amountMin: "100", amountMax: "999999999", amountMultiples: "1", installmentsMin: 6, allowedDates: days,
  });
  // The source side of an STP, not the target's switch-in minimum.
  expect(thresholds.get("STP/MONTHLY")).toMatchObject({ amountMin: "1000" });
});

test("limits are left alone when the ONDC plan could not be read", async () => {
  thresholds.set("SIP/MONTHLY", { type: "SIP", frequency: "MONTHLY" });
  live["INF1"] = open("INF1");
  plans["INF1"] = "missing";
  await expect(assertLiveCapability("INF1", "purchase")).rejects.toThrow("not open for purchases");
  expect([...thresholds.keys()]).toEqual(["SIP/MONTHLY"]);
});
