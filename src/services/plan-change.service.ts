// Changing a running SIP: pausing it, ending the pause early, and changing its
// installment amount.
//
// All three are FP instructions against the plan, not edits of it — a skip
// instruction and a modification instruction — and FP carries them out on its
// own time. Nothing here is mirrored in our tables: the plan row changes only
// when FP says so (a completed amount change is picked up by `refreshPlan`),
// and the pause in force is read from FP each time, so there is no copy of it
// to go stale.
//
// Everything checks the plan against a state just re-read from FP, as
// `cancelPlan` does, so a refusal is in our words rather than the gateway's.
import { OtpPurpose, PlanState, SchemeThresholdType } from "../../generated/prisma/enums.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { fpErrorToHttpError, fpPlans } from "../integrations/fp/index.ts";
import type { FpPlanModificationInstruction, FpPlanSkipInstruction } from "../integrations/fp/index.ts";
import { isOndcRoute } from "../utils/gateway.ts";
import { HttpError } from "../utils/http-error.ts";
import { consumeVerificationToken } from "./otp.service.ts";
import { resolveConsentContact, sendConsent } from "./order.service.ts";
import { asFrequency, refreshPlan, resolveMandate } from "./plan.service.ts";
import { validatePlan } from "./scheme-rules.service.ts";
import type {
  PlanAmountChangeDto,
  PlanPauseDto,
  PlanPauseOptionDto,
  PlanPauseStatusDto,
} from "../types/plan.types.ts";

/** The context a transaction OTP for an amount change is issued and spent under. */
export const planChangeContext = (planId: string) => `planChange:${planId}`;

/** Skip-instruction states in which the pause still holds. */
const LIVE_PAUSE = ["PENDING", "ACTIVE", "CANCELLATION_REQUESTED"];

/**
 * SEBI's limit on consecutive failed installments, per frequency
 * (SEBI/HO/OW/IMD/IMD-SEC1/P/2024/270/1). FP refuses a skip that would reach
 * it, so a pause may cover at most one fewer.
 */
const FAILURE_LIMIT: Record<string, number> = {
  DAILY: 3,
  CALENDAR_DAY_DAILY: 3,
  DAY_IN_A_WEEK: 3,
  FOUR_TIMES_A_MONTH: 3,
  DAY_IN_A_FORTNIGHT: 3,
  TWICE_A_MONTH: 3,
  MONTHLY: 3,
  QUARTERLY: 2,
  HALF_YEARLY: 2,
  YEARLY: 2,
};

/**
 * How far one installment is from the next, for the frequencies whose dates
 * can be worked out without a holiday calendar. A business-day daily plan, or
 * one that runs several times a month, skips dates only FP can name.
 */
const STEP: Record<string, { months: number } | { days: number }> = {
  CALENDAR_DAY_DAILY: { days: 1 },
  DAY_IN_A_WEEK: { days: 7 },
  DAY_IN_A_FORTNIGHT: { days: 14 },
  MONTHLY: { months: 1 },
  QUARTERLY: { months: 3 },
  HALF_YEARLY: { months: 6 },
  YEARLY: { months: 12 },
};

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** `date` moved on by `count` installments of `step`, in UTC so no timezone shifts the day. */
function addSteps(date: Date, step: { months: number } | { days: number }, count: number): Date {
  const next = new Date(date.getTime());
  if ("days" in step) next.setUTCDate(next.getUTCDate() + step.days * count);
  else {
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + step.months * count);
    // A SIP day is at most 28, but clamp anyway rather than roll into next month.
    const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, last));
  }
  return next;
}

async function requireSip(id: string) {
  const row = await db.mfPurchasePlan.findUnique({
    where: { id },
    select: {
      fpId: true,
      state: true,
      gateway: true,
      frequency: true,
      amount: true,
      numberOfInstallments: true,
      installmentDay: true,
      nextInstallmentDate: true,
      mandateId: true,
      schemeIsin: true,
      folioNumber: true,
      mfInvestmentAccountId: true,
    },
  });
  if (!row || !isOndcRoute(row.gateway)) throw HttpError.notFound("No such ONDC SIP");
  return row;
}

function toPauseDto(skip: FpPlanSkipInstruction, frequency: string): PlanPauseDto {
  const step = STEP[frequency];
  const to = skip.to_date;
  return {
    id: skip.id,
    state: skip.state.toUpperCase(),
    from: skip.from_date,
    to,
    resumesOn: to && step ? isoDate(addSteps(new Date(`${to}T00:00:00Z`), step, 1)) : null,
    remainingInstallments: Number(skip.remaining_installments) || 0,
    skippedInstallments: Number(skip.skipped_installments) || 0,
  };
}

