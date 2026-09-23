// Mirror FP order and plan objects into our tables.
//
// Every function here upserts on `fpId`, so the same payload can arrive twice —
// once from the API response that created it, once from the webhook that
// announced it — and produce one row. That is the whole point: order events
// arrive out of band and more than once, and the mirror has to converge.
//
// These take an already-resolved local investment account id rather than
// looking it up, so the caller controls the transaction boundary.
import { db } from "../../db/client.ts";
import {
  MfOrderState,
  MfPurchaseType,
  OrderGateway,
  OrderInitiatedBy,
  OrderInitiatedVia,
  PlanFrequency,
  PlanPaymentMethod,
  PlanPurpose,
  PlanState,
  RedemptionMode,
} from "../../../generated/prisma/enums.ts";
import {
  fpAmount,
  fpDate,
  fpDateTime,
  fpEnum,
  fpEnumOr,
  fpInt,
  fpNav,
  fpText,
  fpUnits,
} from "../../utils/fp-mapping.ts";
import type {
  FpPayoutDetail,
  FpPurchase,
  FpPurchasePlan,
  FpRedemption,
  FpRedemptionPlan,
  FpSwitch,
  FpSwitchPlan,
} from "../../integrations/fp/fp.types.ts";

/**
 * The update half of an order or plan upsert: everything except its scheme.
 *
 * An order's scheme is fixed when it is placed, but FP rewrites it on some
 * failed sandbox orders to the placeholder `INF109K099999` — thirteen
 * characters, not a catalogue ISIN. Even inside an upsert PostgreSQL rejects it
 * against the column ("value too long"), so those orders could never be marked
 * failed and sat as `confirmed` / `submitted` in the mirror for ever. Such a
 * payload is applied as an update of the existing row (see `allIsins`).
 */
function fixedScheme<T extends Record<string, unknown>>(
  data: T,
): Omit<T, "schemeIsin" | "switchOutSchemeIsin" | "switchInSchemeIsin"> {
  const { schemeIsin: _s, switchOutSchemeIsin: _o, switchInSchemeIsin: _i, ...rest } = data;
  return rest;
}

/** Every value is a well-formed 12-character ISIN (what the scheme columns hold). */
function allIsins(...values: (string | null | undefined)[]): boolean {
  return values.every((value) => typeof value === "string" && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value));
}

/** FP sent a value our enums do not model yet. Loud, but never fatal. */
function unknownValue(field: string) {
  return (value: string) => console.warn(`[fp-sync] unmapped ${field}: "${value}"`);
}

/** Attribution and lifecycle columns shared by all three order types. */
function orderCommon(order: FpPurchase | FpRedemption | FpSwitch) {
  return {
    fpOldId: fpInt(order.old_id),
    state: fpEnumOr(MfOrderState, order.state, MfOrderState.PENDING, unknownValue("order state")),
    gateway: fpEnumOr(OrderGateway, order.gateway, OrderGateway.ONDC, unknownValue("gateway")),
    folioNumber: fpText(order.folio_number, 30),
    sourceRefId: fpText(order.source_ref_id, 64),
    userIp: fpText(order.user_ip, 45),
    serverIp: fpText(order.server_ip, 45),
    euin: fpText(order.euin, 10),
    initiatedBy: fpEnum(OrderInitiatedBy, order.initiated_by, unknownValue("initiated_by")),
    initiatedVia: fpEnum(OrderInitiatedVia, order.initiated_via, unknownValue("initiated_via")),
    failureCode: fpText(order.failure_code, 60),
    scheduledOn: fpDate(order.scheduled_on),
    tradedOn: fpDate(order.traded_on),
    fpCreatedAt: fpDateTime(order.created_at),
    confirmedAt: fpDateTime(order.confirmed_at),
    submittedAt: fpDateTime(order.submitted_at),
    succeededAt: fpDateTime(order.succeeded_at),
    failedAt: fpDateTime(order.failed_at),
    reversedAt: fpDateTime(order.reversed_at),
    cancelledAt: fpDateTime(order.cancelled_at),
    syncedAt: new Date(),
  };
}

