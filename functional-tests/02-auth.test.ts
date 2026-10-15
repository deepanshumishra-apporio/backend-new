// FT-AUTH: investor sign-in by phone OTP, sessions, logout and freeze.
import { describe, expect, test } from "bun:test";
import { Client, DEV_OTP, expectError, expectStatus, newPhone, signIn } from "./lib.ts";

describe("FT-AUTH OTP request", () => {
  test("FT-AUTH-01 requesting an OTP returns 202 and masks the number", async () => {
    const client = new Client();
    const phone = newPhone();
    const reply = await client.post("/api/v1/otp/request", { phone, purpose: "LOGIN" });
    expectStatus(reply, 202);
    expect(reply.body.data.phone).not.toBe(phone);
    expect(reply.body.data.phone).toContain("*");
    expect(reply.body.data.phone.endsWith(phone.slice(-4))).toBe(true);
    expect(reply.body.data.attemptsRemaining).toBeGreaterThan(0);
  });

  test("FT-AUTH-02 phone is required", async () => {
    expectError(await new Client().post("/api/v1/otp/request", {}), 400, "BAD_REQUEST");
  });

  test.each([
    ["letters", "+91abcdefghij"],
    ["too short", "98765"],
    ["landline-style first digit", "+915123456789"],
    ["non-Indian length", "+9198765432101"],
  ])("FT-AUTH-03 invalid phone (%s) is rejected", async (_label, phone) => {
    expectError(await new Client().post("/api/v1/otp/request", { phone }), 400);
  });

  test("FT-AUTH-04 a client cannot ask for a TRANSACTION_APPROVAL OTP", async () => {
    const reply = await new Client().post("/api/v1/otp/request", { phone: newPhone(), purpose: "TRANSACTION_APPROVAL" });
    expectError(reply, 400);
  });

  test("FT-AUTH-05 an immediate resend is refused by the cooldown", async () => {
    const client = new Client();
    const phone = newPhone();
    expectStatus(await client.post("/api/v1/otp/request", { phone, purpose: "LOGIN" }), 202);
    const again = await client.post("/api/v1/otp/request", { phone, purpose: "LOGIN" });
    expectError(again, 429);
    expect(again.headers.get("retry-after")).not.toBeNull();
  });
});

describe("FT-AUTH OTP verify", () => {
  test("FT-AUTH-06 an OTP of the wrong length is rejected before checking", async () => {
    expectError(await new Client().post("/api/v1/otp/verify", { phone: newPhone(), otp: "123" }), 400);
  });

  test("FT-AUTH-07 verifying with no OTP requested is refused", async () => {
    expectError(await new Client().post("/api/v1/otp/verify", { phone: newPhone(), otp: "111111", purpose: "LOGIN" }), 400);
  });

  test("FT-AUTH-08 a wrong code is refused and counts down the attempts", async () => {
    const client = new Client();
    const phone = newPhone();
    await client.post("/api/v1/otp/request", { phone, purpose: "LOGIN" });
    const wrong = await client.post("/api/v1/otp/verify", { phone, otp: "000000", purpose: "LOGIN" });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeLessThan(500);
    expect(wrong.body.data).toBeUndefined();
  });

  test("FT-AUTH-09 five wrong codes lock the number, even for the right code", async () => {
    const client = new Client();
    const phone = newPhone();
    await client.post("/api/v1/otp/request", { phone, purpose: "LOGIN" });
    for (let i = 0; i < 5; i += 1) await client.post("/api/v1/otp/verify", { phone, otp: "000000", purpose: "LOGIN" });
    const right = await client.post("/api/v1/otp/verify", { phone, otp: DEV_OTP, purpose: "LOGIN" });
    expectError(right, 429);
    // And asking for a fresh code does not escape the lockout.
    expectError(await new Client().post("/api/v1/otp/request", { phone, purpose: "LOGIN" }), 429);
  });

  test("FT-AUTH-10 the right code returns a single-use verification token", async () => {
    const client = new Client();
    const phone = newPhone();
    await client.post("/api/v1/otp/request", { phone, purpose: "LOGIN" });
    const reply = await client.post("/api/v1/otp/verify", { phone, otp: DEV_OTP, purpose: "LOGIN" });
    expectStatus(reply, 200);
    expect(reply.body.data.verified).toBe(true);
    expect(reply.body.data.verificationToken.length).toBeGreaterThan(20);
    // The same code cannot be verified twice.
    const again = await client.post("/api/v1/otp/verify", { phone, otp: DEV_OTP, purpose: "LOGIN" });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });
});

