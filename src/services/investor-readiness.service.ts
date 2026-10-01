// Is this investor allowed to move money yet?
//
// One place, because two answers that disagree are worse than one that is
// strict: `/investors/onboarding` reports readiness to the app and every order,
// plan and payment asserts it, and both go through here.
//
// Reading FP's pre-verification correctly is the whole job. The verdicts are in
// `readiness.status` and the per-field `status` values; the top-level `status`
// only acknowledges that the request was accepted, and `completed_at` is left
// null by the POA realm even once every verdict has landed. Gating on those two
// makes the check unsatisfiable and silently kills the entire transacting
// surface — so they are treated as metadata, not as the answer.
import { BavConfidence, BavStatus } from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";

/**
 * How long a verdict is trusted before it has to be taken again.
 *
 * Our policy, not FP's guarantee: a PAN can be suspended, and a bank account
 * closed, between the check and the order.
 */
const MAX_CHECK_AGE_MS = 24 * 60 * 60 * 1000;

/** FP's wire value for a check that passed. */
const VERIFIED = "verified";

interface Timestamps {
  completedAt: Date | null;
  fpUpdatedAt: Date | null;
  fpCreatedAt: Date | null;
  createdAt: Date;
}

/**
 * When FP last said anything about this pre-verification.
 *
 * `completedAt` first because it is the precise answer when FP sets it, then
 * progressively weaker fallbacks — this is only the freshness clock, never the
 * verdict.
 */
function decidedAt(row: Timestamps): Date {
  return row.completedAt ?? row.fpUpdatedAt ?? row.fpCreatedAt ?? row.createdAt;
}

function isFresh(row: Timestamps): boolean {
  return decidedAt(row).getTime() > Date.now() - MAX_CHECK_AGE_MS;
}

interface IdentityCheck extends Timestamps {
  readinessStatus: string | null;
  panStatus: string | null;
  nameStatus: string | null;
  dateOfBirthStatus: string | null;
}

function identityCheckPassed(check: IdentityCheck | null, requireFresh = true): boolean {
  return Boolean(
    check &&
      check.readinessStatus === VERIFIED &&
      check.panStatus === VERIFIED &&
      check.nameStatus === VERIFIED &&
      check.dateOfBirthStatus === VERIFIED &&
      (!requireFresh || isFresh(check)),
  );
}

/** A verified pre-profile user must resume after PAN, not restart at PAN. */
export async function userIdentityIsVerified(userId: string): Promise<boolean> {
  const check = await db.preVerification.findFirst({
    where: { userId, readinessStatus: { not: null } },
    orderBy: { fpCreatedAt: "desc" },
  });
  return identityCheckPassed(check);
}

/**
 * Whether an unverified payout bank account blocks an order.
 *
 * Always on. On ONDC an unverified payout account lets an order be reviewed,
 * consented, **paid for** and confirmed, and only then fails it at submission
 * with `payout_account_verification_pending` — after the investor's money has
 * moved. The sandbox enforces the same requirement; its documented account
 * number patterns provide deterministic BAV outcomes.
 */
export function payoutVerificationRequired(): boolean {
  return true;
}

/**
 * Has this bank account passed a penny-drop?
 *
 * The dedicated BAV response is mirrored directly onto the bank account. A
 * completed request only passes at high or very-high ownership confidence.
 */
export async function bankIsVerified(bankAccountId: string): Promise<boolean> {
  const bank = await db.bankAccount.findUnique({
    where: { id: bankAccountId },
    select: { verificationStatus: true, verificationConfidence: true },
  });
  return Boolean(
    bank?.verificationStatus === BavStatus.COMPLETED &&
      (bank.verificationConfidence === BavConfidence.VERY_HIGH ||
        bank.verificationConfidence === BavConfidence.HIGH),
  );
}

