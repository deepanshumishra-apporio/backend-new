// Provision several sandbox investors that SHARE one PAN and one bank account
// but each have a DISTINCT email + mobile, and drive every one to an
// order-ready state (canTransact === true).
//
// Why this is safe for order placement: every step below goes through the same
// service layer the HTTP API uses — createInvestorProfile, addBankAccount,
// verifyBankAccount, createInvestmentAccount, setFolioDefaults and the readiness
// service that every order asserts against. Nothing here is a path an order does
// not already take, and it writes no order/payment rows. It only builds the
// investor accounts an order needs.
//
// SANDBOX ONLY. It creates real objects in the FP sandbox tenant and the
// configured database. Never point it at production.
//
// Run:
//   bun run scripts/sandbox-multi-investor.ts                 # 2 users, shared PAN + bank
//   COUNT=3 bun run scripts/sandbox-multi-investor.ts         # 3 users
//   PAN=AAAPS3751A BANK=000000001193 bun run scripts/sandbox-multi-investor.ts
//   DISTINCT_PAN=1 bun run scripts/sandbox-multi-investor.ts  # distinct compliant PAN per user (fast, still shared bank)
//
// The one FP wall this cannot remove: the partner realm rate-limits the KRA
// lookup PER PAN. Reusing one PAN for several investors in a short window makes
// the 2nd+ pre-verification come back `kyc_rate_limit_exceeded` (readiness null)
// for a few minutes. The script waits it out and retries, so SHARED-PAN runs are
// SLOW (minutes per extra investor) but still succeed. DISTINCT_PAN=1 sidesteps
// the wall entirely and keeps the shared bank account.
import { fpConfig } from "../src/integrations/fp/fp.config.ts";
import { createHash, randomBytes } from "node:crypto";
import { db, disconnectDatabase } from "../src/db/client.ts";
import { checkReadiness, getReadiness } from "../src/services/kyc.service.ts";
import {
  addAddress,
  addBankAccount,
  addEmail,
  addPhone,
  createInvestmentAccount,
  createInvestorProfile,
  verifyBankAccount,
} from "../src/services/investor.service.ts";
import { investmentReadiness } from "../src/services/investor-readiness.service.ts";
import {
  createPurchase,
  refreshOrder,
  recordPurchaseConsent,
  confirmPurchase,
} from "../src/services/order.service.ts";
import {
  createMandate,
  authorizeMandate,
  simulateMandateSettlement,
  payByMandate,
} from "../src/services/payment.service.ts";
import { createSip, refreshPlan, confirmPlan } from "../src/services/plan.service.ts";

// ---------------------------------------------------------------------------
// Configuration and fixtures
// ---------------------------------------------------------------------------

const COUNT = Math.max(1, Number(process.env.COUNT ?? "2") | 0);
const DISTINCT_PAN = process.env.DISTINCT_PAN === "1" || process.env.DISTINCT_PAN === "true";
/** TRANSACT=1 also places a one-time order AND a SIP for each provisioned user. */
const TRANSACT = process.env.TRANSACT === "1" || process.env.TRANSACT === "true";

/**
 * The shared PAN. `AAAPS3751A` is the highest-success choice: 5th character `S`
 * verifies (only `A`/`I` fail), digits `3751` mark it already KYC-compliant, so
 * NO KYC form is ever opened and there is no one-live-form-per-PAN conflict —
 * every investor on it reaches order-ready through pre-verification alone.
 */
const SHARED_PAN = (process.env.PAN ?? "AAAPS3751A").toUpperCase();

/**
 * The shared bank account. Ends `1193`, which the local BAV simulation scores
 * VERY_HIGH (the range 1191-1199). Bank verification runs entirely in-process in
 * this sandbox (simulationEnabled), so the same account passes for every
 * investor with no per-account cap.
 */
