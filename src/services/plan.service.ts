// Systematic plans: SIP (purchase), SWP (redemption) and STP (switch).
//
// `systematic: true` registers a real SIP/SWP/STP with the RTA and validates
// the installment against the scheme's per-frequency limits. That matters more
// than it sounds: a scheme can advertise `sipAllowed` and publish no
// frequencies at all — both index funds in the sandbox catalogue do — and FP
// then answers "selected frequency is not supported" after the investor has
// already chosen an amount and a date. scheme-rules catches it first.
import {

  PlanState,
  SchemeThresholdFrequency,
  SchemeThresholdType,
} from "../../generated/prisma/enums.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { assertInvestmentReady } from "./investor-readiness.service.ts";
import { fpErrorToHttpError, fpPlans } from "../integrations/fp/index.ts";
import { HttpError } from "../utils/http-error.ts";
import { asAmount, asDate, asUnits } from "../utils/money.ts";
import { consumeVerificationToken } from "./otp.service.ts";
import { resolveConsentContact } from "./order.service.ts";
import { syncPurchasePlan, syncRedemptionPlan, syncSwitchPlan } from "./fp-sync/index.ts";
import { validatePlan } from "./scheme-rules.service.ts";
import type { PlanDto, CreateSipInput, CreateStpInput, CreateSwpInput } from "../types/plan.types.ts";

const GATEWAY = "cybrillapoa";

/** The three plan tables share an id space, so a lookup has to try each. */
const planIdentitySelect = {
  fpId: true,
  state: true,
  gateway: true,
  folioNumber: true,
  mfInvestmentAccountId: true,
} as const;