describe("FT-AUTH sessions", () => {
  test("FT-AUTH-11 a verification token opens an 8-hour bearer session", async () => {
    const client = await signIn();
    expect(client.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const workspace = await client.get("/api/v1/workspace");
    expectStatus(workspace, 200);
  });

  test("FT-AUTH-12 a verification token cannot open a second session", async () => {
    const client = new Client();
    const phone = newPhone();
    await client.post("/api/v1/otp/request", { phone, purpose: "LOGIN" });
    const { body } = await client.post("/api/v1/otp/verify", { phone, otp: DEV_OTP, purpose: "LOGIN" });
    const token = body.data.verificationToken;
    expectStatus(await client.post("/api/v1/sessions", { verificationToken: token }), 201);
    expectError(await client.post("/api/v1/sessions", { verificationToken: token }), 401, "UNAUTHORIZED");
  });

  test("FT-AUTH-13 a made-up verification token is refused", async () => {
    expectError(await new Client().post("/api/v1/sessions", { verificationToken: "x".repeat(40) }), 401);
  });

  test.each([
    ["no header", undefined],
    ["wrong scheme", "Basic abc"],
    ["malformed bearer", "Bearer short"],
    ["well-formed but unknown", `Bearer ${"A".repeat(43)}`],
  ])("FT-AUTH-14 protected routes refuse %s", async (_label, authorization) => {
    const client = new Client();
    const reply = await client.get("/api/v1/workspace", authorization ? { headers: { authorization } } : {});
    expectError(reply, 401, "UNAUTHORIZED");
  });

  test("FT-AUTH-15 logout revokes the session", async () => {
    const client = await signIn();
    expectStatus(await client.del("/api/v1/sessions/current"), 204);
    expectError(await client.get("/api/v1/workspace"), 401);
  });

  test("FT-AUTH-16 logout from all devices revokes every session", async () => {
    const phone = newPhone();
    const deviceA = await signIn(new Client(), phone);
    const deviceB = await signIn(new Client(), phone);
    expect(deviceA.userId).toBe(deviceB.userId);
    expectStatus(await deviceA.del("/api/v1/sessions/all"), 204);
    expectError(await deviceA.get("/api/v1/workspace"), 401);
    expectError(await deviceB.get("/api/v1/workspace"), 401);
  });

  test("FT-AUTH-17 freezing the account ends sessions and blocks sign-in", async () => {
    const phone = newPhone();
    const client = await signIn(new Client(), phone);
    expectStatus(await client.post("/api/v1/sessions/freeze"), 204);
    expectError(await client.get("/api/v1/workspace"), 401);

    const again = new Client();
    await again.post("/api/v1/otp/request", { phone, purpose: "LOGIN" });
    const verified = await again.post("/api/v1/otp/verify", { phone, otp: DEV_OTP, purpose: "LOGIN" });
    expectStatus(verified, 200);
    const session = await again.post("/api/v1/sessions", { verificationToken: verified.body.data.verificationToken });
    expectError(session, 403, "ACCOUNT_FROZEN");
  });

  test("FT-AUTH-18 signing in again with the same phone reaches the same account", async () => {
    const phone = newPhone();
    const first = await signIn(new Client(), phone);
    const second = await signIn(new Client(), phone);
    expect(second.userId).toBe(first.userId);
  });
});

describe("FT-AUTH sandbox sign-in (email + mobile)", () => {
  const email = () => `ft-${crypto.randomUUID().slice(0, 8)}@example.test`;

  test("FT-AUTH-19 email + mobile with the sandbox code creates a session", async () => {
    const reply = await new Client().post("/api/v1/sessions/sandbox", { phone: newPhone(), email: email(), emailOtp: "1234", mobileOtp: "1234" });
    expectStatus(reply, 201);
    expect(reply.body.data.accessToken).toBeString();
  });

  test("FT-AUTH-20 a wrong sandbox code is refused", async () => {
    const reply = await new Client().post("/api/v1/sessions/sandbox", { phone: newPhone(), email: email(), emailOtp: "1234", mobileOtp: "9999" });
    expectError(reply, 401, "INVALID_OTP");
  });

  test("FT-AUTH-21 an email already linked to another mobile cannot take over that account", async () => {
    const address = email();
    expectStatus(await new Client().post("/api/v1/sessions/sandbox", { phone: newPhone(), email: address, emailOtp: "1234", mobileOtp: "1234" }), 201);
    const hijack = await new Client().post("/api/v1/sessions/sandbox", { phone: newPhone(), email: address, emailOtp: "1234", mobileOtp: "1234" });
    expectError(hijack, 409, "SANDBOX_IDENTITY_MISMATCH");
  });
});
