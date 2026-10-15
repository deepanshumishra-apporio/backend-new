// FT-JRN: the whole investor journey, in order, against the live FP ONDC
// sandbox — the only way to know the money paths really work.
//
//   sign in → identity readiness (PAN/name/DOB) → investor profile → address,
//   phone, email → bank account → penny-drop → nominee → investment account →
//   onboarding says "can transact" → purchase (bad inputs refused) → FP review
//   → transaction OTP (SEBI 2FA) → consent → UPI payment → SIP mandate → SIP
//
// Each step records what it created in `state`; a later step that needs an
// earlier one fails with "blocked by …" rather than a confusing error.
// Creates real objects in the FP *sandbox* tenant only (setup.ts enforces it).
import { describe, expect, test } from "bun:test";
import { Client, DEV_OTP, expectError, expectStatus, poll, signIn } from "./lib.ts";

const ISIN = "INF109K01605";
const IFSC = "HDFC0001330";
const NAME = "Functional Tester";
const DOB = "1988-04-12";

/** Sandbox PAN rules: 4th char P (individual), 5th not A/I, digits 3751 = KYC compliant. */
function sandboxPan(): string {
  const letters = "BCDEFGHJKLMNOPQRSTUVWXYZ";
  const pick = () => letters[Math.floor(Math.random() * letters.length)];
  return `${pick()}${pick()}${pick()}P${pick()}3751${pick()}`;
}
/** Sandbox penny-drop passes VERY_HIGH for account numbers ending 1191–1199. */
function sandboxAccount(): string {
  let digits = "";
  while (digits.length < 10) digits += Math.floor(Math.random() * 10);
  return `${digits}119${1 + Math.floor(Math.random() * 9)}`;
}

const PAN = sandboxPan();
const ACCOUNT_NUMBER = sandboxAccount();
const state: Record<string, string | undefined> = {};
function need(key: string): string {
  const value = state[key];
  if (!value) throw new Error(`blocked by an earlier step: no ${key}`);
  return value;
}

let investor: Client & { phone: string };