async function resolvePlan(id: string) {
  const [sip, swp, stp] = await Promise.all([
    db.mfPurchasePlan.findUnique({ where: { id }, select: { ...planIdentitySelect, mandateId: true } }),
    db.mfRedemptionPlan.findUnique({ where: { id }, select: planIdentitySelect }),
    db.mfSwitchPlan.findUnique({ where: { id }, select: planIdentitySelect }),
  ]);
  const row = sip ?? swp ?? stp;
  if (!row || row.gateway !== "CYBRILLAPOA") throw HttpError.notFound("No such ONDC plan");
  return { row, kind: sip ? "sip" : swp ? "swp" : "stp", mandateId: sip?.mandateId };
}
export async function getPlan(id: string): Promise<PlanDto> {
  const { kind } = await resolvePlan(id);
  return kind === "sip" ? getSip(id) : kind === "swp" ? getSwp(id) : getStp(id);
}
export async function refreshPlan(id: string): Promise<PlanDto> {
  const { row, kind } = await resolvePlan(id);
  try {
    if (kind === "sip") await syncPurchasePlan(await fpPlans.fetchPurchasePlan(row.fpId), row.mfInvestmentAccountId);
    else if (kind === "swp") await syncRedemptionPlan(await fpPlans.fetchRedemptionPlan(row.fpId), row.mfInvestmentAccountId);
    else await syncSwitchPlan(await fpPlans.fetchSwitchPlan(row.fpId), row.mfInvestmentAccountId);
    return getPlan(id);
  } catch (error) { fpErrorToHttpError(error); }
}
export async function confirmPlan(id: string, verificationToken: string): Promise<PlanDto> {
  await refreshPlan(id);
  const { row, kind, mandateId } = await resolvePlan(id);
  if (["ACTIVE", "SUBMITTED", "CONFIRMED"].includes(row.state)) return getPlan(id);
  if (row.state !== "REVIEW_COMPLETED") throw HttpError.conflict("Wait for the plan review to complete");
  if (kind === "sip") {
    if (!mandateId) throw HttpError.conflict("Create the SIP with an approved mandate before confirming");
    await resolveMandate(mandateId, row.mfInvestmentAccountId);
  }
  const contact = await resolveConsentContact(row.mfInvestmentAccountId, row.folioNumber);
  const proof = await consumeVerificationToken(verificationToken, `plan:${id}`);
  if (proof.phone.replace(/\D/g, "") !== `${contact.isdCode}${contact.mobile}`.replace(/\D/g, "")) throw HttpError.badRequest("Consent phone mismatch");
  const payload = { id: row.fpId, state: "confirmed" as const, consent: { email: contact.email, isd_code: contact.isdCode, mobile: contact.mobile } };
  try {
    if (kind === "sip") await syncPurchasePlan(await fpPlans.updatePurchasePlan(payload), row.mfInvestmentAccountId);
    else if (kind === "swp") await syncRedemptionPlan(await fpPlans.updateRedemptionPlan(payload), row.mfInvestmentAccountId);
    else await syncSwitchPlan(await fpPlans.updateSwitchPlan(payload), row.mfInvestmentAccountId);
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
  if (state === PlanState.REVIEW_COMPLETED) {
    throw HttpError.conflict(
      "A reviewed plan cannot be cancelled on the ONDC route — confirm it, or leave it unconfirmed",
      { state },
    );
  }
}

export async function cancelPlan(id: string, cancellationCode: string, cancellationReason?: string): Promise<PlanDto> {
  const { row, kind } = await resolvePlan(id);
  if (kind === "sip") return cancelSip(id, cancellationCode, cancellationReason);
  if (row.state === "CANCELLED") return getPlan(id);
  assertCancellable(row.state);
  const payload = { cancellation_code: cancellationCode, ...(cancellationReason && { cancellation_reason: cancellationReason }) };
  try {
    if (kind === "swp") await syncRedemptionPlan(await fpPlans.cancelRedemptionPlan(row.fpId, payload), row.mfInvestmentAccountId);
    else await syncSwitchPlan(await fpPlans.cancelSwitchPlan(row.fpId, payload), row.mfInvestmentAccountId);
    return getPlan(id);
  } catch (error) { fpErrorToHttpError(error); }
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
function asFrequency(raw: string): Frequency {
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
const sipSelect = { ...planSelect, schemeIsin: true, scheme: { select: { name: true } } } as const;
const swpSelect = { ...planSelect, units: true, schemeIsin: true, scheme: { select: { name: true } } } as const;
const stpSelect = {
  ...planSelect,
  units: true,
  switchOutSchemeIsin: true,
  switchInSchemeIsin: true,
  switchOutScheme: { select: { name: true } },
} as const;

type SipRow = Prisma.MfPurchasePlanGetPayload<{ select: typeof sipSelect }>;
type SwpRow = Prisma.MfRedemptionPlanGetPayload<{ select: typeof swpSelect }>;
type StpRow = Prisma.MfSwitchPlanGetPayload<{ select: typeof stpSelect }>;

function toPlanDto(
  row: PlanRowBase,
  extra: { type: PlanDto["type"]; isin: string; schemeName: string | null; amount: string | null; units: string | null },
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
async function resolveMandate(mandateId: string | undefined, mfInvestmentAccountId: string) {
  if (!mandateId) return undefined;
  const mandate = await db.mandate.findFirst({
    where: {
      id: mandateId,
      bankAccount: {
        investorProfile: { primaryFor: { some: { id: mfInvestmentAccountId } } },
      },
    },
    select: { fpId: true, mandateStatus: true },
  });
  if (!mandate) throw HttpError.badRequest("That mandate does not belong to this investor");
  if (mandate.mandateStatus !== "APPROVED") {
    throw HttpError.badRequest("The mandate must be approved before it can fund a plan", {
      status: mandate.mandateStatus,
    });
  }
  return mandate;
}

// ---------------------------------------------------------------------------
// SIP
// ---------------------------------------------------------------------------

export async function createSip(input: CreateSipInput): Promise<PlanDto> {
  await assertInvestmentReady(input.mfInvestmentAccountId, input.folioNumber);
  const account = await requireAccount(input.mfInvestmentAccountId);
  const frequency = asFrequency(input.frequency);
  if (!["MONTHLY", "DAILY", "CALENDAR_DAY_DAILY"].includes(frequency)) throw HttpError.badRequest("ONDC SIP supports monthly and daily frequencies only");
  await validatePlan(SchemeThresholdType.SIP, {
    isin: input.isin,
    amount: input.amount,
    frequency,
    installmentDay: input.installmentDay,
    numberOfInstallments: input.numberOfInstallments,
  });

  const mandate = await resolveMandate(input.mandateId, account.id);

  try {
    const created = await fpPlans.createPurchasePlan({
      mf_investment_account: account.fpId,
      scheme: input.isin,
      amount: Number(input.amount),
      systematic: true,
      frequency: toFpFrequency(frequency),
      ...(input.installmentDay !== undefined && { installment_day: input.installmentDay }),
      number_of_installments: input.numberOfInstallments,
      ...(input.folioNumber && { folio_number: input.folioNumber }),
      ...(mandate && { payment_method: "mandate", payment_source: String(mandate.fpId) }),
      ...(input.purpose && { purpose: input.purpose }),
      source_ref_id: input.sourceRefId ?? crypto.randomUUID(),
      user_ip: input.userIp,
      ...(input.serverIp && { server_ip: input.serverIp }),
      ...(input.euin && { euin: input.euin }),
      initiated_by: "investor",
      ...(input.initiatedVia && { initiated_via: input.initiatedVia }),
      gateway: GATEWAY,
    });
    const row = await syncPurchasePlan(created, account.id);
    return getSip(row.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
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
      cancellation_code: cancellationCode,
      // FP accepts free text only alongside the custom_reason code.
      ...(cancellationCode === "custom_reason" &&
        cancellationReason && { cancellation_reason: cancellationReason }),
    });
    await syncPurchasePlan(cancelled, plan.mfInvestmentAccountId);
    return getSip(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

// ---------------------------------------------------------------------------
// SWP and STP
// ---------------------------------------------------------------------------

export async function createSwp(input: CreateSwpInput): Promise<PlanDto> {
  await assertInvestmentReady(input.mfInvestmentAccountId, input.folioNumber);
  if (input.frequency !== "MONTHLY") throw HttpError.badRequest("ONDC SWP supports monthly frequency only");
  const account = await requireAccount(input.mfInvestmentAccountId);
  const frequency = asFrequency(input.frequency);
  await validatePlan(SchemeThresholdType.SWP, {
    isin: input.isin,
    amount: input.amount,
    units: input.units,
    frequency,
    installmentDay: input.installmentDay,
    numberOfInstallments: input.numberOfInstallments,
  });

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
      initiated_by: "investor",
      gateway: GATEWAY,
    });
    const row = await syncRedemptionPlan(created, account.id);
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
  if (input.frequency !== "MONTHLY") throw HttpError.badRequest("ONDC STP supports monthly frequency only");
  const account = await requireAccount(input.mfInvestmentAccountId);
  const frequency = asFrequency(input.frequency);
  await validatePlan(SchemeThresholdType.STP, {
    isin: input.switchOutIsin,
    amount: input.amount,
    units: input.units,
    frequency,
    installmentDay: input.installmentDay,
    numberOfInstallments: input.numberOfInstallments,
  });

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
      initiated_by: "investor",
      gateway: GATEWAY,
    });
    const row = await syncSwitchPlan(created, account.id);
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
