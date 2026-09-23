// Which folio a new purchase or SIP is sent with. Offline: the database and FP
// are stubbed, so this checks the decision, not the queries.
import { beforeEach, expect, mock, test } from "bun:test";

type Folio = { number: string; createdAt: Date; purchases: { id: string }[] };
let folios: Folio[] = [];
let allotted: { folioNumber: string } | null = null;
let awaiting: { id: string } | null = null;
let fpFolios: { number: string }[] = [];
/** What the mirror knows about a folio the caller named; null = never mirrored. */
let namedFolio: { amcCode: string | null; purchases: { scheme: { amcId: string } | null }[] } | null = null;
const synced: string[] = [];

mock.module("../src/db/client.ts", () => ({ db: {
  mfScheme: {
    findUnique: async () => ({ amcId: "amc-icici", amc: { code: "P", name: "ICICI Prudential" } }),
    findMany: async () => [],
  },
  mfHolding: { findMany: async () => [] },
  mfFolio: {
    findMany: async () => folios,
    findUnique: async () => namedFolio,
  },
  mfPurchase: {
    findFirst: async (args: { where: { folioNumber: unknown } }) =>
      args.where.folioNumber === null ? awaiting : allotted,
  },
  mfInvestmentAccount: { findUnique: async () => ({ fpId: "mfia_1" }) },
} }));
mock.module("../src/integrations/fp/index.ts", () => ({
  fpAccounts: { listFolios: async () => fpFolios },
  fpErrorToHttpError: (error: unknown) => { throw error; },
}));
mock.module("../src/services/fp-sync/index.ts", () => ({
  syncFolio: async (folio: { number: string }) => {
    synced.push(folio.number);
    folios.push({ number: folio.number, createdAt: new Date(), purchases: [] });
    return { id: "local" };
  },
}));

const { pickFolio, resolvePurchaseFolio } = await import("../src/services/folio-resolution.service.ts");

beforeEach(() => {
  folios = []; allotted = null; awaiting = null; fpFolios = []; synced.length = 0; namedFolio = null;
});

test("first investment at the AMC is sent without a folio", async () => {
  expect(await resolvePurchaseFolio("acc", "INF109K01Z48")).toBeUndefined();
});

test("a folio the caller named is kept", async () => {
  folios = [{ number: "OTHER", createdAt: new Date(), purchases: [] }];
  expect(await resolvePurchaseFolio("acc", "INF109K01Z48", "NAMED")).toBe("NAMED");
});

test("a second SIP with no folio named reuses the existing one at the AMC", async () => {
  folios = [{ number: "12345/67", createdAt: new Date(), purchases: [{ id: "p1" }] }];
  expect(await resolvePurchaseFolio("acc", "INF109K01Z48")).toBe("12345/67");
});

test("an allotted folio not yet mirrored is pulled from FP and reused", async () => {
  allotted = { folioNumber: "99887/11" };
  fpFolios = [{ number: "99887/11" }];
  expect(await resolvePurchaseFolio("acc", "INF109K01Z48")).toBe("99887/11");
  expect(synced).toEqual(["99887/11"]);
});

test("refuses while the first paid order is still waiting for its folio", async () => {
  awaiting = { id: "order-1" };
  await expect(resolvePurchaseFolio("acc", "INF109K01Z48")).rejects.toThrow("still being allotted");
});

test("prefers the folio already holding the scheme, then the oldest", () => {
  const old = new Date("2025-01-01");
  const recent = new Date("2026-01-01");
  expect(pickFolio([
    { number: "A", holdsScheme: false, createdAt: old },
    { number: "B", holdsScheme: true, createdAt: recent },
  ])).toBe("B");
  expect(pickFolio([
    { number: "A", holdsScheme: false, createdAt: recent },
    { number: "B", holdsScheme: false, createdAt: old },
  ])).toBe("B");
  expect(pickFolio([])).toBeUndefined();
});

test("a named folio at the same fund house is kept", async () => {
  namedFolio = { amcCode: "P", purchases: [] };
  expect(await resolvePurchaseFolio("acc", "INF109K01Z48", "NAMED")).toBe("NAMED");
});

test("a named folio at another fund house is refused, by AMC code or by what it holds", async () => {
  namedFolio = { amcCode: "H", purchases: [] };
  await expect(resolvePurchaseFolio("acc", "INF109K01Z48", "HDFC-FOLIO")).rejects.toThrow("not with ICICI Prudential");
  namedFolio = { amcCode: null, purchases: [{ scheme: { amcId: "amc-hdfc" } }] };
  await expect(resolvePurchaseFolio("acc", "INF109K01Z48", "HDFC-FOLIO")).rejects.toThrow("one fund house");
});

test("a named folio the mirror knows nothing about passes through to FP", async () => {
  namedFolio = { amcCode: null, purchases: [] };
  expect(await resolvePurchaseFolio("acc", "INF109K01Z48", "BARE")).toBe("BARE");
});
