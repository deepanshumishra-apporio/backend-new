// Systematic plans: SIP (purchase), SWP (redemption) and STP (switch).
//
// `systematic: true` registers a real SIP/SWP/STP with the RTA and validates
// the installment against the scheme's per-frequency limits. That matters more
// than it sounds: a scheme can advertise `sipAllowed` and publish no
// frequencies at all — both index funds in the sandbox catalogue do — and FP
// then answers "selected frequency is not supported" after the investor has
// already chosen an amount and a date. scheme-rules catches it first.
import {
  OtpPurpose,
  PlanState,
  SchemeThresholdFrequency,
  SchemeThresholdType,
} from "../../generated/prisma/enums.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { assertInvestmentReady } from "./investor-readiness.service.ts";
import { assertFolioAtSchemeAmc, resolvePurchaseFolio } from "./folio-resolution.service.ts";
import { fpConfig, fpErrorToHttpError, fpOrders, fpPlans } from "../integrations/fp/index.ts";
import { isOndcRoute } from "../utils/gateway.ts";
import { HttpError } from "../utils/http-error.ts";
import { asAmount, asDate, asUnits } from "../utils/money.ts";
import { consumeVerificationToken } from "./otp.service.ts";
import {
  applyPurchaseUpdate,
  applyRedemptionUpdate,
  applySwitchUpdate,
  assertExitBasisSupported,
  pullRedemptionPayout,
  resolveConsentContact,
  sendConsent,
} from "./order.service.ts";
import { syncPurchasePlan, syncRedemptionPlan, syncSwitchPlan } from "./fp-sync/index.ts";
import { assertHoldsScheme, validatePlan } from "./scheme-rules.service.ts";
import {
  assertExitPlanSchedule,
  assertSipMandate,
  assertSipSchedule,
  planCancellationPayload,
} from "./sip-validation.ts";
import type {
  PlanDto,
  PlanMandateDto,
  CreateSipInput,
  CreateStpInput,
  CreateSwpInput,
} from "../types/plan.types.ts";

/** The three plan tables share an id space, so a lookup has to try each. */
const planIdentitySelect = {
  fpId: true,
  state: true,
  gateway: true,
  folioNumber: true,
  mfInvestmentAccountId: true,
} as const;

type PlanKind = "sip" | "swp" | "stp";

/**
 * Find a plan in whichever table holds it, with what confirm and cancel need.
 *
 * `isin` is the scheme the plan draws on: bought by a SIP, sold by an SWP,
 * switched out of by an STP. Confirm re-checks the folio still holds it.
 */
