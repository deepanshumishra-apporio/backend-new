// The rules that guard money leaving a folio — one-off switches, SWPs and
// STPs — and the payment ownership check. Offline: the database is a stub.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Prisma } from "../generated/prisma/client.ts";

type Scheme = {
  isin: string;
  name: string;
  amcId: string;
  isActive: boolean;
  merged: boolean;
  mergedToIsin: string | null;
  purchaseAllowed: boolean;
  redemptionAllowed: boolean;
  switchInAllowed: boolean;
  switchOutAllowed: boolean;
  sipAllowed: boolean;
};

const open = (isin: string): Scheme => ({
  isin, name: `Fund ${isin}`, amcId: "amc-icici", isActive: true, merged: false, mergedToIsin: null,
  purchaseAllowed: true, redemptionAllowed: true, switchInAllowed: true, switchOutAllowed: true, sipAllowed: true,
});

let schemes: Record<string, Scheme> = {};
/** `${isin}:${type}` -> threshold, frequency ignored (every test plan is MONTHLY). */
let thresholds: Record<string, { amountMin: Prisma.Decimal | null }> = {};
let payment: { provider: string | null; purchases: { mfPurchaseId: string }[] } | null = null;

const threshold = (min: string | null) => ({
  amountMin: min === null ? null : new Prisma.Decimal(min),
  amountMax: null, amountMultiples: null, unitsMin: null, unitsMax: null, unitsMultiples: null,
  installmentsMin: null, allowedDates: [],
});

mock.module("../src/db/client.ts", () => ({ db: {
  mfScheme: { findUnique: async ({ where }: { where: { isin: string } }) => schemes[where.isin] ?? null },
  mfSchemeThreshold: {
    findMany: async ({ where }: { where: { scheme: { isin: string }; type: string } }) =>
      thresholds[`${where.scheme.isin}:${where.type}`] ? [{ frequency: "MONTHLY" }] : [],
    findFirst: async ({ where }: { where: { scheme: { isin: string }; type: string } }) => {
      const found = thresholds[`${where.scheme.isin}:${where.type}`];
      return found ? { ...threshold(null), ...found } : null;
    },
  },
  payment: { findUnique: async () => payment },
  mfPurchase: { findUnique: async () => ({ gateway: "ONDC", mfInvestmentAccountId: "01a0cec9-5f28-7219-b721-5cc772862106" }) },
  mfRedemption: { findUnique: async () => null },
  mfSwitch: { findUnique: async () => null },
  mfInvestmentAccount: { findFirst: async () => ({ id: "acc" }) },
} }));

const { assertAmountOrUnits, validatePlan, validateSwitch } = await import("../src/services/scheme-rules.service.ts");
const { assertExitPlanSchedule, planCancellationPayload } = await import("../src/services/sip-validation.ts");
const { ownResource } = await import("../src/middleware/investor-ownership.ts");

const PAYMENT_ID = "01a0cec9-e33b-70ba-942d-4785796f3c47";
const OUT = "INF000000001";
const IN = "INF000000002";
const plan = (extra: Record<string, unknown> = {}) => ({
  isin: OUT, frequency: "MONTHLY" as const, installmentDay: 5, numberOfInstallments: 6, amount: "1000", ...extra,
});

beforeEach(() => {
  schemes = { [OUT]: open(OUT), [IN]: open(IN) };
  thresholds = { [`${OUT}:SWP`]: threshold(null), [`${OUT}:STP`]: threshold(null) };
  payment = null;
});

describe("amount or units", () => {
  test("exactly one is required", () => {
    expect(() => assertAmountOrUnits("100", undefined, "A plan")).not.toThrow();
    expect(() => assertAmountOrUnits(undefined, "1.5", "A plan")).not.toThrow();
    expect(() => assertAmountOrUnits("100", "1.5", "A plan")).toThrow("not both");
    expect(() => assertAmountOrUnits(undefined, undefined, "A plan")).toThrow("A plan needs");
  });
});

