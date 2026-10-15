// FT-SOC: sign in with Apple / Google — the provider proves who the investor is,
// the phone OTP still opens the session, and the link is made only after both.
// FT-PRF: the self-declared investment experience on the profile screen.
//
// Provider tokens are signed here with a throwaway RSA key and its JWKS served
// locally. The app honours the JWKS override only under NODE_ENV=test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { Client, DEV_OTP, expectError, expectStatus, newPhone, signIn } from "./lib.ts";

const { db } = await import("../src/db/client.ts");

const APPLE_AUD = "in.risips.app";
const GOOGLE_AUD = "risips-test.apps.googleusercontent.com";

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}
const trusted = keyPair("ft-key-1");
const stranger = keyPair("ft-key-1"); // same kid, different key: a forgery

function idToken(
  claims: Record<string, unknown>,
  { key = trusted.privateKey, kid = trusted.kid, alg = "RS256" }: { key?: KeyObject; kid?: string; alg?: string } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 600, ...claims })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}
const apple = (sub: string, extra: Record<string, unknown> = {}) =>
  idToken({ iss: "https://appleid.apple.com", aud: APPLE_AUD, sub, email: `${sub}@privaterelay.appleid.com`, email_verified: "true", ...extra });
const google = (sub: string, extra: Record<string, unknown> = {}) =>
  idToken({ iss: "https://accounts.google.com", aud: GOOGLE_AUD, sub, email: `${sub}@gmail.example`, email_verified: true, ...extra });

const sub = () => `ft-${randomBytes(6).toString("hex")}`;

let jwks: ReturnType<typeof Bun.serve> | undefined;

/** Phone OTP, then the session — carrying the social ticket when there is one. */
async function finish(client: Client, phone: string, socialToken?: string) {
  expectStatus(await client.post("/api/v1/otp/request", { phone, purpose: "LOGIN" }), 202);
  const verified = await client.post("/api/v1/otp/verify", { phone, otp: DEV_OTP, purpose: "LOGIN" });
  expectStatus(verified, 200);
  return client.post("/api/v1/sessions", {
    verificationToken: verified.body.data.verificationToken,
    ...(socialToken && { socialToken }),
  });
}

describe("FT-SOC switched off", () => {
  test("FT-SOC-01 with no client ids configured both providers are off and the route is absent", async () => {
    delete process.env.APPLE_CLIENT_IDS;
    delete process.env.GOOGLE_CLIENT_IDS;
    const providers = await new Client().get("/api/v1/sessions/social/providers");
    expectStatus(providers, 200);
    expect(providers.body.data).toEqual({ apple: false, google: false });
    expectError(await new Client().post("/api/v1/sessions/social", { provider: "APPLE", idToken: apple(sub()) }, { idem: false }), 404);
  });
});