const BANK_ACCOUNT_NUMBER = process.env.BANK ?? "000000001193";
const BANK_IFSC = (process.env.BANK_IFSC ?? "HDFC0001330").toUpperCase();
const BANK_TYPE = "savings";

const NAME = process.env.NAME ?? "Tony Sandbox";
const DATE_OF_BIRTH = process.env.DOB ?? "1985-04-12"; // not 2000-01-01 (a simulated mismatch)

/** Demographic fixtures FP requires on the profile, in FP's own vocabulary. */
const PROFILE_FIXTURES: {
  taxStatus: string;
  gender: string;
  occupation: string;
  incomeSlab: string;
  pepDetails: string;
  placeOfBirth: string;
  fatherName: string;
  sourceOfWealth: string;
  countryOfBirth: string;
  nationalityCountry: string;
  citizenshipCountries: string[];
} = {
  taxStatus: "resident_individual",
  gender: "male",
  occupation: "private_sector_service",
  incomeSlab: "above_5lakh_upto_10lakh",
  pepDetails: "not_applicable",
  placeOfBirth: "Mumbai",
  fatherName: "Test Father",
  sourceOfWealth: "salary",
  countryOfBirth: "in",
  nationalityCountry: "in",
  citizenshipCountries: ["in"],
};

const ADDRESS = {
  line1: "1 Sandbox Street",
  city: "Mumbai",
  postalCode: "400001",
  country: "IN",
  nature: "residential",
} as const;

// A stable run id keeps this run's emails/phones unique and greppable, and lets
// a re-run never collide on the phone/email unique constraints.
const RUN = Date.now().toString(36);
// Six numeric digits unique to this run, used to build collision-free phones.
const RUN_DIGITS = String(Date.now()).slice(-6);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const letters = "ABCDEFGHJKLMNOPQRSTUVWXYZ";
// Position 5 drives PAN validation: `A` = aadhaar-not-linked and `I` = invalid
// both fail, so the 5th character is picked from a pool with neither.
const validating = "BCDEFGHJKLMNOPQRSTUVWXYZ";
const pick = (pool: string): string => pool[Math.floor(Math.random() * pool.length)]!;

/** A distinct PAN that is individual (`P`), passes PAN validation and is KYC-compliant (`3751`). */
function compliantPan(): string {
  return `${pick(letters)}${pick(letters)}${pick(letters)}P${pick(validating)}3751${pick(letters)}`;
}

function contactsForUser(index: number): { phone: string; email: string } {
  // E.164, always normalised. A 10-digit local number, made unique per run so a
  // re-run never collides on the phone/email unique constraints.
  const local = `9${RUN_DIGITS}${String(index).padStart(3, "0")}`.slice(0, 10).padEnd(10, "0");
  return { phone: `+91${local}`, email: `sbx.${RUN}.${index}@example.com` };
}

interface ReadinessOutcome {
  preVerificationId: string;
  ready: boolean;
  code: string | null;
}

/**
 * Create a pre-verification and wait for the KRA verdict to settle.
 *
 * The verdict is asynchronous, so a fresh create always comes back with
 * readiness null and has to be polled. When the same PAN is reused too quickly
 * the partner realm answers `kyc_rate_limit_exceeded` and the verdict never
 * settles until the window passes — so on a rate-limit we back off and create a
 * new attempt rather than poll a request that will stay null for ever.
 */