/** Resolve the local folio row for an order, if that folio has been mirrored. */
async function resolveFolioId(
  mfInvestmentAccountId: string,
  folioNumber: string | null,
): Promise<string | null> {
  if (!folioNumber) return null;
  const folio = await db.mfFolio.findUnique({
    where: { mfInvestmentAccountId_number: { mfInvestmentAccountId, number: folioNumber } },
    select: { id: true },
  });
  return folio?.id ?? null;
}

/**
 * Resolve the local plan row an installment belongs to.
 *
 * FP reports the owning plan on every order as `plan`, and it is the only link
 * between a plan and the orders it generates — an SWP installment is an
 * ordinary redemption that happens to carry `mfrp_…` here. Without this the
 * installment lands with `planId` null and "what has my SWP paid out so far"
 * has no answer at all, because the plan object itself only says when the next
 * one is due.
 *
 * Null when the plan has not been mirrored yet: FP can announce an installment
 * before the plan's own webhook lands, and an order is worth keeping either
 * way. The next sync of the same order fills it in.
 */
async function resolvePlanId(
  kind: "purchase" | "redemption" | "switch",
  fpPlanId: string | null,
): Promise<string | null> {
  if (!fpPlanId) return null;
  const where = { fpId: fpPlanId };
  const select = { id: true } as const;
  const plan =
    kind === "purchase"
      ? await db.mfPurchasePlan.findUnique({ where, select })
      : kind === "redemption"
        ? await db.mfRedemptionPlan.findUnique({ where, select })
        : await db.mfSwitchPlan.findUnique({ where, select });
  if (!plan) console.warn(`[fp-sync] ${kind} references unmirrored plan ${fpPlanId}`);
  return plan?.id ?? null;
}

export async function syncPurchase(
  order: FpPurchase,
  mfInvestmentAccountId: string,
): Promise<{ id: string }> {
  const common = orderCommon(order);
  const [mfFolioId, planId] = await Promise.all([
    resolveFolioId(mfInvestmentAccountId, common.folioNumber),
    resolvePlanId("purchase", order.plan),
  ]);

  const data = {
    ...common,
    mfInvestmentAccountId,
    schemeIsin: order.scheme,
    mfFolioId,
    planId,
    type: fpEnum(MfPurchaseType, order.type, unknownValue("purchase type")),
    amount: fpAmount(order.amount) ?? "0.00",
    // Null until the AMC allots. Never synthesise these.
    allottedUnits: fpUnits(order.allotted_units),
    purchasedAmount: fpAmount(order.purchased_amount),
    purchasedPrice: fpNav(order.purchased_price),
    allottedNavDate: fpDate(order.allotted_nav_date),
    retriedAt: fpDateTime(order.retried_at),
  };

  // Not a catalogue ISIN: the row can only already exist, so update it in place.
  if (!allIsins(order.scheme)) {
    return db.mfPurchase.update({ where: { fpId: order.id }, data: fixedScheme(data), select: { id: true } });
  }
  return db.mfPurchase.upsert({
    where: { fpId: order.id },
    update: fixedScheme(data),
    create: { fpId: order.id, ...data },
    select: { id: true },
  });
}

export async function syncRedemption(
  order: FpRedemption,
  mfInvestmentAccountId: string,
): Promise<{ id: string }> {
  const common = orderCommon(order);
  const [mfFolioId, planId] = await Promise.all([
    resolveFolioId(mfInvestmentAccountId, common.folioNumber),
    resolvePlanId("redemption", order.plan),
  ]);

  const data = {
    ...common,
    mfInvestmentAccountId,
    schemeIsin: order.scheme,
    mfFolioId,
    planId,
    redemptionMode: fpEnumOr(
      RedemptionMode,
      order.redemption_mode,
      RedemptionMode.NORMAL,
      unknownValue("redemption_mode"),
    ),
    // Both null is meaningful: redeem the entire holding.
    amount: fpAmount(order.amount),
    units: fpUnits(order.units),
    redeemedAmount: fpAmount(order.redeemed_amount),
    redeemedUnits: fpUnits(order.redeemed_units),
    redeemedPrice: fpNav(order.redeemed_price),
    redeemedNavDate: fpDate(order.redeemed_nav_date),
    redemptionBankAccountNumber: fpText(order.redemption_bank_account_number, 20),
    redemptionBankAccountIfsc: fpText(order.redemption_bank_account_ifsc_code, 11),
  };

  // Not a catalogue ISIN: the row can only already exist, so update it in place.
  if (!allIsins(order.scheme)) {
    return db.mfRedemption.update({ where: { fpId: order.id }, data: fixedScheme(data), select: { id: true } });
  }
  return db.mfRedemption.upsert({
    where: { fpId: order.id },
    update: fixedScheme(data),
    create: { fpId: order.id, ...data },
    select: { id: true },
  });
}