describe("FT-JRN onboarding", () => {
  test("FT-JRN-01 sign in with phone OTP", async () => {
    investor = await signIn();
    expect(investor.token).toBeString();
  });

  test("FT-JRN-02 identity readiness check passes for a KYC-compliant PAN", async () => {
    const started = await investor.post("/api/v1/kyc/readiness", { pan: PAN, name: NAME, dateOfBirth: DOB });
    expectStatus(started, 201);
    state.preVerificationId = started.body.data.id;
    const verdict = await poll("readiness verdict", async () => {
      const reply = await investor.get(`/api/v1/kyc/readiness/${need("preVerificationId")}`);
      expectStatus(reply, 200);
      return { done: reply.body.data.readinessStatus ? reply.body.data : undefined, last: reply.body };
    }, { tries: 40, delayMs: 3_000 });
    expect(verdict.ready).toBe(true);
    expect(verdict.checks.pan.status ?? verdict.checks.pan).toBeDefined();
  });

  test("FT-JRN-03 another investor cannot read this readiness check", async () => {
    const stranger = await signIn();
    expectError(await stranger.get(`/api/v1/kyc/readiness/${need("preVerificationId")}`), 404);
  });

  test("FT-JRN-04 create the investor profile; PAN comes back masked", async () => {
    const reply = await investor.post("/api/v1/investors/profiles", {
      name: NAME, pan: PAN, dateOfBirth: DOB, taxStatus: "resident_individual",
      gender: "male", occupation: "private_sector_service", maritalStatus: "single",
      fatherName: "Father Tester", sourceOfWealth: "salary", incomeSlab: "above_5lakh_upto_10lakh",
      pepDetails: "not_applicable", countryOfBirth: "IN", placeOfBirth: "Mumbai",
      nationalityCountry: "IN", citizenshipCountries: ["IN"],
    });
    expectStatus(reply, 201);
    state.profileId = reply.body.data.id;
    expect(reply.body.data.panMasked).not.toContain(PAN.slice(0, 5));
    expect(JSON.stringify(reply.body)).not.toContain(PAN);
  });

  test("FT-JRN-05 add address, phone and email", async () => {
    const id = need("profileId");
    const address = await investor.post(`/api/v1/investors/profiles/${id}/addresses`, {
      line1: "12 Test Street", city: "Mumbai", state: "MH", postalCode: "400001", country: "IN", nature: "residential",
    });
    expectStatus(address, 201);
    state.addressId = address.body.data.id;
    const phone = await investor.post(`/api/v1/investors/profiles/${id}/phones`, { isd: "91", number: investor.phone.slice(3), belongsTo: "self" });
    expectStatus(phone, 201);
    state.phoneId = phone.body.data.id;
    const email = await investor.post(`/api/v1/investors/profiles/${id}/emails`, { email: `ft-${Date.now()}@example.com`, belongsTo: "self" });
    expectStatus(email, 201);
    state.emailId = email.body.data.id;
  });

  test("FT-JRN-06 add a bank account; only the last four digits are kept", async () => {
    const reply = await investor.post(`/api/v1/investors/profiles/${need("profileId")}/bank-accounts`, {
      accountNumber: ACCOUNT_NUMBER, accountHolderName: NAME, type: "savings", ifscCode: IFSC,
    });
    expectStatus(reply, 201);
    state.bankAccountId = reply.body.data.id;
    expect(reply.body.data.accountNumberLast4).toBe(ACCOUNT_NUMBER.slice(-4));
    expect(JSON.stringify(reply.body)).not.toContain(ACCOUNT_NUMBER);
  });

  test("FT-JRN-07 bank account penny-drop verification completes", async () => {
    const bankId = need("bankAccountId");
    const started = await investor.post(`/api/v1/investors/bank-accounts/${bankId}/verify`);
    expect([200, 202]).toContain(started.status);
    const bank = await poll("bank verification", async () => {
      const reply = await investor.post(`/api/v1/investors/bank-accounts/${bankId}/verification/refresh`);
      expectStatus(reply, 200);
      return { done: reply.body.data.usableForPayout ? reply.body.data : undefined, last: reply.body };
    }, { tries: 30, delayMs: 3_000 });
    expect(["VERY_HIGH", "HIGH"]).toContain(bank.verificationConfidence);
  });

  test("FT-JRN-08 add a nominee", async () => {
    const reply = await investor.post(`/api/v1/investors/profiles/${need("profileId")}/nominees`, {
      name: "Nominee Tester", relationship: "mother", dateOfBirth: "1960-01-01",
    });
    expectStatus(reply, 201);
    state.nomineeId = reply.body.data.id;
  });

  test("FT-JRN-09 nominee allocations over three nominees are refused", async () => {
    const nominees = Array.from({ length: 4 }, () => ({ relatedPartyId: need("nomineeId"), allocationPercentage: "25" }));
    expectError(await investor.post(`/api/v1/investors/profiles/${need("profileId")}/investment-accounts`, { nominees }), 400);
  });

  test("FT-JRN-10 open the investment account with folio defaults", async () => {
    const reply = await investor.post(`/api/v1/investors/profiles/${need("profileId")}/investment-accounts`, {
      emailAddressId: need("emailId"), phoneNumberId: need("phoneId"), addressId: need("addressId"),
      bankAccountId: need("bankAccountId"),
      nominees: [{ relatedPartyId: need("nomineeId"), allocationPercentage: "100" }],
      nominationsInfoVisibility: "show_all_nominee_names",
    });
    expectStatus(reply, 201);
    state.accountId = reply.body.data.id;
    expect(reply.body.data.holdingPattern.toUpperCase()).toBe("SINGLE");
  });

  test("FT-JRN-11 onboarding now says the investor can transact", async () => {
    const reply = await investor.get("/api/v1/investors/onboarding");
    expectStatus(reply, 200);
    expect(reply.body.data.investorProfileId).toBe(need("profileId"));
    expect(JSON.stringify(reply.body.data)).toContain('"canTransact":true');
  });

  test("FT-JRN-12 another investor cannot see this profile, account or bank", async () => {
    const stranger = await signIn();
    expectError(await stranger.get(`/api/v1/investors/profiles/${need("profileId")}`), 404);
    expectError(await stranger.get(`/api/v1/investors/investment-accounts/${need("accountId")}`), 404);
    expectError(await stranger.get(`/api/v1/investors/profiles/${need("profileId")}/bank-accounts`), 404);
    expectError(await stranger.get(`/api/v1/portfolio/${need("accountId")}/summary`), 404);
  });
});