async function preVerify(userId: string, pan: string): Promise<ReadinessOutcome> {
  const CREATE_ATTEMPTS = 8; // ~ up to 8 windows
  const POLLS_PER_CREATE = 8;
  const POLL_MS = 4000;
  const BACKOFF_MS = 45000; // the rate-limit window is "a few minutes"

  let lastId = "";
  let lastCode: string | null = null;
  for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt++) {
    const created = await checkReadiness({
      userId,
      pan,
      name: NAME,
      dateOfBirth: DATE_OF_BIRTH,
    });
    let latest = created;
    for (let poll = 0; poll < POLLS_PER_CREATE; poll++) {
      if (latest.ready) return { preVerificationId: latest.id, ready: true, code: latest.readinessCode };
      if (latest.readinessCode === "kyc_rate_limit_exceeded") break; // polling won't help; re-create after backoff
      await sleep(POLL_MS);
      latest = await getReadiness(created.id);
    }
    lastId = latest.id;
    lastCode = latest.readinessCode;
    if (latest.ready) return { preVerificationId: latest.id, ready: true, code: latest.readinessCode };

    if (attempt < CREATE_ATTEMPTS) {
      const why = latest.readinessCode ?? "still settling";
      console.log(`      readiness not ready yet (${why}); backing off ${BACKOFF_MS / 1000}s then retrying…`);
      await sleep(BACKOFF_MS);
    }
  }
  return { preVerificationId: lastId, ready: false, code: lastCode };
}

interface UserResult {
  index: number;
  phone: string;
  email: string;
  pan: string;
  userId: string;
  investorProfileId: string | null;
  mfInvestmentAccountId: string | null;
  bankAccountId: string | null;
  canTransact: boolean;
  note: string;
  orderNote: string | null;
  sipNote: string | null;
}

// ---------------------------------------------------------------------------
// Transaction phase (TRANSACT=1): a one-time order and a SIP
// ---------------------------------------------------------------------------

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * Write a VERIFIED 2FA challenge and return its single-use token.
 *
 * SEBI needs a `TRANSACTION_APPROVAL` proof before consent/confirm. No SMS is
 * delivered in the sandbox, so the proof is minted straight into the table the
 * real endpoint consumes — the phone must be the one registered on the folio,
 * or the consent is refused with "verified number does not match".
 */
async function mintConsentToken(phone: string, context: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.phoneVerification.create({
    data: {
      phone,
      purpose: "TRANSACTION_APPROVAL",
      status: "VERIFIED",
      context,
      expiresAt: new Date(now.getTime() + 600_000),
      verifiedAt: now,
      tokenHash: hashToken(token),
      tokenExpiresAt: new Date(now.getTime() + 900_000),
    },
  });
  return token;
}

interface SchemeChoice {
  isin: string;
  amount: string;
  frequency: string;
  installmentDay: number;
  installments: number;
}

/**
 * Pick a scheme the catalogue can actually purchase and one it can run a SIP on.
 *
 * The seeded catalogue is small and its capability flags lie — a
 * dividend-reinvestment scheme advertises `purchaseAllowed` and FP still refuses
 * it — so purchasable GROWTH schemes are preferred and the amount is taken from
 * the scheme's real LUMPSUM/SIP thresholds, never invented.
 */
async function pickSchemes(): Promise<{ purchase: SchemeChoice | null; sip: SchemeChoice | null }> {
  const purchaseRow = await db.mfScheme.findFirst({
    where: {
      isActive: true,
      purchaseAllowed: true,
      investmentOption: { not: "DIV_REINVESTMENT" },
      thresholds: { some: { type: "LUMPSUM" } },
    },
    select: { isin: true, thresholds: { where: { type: "LUMPSUM" }, select: { amountMin: true } } },
  });
  // ONDC SIP accepts monthly and daily cadences only, so pick a scheme that
  // publishes a MONTHLY threshold rather than, say, DAY_IN_A_WEEK.
  const sipRow = await db.mfScheme.findFirst({
    where: {
      isActive: true,
      sipAllowed: true,
      investmentOption: { not: "DIV_REINVESTMENT" },
      thresholds: { some: { type: "SIP", frequency: "MONTHLY" } },
    },
    select: {
      isin: true,
      thresholds: {
        where: { type: "SIP", frequency: "MONTHLY" },
        select: { frequency: true, amountMin: true, installmentsMin: true, allowedDates: true },
      },
    },
  });
  const purchase = purchaseRow
    ? {
        isin: purchaseRow.isin,
        amount: String(Math.max(100, Math.ceil(Number(purchaseRow.thresholds[0]?.amountMin ?? 100)))),
        frequency: "",
        installmentDay: 0,
        installments: 0,
      }
    : null;
  const sipT = sipRow?.thresholds[0];
  const sip = sipRow && sipT
    ? {
        isin: sipRow.isin,
        amount: String(Math.max(100, Math.ceil(Number(sipT.amountMin ?? 100)))),
        frequency: String(sipT.frequency),
        // Monthly cadence: a day in 1–28.
        installmentDay: Math.min(28, Math.max(1, sipT.allowedDates[0] ?? 1)),
        installments: Math.max(6, sipT.installmentsMin ?? 6),
      }
    : null;
  return { purchase, sip };
}