export async function syncSwitch(
  order: FpSwitch,
  mfInvestmentAccountId: string,
): Promise<{ id: string }> {
  const common = orderCommon(order);
  const [mfFolioId, planId] = await Promise.all([
    resolveFolioId(mfInvestmentAccountId, common.folioNumber),
    resolvePlanId("switch", order.plan),
  ]);

  const data = {
    ...common,
    mfInvestmentAccountId,
    mfFolioId,
    planId,
    switchOutSchemeIsin: order.switch_out_scheme,
    switchInSchemeIsin: order.switch_in_scheme,
    amount: fpAmount(order.amount),
    units: fpUnits(order.units),
    switchedOutUnits: fpUnits(order.switched_out_units),
    switchedOutAmount: fpAmount(order.switched_out_amount),
    switchedOutPrice: fpNav(order.switched_out_price),
    switchedInUnits: fpUnits(order.switched_in_units),
    switchedInAmount: fpAmount(order.switched_in_amount),
    switchedInPrice: fpNav(order.switched_in_price),
  };

  // Not a catalogue ISIN: the row can only already exist, so update it in place.
  if (!allIsins(order.switch_out_scheme, order.switch_in_scheme)) {
    return db.mfSwitch.update({ where: { fpId: order.id }, data: fixedScheme(data), select: { id: true } });
  }
  return db.mfSwitch.upsert({
    where: { fpId: order.id },
    update: fixedScheme(data),
    create: { fpId: order.id, ...data },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function planCommon(plan: FpPurchasePlan | FpRedemptionPlan | FpSwitchPlan) {
  return {
    fpOldId: fpInt(plan.old_id),
    state: fpEnumOr(PlanState, plan.state, PlanState.CREATED, unknownValue("plan state")),
    gateway: fpEnumOr(OrderGateway, plan.gateway, OrderGateway.ONDC, unknownValue("gateway")),
    folioNumber: fpText(plan.folio_number, 30),
    systematic: plan.systematic,
    frequency: fpEnumOr(
      PlanFrequency,
      plan.frequency,
      PlanFrequency.MONTHLY,
      unknownValue("plan frequency"),
    ),
    installmentDay: fpInt(plan.installment_day),
    numberOfInstallments: fpInt(plan.number_of_installments) ?? 0,
    remainingInstallments: fpInt(plan.remaining_installments),
    autoGenerateInstallments: plan.auto_generate_installments ?? true,
    requestedActivationDate: fpDate(plan.requested_activation_date),
    startDate: fpDate(plan.start_date),
    endDate: fpDate(plan.end_date),
    nextInstallmentDate: fpDate(plan.next_installment_date),
    previousInstallmentDate: fpDate(plan.previous_installment_date),
    sourceRefId: fpText(plan.source_ref_id, 64),
    userIp: fpText(plan.user_ip, 45),
    serverIp: fpText(plan.server_ip, 45),
    euin: fpText(plan.euin, 10),
    initiatedBy: fpEnum(OrderInitiatedBy, plan.initiated_by, unknownValue("initiated_by")),
    initiatedVia: fpEnum(OrderInitiatedVia, plan.initiated_via, unknownValue("initiated_via")),
    consentEmail: fpText(plan.consent?.email, 255),
    consentIsdCode: fpText(plan.consent?.isd_code, 4),
    consentMobile: fpText(plan.consent?.mobile, 20),
    autoCancelled: plan.auto_cancelled ?? null,
    cancellationCode: fpText(plan.cancellation_code, 60),
    cancellationScheduledOn: fpDate(plan.cancellation_scheduled_on),
    reason: fpText(plan.reason, 500),
    fpCreatedAt: fpDateTime(plan.created_at),
    activatedAt: fpDateTime(plan.activated_at),
    cancelledAt: fpDateTime(plan.cancelled_at),
    failedAt: fpDateTime(plan.failed_at),
    completedAt: fpDateTime(plan.completed_at),
    syncedAt: new Date(),
  };
}

export async function syncPurchasePlan(
  plan: FpPurchasePlan,
  mfInvestmentAccountId: string,
): Promise<{ id: string }> {
  // `payment_source` is the mandate's numeric id as a string; resolve it to our
  // row so the plan links to a real mandate rather than a loose reference.
  const mandateFpId = fpInt(plan.payment_source);
  const mandate =
    mandateFpId === null
      ? null
      : await db.mandate.findUnique({ where: { fpId: mandateFpId }, select: { id: true } });

  const data = {
    ...planCommon(plan),
    mfInvestmentAccountId,
    schemeIsin: plan.scheme,
    amount: fpAmount(plan.amount) ?? "0.00",
    paymentMethod: fpEnum(PlanPaymentMethod, plan.payment_method, unknownValue("payment_method")),
    paymentSourceRef: fpText(plan.payment_source, 64),
    mandateId: mandate?.id ?? null,
    purpose: fpEnum(PlanPurpose, plan.purpose, unknownValue("plan purpose")),
  };

  // Not a catalogue ISIN: the row can only already exist, so update it in place.
  if (!allIsins(plan.scheme)) {
    return db.mfPurchasePlan.update({ where: { fpId: plan.id }, data: fixedScheme(data), select: { id: true } });
  }
  return db.mfPurchasePlan.upsert({
    where: { fpId: plan.id },
    update: fixedScheme(data),
    create: { fpId: plan.id, ...data },
    select: { id: true },
  });
}

export async function syncRedemptionPlan(
  plan: FpRedemptionPlan,
  mfInvestmentAccountId: string,
): Promise<{ id: string }> {
  const data = {
    ...planCommon(plan),
    mfInvestmentAccountId,
    schemeIsin: plan.scheme,
    amount: fpAmount(plan.amount),
    units: fpUnits(plan.units),
  };

  // Not a catalogue ISIN: the row can only already exist, so update it in place.
  if (!allIsins(plan.scheme)) {
    return db.mfRedemptionPlan.update({ where: { fpId: plan.id }, data: fixedScheme(data), select: { id: true } });
  }
  return db.mfRedemptionPlan.upsert({
    where: { fpId: plan.id },
    update: fixedScheme(data),
    create: { fpId: plan.id, ...data },
    select: { id: true },
  });
}

export async function syncSwitchPlan(
  plan: FpSwitchPlan,
  mfInvestmentAccountId: string,
): Promise<{ id: string }> {
  const data = {
    ...planCommon(plan),
    mfInvestmentAccountId,
    switchOutSchemeIsin: plan.switch_out_scheme,
    switchInSchemeIsin: plan.switch_in_scheme,
    amount: fpAmount(plan.amount),
    units: fpUnits(plan.units),
  };

  // Not a catalogue ISIN: the row can only already exist, so update it in place.
  if (!allIsins(plan.switch_out_scheme, plan.switch_in_scheme)) {
    return db.mfSwitchPlan.update({ where: { fpId: plan.id }, data: fixedScheme(data), select: { id: true } });
  }
  return db.mfSwitchPlan.upsert({
    where: { fpId: plan.id },
    update: fixedScheme(data),
    create: { fpId: plan.id, ...data },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// Payout
// ---------------------------------------------------------------------------
//
// Settlement details are not mirrored: they report money collected outside FP,
// which only happens on the RTA route. ONDC always collects through FP's own
// Payments API.
// ---------------------------------------------------------------------------

export async function syncPayoutDetail(
  payout: FpPayoutDetail,
  mfRedemptionId: string,
): Promise<{ id: string }> {
  const data = {
    mfRedemptionId,
    amount: fpAmount(payout.amount),
    utrNumber: fpText(payout.utr_number, 60),
    bankAccountNumberMasked: fpText(payout.beneficiary_bank_account_number, 40),
    bankIfsc: fpText(payout.beneficiary_bank_ifsc, 11),
    bankName: fpText(payout.beneficiary_bank_account_title, 150),
    paidAt: fpDateTime(payout.payout_processed_at),
    syncedAt: new Date(),
  };

  return db.mfPayoutDetail.upsert({
    where: { mfRedemptionId },
    update: { fpId: payout.id, ...data },
    create: { fpId: payout.id, ...data },
    select: { id: true },
  });
}
