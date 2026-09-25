// Validate an order against the scheme's limits BEFORE calling FP.
//
// FP enforces these itself and rejects a bad order with a 400, so this is not
// about correctness — it is about the investor's experience and our error
// budget. A local check turns "FP says 400: amount should be multiple of 1"
// into a specific message before any network call, and keeps us inside the
// sandbox's 25-requests-per-second limit.
//
// It is a pre-flight check, never an authority: FP's copy of the thresholds is
// the real one, and a stale local catalogue must not block an otherwise valid
// order. So a scheme we have never synced passes through rather than failing
// closed.
import { Prisma } from "../../generated/prisma/client.ts";
import {
  SchemeThresholdFrequency,
  SchemeThresholdType,
} from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { assertLiveCapability } from "./scheme-availability.service.ts";

type ThresholdType = (typeof SchemeThresholdType)[keyof typeof SchemeThresholdType];
type ThresholdFrequency =
  (typeof SchemeThresholdFrequency)[keyof typeof SchemeThresholdFrequency];

const thresholdSelect = {
  amountMin: true,
  amountMax: true,
  amountMultiples: true,
  unitsMin: true,
  unitsMax: true,
  unitsMultiples: true,
  installmentsMin: true,
  allowedDates: true,
} as const;

export interface SchemeForOrder {
  isin: string;
  name: string;
  /** The fund house. A folio, and so every switch, lives inside one. */
  amcId: string;
  isActive: boolean;
  merged: boolean;
  purchaseAllowed: boolean;
  redemptionAllowed: boolean;
  switchInAllowed: boolean;
  switchOutAllowed: boolean;
  sipAllowed: boolean;
}

/** Load a scheme, or explain precisely why it cannot be transacted in. */
export async function requireTradableScheme(isin: string): Promise<SchemeForOrder> {
  const scheme = await db.mfScheme.findUnique({
    where: { isin },
    select: {
      isin: true,
      name: true,
      amcId: true,
      isActive: true,
      merged: true,
      mergedToIsin: true,
      purchaseAllowed: true,
      redemptionAllowed: true,
      switchInAllowed: true,
      switchOutAllowed: true,
      sipAllowed: true,
    },
  });

  if (!scheme) throw HttpError.notFound(`No scheme with ISIN ${isin}`);
  if (!scheme.isActive) throw HttpError.badRequest(`${scheme.name} is no longer active`);
  if (scheme.merged) {
    throw HttpError.badRequest(
      `${scheme.name} has merged into ${scheme.mergedToIsin ?? "another scheme"}`,
      { mergedToIsin: scheme.mergedToIsin },
    );
  }
  return scheme;
}

async function loadThreshold(
  isin: string,
  type: ThresholdType,
  frequency: ThresholdFrequency = SchemeThresholdFrequency.NOT_APPLICABLE,
) {
  return db.mfSchemeThreshold.findFirst({
    where: { scheme: { isin }, type, frequency },
    select: thresholdSelect,
  });
}

interface AmountRules {
  amountMin: Prisma.Decimal | null;
  amountMax: Prisma.Decimal | null;
  amountMultiples: Prisma.Decimal | null;
}

interface UnitRules {
  unitsMin: Prisma.Decimal | null;
  unitsMax: Prisma.Decimal | null;
  unitsMultiples: Prisma.Decimal | null;
}