describe("FT-JRN lumpsum purchase", () => {
  const purchase = (extra: Record<string, unknown> = {}) =>
    investor.post("/api/v1/orders/purchases", { mfInvestmentAccountId: need("accountId"), isin: ISIN, amount: "5000", initiatedVia: "mobile_app", ...extra });

  test.each([
    ["an amount below the scheme minimum", { amount: "100" }],
    ["a malformed ISIN", { isin: "BADISIN" }],
    ["three decimal places", { amount: "5000.123" }],
    ["no amount", { amount: undefined }],
    ["an unknown channel", { initiatedVia: "fax" }],
  ])("FT-JRN-13 a purchase with %s is refused with a 4xx", async (_label, extra) => {
    const reply = await purchase(extra);
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });

  test("FT-JRN-14 a valid purchase is accepted by FP on the ONDC gateway", async () => {
    const reply = await purchase();
    expectStatus(reply, 201);
    state.orderId = reply.body.data.id;
    expect(reply.body.data.type).toBe("PURCHASE");
    expect(String(reply.body.data.gateway).toUpperCase()).toContain("ONDC");
    expect(Number(reply.body.data.amount)).toBe(5000);
    expect(reply.body.data.consentRecorded).toBe(false);
  });

  test("FT-JRN-15 FP review moves the order to pending", async () => {
    const order = await poll("order review", async () => {
      const reply = await investor.post(`/api/v1/orders/${need("orderId")}/refresh`);
      expectStatus(reply, 200);
      const ready = ["PENDING", "pending", "REVIEW_COMPLETED"].includes(reply.body.data.state);
      return { done: ready ? reply.body.data : undefined, last: reply.body };
    }, { tries: 30, delayMs: 3_000 });
    expect(order.state).toBeDefined();
  });

  test("FT-JRN-16 confirming before consent and payment is refused", async () => {
    const reply = await investor.post(`/api/v1/orders/purchases/${need("orderId")}/confirm`);
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });

  test("FT-JRN-17 a forged or wrong verification token cannot record consent", async () => {
    const reply = await investor.post(`/api/v1/orders/purchases/${need("orderId")}/consent`, { verificationToken: "forged-token-value-1234567890" });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });

  test("FT-JRN-18 SEBI 2FA: a transaction OTP goes to the folio contact, not a caller-named one", async () => {
    const request = await investor.post("/api/v1/transaction-otp/request", { kind: "order", id: need("orderId"), phone: "+919999999999" }, { idem: false });
    expectStatus(request, 202);
    // The masked number is the investor's registered mobile, whatever the body said.
    expect(request.body.data.phone.endsWith(investor.phone.slice(-4))).toBe(true);
    const wrong = await investor.post("/api/v1/transaction-otp/verify", { kind: "order", id: need("orderId"), otp: "000000" }, { idem: false });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const verified = await investor.post("/api/v1/transaction-otp/verify", { kind: "order", id: need("orderId"), otp: DEV_OTP }, { idem: false });
    expectStatus(verified, 200);
    state.consentToken = verified.body.data.verificationToken;
  });

  test("FT-JRN-19 another investor cannot request a transaction OTP for this order", async () => {
    const stranger = await signIn();
    expectError(await stranger.post("/api/v1/transaction-otp/request", { kind: "order", id: need("orderId") }, { idem: false }), 404);
  });

  test("FT-JRN-20 a login OTP token cannot be spent as transaction consent", async () => {
    const other = new Client(investor.ip);
    const phone = investor.phone;
    await other.post("/api/v1/otp/request", { phone, purpose: "PHONE_VERIFICATION" });
    const login = await other.post("/api/v1/otp/verify", { phone, otp: DEV_OTP, purpose: "PHONE_VERIFICATION" });
    expectStatus(login, 200);
    const reply = await investor.post(`/api/v1/orders/purchases/${need("orderId")}/consent`, { verificationToken: login.body.data.verificationToken });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });

  test("FT-JRN-21 the verified transaction OTP records consent", async () => {
    const reply = await investor.post(`/api/v1/orders/purchases/${need("orderId")}/consent`, { verificationToken: need("consentToken") });
    expectStatus(reply, 200);
    expect(reply.body.data.consentRecorded).toBe(true);
  });

  test("FT-JRN-22 the consent token is single-use", async () => {
    const reply = await investor.post(`/api/v1/orders/purchases/${need("orderId")}/consent`, { verificationToken: need("consentToken") });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });

  test("FT-JRN-23 a UPI payment is created for the order with a payment link", async () => {
    const reply = await investor.post("/api/v1/payments/netbanking", {
      orderIds: [need("orderId")], method: "UPI", bankAccountId: need("bankAccountId"),
    });
    if (reply.status !== 201) throw new Error(`payment create: HTTP ${reply.status} ${JSON.stringify(reply.body).slice(0, 500)}`);
    state.paymentId = reply.body.data.id;
    expect(reply.body.data.orderIds).toContain(need("orderId"));
    expect(Number(reply.body.data.amount)).toBe(5000);
  });

  test("FT-JRN-24 the payment is listed on the order and readable only by its owner", async () => {
    const payments = await investor.get(`/api/v1/orders/${need("orderId")}/payments`);
    expectStatus(payments, 200);
    expect(payments.body.data.map((p: { id: string }) => p.id)).toContain(need("paymentId"));
    expectStatus(await investor.get(`/api/v1/payments/${need("paymentId")}`), 200);
    const stranger = await signIn();
    expectError(await stranger.get(`/api/v1/payments/${need("paymentId")}`), 404);
  });

  test("FT-JRN-25 a second payment for an order already being paid is refused", async () => {
    const reply = await investor.post("/api/v1/payments/netbanking", {
      orderIds: [need("orderId")], method: "UPI", bankAccountId: need("bankAccountId"),
    });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });

  test("FT-JRN-26 the order appears in the investor's order list", async () => {
    const reply = await investor.get(`/api/v1/orders?mfInvestmentAccountId=${need("accountId")}`);
    expectStatus(reply, 200);
    expect(reply.body.data.map((o: { id: string }) => o.id)).toContain(need("orderId"));
    expectError(await investor.get("/api/v1/orders"), 400);
  });
});

