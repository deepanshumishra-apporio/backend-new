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
let failing = new Set<string>();
const written: { isin: string; data: Record<string, unknown> }[] = [];
let stale: { isin: string }[] = [];

mock.module("../src/db/client.ts", () => ({ db: {
  mfScheme: {
    updateMany: async ({ where, data }: { where: { isin: string }; data: Record<string, unknown> }) => {
      written.push({ isin: where.isin, data });
      return { count: 1 };
    },
    findMany: async () => stale,
  },
} }));
mock.module("../src/integrations/fp/index.ts", () => ({
  fpCatalogue: {
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
  live = {}; failing = new Set(); written.length = 0; stale = [];
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