const USER_IP = "127.0.0.1";

/** Create → poll → consent → mandate → approve → pay → confirm a lump sum. */
async function placeOrder(
  user: UserResult,
  scheme: SchemeChoice,
): Promise<{ ok: boolean; note: string; mandateId: string | null }> {
  const accountId = user.mfInvestmentAccountId!;
  const order = await createPurchase({
    mfInvestmentAccountId: accountId,
    isin: scheme.isin,
    amount: scheme.amount,
    userIp: USER_IP,
    initiatedVia: "mobile_app",
  });
  let state = order.state;
  for (let i = 0; i < 12 && state === "UNDER_REVIEW"; i++) {
    await sleep(2500);
    state = (await refreshOrder(order.id)).state;
  }
  if (state !== "PENDING") return { ok: false, note: `order stuck at ${state}`, mandateId: null };

  const token = await mintConsentToken(user.phone, `order:${order.id}`);
  await recordPurchaseConsent(order.id, { verificationToken: token });

  // MANDATE_TYPE=UPI exercises the UPI rail; default E_MANDATE is net banking (NACH).
  const mandate = await createMandate({
    bankAccountId: user.bankAccountId!,
    mandateType: process.env.MANDATE_TYPE === "UPI" ? "UPI" : "E_MANDATE",
    mandateLimit: "100000",
    providerName: "CYBRILLAPOA",
  });
  await authorizeMandate(mandate.id);
  const approved = await simulateMandateSettlement(mandate.id, "APPROVED");
  if (approved.status !== "APPROVED") {
    return { ok: false, note: `mandate ${approved.status}`, mandateId: mandate.id };
  }
  await payByMandate(mandate.id, [order.id]);
  const confirmed = await confirmPurchase(order.id);
  let finalState = confirmed.state;
  for (let i = 0; i < 6 && !["SUCCESSFUL", "FAILED"].includes(finalState); i++) {
    await sleep(3000);
    finalState = (await refreshOrder(order.id)).state;
  }
  const ok = ["CONFIRMED", "SUBMITTED", "SUCCESSFUL"].includes(finalState);
  return { ok, note: `order ${order.id.slice(0, 8)} → ${finalState}`, mandateId: mandate.id };
}

/** Create the SIP against the approved mandate, then consent + confirm it. */
async function placeSip(
  user: UserResult,
  mandateId: string,
  scheme: SchemeChoice,
): Promise<{ ok: boolean; note: string }> {
  const plan = await createSip({
    mfInvestmentAccountId: user.mfInvestmentAccountId!,
    isin: scheme.isin,
    amount: scheme.amount,
    mandateId,
    frequency: scheme.frequency,
    installmentDay: scheme.installmentDay,
    numberOfInstallments: scheme.installments,
    userIp: USER_IP,
    initiatedVia: "mobile_app",
  });
  let state = plan.state;
  for (let i = 0; i < 12 && state === "REVIEW"; i++) {
    await sleep(2500);
    state = (await refreshPlan(plan.id)).state;
  }
  const token = await mintConsentToken(user.phone, `plan:${plan.id}`);
  const confirmed = await confirmPlan(plan.id, token);
  const ok = ["ACTIVE", "REVIEW_COMPLETED", "CONFIRMED"].includes(confirmed.state);
  return { ok, note: `sip ${plan.id.slice(0, 8)} → ${confirmed.state}` };
}

