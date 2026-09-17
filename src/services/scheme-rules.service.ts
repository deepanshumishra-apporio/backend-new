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

export async function validateRedemption(
  isin: string,
  amount: string | undefined,
  units: string | undefined,
): Promise<void> {
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

export async function validateSwitch(
  switchOutIsin: string,
  switchInIsin: string,
  amount: string | undefined,
  units: string | undefined,
): Promise<void> {
  if (switchOutIsin === switchInIsin) {
    throw HttpError.badRequest("Cannot switch a scheme into itself");
  }
  const source = await requireTradableScheme(switchOutIsin);
  const target = await requireTradableScheme(switchInIsin);
  if (!source.switchOutAllowed) {
    throw HttpError.badRequest(`${source.name} does not allow switching out`);
  }
  if (!target.switchInAllowed) {
    throw HttpError.badRequest(`${target.name} does not allow switching in`);
  }
  if (amount !== undefined && units !== undefined) {
    throw HttpError.badRequest("Give either amount or units, not both");
  }
  if (amount === undefined && units === undefined) {
    throw HttpError.badRequest("A switch needs either an amount or a number of units");
  }

  const outThreshold = await loadThreshold(switchOutIsin, SchemeThresholdType.SWITCH_OUT);
  if (outThreshold) {
    if (amount !== undefined) checkAmount(amount, outThreshold, "amount");
    if (units !== undefined) checkUnits(units, outThreshold, "units");
  }
  // The switch-in minimum is checked against the amount too: FP rejects a
  // switch whose value lands below the target scheme's entry minimum, which is
  // otherwise a confusing failure late in the flow.
  if (amount !== undefined) {
    const inThreshold = await loadThreshold(switchInIsin, SchemeThresholdType.SWITCH_IN);
    if (inThreshold?.amountMin) {
      checkAmount(amount, { ...inThreshold, amountMax: null, amountMultiples: null }, "amount");
    }
  }
}

export interface PlanValidationInput {
  isin: string;
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
  const scheme = await requireTradableScheme(input.isin);
  if (type === SchemeThresholdType.SIP && !scheme.sipAllowed) {
    throw HttpError.badRequest(`${scheme.name} does not support SIPs`);
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