export function checkAmount(raw: string, rules: AmountRules, label: string): void {
  let amount: Prisma.Decimal;
  try {
    amount = new Prisma.Decimal(raw);
  } catch {
    throw HttpError.badRequest(`${label} must be a decimal number`);
  }
  if (!amount.isFinite() || amount.decimalPlaces() > 2) {
    throw HttpError.badRequest(`${label} must be finite with at most two decimal places`);
  }
  if (amount.lessThanOrEqualTo(0)) {
    throw HttpError.badRequest(`${label} must be greater than zero`);
  }
  if (rules.amountMin && amount.lessThan(rules.amountMin)) {
    throw HttpError.badRequest(`${label} must be at least ${rules.amountMin.toFixed(2)}`, {
      min: rules.amountMin.toFixed(2),
    });
  }
  if (rules.amountMax && amount.greaterThan(rules.amountMax)) {
    throw HttpError.badRequest(`${label} must not exceed ${rules.amountMax.toFixed(2)}`, {
      max: rules.amountMax.toFixed(2),
    });
  }
  // `multiples` is a step, not a divisor of a round number: a scheme with a
  // 100 minimum and a 500 step accepts 100, 600, 1100 — so measure the step
  // from the minimum, not from zero.
  if (rules.amountMultiples && rules.amountMultiples.greaterThan(0)) {
    const base = rules.amountMin ?? new Prisma.Decimal(0);
    const offset = amount.minus(base);
    if (!offset.modulo(rules.amountMultiples).isZero()) {
      throw HttpError.badRequest(
        `${label} must be ${base.toFixed(2)} plus a multiple of ${rules.amountMultiples.toFixed(2)}`,
        { multiples: rules.amountMultiples.toFixed(2) },
      );
    }
  }
}

function checkUnits(raw: string, rules: UnitRules, label: string): void {
  let units: Prisma.Decimal;
  try {
    units = new Prisma.Decimal(raw);
  } catch {
    throw HttpError.badRequest(`${label} must be a decimal number`);
  }
  if (units.lessThanOrEqualTo(0)) {
    throw HttpError.badRequest(`${label} must be greater than zero`);
  }
  if (rules.unitsMin && units.lessThan(rules.unitsMin)) {
    throw HttpError.badRequest(`${label} must be at least ${rules.unitsMin.toFixed(4)}`, {
      min: rules.unitsMin.toFixed(4),
    });
  }
  if (rules.unitsMax && units.greaterThan(rules.unitsMax)) {
    throw HttpError.badRequest(`${label} must not exceed ${rules.unitsMax.toFixed(4)}`, {
      max: rules.unitsMax.toFixed(4),
    });
  }
}

/**
 * A purchase is bounded by the "initial" limits on a fresh folio and the
 * "additional" ones on an existing folio — they differ, often by a lot.
 */
export async function validatePurchase(
  isin: string,
  amount: string,
  hasFolio: boolean,
): Promise<void> {
  // FP first, and written back: our catalogue can still call a fund open that
  // the AMC has closed, and this is the check that tells the investor why.
  await assertLiveCapability(isin, "purchase");
  const scheme = await requireTradableScheme(isin);
  if (!scheme.purchaseAllowed) {
    throw HttpError.badRequest(`${scheme.name} is not open for purchases`);
  }
  const threshold = await loadThreshold(
    isin,
    hasFolio ? SchemeThresholdType.ADDITIONAL : SchemeThresholdType.LUMPSUM,
  );
  checkAmount(amount, threshold ?? { amountMin: null, amountMax: null, amountMultiples: null }, "amount");
}

/**
 * Refuse to sell more than the folio can actually give up.
 *
 * FP's own integration guide makes this step 3 of a redemption, before the
 * order is created: `redeemable_units` must be greater than zero and the
 * requested amount or units must fit inside it. Checking only the scheme's
 * min/max — which is all this did — lets an investor ask for ten times what
 * they hold and meet the refusal at the registrar instead of on the form.
 *
 * `redeemableUnits` is not `units`: it excludes anything under lock-in or
 * already committed to a pending order, so an ELSS holding can show units and
 * still be unsellable. The fallbacks exist because FP leaves the redeemable
 * columns null on some holdings, and the total is a better answer than none.
 *
 * A pre-flight check, never an authority — same rule as the thresholds above.
 * A folio we have never mirrored passes through to FP rather than failing
 * closed, because a stale local holding must not block a valid order.
 */
