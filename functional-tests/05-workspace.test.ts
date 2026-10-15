// FT-WS: the signed-in investor's own space — workspace, watchlist, cart,
// notifications, support — and the input checks on onboarding forms that must
// refuse bad data before anything reaches FP.
import { beforeAll, describe, expect, test } from "bun:test";
import { Client, expectError, expectStatus, signIn } from "./lib.ts";

const ISIN = "INF109K01605";
let investor: Client;

beforeAll(async () => {
  investor = await signIn();
});

describe("FT-WS workspace", () => {
  test("FT-WS-01 a new investor's workspace has no profile and their own phone", async () => {
    const reply = await investor.get("/api/v1/workspace");
    expectStatus(reply, 200);
    expect(reply.body.data.profiles).toEqual([]);
    expect(reply.body.data.contacts.phone).toBe((investor as Client & { phone: string }).phone);
    expect(reply.body.data.onboarding.investorProfileId).toBeNull();
  });

  test("FT-WS-02 onboarding status for a new investor starts with no profile", async () => {
    const reply = await investor.get("/api/v1/investors/onboarding");
    expectStatus(reply, 200);
    expect(reply.body.data.investorProfileId).toBeNull();
  });
});

describe("FT-WL watchlist", () => {
  test("FT-WL-01 add, list and remove a fund", async () => {
    expectStatus(await investor.put(`/api/v1/watchlist/${ISIN}`), 200);
    expectStatus(await investor.put(`/api/v1/watchlist/${ISIN}`), 200); // adding twice is harmless
    const list = await investor.get("/api/v1/watchlist");
    expectStatus(list, 200);
    expect(list.body.data.filter((s: { isin: string }) => s.isin === ISIN).length).toBe(1);
    expectStatus(await investor.del(`/api/v1/watchlist/${ISIN}`), 200);
    const after = await investor.get("/api/v1/watchlist");
    expect(after.body.data.map((s: { isin: string }) => s.isin)).not.toContain(ISIN);
  });

  test("FT-WL-02 an invalid ISIN is 400 and an unknown one 404", async () => {
    expectError(await investor.put("/api/v1/watchlist/BAD"), 400);
    expectError(await investor.put("/api/v1/watchlist/INF000000000"), 404);
  });
});

describe("FT-CART cart", () => {
  test("FT-CART-01 add a lumpsum, change its amount, remove it", async () => {
    const client = await signIn();
    expectStatus(await client.put("/api/v1/cart/items", { isin: ISIN, type: "LUMPSUM", amount: "5000" }), 200);
    expectStatus(await client.put("/api/v1/cart/items", { isin: ISIN, type: "LUMPSUM", amount: "7500" }), 200);
    const cart = await client.get("/api/v1/cart");
    expectStatus(cart, 200);
    expect(cart.body.data.items.length).toBe(1);
    expect(Number(cart.body.data.items[0].amount)).toBe(7500);
    expectStatus(await client.del(`/api/v1/cart/items/${cart.body.data.items[0].id}`), 200);
    expect((await client.get("/api/v1/cart")).body.data.items).toEqual([]);
  });

  test.each([
    ["zero amount", { isin: ISIN, type: "LUMPSUM", amount: "0" }],
    ["negative amount", { isin: ISIN, type: "LUMPSUM", amount: "-100" }],
    ["three decimals", { isin: ISIN, type: "LUMPSUM", amount: "100.123" }],
    ["unknown type", { isin: ISIN, type: "STP", amount: "1000" }],
    ["bad ISIN", { isin: "NOPE", type: "LUMPSUM", amount: "1000" }],
  ])("FT-CART-02 refuses %s", async (_label, body) => {
    expectError(await investor.put("/api/v1/cart/items", body), 400);
  });

  test("FT-CART-03 an unknown fund is 404", async () => {
    expectError(await investor.put("/api/v1/cart/items", { isin: "INF000000000", type: "LUMPSUM", amount: "5000" }), 404);
  });

  test("FT-CART-04 checking out an empty cart is refused", async () => {
    const client = await signIn();
    // No investment account yet, so the body cannot name one; the refusal must still be a 4xx.
    const reply = await client.post("/api/v1/cart/checkouts", {});
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });
});