describe("STP target scheme", () => {
  test("a valid pair passes", async () => {
    await expect(validatePlan("STP", plan({ switchInIsin: IN }))).resolves.toBeUndefined();
  });
  test("a plan with no target, or into itself, is refused", async () => {
    await expect(validatePlan("STP", plan())).rejects.toThrow("target scheme");
    await expect(validatePlan("STP", plan({ switchInIsin: OUT }))).rejects.toThrow("into itself");
  });
  test("a target that refuses switch-ins, or has closed, is refused", async () => {
    schemes[IN] = { ...open(IN), switchInAllowed: false };
    await expect(validatePlan("STP", plan({ switchInIsin: IN }))).rejects.toThrow("switching in");
    schemes[IN] = { ...open(IN), isActive: false };
    await expect(validatePlan("STP", plan({ switchInIsin: IN }))).rejects.toThrow("no longer active");
  });
  test("a target at a different fund house is refused — a switch stays in one folio", async () => {
    schemes[IN] = { ...open(IN), amcId: "amc-hdfc" };
    await expect(validatePlan("STP", plan({ switchInIsin: IN }))).rejects.toThrow("different fund houses");
    await expect(validateSwitch(OUT, IN, "1000", undefined)).rejects.toThrow("different fund houses");
  });
  test("a source that refuses switch-outs is refused", async () => {
    schemes[OUT] = { ...open(OUT), switchOutAllowed: false };
    await expect(validatePlan("STP", plan({ switchInIsin: IN }))).rejects.toThrow("switching out");
  });
  test("an installment below the target's entry minimum is refused", async () => {
    thresholds[`${IN}:SWITCH_IN`] = { amountMin: new Prisma.Decimal("5000") };
    await expect(validatePlan("STP", plan({ switchInIsin: IN }))).rejects.toThrow("at least 5000.00");
  });
  test("amount and units together are refused", async () => {
    await expect(validatePlan("STP", plan({ switchInIsin: IN, units: "2" }))).rejects.toThrow("not both");
  });
});

describe("SWP scheme rules", () => {
  test("a scheme closed to redemptions is refused", async () => {
    schemes[OUT] = { ...open(OUT), redemptionAllowed: false };
    await expect(validatePlan("SWP", plan())).rejects.toThrow("not open for redemptions");
  });
  test("an SWP needs exactly one of amount and units", async () => {
    await expect(validatePlan("SWP", plan({ amount: undefined }))).rejects.toThrow("needs either");
    await expect(validatePlan("SWP", plan({ units: "2" }))).rejects.toThrow("not both");
    await expect(validatePlan("SWP", plan({ amount: undefined, units: "2" }))).resolves.toBeUndefined();
  });
});

describe("one-off switch keeps its rules after the refactor", () => {
  test("pair, amount-or-units and switch-in minimum all still apply", async () => {
    await expect(validateSwitch(OUT, OUT, "100", undefined)).rejects.toThrow("into itself");
    await expect(validateSwitch(OUT, IN, undefined, undefined)).rejects.toThrow("A switch needs");
    thresholds[`${IN}:SWITCH_IN`] = { amountMin: new Prisma.Decimal("500") };
    await expect(validateSwitch(OUT, IN, "100", undefined)).rejects.toThrow("at least 500.00");
    await expect(validateSwitch(OUT, IN, "500", undefined)).resolves.toBeUndefined();
  });
});

describe("SWP / STP schedule", () => {
  test("monthly only, with a payout day between 1 and 28", () => {
    expect(() => assertExitPlanSchedule("SWP", "MONTHLY", 5, 6)).not.toThrow();
    expect(() => assertExitPlanSchedule("STP", "DAILY", undefined, 6)).toThrow("monthly frequency only");
    for (const day of [undefined, 0, 29]) expect(() => assertExitPlanSchedule("SWP", "MONTHLY", day, 6)).toThrow();
    expect(() => assertExitPlanSchedule("STP", "MONTHLY", 5, 0)).toThrow();
  });
});

describe("plan cancellation payload", () => {
  test("free text travels only with custom_reason", () => {
    expect(planCancellationPayload("amount_not_available", "note")).toEqual({ cancellation_code: "amount_not_available" });
    expect(planCancellationPayload("custom_reason", "moving money")).toEqual({
      cancellation_code: "custom_reason", cancellation_reason: "moving money",
    });
  });
});

describe("payment ownership", () => {
  test("a UPI / netbanking payment (provider ONDC) is reachable by its investor", async () => {
    payment = { provider: "ONDC", purchases: [{ mfPurchaseId: "01a0cec9-8ee7-71bd-aa03-fb044ab9225a" }] };
    await expect(ownResource("user", "paymentId", PAYMENT_ID)).resolves.toBeUndefined();
  });
  test("a mandate debit (provider CYBRILLAPOA) is still reachable", async () => {
    payment = { provider: "CYBRILLAPOA", purchases: [{ mfPurchaseId: "01a0cec9-8ee7-71bd-aa03-fb044ab9225a" }] };
    await expect(ownResource("user", "paymentId", PAYMENT_ID)).resolves.toBeUndefined();
  });
  test("any other provider, or a payment with no order, is not", async () => {
    payment = { provider: "RAZORPAY", purchases: [{ mfPurchaseId: "01a0cec9-8ee7-71bd-aa03-fb044ab9225a" }] };
    await expect(ownResource("user", "paymentId", PAYMENT_ID)).rejects.toThrow();
    payment = { provider: "ONDC", purchases: [] };
    await expect(ownResource("user", "paymentId", PAYMENT_ID)).rejects.toThrow();
  });
});
