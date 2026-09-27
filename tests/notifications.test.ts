// Which order states raise a notification, under which key, and the one-week
// window that keeps a first sync from replaying history. Offline: db stubbed.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Prisma } from "../generated/prisma/client.ts";

let raised: { dedupeKey: string; title: string; category: string; createdAt: Date }[] = [];
let purchase: Record<string, unknown> | null = null;

mock.module("../src/db/client.ts", () => ({ db: {
  notification: {
    createMany: async ({ data }: { data: typeof raised }) => {
      for (const row of data) if (!raised.some((r) => r.dedupeKey === row.dedupeKey)) raised.push(row);
      return { count: data.length };
    },
  },
  userInvestorProfile: { findFirst: async () => ({ userId: "u" }) },
  mfPurchase: { findUnique: async () => purchase },
} }));

const { notify, notifyPurchase } = await import("../src/services/notification.service.ts");

const order = (extra: Record<string, unknown>) => ({
  state: "PENDING", amount: new Prisma.Decimal(5000), allottedUnits: null, purchasedPrice: null, failureCode: null,
  planId: null, mfInvestmentAccountId: "a", createdAt: new Date(), fpCreatedAt: new Date(), succeededAt: new Date(),
  failedAt: new Date(), cancelledAt: null, reversedAt: null, scheme: { name: "Test Fund" }, ...extra,
});

beforeEach(() => {
  raised = [];
  purchase = null;
});

describe("order notifications", () => {
  test("placing, then allotment, raise one each — however often they sync", async () => {
    purchase = order({ state: "UNDER_REVIEW" });
    await notifyPurchase("o");
    purchase = order({ state: "PENDING" });
    await notifyPurchase("o");
    purchase = order({ state: "SUCCESSFUL", allottedUnits: new Prisma.Decimal("12.5") });
    await notifyPurchase("o");
    await notifyPurchase("o");
    expect(raised.map((r) => r.dedupeKey)).toEqual(["order:o:placed", "order:o:successful"]);
    expect(raised[1]!.title).toBe("Units allotted");
  });
  test("a failure needs the investor's attention", async () => {
    purchase = order({ state: "FAILED", failureCode: "payment_failure" });
    await notifyPurchase("o");
    expect(raised[0]!.category).toBe("ACTION");
  });
  test("a SIP instalment is not announced as an order the investor placed", async () => {
    purchase = order({ state: "PENDING", planId: "p" });
    await notifyPurchase("o");
    expect(raised).toHaveLength(0);
    purchase = order({ state: "SUCCESSFUL", planId: "p" });
    await notifyPurchase("o");
    expect(raised[0]!.title).toBe("SIP instalment invested");
  });
});

describe("the one-week window", () => {
  test("an event older than a week is not raised", async () => {
    await notify({
      userId: "u", category: "ORDER", title: "Old", body: "", dedupeKey: "old",
      at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    expect(raised).toHaveLength(0);
  });
});