async function resolvePlan(id: string) {
  const [sip, swp, stp] = await Promise.all([
    db.mfPurchasePlan.findUnique({
      where: { id },
      select: { ...planIdentitySelect, mandateId: true, amount: true, schemeIsin: true },
    }),
    db.mfRedemptionPlan.findUnique({ where: { id }, select: { ...planIdentitySelect, schemeIsin: true } }),
    db.mfSwitchPlan.findUnique({ where: { id }, select: { ...planIdentitySelect, switchOutSchemeIsin: true } }),
  ]);
  const row = sip ?? swp ?? stp;
  if (!row || !isOndcRoute(row.gateway)) throw HttpError.notFound("No such ONDC plan");
  const kind: PlanKind = sip ? "sip" : swp ? "swp" : "stp";
  const isin = sip?.schemeIsin ?? swp?.schemeIsin ?? stp?.switchOutSchemeIsin ?? "";
  return { row, kind, isin, mandateId: sip?.mandateId, amount: sip?.amount };
}
export async function getPlan(id: string): Promise<PlanDto> {
  const { kind } = await resolvePlan(id);
  return kind === "sip" ? getSip(id) : kind === "swp" ? getSwp(id) : getStp(id);
}
export async function refreshPlan(id: string): Promise<PlanDto> {
  const { row, kind } = await resolvePlan(id);
  try {
    if (kind === "sip") {
      await syncPurchasePlan(await fpPlans.fetchPurchasePlan(row.fpId), row.mfInvestmentAccountId);
      // FP announces installments only by webhook, and the background loop
      // re-reads a plan every few minutes. A SIP started with its first
      // installment now has that installment within seconds of confirmation,
      // and the investor is waiting on it to pay — so mirror them here too.
      for (const installment of await fpOrders.listPurchases({ plan: row.fpId })) {
        await applyPurchaseUpdate(installment, row.mfInvestmentAccountId);
      }
    } else if (kind === "swp") {
      await syncRedemptionPlan(await fpPlans.fetchRedemptionPlan(row.fpId), row.mfInvestmentAccountId);
      // Same reason as a SIP: otherwise an investor asking "did this month's
      // withdrawal go through" waits on the background sweep to find out.
      for (const installment of await fpOrders.listRedemptions({ plan: row.fpId })) {
        const local = await applyRedemptionUpdate(installment, row.mfInvestmentAccountId);
        if (installment.state === "successful") await pullRedemptionPayout(local.id, installment.id);
      }
    } else {
      await syncSwitchPlan(await fpPlans.fetchSwitchPlan(row.fpId), row.mfInvestmentAccountId);
      for (const installment of await fpOrders.listSwitches({ plan: row.fpId })) {
        await applySwitchUpdate(installment, row.mfInvestmentAccountId);
      }
    }
    return getPlan(id);
  } catch (error) { fpErrorToHttpError(error); }
}
/**
 * Confirm a reviewed plan with the investor's 2FA consent.
 *
 * Every check that can refuse runs before the OTP token is spent, so a refusal
 * never costs the investor a fresh OTP. The readiness check matters for every
 * kind, not only a SIP: an SWP pays out to the payout account and an STP is
 * refused at submission if that account never passed verification — after the
 * investor has consented.
 */
export async function confirmPlan(id: string, verificationToken: string): Promise<PlanDto> {
  await refreshPlan(id);
  const { row, kind, isin, mandateId, amount } = await resolvePlan(id);
  if (row.state === PlanState.ACTIVE || row.state === PlanState.SUBMITTED || row.state === PlanState.CONFIRMED) {
    return getPlan(id);
  }
  if (row.state !== PlanState.REVIEW_COMPLETED) {
    throw HttpError.conflict("Wait for the plan review to complete", { state: row.state });
  }

  await assertInvestmentReady(row.mfInvestmentAccountId, row.folioNumber ?? undefined, kind === "sip" ? true : undefined);
  if (kind === "sip") {
    if (!mandateId || !amount) throw HttpError.conflict("Create the SIP with an approved mandate before confirming");
    await resolveMandate(mandateId, row.mfInvestmentAccountId, amount.toString());
  } else if (row.folioNumber) {
    // Holdings can have been redeemed or switched away since the plan was made.
    await assertHoldsScheme(row.mfInvestmentAccountId, row.folioNumber, isin);
  }

  const contact = await resolveConsentContact(row.mfInvestmentAccountId, row.folioNumber);
  const proof = await consumeVerificationToken(verificationToken, `plan:${id}`);
  if (proof.purpose !== OtpPurpose.TRANSACTION_APPROVAL) {
    throw HttpError.badRequest("This verification was not issued for approving a transaction");
  }
  if (proof.phone.replace(/\D/g, "") !== `${contact.isdCode}${contact.mobile}`.replace(/\D/g, "")) {
    throw HttpError.badRequest("The verified number does not match the mobile registered against this folio");
  }
  const confirm = (consent: { email: string; isd_code?: string; mobile?: string }) =>
    ({ id: row.fpId, state: "confirmed" as const, consent });
  try {
    // Same mobile fallback as an order confirm — FP rejects the registered
    // number on some accounts, and a plan stuck unconfirmed is as dead as an
    // order stuck pending.
    if (kind === "sip") await syncPurchasePlan(await sendConsent(contact, (c) => fpPlans.updatePurchasePlan(confirm(c))), row.mfInvestmentAccountId);
    else if (kind === "swp") await syncRedemptionPlan(await sendConsent(contact, (c) => fpPlans.updateRedemptionPlan(confirm(c))), row.mfInvestmentAccountId);
    else await syncSwitchPlan(await sendConsent(contact, (c) => fpPlans.updateSwitchPlan(confirm(c))), row.mfInvestmentAccountId);
    return getPlan(id);
  } catch (error) { fpErrorToHttpError(error); }
}
/**
 * A reviewed plan is past the point of cancellation on the ONDC route.
 *
 * FP answers "Cancellation not allowed for plans in REVIEW_COMPLETED state with
 * CYBRILLAPOA gateway", which tells the investor nothing about what to do
 * instead. Once the review has passed, the plan is either confirmed or simply
 * left unconfirmed.
 */
