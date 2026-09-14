// End-to-end exercise of the whole API against the live FP sandbox.
//
// Run with:  bun run test:e2e
//
// This is not a unit test suite. It boots the real Express app on an ephemeral
// port, talks to the real FP ONDC (`cybrillapoa`) sandbox and the real Neon
// database, and walks the entire investor journey in order — catalogue, session,
// pre-verification, profile, contacts, bank account, investment account,
// purchase, consent, mandate, payment, confirm, plans, portfolio, webhooks —
// recording what each endpoint actually did.
//
// Two things it fakes, and only these:
//
//   - OTP delivery. MSG91 needs a DLT-approved template id that this
//     environment does not have, so the OTP *send* path is probed for its
//     expected failure and the VERIFIED PhoneVerification rows a session and a
//     2FA consent spend are written straight to the database. Everything that
//     consumes them — /sessions, /orders/:id/consent — runs for real.
//   - The per-IP rate limiter is reset between phases, because the whole run
//     makes far more than 120 requests a minute from one address. It is then
//     tested deliberately at the end.
//
// It creates real objects in the FP sandbox tenant. That is the point: an order
// FP has not accepted has not been tested.
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { db, disconnectDatabase } from "../src/db/client.ts";
import { fpConfig } from "../src/integrations/fp/fp.config.ts";
import { payoutVerificationRequired } from "../src/services/investor-readiness.service.ts";

const payoutRequired = payoutVerificationRequired();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A PAN the sandbox will treat as fully transactable.
 *
 * The simulation reads two independent things out of the PAN: the 5th character
 * (`A` = aadhaar not linked, `I` = invalid, anything else = verified) and the
 * digits (`3751` = KYC compliant, `3753` = in no KRA). Both must pass.
 *
 * Randomised per run on purpose. The partner realm rate-limits the KRA lookup
 * per PAN and then answers `readiness.status: null` with
 * `readinessCode: "kyc_rate_limit_exceeded"` for the next several minutes —
 * indistinguishable from "still checking" if every run reuses one PAN.
 */
function sandboxPan(): string {
  const letters = "ABCDEFGHJKLMNOPQRSTUVWXYZ";
  const pick = () => letters[Math.floor(Math.random() * letters.length)];
  // 4th character P = individual; 5th must be neither A nor I.
  return `${pick()}${pick()}${pick()}P${pick()}3751${pick()}`;
}

const PAN = sandboxPan();
const NAME = "Tony Soprano";
const DATE_OF_BIRTH = "1959-08-22";
/**
 * A bank account number the sandbox will accept.
 *
 * A number matching `31XX` is simulated as failing verification; anything else
 * passes. Randomised per run for the same reason as the PAN: FP caps
 * verification attempts per account, and once that cap is hit the order review
 * itself fails with `bank_account_verification_attempt_limit_exceeded`.
 */
function sandboxAccountNumber(): string {
  let digits = "";
  while (digits.length < 14) digits += Math.floor(Math.random() * 10);
  return digits.startsWith("31") ? `5${digits.slice(1)}` : digits;
}

const BANK_ACCOUNT_NUMBER = sandboxAccountNumber();
const BANK_IFSC = "HDFC0001330";
/**
 * Schemes are chosen from the live catalogue, not hard-coded.
 *
 * The capabilities differ per scheme and a hard-coded ISIN silently skips
 * whole phases: the index fund this suite used to name advertises
 * `sipAllowed: true` and publishes no SIP frequencies at all, so every plan
 * assertion turned into "informational" and nothing was actually tested.
 */
interface SchemeChoice {
  /** Ranked candidates. FP refuses some schemes its own catalogue marks
   *  `purchaseAllowed`, so the purchase phase works down the list. */
  purchaseCandidates: string[];
  purchase: string;
  plan: string | null;
  planFrequency: string | null;
  planAmount: string;
  planInstallments: number;
  planInstallmentDay: number | null;
  switchIn: string | null;
  lumpsumMin: string;
}