export async function assertRedeemable(
  mfInvestmentAccountId: string,
  folioNumber: string,
  isin: string,
  amount: string | undefined,
  units: string | undefined,
): Promise<void> {
  const holding = await db.mfHolding.findUnique({
    where: {
      mfInvestmentAccountId_folioNumber_schemeIsin: {
        mfInvestmentAccountId,
        folioNumber,
        schemeIsin: isin,
      },
    },
    select: { units: true, redeemableUnits: true, marketValue: true, redeemableMarketValue: true },
  });
  if (!holding) return;

  const sellableUnits = holding.redeemableUnits ?? holding.units;
  if (sellableUnits.lessThanOrEqualTo(0)) {
    throw HttpError.badRequest(
      "None of the units in this folio can be sold right now — they are under lock-in or already committed to a pending order",
      { folioNumber, isin, redeemableUnits: sellableUnits.toFixed(4) },
    );
  }

  if (units !== undefined && new Prisma.Decimal(units).greaterThan(sellableUnits)) {
    throw HttpError.badRequest(
      `Only ${sellableUnits.toFixed(4)} units in this folio can be sold`,
      { redeemableUnits: sellableUnits.toFixed(4) },
    );
  }

  const sellableValue = holding.redeemableMarketValue ?? holding.marketValue;
  if (
    amount !== undefined &&
    sellableValue !== null &&
    new Prisma.Decimal(amount).greaterThan(sellableValue)
  ) {
    throw HttpError.badRequest(
      `This folio holds ${sellableValue.toFixed(2)} in this scheme, which is less than the amount requested`,
      { redeemableAmount: sellableValue.toFixed(2) },
    );
  }
}

/**
 * Refuse a withdrawal or transfer plan on a folio that holds none of the scheme.
 *
 * Deliberately weaker than `assertRedeemable`: a plan pays out over months, so
 * units under lock-in today may be free by a later installment and must not
 * block it. A folio holding nothing, though, can never fund a single one — FP
 * accepts such a plan and then fails every installment. Unmirrored holdings
 * pass through to FP, as with `assertRedeemable`.
 */
export async function assertHoldsScheme(
  mfInvestmentAccountId: string,
  folioNumber: string,
  isin: string,
): Promise<void> {
  const holdings = await db.mfHolding.findMany({
    where: { mfInvestmentAccountId },
    select: { folioNumber: true, schemeIsin: true, units: true },
  });
  if (holdings.length === 0) return;
  const holding = holdings.find((h) => h.folioNumber === folioNumber && h.schemeIsin === isin);
  if (!holding || holding.units.lessThanOrEqualTo(0)) {
    throw HttpError.badRequest("This folio holds no units of this scheme to withdraw or transfer", {
      folioNumber,
      isin,
    });
  }
}

export async function validateRedemption(
  isin: string,
  amount: string | undefined,
  units: string | undefined,
): Promise<void> {
  await assertLiveCapability(isin, "redemption");
  const scheme = await requireTradableScheme(isin);
  if (!scheme.redemptionAllowed) {
    throw HttpError.badRequest(`${scheme.name} is not open for redemptions`);
  }
  if (amount !== undefined && units !== undefined) {
    throw HttpError.badRequest("Give either amount or units, not both");
  }
  const threshold = await loadThreshold(isin, SchemeThresholdType.WITHDRAWAL);
  if (!threshold) return;
  if (amount !== undefined) checkAmount(amount, threshold, "amount");
  if (units !== undefined) checkUnits(units, threshold, "units");
  // Neither given is valid and means "redeem everything".
}

/**
 * Exactly one of amount and units. Neither is only legal on a one-off
 * redemption, where it means "everything" — so every other caller says so.
 */
export function assertAmountOrUnits(
  amount: string | undefined,
  units: string | undefined,
  what: string,
): void {
  if (amount !== undefined && units !== undefined) {
    throw HttpError.badRequest("Give either amount or units, not both");
  }
  if (amount === undefined && units === undefined) {
    throw HttpError.badRequest(`${what} needs either an amount or a number of units`);
  }
}

/**
 * Can money move from one scheme into the other at all?
 *
 * Shared by the one-off switch and the STP. A switch moves units between two
 * schemes of one folio, and a folio belongs to one fund house — so both schemes
 * must be at the same AMC; across fund houses the only route is a redemption
 * and a fresh purchase. An STP is a switch repeated on a schedule, and the target scheme's rules apply to every installment just the
 * same — checking only the source, as the STP path did, let a plan into a fund
 * that refuses switch-ins (or into itself) be created, reviewed and confirmed,
 * and then fail every installment.
 */