function assertCancellable(state: string): void {
  // FP answers "Cancellation not allowed for plans in FAILED state with
  // CYBRILLAPOA gateway", which reads as though the cancellation is the thing
  // that went wrong. A failed plan is already dead — there is nothing left to
  // cancel — so say that here rather than relaying the gateway's wording.
  if (state === PlanState.FAILED) {
    throw HttpError.conflict(
      "This plan already failed, so there is nothing to cancel — start a new one instead",
      { state },
    );
  }
  if (state === PlanState.REVIEW_COMPLETED) {
    throw HttpError.conflict(
      "A reviewed plan cannot be cancelled on the ONDC route — confirm it, or leave it unconfirmed",
      { state },
    );
  }
}

/**
 * Translate a refusal about a state we did not know the plan was in.
 *
 * `assertCancellable` runs against a state we have just re-read, so this is the
 * narrow race where FP moved on between that GET and the cancel — and the
 * catch-all for ONDC states no plan in the sandbox has ever reached, whose
 * cancellability we therefore cannot check in advance. FP's own wording blames
 * the cancellation ("Cancellation not allowed for plans in X state with
 * CYBRILLAPOA gateway") rather than naming the state as the reason, so it is
 * rewritten here instead of relayed.
 */
function cancelRefusal(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  const match = /Cancellation not allowed for plans in (\w+) state/i.exec(message);
  if (match) {
    const state = match[1]!.toUpperCase();
    throw HttpError.conflict(
      `This plan is ${state.toLowerCase().replace(/_/g, " ")} and can no longer be cancelled`,
      { state },
    );
  }
  fpErrorToHttpError(error);
}

/**
 * Cancel a plan, deciding on FP's state rather than on our mirror's.
 *
 * Cancellation is the one operation whose legality depends entirely on a state
 * FP can change without telling us. A plan we last saw as CONFIRMED may already
 * have failed at submission — a payout account that never passed its penny-drop
 * does exactly that — and cancelling it then produced FP's
 * "Cancellation not allowed for plans in FAILED state with CYBRILLAPOA
 * gateway", naming a state the investor had never been shown. Re-reading first
 * costs one GET and lets `assertCancellable` answer in our own words.
 *
 * `confirmPlan` already refreshes for the same reason; this is the other half.
 */
export async function cancelPlan(id: string, cancellationCode: string, cancellationReason?: string): Promise<PlanDto> {
  await refreshPlan(id);
  const { row, kind } = await resolvePlan(id);
  if (kind === "sip") return cancelSip(id, cancellationCode, cancellationReason);
  if (row.state === "CANCELLED") return getPlan(id);
  if (row.state === PlanState.COMPLETED) throw HttpError.conflict("A completed plan cannot be cancelled");
  assertCancellable(row.state);
  const payload = planCancellationPayload(cancellationCode, cancellationReason);
  try {
    if (kind === "swp") await syncRedemptionPlan(await fpPlans.cancelRedemptionPlan(row.fpId, payload), row.mfInvestmentAccountId);
    else await syncSwitchPlan(await fpPlans.cancelSwitchPlan(row.fpId, payload), row.mfInvestmentAccountId);
    return getPlan(id);
  } catch (error) { cancelRefusal(error); }
}

type Frequency = (typeof SchemeThresholdFrequency)[keyof typeof SchemeThresholdFrequency];

/**
 * Services speak OUR vocabulary; only the FP client speaks FP's.
 *
 * A plan frequency therefore arrives as an enum name ("MONTHLY") and is
 * lower-cased on the way out, which is exactly the `@map` relationship the
 * schema defines. Letting the wire form in earlier is what makes a validation
 * check silently compare "monthly" against "MONTHLY" and reject a frequency the
 * scheme actually supports.
 */