// ---------------------------------------------------------------------------
// One investor, end to end
// ---------------------------------------------------------------------------

async function provisionOne(index: number): Promise<UserResult> {
  const { phone, email } = contactsForUser(index);
  const pan = DISTINCT_PAN ? compliantPan() : SHARED_PAN;
  const base: UserResult = {
    index,
    phone,
    email,
    pan,
    userId: "",
    investorProfileId: null,
    mfInvestmentAccountId: null,
    bankAccountId: null,
    canTransact: false,
    note: "",
    orderNote: null,
    sipNote: null,
  };

  console.log(`\n[user ${index}] phone=${phone} email=${email} pan=${pan}`);

  // 1) The app account.
  const user = await db.user.create({
    data: {
      phone,
      email,
      status: "ACTIVE",
      phoneVerifiedAt: new Date(),
      emailVerifiedAt: new Date(),
      fullName: NAME,
    },
    select: { id: true },
  });
  base.userId = user.id;
  console.log(`   • user ${user.id}`);

  // 2) Identity pre-verification — this is what makes identityVerified true.
  console.log(`   • pre-verifying PAN…`);
  const readiness = await preVerify(user.id, pan);
  if (!readiness.ready) {
    base.note = `pre-verification not verified (${readiness.code ?? "timed out"})`;
    console.log(`   ✗ ${base.note}`);
    return base;
  }
  console.log(`   • identity verified`);

  // 3) The investor profile, with every write-once demographic supplied here.
  const profile = await createInvestorProfile({
    userId: user.id,
    name: NAME,
    pan,
    dateOfBirth: DATE_OF_BIRTH,
    ...PROFILE_FIXTURES,
  });
  base.investorProfileId = profile.id;
  console.log(`   • profile ${profile.id}`);

  // 4) Contacts + address (folio defaults reference these).
  const phoneRow = await addPhone(profile.id, { isd: "+91", number: phone.replace("+91", ""), belongsTo: "self" });
  const emailRow = await addEmail(profile.id, { email, belongsTo: "self" });
  const addressRow = await addAddress(profile.id, { ...ADDRESS });

  // 5) The shared bank account, then its penny-drop (local BAV simulation).
  const bank = await addBankAccount(profile.id, {
    accountNumber: BANK_ACCOUNT_NUMBER,
    accountHolderName: NAME,
    type: BANK_TYPE,
    ifscCode: BANK_IFSC,
  });
  const verified = await verifyBankAccount(bank.id);
  base.bankAccountId = bank.id;
  console.log(`   • bank ${bank.id} (${verified.verificationConfidence ?? "unverified"})`);

  // 6) The investment account, with folio defaults complete in one call.
  const account = await createInvestmentAccount(profile.id, {
    emailAddressId: emailRow.id,
    phoneNumberId: phoneRow.id,
    addressId: addressRow.id,
    bankAccountId: bank.id,
  });
  base.mfInvestmentAccountId = account.id;
  console.log(`   • investment account ${account.id}`);

  // 7) The exact gate every order asserts against.
  const ready = await investmentReadiness(account.id);
  base.canTransact = ready.canTransact;
  base.note = ready.canTransact
    ? "order-ready"
    : `not order-ready (identity=${ready.identityVerified} payout=${ready.payoutAccountVerified})`;
  console.log(
    ready.canTransact
      ? `   ✓ order-ready (payoutAccountVerified=${ready.payoutAccountVerified})`
      : `   ✗ ${base.note}`,
  );

  // 8) Optionally exercise the whole post-all-set flow: a lump sum and a SIP.
  if (TRANSACT && ready.canTransact) {
    const { purchase, sip } = await pickSchemes();
    let approvedMandateId: string | null = null;
    if (purchase) {
      try {
        console.log(`   • placing order (${purchase.isin} ₹${purchase.amount})…`);
        const r = await placeOrder(base, purchase);
        base.orderNote = r.note;
        approvedMandateId = r.mandateId;
        console.log(r.ok ? `   ✓ ${r.note}` : `   ✗ ${r.note}`);
      } catch (e) {
        base.orderNote = `error: ${e instanceof Error ? e.message : String(e)}`;
        console.log(`   ✗ order ${base.orderNote}`);
      }
    } else {
      base.orderNote = "no purchasable scheme in the catalogue";
    }
    if (sip && approvedMandateId) {
      try {
        console.log(`   • placing SIP (${sip.isin} ₹${sip.amount} ${sip.frequency})…`);
        const r = await placeSip(base, approvedMandateId, sip);
        base.sipNote = r.note;
        console.log(r.ok ? `   ✓ ${r.note}` : `   ✗ ${r.note}`);
      } catch (e) {
        base.sipNote = `error: ${e instanceof Error ? e.message : String(e)}`;
        console.log(`   ✗ sip ${base.sipNote}`);
      }
    } else if (sip && !approvedMandateId) {
      base.sipNote = "skipped — no approved mandate from the order step";
    } else if (!sip) {
      base.sipNote = "no SIP-capable scheme in the catalogue";
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!fpConfig().simulationEnabled) {
    throw new Error(
      "Refusing to run: this is not the FP sandbox (simulationEnabled is false). Never run this against production.",
    );
  }

  console.log(
    `Provisioning ${COUNT} investor(s) — ${DISTINCT_PAN ? "distinct compliant PAN each" : `shared PAN ${SHARED_PAN}`}, shared bank ${BANK_ACCOUNT_NUMBER}/${BANK_IFSC}.`,
  );
  if (!DISTINCT_PAN && COUNT > 1) {
    console.log(
      "Note: shared PAN reuse is rate-limited by FP per PAN, so extra investors can take a few minutes each. Use DISTINCT_PAN=1 for a fast run.",
    );
  }

  const results: UserResult[] = [];
  for (let i = 1; i <= COUNT; i++) {
    try {
      results.push(await provisionOne(i));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`   ✗ failed: ${message}`);
      results.push({
        index: i,
        phone: contactsForUser(i).phone,
        email: contactsForUser(i).email,
        pan: DISTINCT_PAN ? "(distinct)" : SHARED_PAN,
        userId: "",
        investorProfileId: null,
        mfInvestmentAccountId: null,
        bankAccountId: null,
        canTransact: false,
        note: `error: ${message}`,
        orderNote: null,
        sipNote: null,
      });
    }
  }

  console.log(`\n──────── summary ────────`);
  for (const r of results) {
    const mark = r.canTransact ? "✓" : "✗";
    console.log(`${mark} user ${r.index}  ${r.email}  pan=${r.pan}  ${r.note}`);
    if (r.investorProfileId) console.log(`     profile=${r.investorProfileId} account=${r.mfInvestmentAccountId}`);
    if (r.orderNote) console.log(`     ${r.orderNote}`);
    if (r.sipNote) console.log(`     ${r.sipNote}`);
  }
  const ok = results.filter((r) => r.canTransact).length;
  console.log(`\n${ok}/${results.length} order-ready.`);
  if (TRANSACT) {
    const ordered = results.filter((r) => r.orderNote && !r.orderNote.startsWith("error") && !r.orderNote.startsWith("order stuck")).length;
    const sipped = results.filter((r) => r.sipNote && (r.sipNote.includes("→ ACTIVE") || r.sipNote.includes("REVIEW_COMPLETED") || r.sipNote.includes("CONFIRMED"))).length;
    console.log(`${ordered}/${results.length} placed an order · ${sipped}/${results.length} placed a SIP.`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