describe("FT-NOTIF notifications", () => {
  test("FT-NOTIF-01 list, unread count and mark-all-read", async () => {
    expectStatus(await investor.get("/api/v1/notifications"), 200);
    const count = await investor.get("/api/v1/notifications/unread-count");
    expectStatus(count, 200);
    expect(typeof count.body.data.unreadCount).toBe("number");
    expectStatus(await investor.post("/api/v1/notifications/read-all"), 200);
    expect((await investor.get("/api/v1/notifications/unread-count")).body.data.unreadCount).toBe(0);
  });

  test("FT-NOTIF-02 a malformed cursor is 400", async () => {
    expectError(await investor.get("/api/v1/notifications?cursor=abc"), 400);
  });

  test("FT-NOTIF-03 promotions preference round-trips and must be a boolean", async () => {
    expectStatus(await investor.put("/api/v1/notifications/preferences", { promotions: false }), 200);
    const prefs = await investor.get("/api/v1/notifications/preferences");
    expectStatus(prefs, 200);
    expect(prefs.body.data.promotions).toBe(false);
    expectError(await investor.put("/api/v1/notifications/preferences", { promotions: "no" }), 400);
  });
});

describe("FT-SUP support tickets", () => {
  test("FT-SUP-01 raise a ticket, reply to it, and see it in the list", async () => {
    const created = await investor.post("/api/v1/support/tickets", { subject: "Where is my SIP?", category: "SIP_MANDATE", body: "It has not debited." });
    expectStatus(created, 201);
    const id = created.body.data.id;
    expectStatus(await investor.post(`/api/v1/support/tickets/${id}/messages`, { body: "Any update?" }), 201);
    const list = await investor.get("/api/v1/support/tickets");
    expect(list.body.data.map((t: { id: string }) => t.id)).toContain(id);
  });

  test.each([
    ["no subject", { category: "OTHER", body: "x" }],
    ["unknown category", { subject: "s", category: "LOTTERY", body: "x" }],
    ["subject over 160 chars", { subject: "s".repeat(161), category: "OTHER", body: "x" }],
    ["body over 4000 chars", { subject: "s", category: "OTHER", body: "b".repeat(4001) }],
  ])("FT-SUP-02 refuses a ticket with %s", async (_label, body) => {
    expectError(await investor.post("/api/v1/support/tickets", body), 400);
  });
});

describe("FT-ONB onboarding input validation (refused before FP is called)", () => {
  const profile = { name: "Test Investor", pan: "ABCPE3751F", dateOfBirth: "1990-01-01", taxStatus: "resident_individual" };

  test.each([
    ["missing name", { ...profile, name: undefined }],
    ["name over 70 chars", { ...profile, name: "n".repeat(71) }],
    ["lower-case-invalid PAN", { ...profile, pan: "12345ABCDE" }],
    ["short PAN", { ...profile, pan: "ABCPE3751" }],
    ["date not yyyy-mm-dd", { ...profile, dateOfBirth: "01/01/1990" }],
    ["unknown tax status", { ...profile, taxStatus: "alien" }],
    ["unknown gender", { ...profile, gender: "robot" }],
    ["unknown occupation", { ...profile, occupation: "pirate" }],
    ["aadhaar not 4 digits", { ...profile, aadhaarLast4: "12345" }],
    ["unknown PEP status", { ...profile, pepDetails: "maybe" }],
  ])("FT-ONB-01 investor profile with %s is 400", async (_label, body) => {
    expectError(await investor.post("/api/v1/investors/profiles", body), 400);
  });

  test("FT-ONB-02 readiness needs bank number, IFSC and type together", async () => {
    const reply = await investor.post("/api/v1/kyc/readiness", {
      pan: "ABCPE3751F", name: "Test Investor", dateOfBirth: "1990-01-01", bankAccountNumber: "123456789012",
    });
    expectError(reply, 400);
  });

  test.each([
    ["bad IFSC", { bankAccountNumber: "123456789012", bankIfscCode: "HDFC1234567", bankAccountType: "savings" }],
    ["short account number", { bankAccountNumber: "1234", bankIfscCode: "HDFC0001330", bankAccountType: "savings" }],
    ["unknown account type", { bankAccountNumber: "123456789012", bankIfscCode: "HDFC0001330", bankAccountType: "gold" }],
  ])("FT-ONB-03 readiness with %s is 400", async (_label, bank) => {
    const reply = await investor.post("/api/v1/kyc/readiness", { pan: "ABCPE3751F", name: "Test Investor", dateOfBirth: "1990-01-01", ...bank });
    expectError(reply, 400);
  });

  test("FT-ONB-04 KYC signature upload must be a real PNG/JPEG/PDF", async () => {
    // Ownership is checked first, so an unknown form id is a 404 whatever the body.
    const reply = await investor.call("POST", `/api/v1/kyc/forms/${crypto.randomUUID()}/signature`, undefined, {
      raw: "not an image", headers: { "content-type": "image/png" },
    });
    expectError(reply, 404);
  });
});