function toFpFrequency(frequency: string): string {
  return frequency.toLowerCase();
}

/**
 * Reject anything that is not one of our frequency names, loudly.
 *
 * `Object.hasOwn` rather than a bare index: an inherited key ("constructor",
 * "toString") would otherwise come back truthy and be sent to FP as a
 * frequency.
 */
export function asFrequency(raw: string): Frequency {
  const name = raw.toUpperCase();
  const frequencies = SchemeThresholdFrequency as Record<string, string>;
  const match = Object.hasOwn(frequencies, name) ? frequencies[name] : undefined;
  if (!match || match === SchemeThresholdFrequency.NOT_APPLICABLE) {
    throw HttpError.badRequest(`${raw} is not a supported installment frequency`);
  }
  return match as Frequency;
}

const planSelect = {
  id: true,
  fpId: true,
  state: true,
  systematic: true,
  frequency: true,
  installmentDay: true,
  numberOfInstallments: true,
  remainingInstallments: true,
  startDate: true,
  endDate: true,
  nextInstallmentDate: true,
  previousInstallmentDate: true,
  folioNumber: true,
  amount: true,
  cancellationCode: true,
  reason: true,
  fpCreatedAt: true,
  createdAt: true,
  activatedAt: true,
  cancelledAt: true,
} as const;

interface PlanRowBase {
  id: string;
  fpId: string;
  state: string;
  systematic: boolean;
  frequency: string;
  installmentDay: number | null;
  numberOfInstallments: number;
  remainingInstallments: number | null;
  startDate: Date | null;
  endDate: Date | null;
  nextInstallmentDate: Date | null;
  previousInstallmentDate: Date | null;
  folioNumber: string | null;
  cancellationCode: string | null;
  reason: string | null;
  fpCreatedAt: Date | null;
  createdAt: Date;
  activatedAt: Date | null;
  cancelledAt: Date | null;
}

/** What each plan table adds to `planSelect`; one definition per type. */
/**
 * A SIP also carries the mandate it is debited by. Selected here rather than
 * read on demand, because "which bank collects this, and under what UMRN" is
 * the first thing an investor checks when an installment fails.
 */
const sipSelect = {
  ...planSelect,
  schemeIsin: true,
  scheme: { select: { name: true } },
  mandate: {
    select: {
      id: true,
      mandateStatus: true,
      umrn: true,
      bankAccount: { select: { bankName: true, accountNumberLast4: true } },
    },
  },
} as const;
const swpSelect = { ...planSelect, units: true, schemeIsin: true, scheme: { select: { name: true } } } as const;
const stpSelect = {
  ...planSelect,
  units: true,
  switchOutSchemeIsin: true,
  switchInSchemeIsin: true,
  switchOutScheme: { select: { name: true } },
  // The destination, named. An STP's whole point is the fund it transfers
  // into, and without this the screen could only show an ISIN or fetch the
  // scheme separately to read one field of it.
  switchInScheme: { select: { name: true } },
} as const;

type SipRow = Prisma.MfPurchasePlanGetPayload<{ select: typeof sipSelect }>;
type SwpRow = Prisma.MfRedemptionPlanGetPayload<{ select: typeof swpSelect }>;
type StpRow = Prisma.MfSwitchPlanGetPayload<{ select: typeof stpSelect }>;