/** The pause that still holds on this plan, if any — the newest, should FP list several. */
async function livePause(fpId: string): Promise<FpPlanSkipInstruction | null> {
  const skips = await fpPlans.listPurchasePlanSkips(fpId);
  const today = isoDate(new Date());
  return (
    skips
      .filter((skip) => LIVE_PAUSE.includes(skip.state.toUpperCase()))
      .filter((skip) => !skip.to_date || skip.to_date >= today)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

/**
 * The pause in force and the lengths still open to the investor.
 *
 * Each option starts at the next installment and is dated here, once, so the
 * sheet shows the very dates `pauseSip` will send.
 */
export async function getSipPause(id: string): Promise<PlanPauseStatusDto> {
  await refreshPlan(id);
  const row = await requireSip(id);
  try {
    const current = await livePause(row.fpId);
    const pause = current ? toPauseDto(current, row.frequency) : null;
    const closed = (reason: string): PlanPauseStatusDto => ({ pause, options: [], unavailableReason: reason });

    if (pause) return closed("This SIP is already paused.");
    if (row.state !== PlanState.ACTIVE) return closed("Only an active SIP can be paused.");
    const step = STEP[row.frequency];
    if (!step) return closed("A SIP on this frequency cannot be paused here.");
    if (!row.nextInstallmentDate) return closed("The next instalment has not been scheduled yet.");

    const most = (FAILURE_LIMIT[row.frequency] ?? 2) - 1;
    const from = row.nextInstallmentDate;
    const options: PlanPauseOptionDto[] = Array.from({ length: most }, (_, index) => {
      const installments = index + 1;
      return {
        installments,
        from: isoDate(from),
        to: isoDate(addSteps(from, step, installments - 1)),
        resumesOn: isoDate(addSteps(from, step, installments)),
      };
    });
    return { pause, options, unavailableReason: null };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fpErrorToHttpError(error);
  }
}

/** Pause the SIP for its next `installments` installments. */
export async function pauseSip(id: string, installments: number): Promise<PlanPauseDto> {
  const status = await getSipPause(id);
  if (status.unavailableReason) throw HttpError.conflict(status.unavailableReason);
  const option = status.options.find((item) => item.installments === installments);
  if (!option) {
    const most = status.options.length;
    throw HttpError.badRequest(
      `A SIP on this frequency can skip at most ${most} instalment${most === 1 ? "" : "s"} in a row`,
    );
  }
  const row = await requireSip(id);
  try {
    const skip = await fpPlans.createPurchasePlanSkip(row.fpId, { from: option.from, to: option.to });
    return toPauseDto(skip, row.frequency);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * End the pause early.
 *
 * FP answers CANCELLATION_REQUESTED and decides later; on the ONDC sandbox that
 * decision has so far always been a refusal, the pause staying ACTIVE. The
 * investor is told the request was made, and the pause read back afterwards
 * says whether it took.
 */
export async function resumeSip(id: string): Promise<PlanPauseDto> {
  await refreshPlan(id);
  const row = await requireSip(id);
  try {
    const current = await livePause(row.fpId);
    if (!current) throw HttpError.conflict("This SIP is not paused");
    if (current.state.toUpperCase() === "CANCELLATION_REQUESTED") return toPauseDto(current, row.frequency);
    return toPauseDto(await fpPlans.cancelPurchasePlanSkip(current.id), row.frequency);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fpErrorToHttpError(error);
  }
}

function toAmountChangeDto(change: FpPlanModificationInstruction): PlanAmountChangeDto {
  return {
    id: change.id,
    state: change.state,
    from: change.amount?.from ?? null,
    to: change.amount?.to ?? null,
    failureReason: change.failure_reason,
    createdAt: change.created_at,
    completedAt: change.completed_at,
  };
}

/**
 * Change the SIP's installment amount, with the investor's 2FA consent.
 *
 * The new amount is held to everything the original was — the scheme's SIP
 * limits for this frequency and the mandate's per-debit ceiling — before the
 * OTP proof is spent, so a refusal never costs a fresh code. FP applies it to
 * installments not yet scheduled; one already generated keeps the old amount.
 */
export async function changeSipAmount(
  id: string,
  amount: string,
  verificationToken: string,
): Promise<PlanAmountChangeDto> {
  await refreshPlan(id);
  const row = await requireSip(id);
  if (row.state !== PlanState.ACTIVE) throw HttpError.conflict("Only an active SIP's amount can be changed", { state: row.state });
  // The controller has already checked this is a decimal string.
  const next = new Prisma.Decimal(amount);
  if (row.amount.equals(next)) throw HttpError.badRequest("That is already this SIP's amount");

  await validatePlan(SchemeThresholdType.SIP, {
    isin: row.schemeIsin,
    amount: next.toFixed(2),
    frequency: asFrequency(row.frequency),
    installmentDay: row.installmentDay ?? undefined,
    numberOfInstallments: row.numberOfInstallments,
  });
  await resolveMandate(row.mandateId ?? undefined, row.mfInvestmentAccountId, next.toFixed(2));

  const contact = await resolveConsentContact(row.mfInvestmentAccountId, row.folioNumber);
  const proof = await consumeVerificationToken(verificationToken, planChangeContext(id));
  if (proof.purpose !== OtpPurpose.TRANSACTION_APPROVAL) {
    throw HttpError.badRequest("This verification was not issued for approving a transaction");
  }
  if (proof.phone.replace(/\D/g, "") !== `${contact.isdCode}${contact.mobile}`.replace(/\D/g, "")) {
    throw HttpError.badRequest("The verified number does not match the mobile registered against this folio");
  }
  try {
    const change = await sendConsent(contact, (consent) =>
      fpPlans.createPlanAmountChange({ plan: row.fpId, amount: next.toNumber(), consent }),
    );
    return toAmountChangeDto(change);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Read an amount change back. Once FP completes it the plan is re-read, so the
 * new amount reaches our mirror and the SIP's own screen.
 *
 * The change id is not a guarded route parameter; it is checked against the
 * plan here, and the plan is.
 */
export async function getSipAmountChange(id: string, changeId: string): Promise<PlanAmountChangeDto> {
  const row = await requireSip(id);
  try {
    const change = await fpPlans.fetchPlanModification(changeId);
    if (change.plan !== row.fpId) throw HttpError.notFound("No such change on this SIP");
    if (change.state === "completed") await refreshPlan(id);
    return toAmountChangeDto(change);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fpErrorToHttpError(error);
  }
}