/**
 * The investor's PAN, name and date of birth all cleared a recent check.
 *
 * The newest check for this PAN wins, not the newest *passing* one: a later
 * verdict that the investor is no longer ready has to be able to close the gate
 * that an earlier one opened.
 *
 * Checks taken before the profile existed count. That is the documented order
 * of the journey — readiness first, then the profile — so those rows are linked
 * to the user and not yet to a profile, and ignoring them would make the
 * recommended sequence the one sequence that cannot transact.
 */
export async function identityIsVerified(
  investorProfileId: string,
  pan: string | null,
  requireFresh = true,
): Promise<boolean> {
  return identityCheckPassed(await latestIdentityCheck(investorProfileId, pan), requireFresh);
}

/** The newest identity verdict for this profile's PAN, or null when there is none. */
async function latestIdentityCheck(investorProfileId: string, pan: string | null) {
  if (!pan) return null;
  const owner = await db.userInvestorProfile.findFirst({
    where: { investorProfileId, relationship: "SELF" },
    select: { userId: true },
  });
  const check = await db.preVerification.findFirst({
    where: {
      investorIdentifier: pan,
      // Only rows that actually carry a readiness verdict. A penny-drop opens a
      // pre-verification of its own for the bank account, and that row has
      // `readiness.status` null because it was never asked about the identity.
      // Taken as "the newest check", it displaced the real verdict and closed
      // the gate: an investor who verified a bank AFTER their readiness check
      // silently lost `canTransact`, so an approved mandate could be selected on
      // the SIP screen while "Review investment" stayed disabled with nothing
      // saying why.
      //
      // A later *readiness* verdict still closes the gate, which is the point of
      // taking the newest — a bank check simply is not one.
      readinessStatus: { not: null },
      OR: [{ investorProfileId }, ...(owner ? [{ investorProfileId: null, userId: owner.userId }] : [])],
    },
    orderBy: { fpCreatedAt: "desc" },
  });
  return check;
}

export interface InvestmentReadiness {
  identityVerified: boolean;
  payoutAccountVerified: boolean;
  /** ONDC requires this in every environment. */
  payoutAccountRequired: boolean;
  canTransact: boolean;
}

/**
 * Everything that gates money on one investment account.
 *
 * Returns rather than throws so the onboarding screen can show the investor
 * which step is outstanding; `assertInvestmentReady` is the throwing form.
 */
export async function investmentReadiness(accountId: string): Promise<InvestmentReadiness> {
  const account = await db.mfInvestmentAccount.findUnique({
    where: { id: accountId },
    include: { primaryInvestorProfile: true, folioDefaults: true },
  });
  if (!account || account.holdingPattern !== "SINGLE") {
    return { identityVerified: false, payoutAccountVerified: false, payoutAccountRequired: payoutVerificationRequired(), canTransact: false };
  }

  // A pass counts here however old it is: the guard below renews an expired
  // one by itself when an order needs it, so telling the app "not ready" would
  // grey out every button for a check the investor never has to redo.
  const identityVerified = await identityIsVerified(
    account.primaryInvestorProfileId,
    account.primaryInvestorProfile.pan,
    false,
  );
  const payoutBankAccountId = account.folioDefaults?.payoutBankAccountId;
  const payoutAccountVerified = payoutBankAccountId ? await bankIsVerified(payoutBankAccountId) : false;
  const payoutAccountRequired = payoutVerificationRequired();

  return {
    identityVerified,
    payoutAccountVerified,
    payoutAccountRequired,
    canTransact:
      identityVerified &&
      Boolean(payoutBankAccountId) &&
      (payoutAccountVerified || !payoutAccountRequired),
  };
}

/**
 * The same check, as a guard.
 *
 * Every order, plan and payment goes through this before anything reaches FP.
 */