describe("FT-SOC sign in with Apple / Google", () => {
  beforeAll(() => {
    jwks = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ keys: [trusted.jwk] }) });
    Object.assign(process.env, {
      APPLE_CLIENT_IDS: APPLE_AUD,
      GOOGLE_CLIENT_IDS: GOOGLE_AUD,
      APPLE_JWKS_URL: `http://127.0.0.1:${jwks.port}/apple`,
      GOOGLE_JWKS_URL: `http://127.0.0.1:${jwks.port}/google`,
    });
  });
  afterAll(() => {
    jwks?.stop(true);
    for (const name of ["APPLE_CLIENT_IDS", "GOOGLE_CLIENT_IDS", "APPLE_JWKS_URL", "GOOGLE_JWKS_URL"]) delete process.env[name];
  });

  test("FT-SOC-02 configured providers are reported on", async () => {
    const providers = await new Client().get("/api/v1/sessions/social/providers");
    expect(providers.body.data).toEqual({ apple: true, google: true });
  });

  test.each([
    ["a token signed by someone else's key", () => idToken({ iss: "https://appleid.apple.com", aud: APPLE_AUD, sub: sub() }, { key: stranger.privateKey })],
    ["a token for another app", () => apple(sub(), { aud: "com.someone.else" })],
    ["a token from another issuer", () => apple(sub(), { iss: "https://evil.example" })],
    ["an expired token", () => apple(sub(), { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["an unsigned token", () => idToken({ iss: "https://appleid.apple.com", aud: APPLE_AUD, sub: sub() }, { alg: "none" })],
  ])("FT-SOC-03 refuses %s", async (_label, make) => {
    expectError(await new Client().post("/api/v1/sessions/social", { provider: "APPLE", idToken: make() }, { idem: false }), 401, "INVALID_ID_TOKEN");
  });

  test("FT-SOC-04 the nonce must match when the token carries one", async () => {
    const nonce = randomBytes(16).toString("hex");
    const hashed = createHash("sha256").update(nonce).digest("hex");
    const token = apple(sub(), { nonce: hashed });
    expectError(await new Client().post("/api/v1/sessions/social", { provider: "APPLE", idToken: token, nonce: "other" }, { idem: false }), 401, "INVALID_ID_TOKEN");
    expectError(await new Client().post("/api/v1/sessions/social", { provider: "APPLE", idToken: token }, { idem: false }), 401, "INVALID_ID_TOKEN");
    expectStatus(await new Client().post("/api/v1/sessions/social", { provider: "APPLE", idToken: token, nonce }, { idem: false }), 201);
  });

  const appleSub = sub();
  const phone = newPhone();
  let userId: string;

  test("FT-SOC-05 a new Apple account signs up through the phone OTP and is linked", async () => {
    const client = new Client();
    const started = await client.post("/api/v1/sessions/social", { provider: "APPLE", idToken: apple(appleSub) }, { idem: false });
    expectStatus(started, 201);
    expect(started.body.data.linked).toBe(false);
    expect(started.body.data.phoneHint).toBeNull();
    const session = await finish(client, phone, started.body.data.socialToken);
    expectStatus(session, 201);
    userId = session.body.data.userId;
    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
    expect(user.email).toBe(`${appleSub}@privaterelay.appleid.com`);
    expect(user.emailVerifiedAt).not.toBeNull();
    const audit = await db.auditLog.findMany({ where: { entityId: userId, action: "SOCIAL_IDENTITY_LINKED" }, select: { id: true } });
    expect(audit).toHaveLength(1);
  });

  test("FT-SOC-06 a ticket is single use", async () => {
    const client = new Client();
    const started = await client.post("/api/v1/sessions/social", { provider: "APPLE", idToken: apple(appleSub) }, { idem: false });
    expectStatus(await finish(client, phone, started.body.data.socialToken), 201);
    expectError(await finish(client, phone, started.body.data.socialToken), 401, "SOCIAL_SIGN_IN_EXPIRED");
  });

  test("FT-SOC-07 a linked account names its number (masked) and signs in to it", async () => {
    const client = new Client();
    const started = await client.post("/api/v1/sessions/social", { provider: "APPLE", idToken: apple(appleSub) }, { idem: false });
    expect(started.body.data.linked).toBe(true);
    expect(started.body.data.phoneHint).toBe(`XXXXXX${phone.slice(-4)}`);
    const session = await finish(client, phone, started.body.data.socialToken);
    expectStatus(session, 201);
    expect(session.body.data.userId).toBe(userId);
  });

  test("FT-SOC-08 a linked account cannot open a different number's login, and nothing is issued", async () => {
    const client = new Client();
    const otherPhone = newPhone();
    const started = await client.post("/api/v1/sessions/social", { provider: "APPLE", idToken: apple(appleSub) }, { idem: false });
    expectError(await finish(client, otherPhone, started.body.data.socialToken), 409);
    // Rolled back with the refusal: the number was never signed up.
    expect(await db.user.findUnique({ where: { phone: otherPhone }, select: { id: true } })).toBeNull();
  });

  test("FT-SOC-09 a login already linked to one Google account refuses a second", async () => {
    const owner = newPhone();
    const first = new Client();
    const a = await first.post("/api/v1/sessions/social", { provider: "GOOGLE", idToken: google(sub()) }, { idem: false });
    expectStatus(await finish(first, owner, a.body.data.socialToken), 201);
    const second = new Client();
    const b = await second.post("/api/v1/sessions/social", { provider: "GOOGLE", idToken: google(sub()) }, { idem: false });
    expectError(await finish(second, owner, b.body.data.socialToken), 409);
  });

  test("FT-SOC-10 a provider email never replaces an existing one or takes another login's", async () => {
    const investor = await signIn();
    await db.user.update({ where: { id: investor.userId! }, data: { email: `kept-${sub()}@example.test` } });
    const before = await db.user.findUniqueOrThrow({ where: { id: investor.userId! }, select: { email: true } });
    const client = new Client();
    const started = await client.post("/api/v1/sessions/social", { provider: "GOOGLE", idToken: google(sub()) }, { idem: false });
    expectStatus(await finish(client, investor.phone, started.body.data.socialToken), 201);
    const after = await db.user.findUniqueOrThrow({ where: { id: investor.userId! }, select: { email: true } });
    expect(after.email).toBe(before.email);
  });

  test("FT-SOC-11 a ticket without a passed phone OTP opens nothing", async () => {
    const client = new Client();
    const started = await client.post("/api/v1/sessions/social", { provider: "GOOGLE", idToken: google(sub()) }, { idem: false });
    expectError(await client.post("/api/v1/sessions", { verificationToken: "x".repeat(43), socialToken: started.body.data.socialToken }), 401);
  });
});

describe("FT-PRF investment experience", () => {
  let investor: Client;
  beforeAll(async () => {
    investor = await signIn();
  });

  test("FT-PRF-01 unanswered at first", async () => {
    const reply = await investor.get("/api/v1/investors/investment-experience");
    expectStatus(reply, 200);
    expect(reply.body.data).toEqual({ value: null, updatedAt: null });
  });

  test("FT-PRF-02 an answer is saved and audit-logged", async () => {
    const saved = await investor.put("/api/v1/investors/investment-experience", { value: "ONE_TO_3_YEARS" });
    expectStatus(saved, 200);
    expect(saved.body.data.value).toBe("ONE_TO_3_YEARS");
    expect(typeof saved.body.data.updatedAt).toBe("string");
    expectStatus(await investor.put("/api/v1/investors/investment-experience", { value: "MORE_THAN_5_YEARS" }), 200);
    expect((await investor.get("/api/v1/investors/investment-experience")).body.data.value).toBe("MORE_THAN_5_YEARS");
    const audit = await db.auditLog.findMany({
      where: { entityId: investor.userId!, action: "INVESTMENT_EXPERIENCE_UPDATED" },
      orderBy: { createdAt: "asc" }, select: { metadata: true },
    });
    expect(audit.map((row) => row.metadata)).toEqual([
      { from: null, to: "ONE_TO_3_YEARS" },
      { from: "ONE_TO_3_YEARS", to: "MORE_THAN_5_YEARS" },
    ]);
  });

  test("FT-PRF-03 an unknown answer is a 400; signed out is a 401", async () => {
    expectError(await investor.put("/api/v1/investors/investment-experience", { value: "A_LOT" }), 400);
    expectError(await investor.put("/api/v1/investors/investment-experience", {}), 400);
    expectError(await new Client().get("/api/v1/investors/investment-experience"), 401);
  });
});