const phone = `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const email = `e2e.${Date.now()}@example.com`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Outcome = "PASS" | "FAIL" | "INFO" | "SKIP";

interface Result {
  phase: string;
  name: string;
  outcome: Outcome;
  detail: string;
}

const results: Result[] = [];
let phase = "";

function section(title: string): void {
  phase = title;
  console.log(`\n\x1b[1m── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}\x1b[0m`);
}

function record(name: string, outcome: Outcome, detail: string): void {
  results.push({ phase, name, outcome, detail });
  const colour = { PASS: 32, FAIL: 31, INFO: 36, SKIP: 33 }[outcome];
  console.log(`  \x1b[${colour}m${outcome.padEnd(4)}\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
}

let baseUrl = "";
let accessToken = "";

interface ApiResponse {
  status: number;
  headers: Headers;
  body: any;
}

async function api(
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; headers?: Record<string, string>; idempotency?: boolean } = {},
): Promise<ApiResponse> {
  const token = options.token === null ? undefined : (options.token ?? accessToken);
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  // Every authenticated write needs one; harmless everywhere else.
  if (options.idempotency !== false && method !== "GET") {
    headers["idempotency-key"] ??= randomBytes(16).toString("hex");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}

/** Assert a status code, and summarise what came back either way. */
function expectStatus(name: string, response: ApiResponse, ...expected: number[]): boolean {
  const ok = expected.includes(response.status);
  record(name, ok ? "PASS" : "FAIL", `${response.status}${ok ? "" : ` (want ${expected.join("/")})`} ${summarise(response)}`);
  return ok;
}

function summarise(response: ApiResponse): string {
  const body = response.body;
  if (body && typeof body === "object" && "error" in body) {
    const { code, message, ...details } = (body as any).error;
    // FP's per-field errors travel in the extra keys; without them a failure
    // reads as "Validation failed. 1 error(s)" and says nothing.
    const extra = Object.keys(details).length ? ` ${JSON.stringify(details).slice(0, 300)}` : "";
    return `${code}: ${String(message).slice(0, 140)}${extra}`;
  }
  if (body && typeof body === "object" && "data" in body) {
    const data = (body as any).data;
    if (Array.isArray(data)) return `${data.length} item(s)`;
    if (data && typeof data === "object") {
      const keys = ["id", "state", "status", "readinessStatus", "stage", "ready"].filter((k) => k in data);
      return keys.map((k) => `${k}=${JSON.stringify(data[k])}`).join(" ") || Object.keys(data).slice(0, 4).join(",");
    }
  }
  return "";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The limiter counts every request from this address; the run makes hundreds. */
async function resetRateLimit(): Promise<void> {
  await db.$executeRawUnsafe("DELETE FROM api_rate_limits");
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Write a VERIFIED phone challenge and return its single-use token.
 *
 * This is the only shortcut in the run: MSG91 cannot deliver in this
 * environment, so the proof is minted rather than earned. Everything that
 * spends it is the real endpoint.
 */
async function mintVerificationToken(
  forPhone: string,
  purpose: "LOGIN" | "TRANSACTION_APPROVAL",
  context?: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.phoneVerification.create({
    data: {
      phone: forPhone,
      purpose,
      status: "VERIFIED",
      ...(context && { context }),
      expiresAt: new Date(now.getTime() + 600_000),
      verifiedAt: now,
      tokenHash: hashToken(token),
      tokenExpiresAt: new Date(now.getTime() + 900_000),
    },
  });
  return token;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const server = createApp().listen(0);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

console.log(`\x1b[1mONDC end-to-end run\x1b[0m`);
console.log(`  server   ${baseUrl}`);
console.log(`  gateway  ${fpConfig().orderGateway}   FP ${fpConfig().baseUrl}   tenant ${fpConfig().tenantId}`);
console.log(`  payout-account verification ${payoutRequired ? "enforced" : "NOT enforced (FP_REQUIRE_PAYOUT_ACCOUNT_VERIFICATION=false)"}`);
console.log(`  investor ${NAME} / ${PAN} / ${phone}`);

// State carried between phases.
let profileId = "";
let accountId = "";
let bankAccountId = "";
let emailId = "";
let phoneId = "";
let addressId = "";
let nomineeId = "";
let preVerificationId = "";
let orderId = "";
let mandateId = "";
let paymentId = "";
let readinessVerified = false;
let bankVerified = false;

try {
  // -------------------------------------------------------------------------
  section("1. Configuration and infrastructure");

  record(
    "order gateway is ONDC only",
    fpConfig().orderGateway === "cybrillapoa" ? "PASS" : "FAIL",
    `FP_ORDER_GATEWAY resolves to "${fpConfig().orderGateway}"`,
  );

  await resetRateLimit();
  const health = await api("GET", "/health", { token: null });
  expectStatus("GET /health", health, 200);
  record(
    "security headers present",
    health.headers.get("x-content-type-options") === "nosniff" && health.headers.get("x-frame-options") === "DENY"
      ? "PASS"
      : "FAIL",
    `nosniff=${health.headers.get("x-content-type-options")} frame=${health.headers.get("x-frame-options")}`,
  );
  // An unknown path under /api/v1 hits requireSession before the 404 handler,
  // so an anonymous caller gets 401 and cannot map the route table.
  expectStatus("an unknown route leaks nothing", await api("GET", "/api/v1/nope", { token: null }), 401);
  expectStatus("an unknown route 404s once authenticated", await api("GET", "/nope", { token: null }), 404);

  // -------------------------------------------------------------------------
  section("2. Catalogue (unauthenticated)");

  const schemes = await api("GET", "/api/v1/schemes?limit=20", { token: null });
  if (!expectStatus("GET /schemes", schemes, 200)) throw new Error("no catalogue to test against");

  const catalogue: { isin: string; detail: any }[] = [];
  for (const row of schemes.body.data as { isin: string }[]) {
    const detail = await api("GET", `/api/v1/schemes/${row.isin}`, { token: null });
    if (detail.status === 200) catalogue.push({ isin: row.isin, detail: detail.body.data });
  }
  record("GET /schemes/:isin for every listed scheme", catalogue.length === schemes.body.data.length ? "PASS" : "FAIL", `${catalogue.length}/${schemes.body.data.length} readable`);

  const thresholdOf = (detail: any, type: string, frequency = "NOT_APPLICABLE") =>
    (detail.thresholds as any[]).find((t) => t.type === type && t.frequency === frequency);

  // Cheapest lumpsum, so the purchase phase costs the least sandbox money.
  const purchasable = catalogue
    .filter((s) => s.detail.purchaseAllowed && thresholdOf(s.detail, "LUMPSUM"))
    .sort((a, b) => Number(thresholdOf(a.detail, "LUMPSUM").amountMin) - Number(thresholdOf(b.detail, "LUMPSUM").amountMin));
  if (purchasable.length === 0) throw new Error("no purchasable scheme in the catalogue");

  // A plan needs a frequency the scheme genuinely publishes AND one the ONDC
  // route accepts — the service restricts SIPs to monthly and daily.
  // Most specific first: MONTHLY is the cadence almost every investor picks,
  // and a daily plan takes no installment day at all.
  const ONDC_SIP_FREQUENCIES = ["MONTHLY", "CALENDAR_DAY_DAILY", "DAILY"];
  const planCandidate = catalogue.find((s) =>
    (s.detail.thresholds as any[]).some((t) => t.type === "SIP" && ONDC_SIP_FREQUENCIES.includes(t.frequency)),
  );
  const planSip = planCandidate
    ? (planCandidate.detail.thresholds as any[])
        .filter((t) => t.type === "SIP" && ONDC_SIP_FREQUENCIES.includes(t.frequency))
        .sort((a, b) => ONDC_SIP_FREQUENCIES.indexOf(a.frequency) - ONDC_SIP_FREQUENCIES.indexOf(b.frequency))[0]
    : null;
  const planIsDaily = planSip ? planSip.frequency !== "MONTHLY" : false;

  const scheme: SchemeChoice = {
    purchaseCandidates: purchasable.map((p) => p.isin),
    purchase: purchasable[0]!.isin,
    plan: planCandidate?.isin ?? null,
    planFrequency: planSip?.frequency ?? null,
    // Round the minimum up to a whole multiple, then to an amount ending in 0
    // so the sandbox auto-succeeds it.
    planAmount: planSip ? String(Math.max(10, Math.ceil(Number(planSip.amountMin) / 10) * 10)) : "0",
    planInstallments: planSip?.installmentsMin ?? 6,
    planInstallmentDay: planIsDaily ? null : (planSip?.allowedDates?.[0] ?? null),
    switchIn:
      catalogue.find((s) => s.isin !== purchasable[0]!.isin && thresholdOf(s.detail, "SWITCH_IN"))?.isin ?? null,
    lumpsumMin: thresholdOf(purchasable[0]!.detail, "LUMPSUM").amountMin,
  };

  // Amounts ending in 0 are auto-succeeded at the RTA after submission, so
  // round the scheme's minimum up to the next multiple of ten.
  let purchaseAmount = String(Math.max(10, Math.ceil(Number(scheme.lumpsumMin) / 10) * 10));

  record("scheme thresholds published", "PASS", `${catalogue.length} scheme(s); purchase ${scheme.purchase} min ${scheme.lumpsumMin}`);
  record(
    "a scheme that really supports SIP",
    scheme.plan ? "PASS" : "SKIP",
    scheme.plan
      ? `${scheme.plan} ${scheme.planFrequency} min ${scheme.planAmount} x${scheme.planInstallments} on day ${scheme.planInstallmentDay}`
      : "none in the catalogue publishes an ONDC-supported SIP frequency",
  );
  record(
    "sipAllowed is not the same as a placeable SIP",
    "INFO",
    `${catalogue.filter((s) => s.detail.sipAllowed).length} advertise sipAllowed, ` +
      `${catalogue.filter((s) => (s.detail.thresholds as any[]).some((t) => t.type === "SIP")).length} publish any SIP frequency`,
  );

  expectStatus("GET /schemes/:isin/nav", await api("GET", `/api/v1/schemes/${scheme.purchase}/nav`, { token: null }), 200);
  expectStatus("unknown ISIN 404s", await api("GET", "/api/v1/schemes/INF000000000", { token: null }), 404);
  expectStatus("a malformed ISIN is rejected", await api("GET", "/api/v1/schemes/not-an-isin", { token: null }), 400, 404);

  // -------------------------------------------------------------------------
  section("3. Authentication");

  expectStatus("no token is refused", await api("GET", "/api/v1/investors/profiles", { token: null }), 401);
  expectStatus(
    "malformed token is refused",
    await api("GET", "/api/v1/investors/profiles", { token: "not-a-real-session-token" }),
    401,
  );
  expectStatus(
    "POST /sessions rejects an unknown proof",
    await api("POST", "/api/v1/sessions", { token: null, body: { verificationToken: randomBytes(32).toString("base64url") } }),
    401,
  );

  const loginToken = await mintVerificationToken(phone, "LOGIN");
  const session = await api("POST", "/api/v1/sessions", { token: null, body: { verificationToken: loginToken } });
  if (!expectStatus("POST /sessions issues a session", session, 201)) throw new Error("cannot continue without a session");
  accessToken = session.body.data.accessToken;
  const userId: string = session.body.data.userId;
  record("session bound to a user", "PASS", `userId ${userId}`);

  expectStatus(
    "a verification proof is single-use",
    await api("POST", "/api/v1/sessions", { token: null, body: { verificationToken: loginToken } }),
    401,
  );

  // -------------------------------------------------------------------------
  section("4. OTP endpoints");

  expectStatus("POST /otp/request rejects a bad number", await api("POST", "/api/v1/otp/request", { token: null, body: { phone: "12345" } }), 400);
  const otpSend = await api("POST", "/api/v1/otp/request", { token: null, body: { phone, purpose: "LOGIN" } });
  record(
    "POST /otp/request reaches the provider",
    otpSend.status === 202 || otpSend.status === 200 ? "PASS" : otpSend.status === 503 ? "SKIP" : "FAIL",
    `${otpSend.status} ${summarise(otpSend)}${otpSend.status === 503 ? " — MSG91_OTP_TEMPLATE_ID is unset in this environment" : ""}`,
  );
  expectStatus("POST /otp/verify rejects an unrequested code", await api("POST", "/api/v1/otp/verify", { token: null, body: { phone: "+919000000001", otp: "123456" } }), 400);

  // -------------------------------------------------------------------------
  section("5. Idempotency and ownership guards");

  await resetRateLimit();
  const noKey = await api("POST", "/api/v1/investors/profiles", {
    body: { name: NAME, pan: PAN, dateOfBirth: DATE_OF_BIRTH, taxStatus: "resident_individual" },
    idempotency: false,
  });
  expectStatus("a write without Idempotency-Key is refused", noKey, 400);

  expectStatus(
    "a too-short Idempotency-Key is refused",
    await api("POST", "/api/v1/kyc/readiness", {
      body: { pan: PAN, name: NAME, dateOfBirth: DATE_OF_BIRTH },
      headers: { "idempotency-key": "short" },
    }),
    400,
  );

  const strangersProfile = await db.investorProfile.findFirst({ where: { userLinks: { none: { userId } } } });
  if (strangersProfile) {
    expectStatus(
      "another investor's profile is not reachable",
      await api("GET", `/api/v1/investors/profiles/${strangersProfile.id}`),
      404,
    );
  } else {
    record("another investor's profile is not reachable", "SKIP", "no other profile in the database");
  }
  expectStatus(
    "a non-uuid resource id is rejected",
    await api("GET", "/api/v1/investors/profiles/not-a-uuid"),
    400, 404,
  );

  // -------------------------------------------------------------------------
  section("6. KYC readiness (pre-verification, partner realm)");

  const readiness = await api("POST", "/api/v1/kyc/readiness", {
    body: {
      pan: PAN,
      name: NAME,
      dateOfBirth: DATE_OF_BIRTH,
      bankAccountNumber: BANK_ACCOUNT_NUMBER,
      bankIfscCode: BANK_IFSC,
      bankAccountType: "savings",
    },
  });
  if (expectStatus("POST /kyc/readiness", readiness, 201)) {
    preVerificationId = readiness.body.data.id;
    // The verdicts land asynchronously. Usually within a second or two, but
    // the POA sandbox has taken well over half a minute, so give it room.
    const attempts = 24;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(3000);
      const poll = await api("GET", `/api/v1/kyc/readiness/${preVerificationId}`);
      if (poll.status !== 200) {
        record("GET /kyc/readiness/:id", "FAIL", `${poll.status} ${summarise(poll)}`);
        break;
      }
      const data = poll.body.data;
      // A null verdict carrying a code is not "still running" — it is a
      // refusal. The partner throttles the KRA lookup per PAN and reports
      // `kyc_rate_limit_exceeded` here, which polling will never clear.
      if (data.readinessStatus === null && data.readinessCode) {
        record("pre-verification settled", "FAIL", `refused: ${data.readinessCode}`);
        break;
      }
      if (data.readinessStatus !== null) {
        readinessVerified = data.ready === true;
        bankVerified = data.checks?.bankAccount?.status === "verified";
        record(
          "pre-verification settled",
          readinessVerified ? "PASS" : "FAIL",
          `readiness=${data.readinessStatus}${data.readinessCode ? `/${data.readinessCode}` : ""} pan=${data.checks.pan.status} name=${data.checks.name.status} dob=${data.checks.dateOfBirth.status} bank=${data.checks?.bankAccount?.status ?? "n/a"}`,
        );
        break;
      }
      if (attempt === attempts - 1) record("pre-verification settled", "FAIL", `still pending after ${(attempts * 3)}s`);
    }
  }

  // -------------------------------------------------------------------------
  section("7. KYC forms (partner realm)");

  // Callback URLs must be on an origin listed in CALLBACK_ALLOWED_ORIGINS.
  const callbackOrigin = (process.env["CALLBACK_ALLOWED_ORIGINS"] ?? "").split(",")[0]?.trim();
  expectStatus(
    "a callback URL outside the allow-list is refused",
    await api("POST", "/api/v1/kyc/forms", {
      body: {
        type: "FRESH", pan: PAN, name: NAME, dateOfBirth: DATE_OF_BIRTH,
        proofCallbackUrl: "https://attacker.example.net/proof",
        esignCallbackUrl: "https://attacker.example.net/esign",
      },
    }),
    400, 503,
  );

  const form = await api("POST", "/api/v1/kyc/forms", {
    body: {
      type: "FRESH",
      pan: PAN,
      name: NAME,
      dateOfBirth: DATE_OF_BIRTH,
      proofCallbackUrl: `${callbackOrigin}/proof`,
      esignCallbackUrl: `${callbackOrigin}/esign`,
    },
  });
  if (form.status === 201) {
    record("POST /kyc/forms", "PASS", summarise(form));
    const formId = form.body.data.id;
    await sleep(3000);
    const refreshed = await api("POST", `/api/v1/kyc/forms/${formId}/refresh`);
    record(
      "eligibility settles",
      refreshed.status === 200 ? "INFO" : "FAIL",
      `${refreshed.status} status=${refreshed.body?.data?.status} reason=${refreshed.body?.data?.reason ?? "-"}`,
    );
    expectStatus("GET /kyc/forms/:id", await api("GET", `/api/v1/kyc/forms/${formId}`), 200);
  } else {
    record(
      "POST /kyc/forms",
      form.status === 400 || form.status === 409 ? "INFO" : "FAIL",
      `${form.status} ${summarise(form)}`,
    );
  }
  expectStatus("GET /kyc/forms", await api("GET", "/api/v1/kyc/forms"), 200);

  // -------------------------------------------------------------------------
  section("8. Investor profile and contacts");

  await resetRateLimit();
  const profileBody = {
    name: NAME,
    pan: PAN,
    dateOfBirth: DATE_OF_BIRTH,
    taxStatus: "resident_individual",
    gender: "male",
    occupation: "business",
    // Write-once at FP: this create is the only chance to record them.
    maritalStatus: "married",
    fatherName: "Johnny Soprano",
    motherName: "Livia Soprano",
    aadhaarLast4: "4321",
    countryOfBirth: "IN",
    placeOfBirth: "Newark",
    nationalityCountry: "IN",
    sourceOfWealth: "business",
    incomeSlab: "above_10lakh_upto_25lakh",
    pepDetails: "not_applicable",
  };
  const profileKey = randomBytes(16).toString("hex");
  const profile = await api("POST", "/api/v1/investors/profiles", {
    body: profileBody,
    headers: { "idempotency-key": profileKey },
  });
  if (!expectStatus("POST /investors/profiles", profile, 201)) throw new Error("cannot continue without a profile");
  profileId = profile.body.data.id;

  // Replay, proved on the route where it matters most: repeating this call
  // without the guard would create a SECOND investor profile at FP.
  const replay = await api("POST", "/api/v1/investors/profiles", {
    body: profileBody,
    headers: { "idempotency-key": profileKey },
  });
  record(
    "the same Idempotency-Key replays the stored response",
    replay.status === 201 && replay.body?.data?.id === profileId ? "PASS" : "FAIL",
    `${replay.status} id=${replay.body?.data?.id ?? "?"} (want ${profileId})`,
  );
  record(
    "a replay is marked as one",
    replay.headers.get("idempotency-replayed") === "true" ? "PASS" : "FAIL",
    `Idempotency-Replayed: ${replay.headers.get("idempotency-replayed") ?? "(absent)"}`,
  );
  const profilesAfterReplay = await api("GET", "/api/v1/investors/profiles");
  record(
    "the replay created nothing",
    (profilesAfterReplay.body?.data ?? []).length === 1 ? "PASS" : "FAIL",
    `${(profilesAfterReplay.body?.data ?? []).length} profile(s) on this user`,
  );
  expectStatus(
    "reusing a key for a different body is refused",
    await api("POST", "/api/v1/investors/profiles", {
      body: { ...profileBody, name: "Someone Else" },
      headers: { "idempotency-key": profileKey },
    }),
    409,
  );
  record("profile mirrored from FP", "INFO", `fpId ${profile.body.data.fpId ?? "?"}`);

  expectStatus("GET /investors/profiles", await api("GET", "/api/v1/investors/profiles"), 200);
  expectStatus("GET /investors/profiles/:id", await api("GET", `/api/v1/investors/profiles/${profileId}`), 200);

  const address = await api("POST", `/api/v1/investors/profiles/${profileId}/addresses`, {
    body: { line1: "14 Aspen Drive", city: "North Caldwell", state: "NJ", postalCode: "400001", country: "IN", nature: "residential" },
  });
  if (expectStatus("POST .../addresses", address, 201)) addressId = address.body.data.id;

  const phoneRow = await api("POST", `/api/v1/investors/profiles/${profileId}/phones`, {
    body: { isd: "+91", number: phone.slice(3), belongsTo: "self" },
  });
  if (expectStatus("POST .../phones", phoneRow, 201)) phoneId = phoneRow.body.data.id;

  const emailRow = await api("POST", `/api/v1/investors/profiles/${profileId}/emails`, {
    body: { email, belongsTo: "self" },
  });
  if (expectStatus("POST .../emails", emailRow, 201)) emailId = emailRow.body.data.id;

  const bank = await api("POST", `/api/v1/investors/profiles/${profileId}/bank-accounts`, {
    body: { accountNumber: BANK_ACCOUNT_NUMBER, accountHolderName: NAME, type: "savings", ifscCode: BANK_IFSC },
  });
  if (expectStatus("POST .../bank-accounts", bank, 201)) bankAccountId = bank.body.data.id;
  record(
    "full account number is not stored",
    bank.body?.data && !("accountNumber" in bank.body.data) ? "PASS" : "FAIL",
    `response exposes ${Object.keys(bank.body?.data ?? {}).filter((k) => k.startsWith("accountNumber")).join(", ")}`,
  );
  expectStatus("GET .../bank-accounts", await api("GET", `/api/v1/investors/profiles/${profileId}/bank-accounts`), 200);

  const nominee = await api("POST", `/api/v1/investors/profiles/${profileId}/nominees`, {
    body: { name: "Carmela Soprano", relationship: "spouse", dateOfBirth: "1960-05-18" },
  });
  if (expectStatus("POST .../nominees", nominee, 201)) nomineeId = nominee.body.data.id;

  // -------------------------------------------------------------------------
  section("9. Bank account verification (required before an ONDC order)");

  if (bankAccountId) {
    const verify = await api("POST", `/api/v1/investors/bank-accounts/${bankAccountId}/verify`);
    if (expectStatus("POST /investors/bank-accounts/:id/verify", verify, 202)) {
      for (let attempt = 0; attempt < 10; attempt++) {
        await sleep(2500);
        const poll = await api("POST", `/api/v1/investors/bank-accounts/${bankAccountId}/verification/refresh`);
        if (poll.status !== 200) {
          record("verification refresh", "FAIL", `${poll.status} ${summarise(poll)}`);
          break;
        }
        if (poll.body.data.usableForPayout === true) {
          bankVerified = true;
          record("payout account verified", "PASS", "usableForPayout=true");
          break;
        }
        if (attempt === 9) {
          // Only a failure where the deployment still enforces it; otherwise it
          // is the known, deliberately accepted sandbox gap.
          record(
            "payout account verified",
            payoutRequired ? "FAIL" : "INFO",
            `usableForPayout=${poll.body.data.usableForPayout} after 25s — the POA penny-drop returns no verdict on this partner; on ONDC an unverified payout account fails the order at submission with payout_account_verification_pending, after payment`,
          );
        }
      }
    }
  } else {
    record("bank verification", "SKIP", "no bank account was created");
  }

  // -------------------------------------------------------------------------
  section("10. Investment account and folio defaults");

  await resetRateLimit();
  const account = await api("POST", `/api/v1/investors/profiles/${profileId}/investment-accounts`, {
    body: {
      emailAddressId: emailId,
      phoneNumberId: phoneId,
      addressId,
      bankAccountId,
      ...(nomineeId && { nominees: [{ relatedPartyId: nomineeId, allocationPercentage: "100" }] }),
      nominationsInfoVisibility: "show_all_nominee_names",
    },
  });
  if (!expectStatus("POST .../investment-accounts", account, 201)) throw new Error("cannot continue without an investment account");
  accountId = account.body.data.id;

  expectStatus("GET /investors/investment-accounts/:id", await api("GET", `/api/v1/investors/investment-accounts/${accountId}`), 200);
  expectStatus(
    "PATCH .../folio-defaults",
    await api("PATCH", `/api/v1/investors/investment-accounts/${accountId}/folio-defaults`, {
      body: { emailAddressId: emailId, phoneNumberId: phoneId, bankAccountId, nominationsInfoVisibility: "show_all_nominee_names" },
    }),
    200,
  );

  // The order gate reads the pre-verification verdicts, so wait on the signal
  // it actually uses rather than on the poll above — a check taken before the
  // profile existed is only joined to the account here.
  let onboarding = await api("GET", "/api/v1/investors/onboarding");
  expectStatus("GET /investors/onboarding", onboarding, 200);
  for (let attempt = 0; attempt < 20 && onboarding.body?.data?.readiness?.identityVerified === false; attempt++) {
    await sleep(3000);
    onboarding = await api("GET", "/api/v1/investors/onboarding");
  }
  const readinessDto = onboarding.body?.data?.readiness ?? {};
  record(
    "onboarding readiness matches the order gate",
    readinessDto.canTransact === true ? "PASS" : "FAIL",
    `stage=${onboarding.body?.data?.stage} identityVerified=${readinessDto.identityVerified} payoutAccountVerified=${readinessDto.payoutAccountVerified} canTransact=${readinessDto.canTransact}`,
  );

  // -------------------------------------------------------------------------
  section("11. ONDC purchase — create");

  await resetRateLimit();
  const badAmount = await api("POST", "/api/v1/orders/purchases", {
    body: { mfInvestmentAccountId: accountId, isin: scheme.purchase, amount: "1", initiatedVia: "mobile_app" },
  });
  expectStatus("an amount below the scheme minimum is refused", badAmount, 400, 409);

  // Work down the candidates. A scheme FP's own catalogue marks
  // `purchaseAllowed: true` can still be refused by the order API with
  // "scheme is not available for purchase" — dividend-reinvestment plans are,
  // in this sandbox — so a single hard-coded ISIN makes the whole phase look
  // broken when it is the catalogue that lied.
  let purchase = { status: 0, headers: new Headers(), body: null } as ApiResponse;
  const refusedSchemes: string[] = [];
  for (const candidate of scheme.purchaseCandidates) {
    const detail = catalogue.find((c) => c.isin === candidate)!.detail;
    const min = (detail.thresholds as any[]).find((t) => t.type === "LUMPSUM" && t.frequency === "NOT_APPLICABLE")?.amountMin ?? "100";
    const amount = String(Math.max(10, Math.ceil(Number(min) / 10) * 10));
    purchase = await api("POST", "/api/v1/orders/purchases", {
      body: { mfInvestmentAccountId: accountId, isin: candidate, amount, initiatedVia: "mobile_app" },
    });
    if (purchase.status === 201) {
      scheme.purchase = candidate;
      purchaseAmount = amount;
      break;
    }
    refusedSchemes.push(`${candidate} (${detail.investmentOption ?? "?"}): ${summarise(purchase)}`);
  }
  if (refusedSchemes.length > 0) {
    record(
      "schemes the catalogue calls purchasable that FP refuses",
      "INFO",
      refusedSchemes.join(" | ").slice(0, 400),
    );
  }
  if (expectStatus("POST /orders/purchases", purchase, 201)) {
    orderId = purchase.body.data.id;
    record(
      "order opens in the ONDC state",
      purchase.body.data.state === "UNDER_REVIEW" ? "PASS" : "INFO",
      `state=${purchase.body.data.state} gateway=${purchase.body.data.gateway}`,
    );
  }

  if (orderId) {
    expectStatus("GET /orders/:id", await api("GET", `/api/v1/orders/${orderId}`), 200);
    expectStatus("GET /orders?mfInvestmentAccountId=", await api("GET", `/api/v1/orders?mfInvestmentAccountId=${accountId}`), 200);

    // -----------------------------------------------------------------------
    section("12. ONDC purchase — review, consent, payment, confirm");

    let state = purchase.body.data.state;
    for (let attempt = 0; attempt < 12 && state === "UNDER_REVIEW"; attempt++) {
      await sleep(2500);
      const refreshed = await api("POST", `/api/v1/orders/${orderId}/refresh`);
      if (refreshed.status !== 200) {
        record("POST /orders/:id/refresh", "FAIL", `${refreshed.status} ${summarise(refreshed)}`);
        break;
      }
      state = refreshed.body.data.state;
      if (state !== "UNDER_REVIEW") {
        record(
          "asynchronous review completed",
          state === "PENDING" ? "PASS" : "FAIL",
          `state=${state}${refreshed.body.data.failureCode ? ` failureCode=${refreshed.body.data.failureCode}` : ""}`,
        );
      }
    }
    if (state === "UNDER_REVIEW") record("asynchronous review completed", "FAIL", "still under_review after 30s");

    // Consent must be refused before the review passes, and pay before consent.
    if (state === "PENDING") {
      const earlyPay = await api("POST", `/api/v1/payments/netbanking`, {
        body: { orderIds: [orderId], method: "NETBANKING" },
      });
      expectStatus("payment before consent is refused", earlyPay, 409);

      // The 2FA challenge goes to the folio's registered mobile; the endpoint
      // that requests it needs MSG91, so probe it and then mint the proof.
      const otpRequest = await api("POST", "/api/v1/transaction-otp/request", {
        body: { kind: "order", id: orderId },
      });
      record(
        "POST /transaction-otp/request",
        otpRequest.status === 202 ? "PASS" : otpRequest.status === 503 ? "SKIP" : "FAIL",
        `${otpRequest.status} ${summarise(otpRequest)}`,
      );

      const consentToken = await mintVerificationToken(phone, "TRANSACTION_APPROVAL", `order:${orderId}`);
      const wrongToken = await mintVerificationToken("+919000000009", "TRANSACTION_APPROVAL", `order:${orderId}`);
      expectStatus(
        "consent from a different number is refused",
        await api("POST", `/api/v1/orders/purchases/${orderId}/consent`, { body: { verificationToken: wrongToken } }),
        400,
      );

      const consent = await api("POST", `/api/v1/orders/purchases/${orderId}/consent`, {
        body: { verificationToken: consentToken },
      });
      const consented = expectStatus("POST /orders/purchases/:id/consent", consent, 200);
      if (consented) {
        record("consent recorded alone, before payment", consent.body.data.consentRecorded ? "PASS" : "FAIL", `state=${consent.body.data.state}`);

        expectStatus(
          "confirm without a payment is refused",
          await api("POST", `/api/v1/orders/purchases/${orderId}/confirm`),
          409,
        );

        // --- mandate ---------------------------------------------------------
        const mandate = await api("POST", "/api/v1/payments/mandates", {
          body: { bankAccountId, mandateType: "E_MANDATE", mandateLimit: "100000", providerName: "CYBRILLAPOA" },
        });
        if (expectStatus("POST /payments/mandates", mandate, 201)) {
          mandateId = mandate.body.data.id;
          record("mandate provider matches the gateway", mandate.body.data.provider === "CYBRILLAPOA" ? "PASS" : "FAIL", `provider=${mandate.body.data.provider}`);

          const authorize = await api("POST", `/api/v1/payments/mandates/${mandateId}/authorize`);
          expectStatus("POST /payments/mandates/:id/authorize", authorize, 200);
          record("authorisation URL issued", authorize.body?.data?.authorizationUrl ? "PASS" : "FAIL", String(authorize.body?.data?.authorizationUrl ?? "").slice(0, 80));

          await sleep(3000);
          const refreshedMandate = await api("POST", `/api/v1/payments/mandates/${mandateId}/refresh`);
          expectStatus("POST /payments/mandates/:id/refresh", refreshedMandate, 200);
          record(
            "mandate status",
            "INFO",
            `${refreshedMandate.body?.data?.status} — only APPROVED can be debited (approval happens at the investor's bank)`,
          );

          expectStatus("GET /payments/mandates?investorProfileId=", await api("GET", `/api/v1/payments/mandates?investorProfileId=${profileId}`), 200);
          expectStatus("GET /payments/mandates/:id", await api("GET", `/api/v1/payments/mandates/${mandateId}`), 200);

          if (refreshedMandate.body?.data?.status === "APPROVED") {
            const pay = await api("POST", `/api/v1/payments/mandates/${mandateId}/pay`, { body: { orderIds: [orderId] } });
            if (expectStatus("POST /payments/mandates/:id/pay", pay, 201)) {
              paymentId = pay.body.data.id;
              record("payment reached FP", "PASS", `status=${pay.body.data.status} amount=${pay.body.data.amount}`);
            }
          } else {
            record("POST /payments/mandates/:id/pay", "SKIP", `mandate is ${refreshedMandate.body?.data?.status}, not APPROVED`);
          }
        }

        // --- netbanking fallback ---------------------------------------------
        if (!paymentId) {
          const netbanking = await api("POST", "/api/v1/payments/netbanking", {
            body: { orderIds: [orderId], method: "NETBANKING", bankAccountId },
          });
          if (netbanking.status === 201) {
            paymentId = netbanking.body.data.id;
            record("POST /payments/netbanking", "PASS", `status=${netbanking.body.data.status} url=${netbanking.body.data.paymentUrl ? "issued" : "none"}`);
          } else {
            record("POST /payments/netbanking", "INFO", `${netbanking.status} ${summarise(netbanking)}`);
            // FP rejected the request outright, so nothing was charged and the
            // order must still be payable. Holding the claim here would brick
            // the order over a provider misconfiguration.
            const stuck = await db.paymentSubmission.count({ where: { orderId, fpPaymentId: null } });
            record(
              "a rejected payment does not brick the order",
              stuck === 0 ? "PASS" : "FAIL",
              stuck === 0 ? "the claim was released" : `${stuck} claim(s) still held with no payment behind them`,
            );
          }
        }

        if (paymentId) {
          expectStatus("GET /payments/:id", await api("GET", `/api/v1/payments/${paymentId}`), 200);
          expectStatus("POST /payments/:id/refresh", await api("POST", `/api/v1/payments/${paymentId}/refresh`), 200);
          expectStatus(
            "a second payment for the same order is refused",
            await api("POST", `/api/v1/payments/mandates/${mandateId}/pay`, { body: { orderIds: [orderId] } }),
            409,
          );

          const confirm = await api("POST", `/api/v1/orders/purchases/${orderId}/confirm`);
          if (expectStatus("POST /orders/purchases/:id/confirm", confirm, 200)) {
            record("order confirmed", ["CONFIRMED", "SUBMITTED", "SUCCESSFUL"].includes(confirm.body.data.state) ? "PASS" : "FAIL", `state=${confirm.body.data.state}`);
            await sleep(4000);
            const final = await api("POST", `/api/v1/orders/${orderId}/refresh`);
            record(
              "order settles at the AMC",
              final.body?.data?.state === "SUCCESSFUL" ? "PASS" : "INFO",
              `state=${final.body?.data?.state} failureCode=${final.body?.data?.failureCode ?? "-"} units=${final.body?.data?.allottedUnits ?? "-"}`,
            );
          }
        } else {
          record("POST /orders/purchases/:id/confirm", "SKIP", "no payment was created");
        }
      }
    } else {
      record("consent / payment / confirm", "SKIP", `order is ${state}, not PENDING`);
    }
  }

  // -------------------------------------------------------------------------
  section("12b. Cancel and retry");

  // A second, deliberately abandoned order — cancel is only valid while an
  // order is pending with no payment behind it, so it cannot be tested on the
  // one the flow above just paid for.
  await resetRateLimit();
  const spare = await api("POST", "/api/v1/orders/purchases", {
    body: { mfInvestmentAccountId: accountId, isin: scheme.purchase, amount: purchaseAmount, initiatedVia: "mobile_app" },
  });
  if (spare.status === 201) {
    const spareId = spare.body.data.id;
    let spareState = spare.body.data.state;
    for (let attempt = 0; attempt < 12 && spareState === "UNDER_REVIEW"; attempt++) {
      await sleep(2500);
      const refreshed = await api("POST", `/api/v1/orders/${spareId}/refresh`);
      spareState = refreshed.body?.data?.state ?? spareState;
    }
    const retried = await api("POST", `/api/v1/orders/purchases/${spareId}/retry`);
    if (spareState === "FAILED") {
      // A failed order passes our guard; whether FP will reopen it depends on
      // why it failed — only payment_failure and order_expiry are eligible.
      record("POST /orders/purchases/:id/retry", retried.status === 200 ? "PASS" : "INFO", `${retried.status} ${summarise(retried)}`);
    } else {
      expectStatus("retrying an order that has not failed is refused", retried, 409);
    }

    const cancelled = await api("POST", `/api/v1/orders/purchases/${spareId}/cancel`);
    record(
      "POST /orders/purchases/:id/cancel",
      cancelled.status === 200 ? "PASS" : spareState === "PENDING" ? "FAIL" : "INFO",
      `${cancelled.status} ${summarise(cancelled)} (order was ${spareState})`,
    );
  } else {
    record("cancel / retry", "SKIP", `could not place a second order: ${summarise(spare)}`);
  }

  // -------------------------------------------------------------------------
  section("13. Redemptions and switches");

  await resetRateLimit();
  const folios = await api("GET", `/api/v1/portfolio/${accountId}/folios`);
  const folioNumber: string | undefined = folios.body?.data?.[0]?.number;
  if (folioNumber) {
    const redemption = await api("POST", "/api/v1/orders/redemptions", {
      body: { mfInvestmentAccountId: accountId, isin: scheme.purchase, folioNumber, amount: "500", initiatedVia: "mobile_app" },
    });
    record("POST /orders/redemptions", redemption.status === 201 ? "PASS" : "INFO", `${redemption.status} ${summarise(redemption)}`);
    const switchOrder = await api("POST", "/api/v1/orders/switches", {
      body: { mfInvestmentAccountId: accountId, switchOutIsin: scheme.purchase, switchInIsin: scheme.switchIn, folioNumber, amount: "500", initiatedVia: "mobile_app" },
    });
    record("POST /orders/switches", switchOrder.status === 201 ? "PASS" : "INFO", `${switchOrder.status} ${summarise(switchOrder)}`);
  } else {
    record("redemption / switch", "SKIP", "no folio exists yet — a purchase must settle first");
  }

  // -------------------------------------------------------------------------
  section("14. Plans (SIP / SWP / STP)");

  // A scheme that publishes no frequency must be refused locally, with a
  // message naming the scheme — not by FP after the investor picked a date.
  const noSipScheme = catalogue.find(
    (s) => !(s.detail.thresholds as any[]).some((t) => t.type === "SIP"),
  );
  if (noSipScheme) {
    const refused = await api("POST", "/api/v1/plans/sips", {
      body: {
        mfInvestmentAccountId: accountId,
        isin: noSipScheme.isin,
        amount: "1000",
        frequency: "MONTHLY",
        numberOfInstallments: 12,
      },
    });
    expectStatus("a SIP on a scheme with no frequencies is refused locally", refused, 400);
  }

  expectStatus(
    "an unsupported frequency is refused",
    await api("POST", "/api/v1/plans/sips", {
      body: {
        mfInvestmentAccountId: accountId,
        isin: scheme.plan ?? scheme.purchase,
        amount: "1000",
        frequency: "FORTNIGHTLY",
        numberOfInstallments: 12,
      },
    }),
    400,
  );

  if (scheme.plan && scheme.planFrequency) {
    const planBody = {
      mfInvestmentAccountId: accountId,
      isin: scheme.plan,
      amount: scheme.planAmount,
      frequency: scheme.planFrequency,
      numberOfInstallments: scheme.planInstallments,
      ...(scheme.planInstallmentDay !== null && { installmentDay: scheme.planInstallmentDay }),
    };

    // A mandate that has not been approved at the investor's bank cannot fund
    // installments, and FP's own error for it names a gateway rather than the
    // mandate — so the refusal has to happen here.
    if (mandateId) {
      expectStatus(
        "a SIP funded by an unapproved mandate is refused",
        await api("POST", "/api/v1/plans/sips", { body: { ...planBody, mandateId } }),
        400,
      );
    }

    // A daily plan takes no installment day; FP answers "installment_day
    // should be null for the given frequency", which the client cannot act on.
    expectStatus(
      "an installment day on a daily plan is refused",
      await api("POST", "/api/v1/plans/sips", {
        body: { ...planBody, frequency: "DAILY", installmentDay: 1 },
      }),
      400,
    );

    const sip = await api("POST", "/api/v1/plans/sips", { body: planBody });
    if (expectStatus("POST /plans/sips", sip, 201)) {
      const planId = sip.body.data.id;
      record(
        "plan opens systematic, on the ONDC route",
        sip.body.data.systematic === true ? "PASS" : "FAIL",
        `state=${sip.body.data.state} frequency=${sip.body.data.frequency} next=${sip.body.data.nextInstallmentDate ?? "-"}`,
      );
      expectStatus("GET /plans/:id", await api("GET", `/api/v1/plans/${planId}`), 200);
      expectStatus("POST /plans/:id/refresh", await api("POST", `/api/v1/plans/${planId}/refresh`), 200);

      const list = await api("GET", `/api/v1/plans?mfInvestmentAccountId=${accountId}`);
      expectStatus("GET /plans?mfInvestmentAccountId=", list, 200);
      record(
        "the new plan appears in the list",
        (list.body?.data ?? []).some((p: any) => p.id === planId) ? "PASS" : "FAIL",
        `${(list.body?.data ?? []).length} plan(s)`,
      );

      expectStatus(
        "a custom cancellation reason is required with custom_reason",
        await api("POST", `/api/v1/plans/${planId}/cancel`, { body: { cancellationCode: "custom_reason" } }),
        400,
      );
      // What cancel does depends on how far the plan got. Once FP has reviewed
      // it, the ONDC route refuses cancellation outright and the refusal has to
      // come from us, in words the investor can act on.
      const stateBeforeCancel = (await api("GET", `/api/v1/plans/${planId}`)).body?.data?.state;
      const cancelled = await api("POST", `/api/v1/plans/${planId}/cancel`, {
        body: { cancellationCode: "amount_not_available" },
      });
      if (stateBeforeCancel === "REVIEW_COMPLETED") {
        const refused = expectStatus("a reviewed plan cannot be cancelled on ONDC", cancelled, 409);
        record(
          "the refusal says what to do instead",
          refused && /confirm it/i.test(String(cancelled.body?.error?.message)) ? "PASS" : "FAIL",
          String(cancelled.body?.error?.message ?? "").slice(0, 120),
        );
      } else if (expectStatus("POST /plans/:id/cancel", cancelled, 200)) {
        record("plan reaches a terminal state", cancelled.body.data.state === "CANCELLED" ? "PASS" : "INFO", `state=${cancelled.body.data.state}`);
      }
    }
  } else {
    record("POST /plans/sips", "SKIP", "no scheme in the catalogue supports an ONDC SIP frequency");
    expectStatus("GET /plans?mfInvestmentAccountId=", await api("GET", `/api/v1/plans?mfInvestmentAccountId=${accountId}`), 200);
  }

  // SWP and STP sell units, so they need a folio with a holding behind it.
  if (scheme.plan) {
    const swp = await api("POST", "/api/v1/plans/swps", {
      body: {
        mfInvestmentAccountId: accountId,
        isin: scheme.plan,
        folioNumber: "NOSUCHFOLIO",
        amount: "1000",
        frequency: "MONTHLY",
        numberOfInstallments: 6,
      },
    });
    expectStatus("an SWP on a folio this account does not own is refused", swp, 400);
    const stp = await api("POST", "/api/v1/plans/stps", {
      body: {
        mfInvestmentAccountId: accountId,
        switchOutIsin: scheme.plan,
        switchInIsin: scheme.switchIn ?? scheme.purchase,
        folioNumber: "NOSUCHFOLIO",
        amount: "1000",
        frequency: "MONTHLY",
        numberOfInstallments: 6,
      },
    });
    expectStatus("an STP on a folio this account does not own is refused", stp, 400);
    expectStatus(
      "an SWP with neither amount nor units is refused",
      await api("POST", "/api/v1/plans/swps", {
        body: {
          mfInvestmentAccountId: accountId,
          isin: scheme.plan,
          folioNumber: "NOSUCHFOLIO",
          frequency: "MONTHLY",
          numberOfInstallments: 6,
        },
      }),
      400,
    );
  }

  // -------------------------------------------------------------------------
  section("15. Portfolio");

  await resetRateLimit();
  expectStatus("GET /portfolio/:id/summary", await api("GET", `/api/v1/portfolio/${accountId}/summary`), 200);
  expectStatus("GET /portfolio/:id/holdings", await api("GET", `/api/v1/portfolio/${accountId}/holdings`), 200);
  expectStatus("GET /portfolio/:id/folios", await api("GET", `/api/v1/portfolio/${accountId}/folios`), 200);
  expectStatus("GET /portfolio/:id/returns", await api("GET", `/api/v1/portfolio/${accountId}/returns`), 200);
  expectStatus("GET /portfolio/:id/capital-gains", await api("GET", `/api/v1/portfolio/${accountId}/capital-gains`), 200);
  expectStatus("POST /portfolio/:id/refresh", await api("POST", `/api/v1/portfolio/${accountId}/refresh`), 200);

  // -------------------------------------------------------------------------
  section("16. Webhooks");

  const eventId = `evt_e2e_${randomBytes(8).toString("hex")}`;
  const event = { id: eventId, type: "mf_purchase.pending", time: new Date().toISOString(), data: { object: { id: "mfp_does_not_exist" } } };
  const first = await api("POST", "/api/v1/webhooks/fp", { token: null, body: event, idempotency: false });
  expectStatus("POST /webhooks/fp accepts a delivery", first, 200);
  record("delivery recorded", first.body?.data?.received === true ? "PASS" : "FAIL", JSON.stringify(first.body?.data));
  const second = await api("POST", "/api/v1/webhooks/fp", { token: null, body: event, idempotency: false });
  record(
    "a redelivery is acknowledged, not retried",
    second.status === 200 && second.body?.data?.duplicate === true ? "PASS" : "FAIL",
    `${second.status} duplicate=${second.body?.data?.duplicate}`,
  );
  expectStatus("a payload with no id is refused", await api("POST", "/api/v1/webhooks/fp", { token: null, body: { type: "x" }, idempotency: false }), 400);
  expectStatus("operator endpoints need the shared secret", await api("GET", "/api/v1/webhooks/fp/backlog", { token: null }), 403);
  const adminSecret = process.env["FP_WEBHOOK_ADMIN_SECRET"]?.trim();
  if (adminSecret) {
    const backlog = await api("GET", "/api/v1/webhooks/fp/backlog", { token: null, headers: { "x-admin-secret": adminSecret } });
    expectStatus("GET /webhooks/fp/backlog", backlog, 200);
    record("backlog", "INFO", JSON.stringify(backlog.body?.data).slice(0, 160));
    const processed = await api("POST", "/api/v1/webhooks/fp/process?limit=5", { token: null, headers: { "x-admin-secret": adminSecret }, idempotency: false });
    expectStatus("POST /webhooks/fp/process", processed, 200);
    record("processor result", "INFO", JSON.stringify(processed.body?.data).slice(0, 200));
    record(
      "an event whose object FP does not have is retried, not lost",
      (processed.body?.data?.failed ?? 0) >= 1 ? "PASS" : "FAIL",
      "it stays pending for the operator rather than being marked processed",
    );
  } else {
    record("operator endpoints", "SKIP", "FP_WEBHOOK_ADMIN_SECRET is not set");
  }
  // The synthetic event points at an object FP does not have, so it would sit
  // in the backlog for ever. Real backlog is a signal; test litter is not.
  await db.fpWebhookEvent.deleteMany({ where: { fpEventId: { startsWith: "evt_e2e_" } } });

  // -------------------------------------------------------------------------
  section("17. ONDC-only guards");

  const rtaOrder = await db.mfPurchase.findFirst({ where: { gateway: { not: "CYBRILLAPOA" } }, select: { id: true, gateway: true } });
  if (rtaOrder) {
    expectStatus(`a legacy ${rtaOrder.gateway} order is not reachable`, await api("GET", `/api/v1/orders/${rtaOrder.id}`), 404);
  } else {
    record("legacy non-ONDC orders are unreachable", "SKIP", "none in the database");
  }
  expectStatus("there is no settlement route", await api("POST", `/api/v1/orders/purchases/${orderId || "x"}/settlement`, { body: {} }), 404);
  const badProvider = await api("POST", "/api/v1/payments/mandates", {
    body: { bankAccountId, mandateType: "E_MANDATE", mandateLimit: "1000", providerName: "RAZORPAY" },
  });
  expectStatus("a non-ONDC payment provider is refused", badProvider, 400);

  // -------------------------------------------------------------------------
  section("18. Rate limiting");

  await resetRateLimit();
  let limited = 0;
  for (let i = 0; i < 20; i++) {
    const response = await api("POST", "/api/v1/otp/verify", { token: null, body: { phone: "+919000000002", otp: "000000" } });
    if (response.status === 429) limited++;
  }
  record("the auth group is rate limited", limited > 0 ? "PASS" : "FAIL", `${limited}/20 requests were rejected with 429`);
  await resetRateLimit();
} catch (error) {
  record("run aborted", "FAIL", error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) console.error(error.stack);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n\x1b[1m── Summary ${"─".repeat(50)}\x1b[0m`);
const failures = results.filter((r) => r.outcome === "FAIL");
const counts = { PASS: 0, FAIL: 0, INFO: 0, SKIP: 0 };
for (const result of results) counts[result.outcome]++;
console.log(`  ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIP} skipped, ${counts.INFO} informational`);
if (failures.length) {
  console.log(`\n\x1b[31m  Failures:\x1b[0m`);
  for (const failure of failures) console.log(`    [${failure.phase}] ${failure.name} — ${failure.detail}`);
}
console.log(
  `\n  artefacts: profile=${profileId || "-"} account=${accountId || "-"} order=${orderId || "-"} mandate=${mandateId || "-"} payment=${paymentId || "-"}`,
);
console.log(`  readiness verified=${readinessVerified}  payout account verified=${bankVerified}`);

server.close();
await disconnectDatabase();
process.exit(failures.length ? 1 : 0);