export async function assertInvestmentReady(
  accountId: string,
  folioNumber?: string | null,
  requireVerifiedPayout = payoutVerificationRequired(),
): Promise<void> {
  const account = await db.mfInvestmentAccount.findUnique({
    where: { id: accountId },
    include: { primaryInvestorProfile: true, folioDefaults: true },
  });
  if (!account || account.holdingPattern !== "SINGLE") {
    throw HttpError.notFound("No such individual investment account");
  }

  await assertFreshIdentity(account.primaryInvestorProfile);

  const payoutBankAccountId = account.folioDefaults?.payoutBankAccountId;
  if (!payoutBankAccountId) {
    throw HttpError.conflict("Set a payout bank account on this investment account before transacting");
  }
  if (requireVerifiedPayout && !(await bankIsVerified(payoutBankAccountId))) {
    throw HttpError.conflict("Verify the payout bank account before transacting");
  }

  if (folioNumber) {
    const folio = await db.mfFolio.findUnique({
      where: { mfInvestmentAccountId_number: { mfInvestmentAccountId: accountId, number: folioNumber } },
    });
    if (!folio) throw HttpError.badRequest("The folio does not belong to this investment account");
  }
}

/** How long an order waits for a renewed check's verdict before giving up. */
const RENEW_WAIT_MS = 9_000;
const RENEW_POLL_MS = 1_500;
/** One renewal per profile at a time, however many orders arrive together. */
const renewing = new Map<string, Promise<void>>();

/**
 * The identity gate for an order: a fresh pass, or one renewed on the spot.
 *
 * A pass expires after MAX_CHECK_AGE_MS, which is our policy. Before this, an
 * expired pass refused every order with "complete a fresh pre-verification" —
 * and nothing in the app could start one, so a fully verified investor was
 * locked out a day after onboarding. Now an expired *pass* is re-run with the
 * PAN, name and date of birth already on the profile, and the order waits a
 * few seconds for FP's verdict (it lands in about one on this route).
 *
 * Only a pass is renewed. A check that failed, or none at all, still refuses:
 * re-submitting the same details would only fail again, and a real problem
 * with the PAN must reach the investor rather than be retried away.
 */
async function assertFreshIdentity(profile: {
  id: string;
  pan: string | null;
  name: string | null;
  dateOfBirth: Date | null;
}): Promise<void> {
  const latest = await latestIdentityCheck(profile.id, profile.pan);
  if (identityCheckPassed(latest)) return;
  if (!identityCheckPassed(latest, false) || !profile.pan || !profile.name || !profile.dateOfBirth) {
    throw HttpError.conflict("Complete a fresh investor pre-verification before transacting");
  }

  const running = renewing.get(profile.id) ?? renewIdentity(profile as RenewableProfile).finally(() => renewing.delete(profile.id));
  renewing.set(profile.id, running);
  await running;

  if (identityCheckPassed(await latestIdentityCheck(profile.id, profile.pan))) return;
  throw HttpError.conflict(
    "We're re-confirming your PAN details with the registry. Please try again in a minute.",
    { reason: "IDENTITY_RECHECK_PENDING" },
  );
}

type RenewableProfile = { id: string; pan: string; name: string; dateOfBirth: Date };

/** Run a new pre-verification on the profile's own details and wait for its verdict. */
async function renewIdentity(profile: RenewableProfile): Promise<void> {
  const owner = await db.userInvestorProfile.findFirst({
    where: { investorProfileId: profile.id, relationship: "SELF" },
    select: { userId: true },
  });
  if (!owner) return;
  // Imported here, not at the top: kyc.service sits above the sync layer, and
  // this module is imported by every order path.
  const kyc = await import("./kyc.service.ts");
  try {
    const started = await kyc.checkReadiness({
      userId: owner.userId,
      investorProfileId: profile.id,
      pan: profile.pan,
      name: profile.name,
      dateOfBirth: profile.dateOfBirth.toISOString().slice(0, 10),
    });
    // The create usually answers with the verdict still running; read it back.
    // `readinessStatus` is null until FP decides; `ready` is only its yes/no.
    for (let waited = 0, status = started.readinessStatus; status == null && waited < RENEW_WAIT_MS; waited += RENEW_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, RENEW_POLL_MS));
      status = (await kyc.getReadiness(started.id)).readinessStatus;
    }
  } catch (error) {
    // FP unreachable: the caller refuses with "try again", which is the truth.
    console.warn("[readiness] identity re-check failed:", error instanceof Error ? error.message : error);
  }
}