export async function assertSwitchPair(switchOutIsin: string, switchInIsin: string): Promise<void> {
  if (switchOutIsin === switchInIsin) {
    throw HttpError.badRequest("Cannot switch a scheme into itself");
  }
  const [source, target] = await Promise.all([
    requireTradableScheme(switchOutIsin),
    requireTradableScheme(switchInIsin),
  ]);
  if (!source.switchOutAllowed) {
    throw HttpError.badRequest(`${source.name} does not allow switching out`);
  }
  if (!target.switchInAllowed) {
    throw HttpError.badRequest(`${target.name} does not allow switching in`);
  }
  if (source.amcId !== target.amcId) {
    throw HttpError.badRequest(
      `${source.name} and ${target.name} are with different fund houses. A switch stays within one fund house — redeem and invest instead.`,
      { switchOutIsin, switchInIsin },
    );
  }
}

/** An STP's target must publish the plan's frequency for STP too. */
async function assertStpTargetFrequency(
  switchInIsin: string,
  frequency: ThresholdFrequency,
): Promise<void> {
  const [target, supported] = await Promise.all([
    requireTradableScheme(switchInIsin),
    db.mfSchemeThreshold.findMany({
      where: { scheme: { isin: switchInIsin }, type: SchemeThresholdType.STP },
      select: { frequency: true },
    }),
  ]);
  if (!supported.some((row) => row.frequency === frequency)) {
    throw HttpError.badRequest(
      `${target.name} does not accept ${frequency.toLowerCase()} transfer plans. Choose another fund to transfer into.`,
      { switchInIsin, supported: supported.map((row) => row.frequency) },
    );
  }
}

/**
 * The target scheme's entry minimum, checked against a switch amount.
 *
 * FP rejects a switch whose value lands below it, late in the flow and in
 * words that name neither scheme. Units cannot be checked here — their value
 * depends on a NAV that is not known until the switch is processed.
 */
async function checkSwitchInMinimum(switchInIsin: string, amount: string | undefined): Promise<void> {
  if (amount === undefined) return;
  const inThreshold = await loadThreshold(switchInIsin, SchemeThresholdType.SWITCH_IN);
  if (inThreshold?.amountMin) {
    checkAmount(amount, { ...inThreshold, amountMax: null, amountMultiples: null }, "amount");
  }
}

export async function validateSwitch(
  switchOutIsin: string,
  switchInIsin: string,
  amount: string | undefined,
  units: string | undefined,
): Promise<void> {
  await assertSwitchPair(switchOutIsin, switchInIsin);
  assertAmountOrUnits(amount, units, "A switch");
  await assertLiveCapability(switchOutIsin, "switch_out");
  await assertLiveCapability(switchInIsin, "switch_in");

  const outThreshold = await loadThreshold(switchOutIsin, SchemeThresholdType.SWITCH_OUT);
  if (outThreshold) {
    if (amount !== undefined) checkAmount(amount, outThreshold, "amount");
    if (units !== undefined) checkUnits(units, outThreshold, "units");
  }
  await checkSwitchInMinimum(switchInIsin, amount);
}

export interface PlanValidationInput {
  /** The scheme the plan buys (SIP), sells (SWP) or switches out of (STP). */
  isin: string;
  /** STP only: the scheme each installment switches into. */
  switchInIsin?: string | undefined;
  amount?: string | undefined;
  units?: string | undefined;
  frequency: ThresholdFrequency;
  installmentDay?: number | undefined;
  numberOfInstallments: number;
}

/**
 * Validate a systematic plan against the scheme's per-frequency limits.
 *
 * The frequency check is the one that matters most: a scheme can advertise
 * `sipAllowed` and still support no frequencies at all — both index funds in
 * the sandbox catalogue do exactly that — and FP answers with a flat "selected
 * frequency is not supported" well after the investor has picked a date.
 */