function toPlanDto(
  row: PlanRowBase,
  extra: {
    type: PlanDto["type"];
    isin: string;
    schemeName: string | null;
    amount: string | null;
    units: string | null;
    mandate?: PlanMandateDto | null;
  },
): PlanDto {
  return {
    id: row.id,
    fpId: row.fpId,
    type: extra.type,
    state: row.state,
    isin: extra.isin,
    schemeName: extra.schemeName,
    systematic: row.systematic,
    frequency: row.frequency,
    installmentDay: row.installmentDay,
    amount: extra.amount,
    units: extra.units,
    numberOfInstallments: row.numberOfInstallments,
    remainingInstallments: row.remainingInstallments,
    startDate: asDate(row.startDate),
    endDate: asDate(row.endDate),
    nextInstallmentDate: asDate(row.nextInstallmentDate),
    previousInstallmentDate: asDate(row.previousInstallmentDate),
    folioNumber: row.folioNumber,
    mandate: extra.mandate ?? null,
    cancellationCode: row.cancellationCode,
    reason: row.reason,
    createdAt: (row.fpCreatedAt ?? row.createdAt).toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

const toSipDto = (row: SipRow): PlanDto =>
  toPlanDto(row, {
    type: "SIP",
    isin: row.schemeIsin,
    schemeName: row.scheme?.name ?? null,
    amount: asAmount(row.amount),
    units: null,
    mandate: row.mandate
      ? {
          id: row.mandate.id,
          status: row.mandate.mandateStatus,
          umrn: row.mandate.umrn,
          bankName: row.mandate.bankAccount.bankName,
          accountNumberLast4: row.mandate.bankAccount.accountNumberLast4,
        }
      : null,
  });

const toSwpDto = (row: SwpRow): PlanDto =>
  toPlanDto(row, {
    type: "SWP",
    isin: row.schemeIsin,
    schemeName: row.scheme?.name ?? null,
    amount: asAmount(row.amount),
    units: asUnits(row.units),
  });

const toStpDto = (row: StpRow): PlanDto => ({
  ...toPlanDto(row, {
    type: "STP",
    isin: row.switchOutSchemeIsin,
    schemeName: row.switchOutScheme?.name ?? null,
    amount: asAmount(row.amount),
    units: asUnits(row.units),
  }),
  switchInIsin: row.switchInSchemeIsin,
  switchInSchemeName: row.switchInScheme?.name ?? null,
});

async function requireAccount(mfInvestmentAccountId: string) {
  const account = await db.mfInvestmentAccount.findUnique({
    where: { id: mfInvestmentAccountId },
    select: { id: true, fpId: true },
  });
  if (!account) throw HttpError.notFound("No such investment account");
  return account;
}

/**
 * Resolve the mandate that will fund the installments.
 *
 * The mandate must be APPROVED, and its provider must match the order gateway —
 * FP answers "Mandate passed is incorrect, pass correct mandate for order
 * gateway …" otherwise, which is impossible to act on from the client.
 */
export async function resolveMandate(mandateId: string | undefined, mfInvestmentAccountId: string, amount: string) {
  if (!mandateId) throw HttpError.badRequest("Choose an approved mandate before creating a SIP");
  const mandate = await db.mandate.findFirst({
    where: {
      id: mandateId,
      bankAccount: {
        investorProfile: { primaryFor: { some: { id: mfInvestmentAccountId } } },
      },
    },
    select: { fpId: true, mandateStatus: true, providerName: true, mandateLimit: true, validFrom: true, validTo: true },
  });
  if (!mandate) throw HttpError.badRequest("That mandate does not belong to this investor");
  assertSipMandate(mandate, amount);
  return mandate;
}

// ---------------------------------------------------------------------------
// SIP
// ---------------------------------------------------------------------------

export async function createSip(input: CreateSipInput): Promise<PlanDto> {
  // FP rejects SIPs at review when the payout bank has not passed verification,
  // even on sandbox deployments that relax this check for ordinary orders.
  await assertInvestmentReady(input.mfInvestmentAccountId, input.folioNumber, true);
  const account = await requireAccount(input.mfInvestmentAccountId);
  const frequency = asFrequency(input.frequency);
  assertSipSchedule(frequency, input.installmentDay, input.numberOfInstallments);
  await validatePlan(SchemeThresholdType.SIP, {
    isin: input.isin,
    amount: input.amount,
    frequency,
    installmentDay: input.installmentDay,
    numberOfInstallments: input.numberOfInstallments,
  });

  const mandate = await resolveMandate(input.mandateId, account.id, input.amount);
  // A second SIP at the same AMC goes into the folio the first one opened, even
  // when started from the fund page rather than the holding. See
  // folio-resolution.service.ts.
  const folioNumber = await resolvePurchaseFolio(account.id, input.isin, input.folioNumber);

  try {
    const created = await fpPlans.createPurchasePlan({
      mf_investment_account: account.fpId,
      scheme: input.isin,
      amount: Number(input.amount),
      systematic: true,
      frequency: toFpFrequency(frequency),
      ...(input.installmentDay !== undefined && { installment_day: input.installmentDay }),
      number_of_installments: input.numberOfInstallments,
      ...(folioNumber && { folio_number: folioNumber }),
      ...(mandate && { payment_method: "mandate", payment_source: String(mandate.fpId) }),
      ...(input.purpose && { purpose: input.purpose }),
      ...(input.firstInstallmentNow && { generate_first_installment_now: true }),
      source_ref_id: input.sourceRefId ?? crypto.randomUUID(),
      user_ip: input.userIp,
      ...(input.serverIp && { server_ip: input.serverIp }),
      ...(input.euin && { euin: input.euin }),
      initiated_by: "investor",
      ...(input.initiatedVia && { initiated_via: input.initiatedVia }),
      gateway: fpConfig().orderGateway,
    });
    const row = await syncPurchasePlan(created, account.id);
    // FP does not echo `generate_first_installment_now`, so the mirror cannot
    // learn it from the response. Record what we asked for: the collector's
    // grace period for that first installment keys on it.
    if (input.firstInstallmentNow) {
      await db.mfPurchasePlan.update({ where: { id: row.id }, data: { generateFirstInstallmentNow: true } });
    }
    await settleNewSip(row.id, created.id, account.id, input.isin);
    return getSip(row.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Wait out FP's activation review, and refuse to call a dead plan "created".
 *
 * Every plan create answers `created` and FP runs its own checks immediately
 * afterwards — on the ONDC gateway a refusal lands within a second, with
 * `failed_at` equal to `created_at`. Returning the create response as-is
 * therefore reports a live plan that is already dead, and the investor only
 * finds out when they press "Refresh status" and meet FP's reason with no
 * context. Poll briefly instead and raise the reason as the outcome of the
 * request that caused it.
 *
 * The plan row stays — FP created it and the mirror must say so — so the id
 * travels with the error and the client can still open the plan.
 *
 * An SWP and an STP are reviewed by the same gateway as a SIP and fail the
 * same way; they were returning FP's optimistic `created` unchecked, which is
 * the one case where the app shows a withdrawal plan the investor does not
 * have.
 */
async function settleNewPlan(
  kind: "sip" | "swp" | "stp",
  id: string,
  fpId: string,
  mfInvestmentAccountId: string,
): Promise<{ state: string; reason: string | null }> {
  let state = "";
  let reason: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 400 : 800));
    if (kind === "sip") {
      const fresh = await fpPlans.fetchPurchasePlan(fpId);
      await syncPurchasePlan(fresh, mfInvestmentAccountId);
      state = String(fresh.state).toUpperCase();
      reason = fresh.reason ?? null;
    } else if (kind === "swp") {
      const fresh = await fpPlans.fetchRedemptionPlan(fpId);
      await syncRedemptionPlan(fresh, mfInvestmentAccountId);
      state = String(fresh.state).toUpperCase();
      reason = fresh.reason ?? null;
    } else {
      const fresh = await fpPlans.fetchSwitchPlan(fpId);
      await syncSwitchPlan(fresh, mfInvestmentAccountId);
      state = String(fresh.state).toUpperCase();
      reason = fresh.reason ?? null;
    }
    if (state !== PlanState.CREATED) break;
  }
  if (state === PlanState.FAILED) {
    const noun = kind.toUpperCase();
    throw HttpError.badRequest(
      reason ?? `The provider refused this ${noun} without giving a reason`,
      { planId: id, state, reason },
    );
  }
  return { state, reason };
}

/** The SIP path, which also learns from a refusal that names the scheme. */
async function settleNewSip(
  id: string,
  fpId: string,
  mfInvestmentAccountId: string,
  isin: string,
): Promise<void> {
  try {
    await settleNewPlan("sip", id, fpId, mfInvestmentAccountId);
  } catch (error) {
    if (error instanceof HttpError) {
      const reason = (error.details as { reason?: string | null } | undefined)?.reason ?? null;
      await rememberSipRefusal(isin, reason);
      throw HttpError.badRequest(error.message, { ...(error.details ?? {}), isin });
    }
    throw error;
  }
}

/**
 * Believe a refusal about the scheme over the catalogue that advertised it.
 *
 * FP publishes `sip_allowed` and a full set of per-frequency SIP thresholds for
 * schemes its own gateway then refuses — the sandbox's
 * "ICICI Prudential Retirement Fund Hybrid Aggressive Plan IDCW Payout"
 * (INF109KC1TV6) is one, and nothing in the catalogue distinguishes it from the
 * Growth plan beside it that works. The flag is a hint; a refusal naming the
 * scheme is evidence. Clearing it here makes `validatePlan` stop the next
 * investor before the order rather than after it.
 *
 * Only a refusal that is *about the scheme* counts. "payout account
 * verification pending" is about the investor and would otherwise disable SIPs
 * on a perfectly good fund for everyone.
 *
 * Writing to a mirrored row is allowed here because FP is the one that said it:
 * the refusal arrived in an API response, which is exactly the authority the
 * mirror requires. A re-seed restores the catalogue's optimistic flag, and the
 * next refusal clears it again.
 */
async function rememberSipRefusal(isin: string, reason: string | null): Promise<void> {
  if (!reason || !/sip .*not allowed .*scheme/i.test(reason)) return;
  await db.mfScheme.updateMany({ where: { isin }, data: { sipAllowed: false } });
}

export async function getSip(id: string): Promise<PlanDto> {
  const row = await db.mfPurchasePlan.findUnique({ where: { id }, select: sipSelect });
  if (!row) throw HttpError.notFound("No such plan");
  return toSipDto(row);
}

/**
 * Cancel a plan.
 *
 * Installments already generated are unaffected — they are orders in their own
 * right and continue to their own conclusion. A cancelled plan can never be
 * reactivated, so the client should confirm before calling.
 */
export async function cancelSip(
  id: string,
  cancellationCode: string,
  cancellationReason?: string,
): Promise<PlanDto> {
  const plan = await db.mfPurchasePlan.findUnique({
    where: { id },
    select: { fpId: true, mfInvestmentAccountId: true, state: true },
  });
  if (!plan) throw HttpError.notFound("No such plan");
  if (plan.state === PlanState.CANCELLED) return getSip(id);
  if (plan.state === PlanState.COMPLETED) {
    throw HttpError.conflict("A completed plan cannot be cancelled");
  }
  assertCancellable(plan.state);

  try {
    const cancelled = await fpPlans.cancelPurchasePlan({
      id: plan.fpId,
      ...planCancellationPayload(cancellationCode, cancellationReason),
    });
    await syncPurchasePlan(cancelled, plan.mfInvestmentAccountId);
    return getSip(id);
  } catch (error) {
    cancelRefusal(error);
  }
}

// ---------------------------------------------------------------------------
// SWP and STP
// ---------------------------------------------------------------------------

export async function createSwp(input: CreateSwpInput): Promise<PlanDto> {
  await assertInvestmentReady(input.mfInvestmentAccountId, input.folioNumber);
  const account = await requireAccount(input.mfInvestmentAccountId);
  const frequency = asFrequency(input.frequency);
  assertExitPlanSchedule("SWP", frequency, input.installmentDay, input.numberOfInstallments);
  // Each installment is a redemption, and the ONDC route refuses those by units.
  assertExitBasisSupported(fpConfig().orderGateway, input.units);
  await validatePlan(SchemeThresholdType.SWP, {
    isin: input.isin,
    amount: input.amount,
    units: input.units,
    frequency,
    installmentDay: input.installmentDay,
    numberOfInstallments: input.numberOfInstallments,
  });
  await assertFolioAtSchemeAmc(account.id, input.folioNumber, input.isin);
  await assertHoldsScheme(account.id, input.folioNumber, input.isin);

  try {
    const created = await fpPlans.createRedemptionPlan({
      mf_investment_account: account.fpId,
      scheme: input.isin,
      folio_number: input.folioNumber,
      ...(input.amount !== undefined && { amount: Number(input.amount) }),
      ...(input.units !== undefined && { units: Number(input.units) }),
      systematic: true,
      frequency: toFpFrequency(frequency),
      ...(input.installmentDay !== undefined && { installment_day: input.installmentDay }),
      number_of_installments: input.numberOfInstallments,
      source_ref_id: input.sourceRefId ?? crypto.randomUUID(),
      user_ip: input.userIp,
      ...(input.serverIp && { server_ip: input.serverIp }),
      ...(input.euin && { euin: input.euin }),
      initiated_by: "investor",
      ...(input.initiatedVia && { initiated_via: input.initiatedVia }),
      gateway: fpConfig().orderGateway,
    });
    const row = await syncRedemptionPlan(created, account.id);
    await settleNewPlan("swp", row.id, created.id, account.id);
    return getSwp(row.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function getSwp(id: string): Promise<PlanDto> {
  const row = await db.mfRedemptionPlan.findUnique({ where: { id }, select: swpSelect });
  if (!row) throw HttpError.notFound("No such plan");
  return toSwpDto(row);
}

export async function createStp(input: CreateStpInput): Promise<PlanDto> {
  await assertInvestmentReady(input.mfInvestmentAccountId, input.folioNumber);
  const account = await requireAccount(input.mfInvestmentAccountId);
  const frequency = asFrequency(input.frequency);
  assertExitPlanSchedule("STP", frequency, input.installmentDay, input.numberOfInstallments);
  // Each installment is a switch, and the ONDC route does not settle those by units.
  assertExitBasisSupported(fpConfig().orderGateway, input.units);
  await validatePlan(SchemeThresholdType.STP, {
    isin: input.switchOutIsin,
    switchInIsin: input.switchInIsin,
    amount: input.amount,
    units: input.units,
    frequency,
    installmentDay: input.installmentDay,
    numberOfInstallments: input.numberOfInstallments,
  });
  await assertFolioAtSchemeAmc(account.id, input.folioNumber, input.switchOutIsin);
  await assertHoldsScheme(account.id, input.folioNumber, input.switchOutIsin);

  try {
    const created = await fpPlans.createSwitchPlan({
      mf_investment_account: account.fpId,
      switch_out_scheme: input.switchOutIsin,
      switch_in_scheme: input.switchInIsin,
      folio_number: input.folioNumber,
      ...(input.amount !== undefined && { amount: Number(input.amount) }),
      ...(input.units !== undefined && { units: Number(input.units) }),
      systematic: true,
      frequency: toFpFrequency(frequency),
      ...(input.installmentDay !== undefined && { installment_day: input.installmentDay }),
      number_of_installments: input.numberOfInstallments,
      source_ref_id: input.sourceRefId ?? crypto.randomUUID(),
      user_ip: input.userIp,
      ...(input.serverIp && { server_ip: input.serverIp }),
      ...(input.euin && { euin: input.euin }),
      initiated_by: "investor",
      ...(input.initiatedVia && { initiated_via: input.initiatedVia }),
      gateway: fpConfig().orderGateway,
    });
    const row = await syncSwitchPlan(created, account.id);
    await settleNewPlan("stp", row.id, created.id, account.id);
    return getStp(row.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function getStp(id: string): Promise<PlanDto> {
  const row = await db.mfSwitchPlan.findUnique({ where: { id }, select: stpSelect });
  if (!row) throw HttpError.notFound("No such plan");
  return toStpDto(row);
}

/**
 * Every plan on an account, whatever its type, newest first.
 *
 * Three queries, not three plus one per row: selecting ids and then reading
 * each plan back individually turned a page of 100 SWPs and 100 STPs into 200
 * extra round trips to the database.
 */
export async function listPlans(mfInvestmentAccountId: string): Promise<PlanDto[]> {
  const where = { mfInvestmentAccountId };
  const orderBy = { fpCreatedAt: "desc" } as const;
  const take = 100;

  const [sips, swps, stps] = await Promise.all([
    db.mfPurchasePlan.findMany({ where, select: sipSelect, orderBy, take }),
    db.mfRedemptionPlan.findMany({ where, select: swpSelect, orderBy, take }),
    db.mfSwitchPlan.findMany({ where, select: stpSelect, orderBy, take }),
  ]);

  return [
    ...sips.map(toSipDto),
    ...swps.map(toSwpDto),
    ...stps.map(toStpDto),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
