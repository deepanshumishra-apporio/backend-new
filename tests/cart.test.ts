// The cart's own rules — what may go in, and the one-code consent refusing a
// checkout before FP has reviewed it. Offline: the database is a stub.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Prisma } from "../generated/prisma/client.ts";

type Scheme = { id: string; name: string; isActive: boolean; purchaseAllowed: boolean; sipAllowed: boolean };
let schemes: Record<string, Scheme> = {};
let items: { id: string; userId: string; schemeId: string; type: string; amount: Prisma.Decimal }[] = [];
let checkout: Record<string, unknown> | null = null;
let orderState = "UNDER_REVIEW";
let consumed = 0;

const scheme = (isin: string, extra: Partial<Scheme> = {}): Scheme => ({
  id: `s-${isin}`, name: `Fund ${isin}`, isActive: true, purchaseAllowed: true, sipAllowed: true, ...extra,
});

mock.module("../src/db/client.ts", () => ({ db: {
  mfScheme: {
    findUnique: async ({ where }: { where: { isin: string } }) => schemes[where.isin] ?? null,
    findMany: async () => [],
  },
  cartItem: {
    count: async ({ where }: { where: { userId: string; type?: string } }) =>
      items.filter((i) => i.userId === where.userId && (!where.type || i.type === where.type)).length,
    findUnique: async ({ where }: { where: { userId_schemeId_type: { userId: string; schemeId: string; type: string } } }) => {
      const key = where.userId_schemeId_type;
      return items.find((i) => i.userId === key.userId && i.schemeId === key.schemeId && i.type === key.type) ?? null;
    },
    upsert: async ({ where, create, update }: {
      where: { userId_schemeId_type: { userId: string; schemeId: string; type: string } };
      create: { userId: string; schemeId: string; type: string; amount: Prisma.Decimal };
      update: { amount: Prisma.Decimal };
    }) => {
      const key = where.userId_schemeId_type;
      const found = items.find((i) => i.userId === key.userId && i.schemeId === key.schemeId && i.type === key.type);
      if (found) found.amount = update.amount;
      else items.push({ id: `i${items.length}`, ...create });
    },
    findMany: async () => [],
  },
  cartCheckout: { findFirst: async () => checkout },
  mfPurchase: {
    findMany: async () => [{ id: "o", state: orderState, failureCode: null, folioNumber: null }],
  },
  mfPurchasePlan: { findMany: async () => [] },
  paymentPurchase: { findFirst: async () => null },
} }));
mock.module("../src/services/otp.service.ts", () => ({
  consumeVerificationToken: async () => {
    consumed++;
    return { phone: "+919999999999", purpose: "TRANSACTION_APPROVAL", verifiedAt: "" };
  },
}));

const cart = await import("../src/services/cart.service.ts");

beforeEach(() => {
  schemes = { INF000000001: scheme("INF000000001"), INF000000002: scheme("INF000000002", { sipAllowed: false }) };
  items = [];
  checkout = null;
  consumed = 0;
  orderState = "UNDER_REVIEW";
});

describe("adding to the cart", () => {
  test("the same fund and type edits the line instead of stacking a second", async () => {
    await cart.putCartItem({ userId: "u", isin: "INF000000001", type: "SIP", amount: "1000" });
    await cart.putCartItem({ userId: "u", isin: "INF000000001", type: "SIP", amount: "2500" });
    expect(items).toHaveLength(1);
    expect(items[0]!.amount.toFixed(2)).toBe("2500.00");
  });
  test("a SIP on a fund that takes none is refused", async () => {
    await expect(
      cart.putCartItem({ userId: "u", isin: "INF000000002", type: "SIP", amount: "1000" }),
    ).rejects.toThrow("does not take SIPs");
  });
  test("an unknown or closed fund is refused", async () => {
    schemes["INF000000003"] = scheme("INF000000003", { isActive: false });
    await expect(
      cart.putCartItem({ userId: "u", isin: "INF000000003", type: "LUMPSUM", amount: "1000" }),
    ).rejects.toThrow("No such fund");
  });
  test("no more than ten one-time lines — FP pays at most ten orders together", async () => {
    for (let n = 0; n < 10; n++) {
      schemes[`INF10000000${n}`] = scheme(`INF10000000${n}`);
      await cart.putCartItem({ userId: "u", isin: `INF10000000${n}`, type: "LUMPSUM", amount: "1000" });
    }
    await expect(
      cart.putCartItem({ userId: "u", isin: "INF000000001", type: "LUMPSUM", amount: "1000" }),
    ).rejects.toThrow("At most 10");
  });
});

describe("one code for the whole checkout", () => {
  test("is not spent while FP has not reviewed anything", async () => {
    checkout = {
      id: "c", userId: "u", mfInvestmentAccountId: "a", mandateId: null, installmentDay: null,
      consentedAt: null, createdAt: new Date(),
      items: [{ id: "l", isin: "INF000000001", type: "LUMPSUM", amount: new Prisma.Decimal(1000),
        error: null, mfPurchaseId: "o", mfPurchasePlanId: null }],
    };
    await expect(cart.consentCheckout("u", "c", "token")).rejects.toThrow("Wait for provider review");
    expect(consumed).toBe(0);
  });
  test("is issued and spent under the checkout's own context", () => {
    expect(cart.checkoutContext("c")).toBe("cart:c");
  });
});