export async function validatePlan(
  type: ThresholdType,
  input: PlanValidationInput,
): Promise<void> {
  // A plan is checked against FP's live flags as a purchase is — a fund the
  // AMC has closed must be refused before the investor chooses a mandate and
  // a date, not by FP after the plan is created.
  if (type === SchemeThresholdType.SIP) await assertLiveCapability(input.isin, "sip");
  if (type === SchemeThresholdType.SWP) await assertLiveCapability(input.isin, "redemption");
  if (type === SchemeThresholdType.STP) await assertLiveCapability(input.isin, "switch_out");
  const scheme = await requireTradableScheme(input.isin);
  if (type === SchemeThresholdType.SIP && !scheme.sipAllowed) {
    throw HttpError.badRequest(`${scheme.name} does not support SIPs`);
  }
  // Every SWP installment is a redemption and every STP installment a switch,
  // so the one-off order's scheme rules hold for each of them. Without these a
  // plan on a closed scheme passes review and fails every installment.
  if (type === SchemeThresholdType.SWP) {
    if (!scheme.redemptionAllowed) {
      throw HttpError.badRequest(`${scheme.name} is not open for redemptions`);
    }
    assertAmountOrUnits(input.amount, input.units, "A withdrawal plan");
  }
  if (type === SchemeThresholdType.STP) {
    if (!input.switchInIsin) throw HttpError.badRequest("A transfer plan needs a target scheme");
    await assertSwitchPair(input.isin, input.switchInIsin);
    assertAmountOrUnits(input.amount, input.units, "A transfer plan");
    await checkSwitchInMinimum(input.switchInIsin, input.amount);
  }

  const supported = await db.mfSchemeThreshold.findMany({
    where: { scheme: { isin: input.isin }, type },
    select: { frequency: true },
  });
  if (supported.length === 0) {
    throw HttpError.badRequest(`${scheme.name} publishes no ${type} frequencies`, {
      isin: input.isin,
    });
  }
  if (!supported.some((row) => row.frequency === input.frequency)) {
    throw HttpError.badRequest(`${scheme.name} does not support ${input.frequency} for ${type}`, {
      supported: supported.map((row) => row.frequency),
    });
  }
  // FP checks the frequency against the target scheme as well, and answers a
  // target that publishes none with a bare "frequency: not supported". Both
  // sandbox index funds are such targets.
  if (type === SchemeThresholdType.STP && input.switchInIsin) {
    await assertStpTargetFrequency(input.switchInIsin, input.frequency);
  }

  const threshold = await loadThreshold(input.isin, type, input.frequency);
  if (!threshold) return;

  if (input.amount !== undefined) checkAmount(input.amount, threshold, "amount");
  if (input.units !== undefined) checkUnits(input.units, threshold, "units");

  if (threshold.installmentsMin && input.numberOfInstallments < threshold.installmentsMin) {
    throw HttpError.badRequest(
      `This plan needs at least ${threshold.installmentsMin} installments`,
      { min: threshold.installmentsMin },
    );
  }
  // A daily plan runs every day, so there is no day to choose. FP rejects one
  // with "installment_day should be null for the given frequency" — an error
  // the client cannot act on, since the scheme publishes `allowedDates` for
  // daily frequencies too and nothing else says they do not apply.
  if (input.installmentDay !== undefined && isDailyFrequency(input.frequency)) {
    throw HttpError.badRequest(
      `A ${input.frequency} plan runs every day, so it takes no installment day`,
      { frequency: input.frequency },
    );
  }
  if (
    input.installmentDay !== undefined &&
    threshold.allowedDates.length > 0 &&
    !threshold.allowedDates.includes(input.installmentDay)
  ) {
    throw HttpError.badRequest(`Installment day ${input.installmentDay} is not offered`, {
      allowedDates: threshold.allowedDates,
    });
  }
}

/** Frequencies that run every day and therefore take no installment day. */
export function isDailyFrequency(frequency: string): boolean {
  return frequency === SchemeThresholdFrequency.DAILY ||
    frequency === SchemeThresholdFrequency.CALENDAR_DAY_DAILY;
}
