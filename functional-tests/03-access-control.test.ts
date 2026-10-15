// FT-ACL: one investor can never read or act on another's data, and every
// write is protected by an Idempotency-Key.
import { beforeAll, describe, expect, test } from "bun:test";
import { Client, expectError, expectStatus, idemKey, signIn } from "./lib.ts";

const ISIN = "INF109K01605";
const ticket = (subject = "Functional test ticket") => ({ subject, category: "OTHER", body: "Raised by the functional test suite." });

let alice: Client;
let bob: Client;

beforeAll(async () => {
  alice = await signIn();
  bob = await signIn();
});

describe("FT-ACL ownership (IDOR)", () => {
  test("FT-ACL-01 another investor's support ticket answers 404, not 403", async () => {
    const created = await alice.post("/api/v1/support/tickets", ticket());
    expectStatus(created, 201);
    const id = created.body.data.id;
    expectStatus(await alice.get(`/api/v1/support/tickets/${id}`), 200);
    expectError(await bob.get(`/api/v1/support/tickets/${id}`), 404, "NOT_FOUND");
    expectError(await bob.post(`/api/v1/support/tickets/${id}/messages`, { body: "hijack" }), 404);
  });

  test("FT-ACL-02 another investor's cart item cannot be removed", async () => {
    expectStatus(await alice.put("/api/v1/cart/items", { isin: ISIN, type: "LUMPSUM", amount: "5000" }), 200);
    const cart = await alice.get("/api/v1/cart");
    expectStatus(cart, 200);
    const itemId = cart.body.data.items[0].id;
    expectError(await bob.del(`/api/v1/cart/items/${itemId}`), 404);
    const still = await alice.get("/api/v1/cart");
    expect(still.body.data.items.map((i: { id: string }) => i.id)).toContain(itemId);
  });

  test("FT-ACL-03 a userId in the query or body that is not yours is refused", async () => {
    expectError(await alice.get(`/api/v1/support/tickets?userId=${bob.userId}`), 404);
    expectError(await alice.post("/api/v1/support/tickets", { ...ticket(), userId: bob.userId }), 404);
  });

  test("FT-ACL-04 a resource id that is not a UUID is rejected as 400", async () => {
    expectError(await alice.get("/api/v1/support/tickets/not-a-uuid"), 400);
    expectError(await alice.get("/api/v1/orders/1%20OR%201=1"), 400);
  });

  test.each([
    ["investor profile", "/api/v1/investors/profiles/"],
    ["investment account", "/api/v1/investors/investment-accounts/"],
    ["order", "/api/v1/orders/"],
    ["plan", "/api/v1/plans/"],
    ["payment", "/api/v1/payments/"],
    ["mandate", "/api/v1/payments/mandates/"],
    ["KYC form", "/api/v1/kyc/forms/"],
    ["portfolio", "/api/v1/portfolio/"],
  ])("FT-ACL-05 an unknown %s id answers 404", async (_label, prefix) => {
    const path = prefix === "/api/v1/portfolio/" ? `${prefix}${crypto.randomUUID()}/summary` : `${prefix}${crypto.randomUUID()}`;
    expectError(await alice.get(path), 404);
  });

  test("FT-ACL-06 naming someone else's (or no) profile in a body is refused before any work", async () => {
    const reply = await alice.post("/api/v1/kyc/readiness", {
      investorProfileId: crypto.randomUUID(), pan: "ABCPE3751F", name: "Test Person", dateOfBirth: "1990-01-01",
    });
    expectError(reply, 404);
  });

  test("FT-ACL-07 callback URLs must be on an approved HTTPS origin", async () => {
    const base = { type: "FRESH", pan: "ABCPE3751F", name: "Test Person", dateOfBirth: "1990-01-01" };
    for (const proofCallbackUrl of ["http://app.example.test/cb", "https://evil.example.com/cb", "https://user:pw@app.example.test/cb", "javascript:alert(1)"]) {
      const reply = await alice.post("/api/v1/kyc/forms", { ...base, proofCallbackUrl, esignCallbackUrl: "https://app.example.test/e" });
      expectError(reply, 400);
    }
  });

  test("FT-ACL-08 an investor token does not open the admin portal", async () => {
    expectError(await alice.get("/api/v1/admin/me"), 401);
    expectError(await alice.get("/api/v1/admin/investors"), 401);
  });
});

describe("FT-IDEM idempotency on writes", () => {
  test("FT-IDEM-01 a write without an Idempotency-Key is refused", async () => {
    expectError(await alice.post("/api/v1/support/tickets", ticket(), { idem: false }), 400);
  });

  test("FT-IDEM-02 a malformed Idempotency-Key is refused", async () => {
    expectError(await alice.post("/api/v1/support/tickets", ticket(), { idem: "short" }), 400);
    expectError(await alice.post("/api/v1/support/tickets", ticket(), { idem: "has spaces in it!!!!!" }), 400);
  });

  test("FT-IDEM-03 retrying with the same key replays the first answer and creates nothing new", async () => {
    const key = idemKey();
    const first = await alice.post("/api/v1/support/tickets", ticket("Idempotent ticket"), { idem: key });
    expectStatus(first, 201);
    const second = await alice.post("/api/v1/support/tickets", ticket("Idempotent ticket"), { idem: key });
    expectStatus(second, 201);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.body.data.id).toBe(first.body.data.id);
    const list = await alice.get("/api/v1/support/tickets");
    const matching = list.body.data.filter((t: { subject: string }) => t.subject === "Idempotent ticket");
    expect(matching.length).toBe(1);
  });

  test("FT-IDEM-04 reusing a key for a different request is a 409", async () => {
    const key = idemKey();
    expectStatus(await alice.post("/api/v1/support/tickets", ticket("First use"), { idem: key }), 201);
    expectError(await alice.post("/api/v1/support/tickets", ticket("Different body"), { idem: key }), 409, "IDEMPOTENCY_KEY_REUSED");
  });

  test("FT-IDEM-05 keys are per investor — the same key from another investor is independent", async () => {
    const key = idemKey();
    const a = await alice.post("/api/v1/support/tickets", ticket("Shared key"), { idem: key });
    const b = await bob.post("/api/v1/support/tickets", ticket("Shared key"), { idem: key });
    expectStatus(a, 201);
    expectStatus(b, 201);
    expect(b.headers.get("idempotency-replayed")).toBeNull();
    expect(b.body.data.id).not.toBe(a.body.data.id);
  });

  test("FT-IDEM-06 a rejected request does not poison its key", async () => {
    const key = idemKey();
    expectError(await alice.post("/api/v1/support/tickets", { subject: "", category: "OTHER", body: "x" }, { idem: key }), 400);
    // Same key, same (still invalid) body: evaluated again rather than replayed as stored.
    const retry = await alice.post("/api/v1/support/tickets", { subject: "", category: "OTHER", body: "x" }, { idem: key });
    expectError(retry, 400);
    expect(retry.headers.get("idempotency-replayed")).toBeNull();
  });
});
