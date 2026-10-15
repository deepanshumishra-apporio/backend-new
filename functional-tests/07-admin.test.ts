// FT-ADM: the admin portal — staff sign-in, MFA, lockout, forced password
// change and role-based permissions.
//
// Staff accounts are created with the same service `bun run staff:create`
// uses; everything after that goes over HTTP.
import { beforeAll, describe, expect, test } from "bun:test";
import { Client, expectError, expectStatus, signIn } from "./lib.ts";
import { CHANGED, INITIAL, base32Decode, createStaff, onboardStaff, timeStep, totpAt } from "./staff.ts";

describe("FT-ADM staff sign-in", () => {
  test("FT-ADM-01 a wrong password and an unknown email give the same answer", async () => {
    const email = await createStaff("SUPPORT");
    const wrong = await new Client().post("/api/v1/admin/sessions", { email, password: "definitely-wrong-pw" }, { idem: false });
    const unknown = await new Client().post("/api/v1/admin/sessions", { email: "nobody@example.test", password: "definitely-wrong-pw" }, { idem: false });
    expectError(wrong, 401);
    expectError(unknown, 401);
    expect(wrong.body.error.code).toBe(unknown.body.error.code);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  test("FT-ADM-02 five wrong passwords lock the account for the right one too", async () => {
    const email = await createStaff("SUPPORT");
    const client = new Client();
    for (let i = 0; i < 5; i += 1) await client.post("/api/v1/admin/sessions", { email, password: `wrong-password-${i}` }, { idem: false });
    expectError(await client.post("/api/v1/admin/sessions", { email, password: INITIAL }, { idem: false }), 423, "ACCOUNT_LOCKED");
  });

  test("FT-ADM-03 malformed sign-in input is a 400", async () => {
    const client = new Client();
    expectError(await client.post("/api/v1/admin/sessions", { email: "not-an-email", password: "x" }, { idem: false }), 400);
    expectError(await client.post("/api/v1/admin/sessions", { email: "a@b.co", password: "" }, { idem: false }), 400);
    expectError(await client.post("/api/v1/admin/sessions", { email: "a@b.co", password: "p".repeat(257) }, { idem: false }), 400);
  });
});

describe("FT-ADM MFA and first sign-in", () => {
  let email: string;
  const client = new Client();

  beforeAll(async () => {
    email = await createStaff("SUPER_ADMIN");
  });

  test("FT-ADM-04 a correct password alone yields a session that must set up MFA", async () => {
    const login = await client.post("/api/v1/admin/sessions", { email, password: INITIAL }, { idem: false });
    expectStatus(login, 201);
    expect(login.body.data.mfa).toBe("SETUP_REQUIRED");
    client.token = login.body.data.accessToken;
  });

  test("FT-ADM-05 no data is reachable before MFA", async () => {
    expectError(await client.get("/api/v1/admin/me"), 403, "MFA_REQUIRED");
    expectError(await client.get("/api/v1/admin/investors"), 403, "MFA_REQUIRED");
  });

  let secret: Uint8Array;
  test("FT-ADM-06 MFA setup issues a TOTP secret; a wrong code is refused", async () => {
    const setup = await client.post("/api/v1/admin/sessions/mfa/setup", {}, { idem: false });
    expectStatus(setup, 201);
    expect(setup.body.data.otpauthUri).toStartWith("otpauth://totp/");
    secret = base32Decode(setup.body.data.secret);
    const wrongCode = totpAt(secret, timeStep(new Date()) + 10);
    const reply = await client.post("/api/v1/admin/sessions/mfa/verify", { code: wrongCode }, { idem: false });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expectError(await client.post("/api/v1/admin/sessions/mfa/verify", { code: "12ab" }, { idem: false }), 400);
  });

  test("FT-ADM-07 the right TOTP code completes MFA", async () => {
    const reply = await client.post("/api/v1/admin/sessions/mfa/verify", { code: totpAt(secret, timeStep(new Date())) }, { idem: false });
    expectStatus(reply, 200);
    expect(reply.body.data.mfa).toBe("VERIFIED");
    expectError(await client.post("/api/v1/admin/sessions/mfa/setup", {}, { idem: false }), 409, "MFA_ALREADY_VERIFIED");
  });

  test("FT-ADM-08 an issued password must be changed before any data", async () => {
    expectStatus(await client.get("/api/v1/admin/me"), 200);
    expectError(await client.get("/api/v1/admin/investors"), 403, "PASSWORD_CHANGE_REQUIRED");
  });

  test("FT-ADM-09 the new password is checked against policy", async () => {
    expectError(await client.post("/api/v1/admin/me/password", { currentPassword: INITIAL, newPassword: "short" }, { idem: false }), 400);
    const local = email.split("@")[0]!;
    expectError(await client.post("/api/v1/admin/me/password", { currentPassword: INITIAL, newPassword: `${local}-padding-123` }, { idem: false }), 400);
    expectError(await client.post("/api/v1/admin/me/password", { currentPassword: "wrong-current-pw", newPassword: CHANGED }, { idem: false }), 401);
  });

  test("FT-ADM-10 after the change, data opens up", async () => {
    expectStatus(await client.post("/api/v1/admin/me/password", { currentPassword: INITIAL, newPassword: CHANGED }, { idem: false }), 204);
    expectStatus(await client.get("/api/v1/admin/investors"), 200);
    expectStatus(await client.get("/api/v1/admin/dashboard/summary"), 200);
  });

  test("FT-ADM-11 logout ends the staff session", async () => {
    expectStatus(await client.del("/api/v1/admin/sessions/current", { idem: false }), 204);
    expectError(await client.get("/api/v1/admin/me"), 401);
  });
});

describe("FT-ADM role permissions", () => {
  let readOnly: Client;
  let support: Client;
  let superAdmin: Client;

  beforeAll(async () => {
    [readOnly, support, superAdmin] = await Promise.all([onboardStaff("READ_ONLY"), onboardStaff("SUPPORT"), onboardStaff("SUPER_ADMIN")]);
  });

  test("FT-ADM-12 READ_ONLY sees the dashboard and nothing else", async () => {
    expectStatus(await readOnly.get("/api/v1/admin/dashboard/summary"), 200);
    expectError(await readOnly.get("/api/v1/admin/investors"), 403, "FORBIDDEN");
    expectError(await readOnly.get("/api/v1/admin/transactions"), 403, "FORBIDDEN");
    expectError(await readOnly.get("/api/v1/admin/staff"), 403, "FORBIDDEN");
  });

  test("FT-ADM-13 SUPPORT reads investors and tickets but cannot manage staff or reports", async () => {
    expectStatus(await support.get("/api/v1/admin/investors"), 200);
    expectStatus(await support.get("/api/v1/admin/support/tickets"), 200);
    expectError(await support.get("/api/v1/admin/staff"), 403, "FORBIDDEN");
    expectError(await support.get("/api/v1/admin/reports"), 403, "FORBIDDEN");
    expectError(await support.post("/api/v1/admin/roles", { key: "X", name: "x" }, { idem: false }), 403, "FORBIDDEN");
  });

  test("FT-ADM-14 SUPER_ADMIN reaches staff, roles, reports and compliance", async () => {
    for (const path of ["/staff", "/roles", "/permissions", "/reports", "/compliance/alerts", "/transactions/summary"]) {
      expectStatus(await superAdmin.get(`/api/v1/admin${path}`), 200);
    }
  });

  test("FT-ADM-15 an investor who signed up appears in the admin investor list after the projection tick", async () => {
    const investor = await signIn();
    // The list reads a projection the server rebuilds every 60s
    // (admin-projection.service.ts, started by index.ts). Run one tick.
    const { runProjection } = await import("../src/services/admin-projection.service.ts");
    await runProjection({ forceFull: true });
    const list = await superAdmin.get("/api/v1/admin/investors?limit=100");
    expectStatus(list, 200);
    expect(JSON.stringify(list.body)).toContain(investor.userId!);
  });

  test("FT-ADM-16 a staff token does not open investor routes", async () => {
    expectError(await superAdmin.get("/api/v1/workspace"), 401);
  });

  test("FT-ADM-18 review meetings are parked: the API does not expose them", async () => {
    expectError(await superAdmin.get("/api/v1/admin/review-meetings"), 404);
    expectError(await superAdmin.post("/api/v1/admin/review-meetings", {}, { idem: false }), 404);
  });

  test("FT-ADM-17 an unknown admin path answers 404 rather than the investor gate", async () => {
    expectError(await superAdmin.get("/api/v1/admin/no-such-page"), 404);
  });
});