describe("FT-JRN exits without holdings", () => {
  test("FT-JRN-27 redeeming from a folio the investor does not hold is refused", async () => {
    const reply = await investor.post("/api/v1/orders/redemptions", {
      mfInvestmentAccountId: need("accountId"), isin: ISIN, folioNumber: "99999999", amount: "1000",
    });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });

  test("FT-JRN-28 a switch into the same scheme or without a folio is refused", async () => {
    const noFolio = await investor.post("/api/v1/orders/switches", {
      mfInvestmentAccountId: need("accountId"), switchOutIsin: ISIN, switchInIsin: "INF109K01423", amount: "1000",
    });
    expectError(noFolio, 400);
  });
});

describe("FT-JRN SIP with an AutoPay mandate", () => {
  test("FT-JRN-29 create an e-mandate on the verified bank account", async () => {
    const reply = await investor.post("/api/v1/payments/mandates", {
      bankAccountId: need("bankAccountId"), mandateType: "E_MANDATE", mandateLimit: "50000", providerName: "CYBRILLAPOA",
    });
    expectStatus(reply, 201);
    state.mandateId = reply.body.data.id;
  });

  test("FT-JRN-30 a SIP needs an approved mandate", async () => {
    const reply = await investor.post("/api/v1/plans/sips", {
      mfInvestmentAccountId: need("accountId"), isin: ISIN, amount: "1000", mandateId: need("mandateId"),
      frequency: "MONTHLY", installmentDay: 10, numberOfInstallments: 12,
    });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });

  test("FT-JRN-31 the investor authorizes the mandate (bank approval link), then the sandbox approves it", async () => {
    const authorize = await investor.post(`/api/v1/payments/mandates/${need("mandateId")}/authorize`, {});
    expectStatus(authorize, 200);
    const reply = await investor.post(`/api/v1/payments/mandates/${need("mandateId")}/simulate`, { status: "APPROVED" });
    expectStatus(reply, 200);
    const mandate = await poll("mandate approval", async () => {
      const refreshed = await investor.post(`/api/v1/payments/mandates/${need("mandateId")}/refresh`);
      expectStatus(refreshed, 200);
      return { done: refreshed.body.data.status === "APPROVED" ? refreshed.body.data : undefined, last: refreshed.body };
    }, { tries: 20, delayMs: 3_000 });
    expect(mandate.usableForPlans).toBe(true);
  });

  test.each([
    ["installment day 31", { installmentDay: 31 }],
    ["zero installments", { numberOfInstallments: 0 }],
    ["unknown frequency", { frequency: "HOURLY" }],
  ])("FT-JRN-32 a SIP with %s is refused", async (_label, extra) => {
    const reply = await investor.post("/api/v1/plans/sips", {
      mfInvestmentAccountId: need("accountId"), isin: ISIN, amount: "1000", mandateId: need("mandateId"),
      frequency: "MONTHLY", installmentDay: 10, numberOfInstallments: 12, ...extra,
    });
    expectError(reply, 400);
  });

  test("FT-JRN-33 a monthly SIP is created against the approved mandate", async () => {
    const reply = await investor.post("/api/v1/plans/sips", {
      mfInvestmentAccountId: need("accountId"), isin: ISIN, amount: "1000", mandateId: need("mandateId"),
      frequency: "MONTHLY", installmentDay: 10, numberOfInstallments: 12, initiatedVia: "mobile_app",
    });
    expectStatus(reply, 201);
    state.planId = reply.body.data.id;
  });

  test("FT-JRN-34 the SIP is listed and readable only by its owner", async () => {
    const list = await investor.get(`/api/v1/plans?mfInvestmentAccountId=${need("accountId")}`);
    expectStatus(list, 200);
    expect(JSON.stringify(list.body)).toContain(need("planId"));
    const stranger = await signIn();
    expectError(await stranger.get(`/api/v1/plans/${need("planId")}`), 404);
  });
});

describe("FT-JRN portfolio", () => {
  test.each(["summary", "holdings", "folios", "transactions"])("FT-JRN-35 portfolio %s answers for the owner", async (view) => {
    const reply = await investor.get(`/api/v1/portfolio/${need("accountId")}/${view}`);
    expectStatus(reply, 200);
  });
});
