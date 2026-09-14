// Placing and progressing mutual fund orders on the ONDC route.
//
// The platform runs exclusively on FP's ONDC gateway, whose API value is
// `cybrillapoa`. The sequence is fixed and each step fails loudly if taken out
// of turn — every rule below was established by making FP reject the
// alternative:
//
//   1. create                  -> under_review
//   2. FP reviews asynchronously (investor KYC + PAN verification)
//                              -> pending, or failed
//   3. PATCH consent, ALONE    -> still pending
//   4. create a payment against the order
//   5. PATCH state=confirmed   -> confirmed, then submitted by FP
//
// Details that are easy to get wrong:
//
//   - `state` and `consent` cannot travel together; FP rejects it outright.
//   - An order is not payable until the review passes. Poll `refreshOrder`.
//   - Confirm needs a live payment behind it. We refuse locally first, because
//     FP's own error does not say which order or why.
//   - There is no settlement step. Settlement reports money collected outside
//     FP, which only applies to the RTA route; `/v2/mf_settlement_details` is
//     blocked in the transport so it cannot be called by accident.
//   - The payout bank account must have passed verification before submission,
//     or the order is reviewed, paid for and confirmed, then fails with
//     `payout_account_verification_pending` — after the money has moved.
//   - Order creation is NOT idempotent at FP. `sourceRefId` is the only guard.
import {
  MfOrderState,
  OrderGateway,
  OtpPurpose,
  PaymentStatus,
} from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import { assertInvestmentReady } from "./investor-readiness.service.ts";
import { fpConfig, fpErrorToHttpError, fpOrders } from "../integrations/fp/index.ts";
import { HttpError } from "../utils/http-error.ts";
import { asAmount, asDate, asNav, asUnits } from "../utils/money.ts";
import { consumeVerificationToken } from "./otp.service.ts";
import { syncPurchase, syncRedemption, syncSwitch } from "./fp-sync/index.ts";
import { validatePurchase, validateRedemption, validateSwitch } from "./scheme-rules.service.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import type {
  CreatePurchaseInput,
  CreateRedemptionInput,
  CreateSwitchInput,
  OrderConsentInput,
  OrderDto,
} from "../types/order.types.ts";

const orderSelect = {
  id: true,
  fpId: true,
  fpOldId: true,
  state: true,
  gateway: true,
  folioNumber: true,
  scheduledOn: true,
  tradedOn: true,
  failureCode: true,
  consentAt: true,
  fpCreatedAt: true,
  confirmedAt: true,
  succeededAt: true,
  createdAt: true,
} as const;

const purchaseSelect = {
  ...orderSelect,
  schemeIsin: true,
  type: true,
  amount: true,
  allottedUnits: true,
  purchasedAmount: true,
  purchasedPrice: true,
  scheme: { select: { name: true } },
} as const;

const redemptionSelect = {
  ...orderSelect,
  schemeIsin: true,
  amount: true,
  units: true,
  redeemedUnits: true,
  redeemedAmount: true,
  redeemedPrice: true,
  scheme: { select: { name: true } },
} as const;

const switchSelect = {
  ...orderSelect,
  switchOutSchemeIsin: true,
  switchInSchemeIsin: true,
  amount: true,
  units: true,
  switchedOutUnits: true,
  switchedOutAmount: true,
  switchedOutPrice: true,
  switchOutScheme: { select: { name: true } },
} as const;

type PurchaseRow = Prisma.MfPurchaseGetPayload<{ select: typeof purchaseSelect }>;
type RedemptionRow = Prisma.MfRedemptionGetPayload<{ select: typeof redemptionSelect }>;
type SwitchRow = Prisma.MfSwitchGetPayload<{ select: typeof switchSelect }>;

function baseDto(row: PurchaseRow | RedemptionRow | SwitchRow) {
  return {
    id: row.id,
    fpId: row.fpId,
    state: row.state,
    gateway: row.gateway,
    folioNumber: row.folioNumber,
    scheduledOn: asDate(row.scheduledOn),
    tradedOn: asDate(row.tradedOn),
    failureCode: row.failureCode,
    consentRecorded: row.consentAt !== null,
    createdAt: (row.fpCreatedAt ?? row.createdAt).toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    succeededAt: row.succeededAt?.toISOString() ?? null,
  };
}

const toPurchaseDto = (row: PurchaseRow): OrderDto => ({
  ...baseDto(row),
  type: "PURCHASE",
  isin: row.schemeIsin,
  schemeName: row.scheme?.name ?? null,
  purchaseType: row.type,
  amount: asAmount(row.amount),
  units: null,
  allottedUnits: asUnits(row.allottedUnits),
  allottedPrice: asNav(row.purchasedPrice),
  settledAmount: asAmount(row.purchasedAmount),
});

const toRedemptionDto = (row: RedemptionRow): OrderDto => ({
  ...baseDto(row),
  type: "REDEMPTION",
  isin: row.schemeIsin,
  schemeName: row.scheme?.name ?? null,
  amount: asAmount(row.amount),
  units: asUnits(row.units),
  allottedUnits: asUnits(row.redeemedUnits),
  allottedPrice: asNav(row.redeemedPrice),
  settledAmount: asAmount(row.redeemedAmount),
});

const toSwitchDto = (row: SwitchRow): OrderDto => ({
  ...baseDto(row),
  type: "SWITCH",
  isin: row.switchOutSchemeIsin,
  switchOutIsin: row.switchOutSchemeIsin,
  switchInIsin: row.switchInSchemeIsin,
  schemeName: row.switchOutScheme?.name ?? null,
  amount: asAmount(row.amount),
  units: asUnits(row.units),
  allottedUnits: asUnits(row.switchedOutUnits),
  allottedPrice: asNav(row.switchedOutPrice),
  settledAmount: asAmount(row.switchedOutAmount),
});

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

async function requireAccount(mfInvestmentAccountId: string) {
  const account = await db.mfInvestmentAccount.findUnique({
    where: { id: mfInvestmentAccountId },
    select: { id: true, fpId: true, fpOldId: true },
  });
  if (!account) throw HttpError.notFound("No such investment account");
  return account;
}

/**
 * The contact FP expects the 2FA OTP to have gone to.
 *
 * FP checks the consent against the folio's registered contact and rejects a
 * mismatch ("does not match with folio_defaults.communication_email_address").
 * So this is resolved from stored data, never from caller input — a caller who
 * could name the contact could route the OTP away from the investor.
 *
 * An order on an existing folio uses that folio's registered details; a fresh
 * purchase has no folio yet, so it uses the account's folio defaults.
 */
export async function resolveConsentContact(
  mfInvestmentAccountId: string,
  folioNumber: string | null,
): Promise<{ email: string; isdCode: string; mobile: string }> {
  if (folioNumber) {
    const folio = await db.mfFolio.findUnique({
      where: { mfInvestmentAccountId_number: { mfInvestmentAccountId, number: folioNumber } },
      select: { emailAddresses: true, mobileNumbers: true },
    });
    const email = folio?.emailAddresses[0];
    const mobile = folio?.mobileNumbers[0];
    if (email && mobile) {
      // Folio mobiles arrive in E.164 ("+919998886665"); FP wants the ISD and
      // the number as separate fields.
      const match = /^\+?(\d{1,3})(\d{10})$/.exec(mobile.replace(/[\s-]/g, ""));
      if (match) return { email, isdCode: match[1] ?? "91", mobile: match[2] ?? "" };
    }
    throw HttpError.conflict("Refresh the folio's registered contact details before requesting consent");
  }

  const defaults = await db.mfFolioDefaults.findUnique({
    where: { mfInvestmentAccountId },
    select: {
      communicationEmailAddress: { select: { email: true } },
      communicationPhoneNumber: { select: { isd: true, number: true } },
    },
  });

  const email = defaults?.communicationEmailAddress?.email;
  const phone = defaults?.communicationPhoneNumber;
  if (!email || !phone) {
    throw HttpError.badRequest(
      "This investment account has no communication email and mobile set. " +
        "Set folio defaults before placing an order.",
    );
  }
  return { email, isdCode: phone.isd.replace("+", ""), mobile: phone.number };
}

/**
 * Spend the OTP token and check it belongs to the investor being debited.
 *
 * Binding the token to the registered mobile is what stops a verified OTP for
 * one phone authorising an order on somebody else's folio.
 */
async function requireConsentProof(
  input: OrderConsentInput,
  contact: { isdCode: string; mobile: string },
  orderId: string,
): Promise<void> {
  const consumed = await consumeVerificationToken(input.verificationToken, `order:${orderId}`);
  if (consumed.purpose !== OtpPurpose.TRANSACTION_APPROVAL) {
    throw HttpError.badRequest("This verification was not issued for approving a transaction");
  }
  const verifiedDigits = consumed.phone.replace(/\D/g, "");
  const expectedDigits = `${contact.isdCode}${contact.mobile}`.replace(/\D/g, "");
  if (verifiedDigits !== expectedDigits) {
    throw HttpError.badRequest(
      "The verified number does not match the mobile registered against this folio",
    );
  }
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

export async function createPurchase(input: CreatePurchaseInput): Promise<OrderDto> {
  await assertInvestmentReady(input.mfInvestmentAccountId, input.folioNumber);
  const account = await requireAccount(input.mfInvestmentAccountId);
  await validatePurchase(input.isin, input.amount, Boolean(input.folioNumber));

  // FP rejects a repeat of a source_ref_id it has seen, which is what makes a
  // retried request safe. Generating one here means even a caller that forgets
  // to send one cannot accidentally place two orders from one click, as long as
  // it retries with the id we returned.
  const sourceRefId = input.sourceRefId ?? crypto.randomUUID();

  try {
    const created = await fpOrders.createPurchase({
      mf_investment_account: account.fpId,
      scheme: input.isin,
      amount: Number(input.amount),
      ...(input.folioNumber && { folio_number: input.folioNumber }),
      source_ref_id: sourceRefId,
      user_ip: input.userIp,
      ...(input.serverIp && { server_ip: input.serverIp }),
      ...(input.euin && { euin: input.euin }),
      ...(input.initiatedVia && { initiated_via: input.initiatedVia }),
      initiated_by: "investor",
      gateway: fpConfig().orderGateway,
    });
    await syncPurchase(created, account.id);
    return loadPurchase(created.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** Record the investor's 2FA consent. Must be sent alone, before payment. */
export async function recordPurchaseConsent(
  id: string,
  input: OrderConsentInput,
): Promise<OrderDto> {
  const order = await db.mfPurchase.findUnique({
    where: { id },
    select: { fpId: true, mfInvestmentAccountId: true, folioNumber: true, state: true },
  });
  if (!order) throw HttpError.notFound("No such order");
  if (order.state !== MfOrderState.PENDING) {
    throw HttpError.conflict(`Consent can only be recorded while the order is pending`, {
      state: order.state,
    });
  }

  const contact = await resolveConsentContact(order.mfInvestmentAccountId, order.folioNumber);
  await requireConsentProof(input, contact, id);

  try {
    const updated = await fpOrders.updatePurchase({
      id: order.fpId,
      consent: { email: contact.email, isd_code: contact.isdCode, mobile: contact.mobile },
    });
    await syncPurchase(updated, order.mfInvestmentAccountId);
    // FP does not echo a consent timestamp, so record ours: it is the audit
    // trail for the 2FA that SEBI requires.
    await db.mfPurchase.update({
      where: { id },
      data: {
        consentEmail: contact.email,
        consentIsdCode: contact.isdCode,
        consentMobile: contact.mobile,
        consentAt: new Date(),
      },
    });
    return loadPurchase(order.fpId);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** Final step: confirm, which is what submits the order to the gateway. */
export async function confirmPurchase(id: string): Promise<OrderDto> {
  const order = await db.mfPurchase.findUnique({
    where: { id },
    select: {
      id: true,
      fpId: true,
      mfInvestmentAccountId: true,
      state: true,
      gateway: true,
      consentAt: true,
      payments: {
        select: { payment: { select: { status: true } } },
      },
    },
  });
  if (!order) throw HttpError.notFound("No such order");

  // A payment that settles through FP can carry the order forward on its own,
  // so arriving here afterwards is not an error — report what it became.
  if (order.state !== MfOrderState.PENDING) {
    if (
      order.state === MfOrderState.CONFIRMED ||
      order.state === MfOrderState.SUBMITTED ||
      order.state === MfOrderState.SUCCESSFUL
    ) {
      return loadPurchase(order.fpId);
    }
    throw HttpError.conflict("Only a pending order can be confirmed", { state: order.state });
  }

  if (order.gateway !== OrderGateway.CYBRILLAPOA) {
    throw HttpError.conflict("Only ONDC orders can be confirmed", { gateway: order.gateway });
  }

  if (!order.consentAt) {
    throw HttpError.conflict("Record the investor's consent before confirming");
  }

  // FP refuses a confirm with no money behind it. Checking here turns an opaque
  // upstream 400 into something the client can act on.
  const hasLivePayment = order.payments.some(
    (link) =>
      link.payment.status !== PaymentStatus.FAILED &&
      link.payment.status !== PaymentStatus.REJECTED,
  );
  if (!hasLivePayment) {
    throw HttpError.conflict(
      "Create a payment for this order before confirming",
      { gateway: order.gateway },
    );
  }

  try {
    const updated = await fpOrders.updatePurchase({ id: order.fpId, state: "confirmed" });
    await syncPurchase(updated, order.mfInvestmentAccountId);
    return loadPurchase(order.fpId);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** Reopen a failed order for another payment attempt. */
export async function retryPurchase(id: string): Promise<OrderDto> {
  const order = await db.mfPurchase.findUnique({
    where: { id },
    select: { fpId: true, mfInvestmentAccountId: true, state: true },
  });
  if (!order) throw HttpError.notFound("No such order");
  if (order.state !== MfOrderState.FAILED) {
    throw HttpError.conflict("Only a failed order can be retried", { state: order.state });
  }
  try {
    const updated = await fpOrders.retryPurchase(order.fpId);
    await syncPurchase(updated, order.mfInvestmentAccountId);
    return loadPurchase(order.fpId);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function cancelPurchase(id: string): Promise<OrderDto> {
  const order = await db.mfPurchase.findUnique({
    where: { id },
    select: { fpId: true, mfInvestmentAccountId: true, state: true },
  });
  if (!order) throw HttpError.notFound("No such order");
  if (order.state !== MfOrderState.PENDING) {
    throw HttpError.conflict("Only a pending order can be cancelled", { state: order.state });
  }
  try {
    const updated = await fpOrders.cancelPurchase(order.fpId);
    await syncPurchase(updated, order.mfInvestmentAccountId);
    return loadPurchase(order.fpId);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

// ---------------------------------------------------------------------------
// Redemptions and switches
// ---------------------------------------------------------------------------

export async function createRedemption(input: CreateRedemptionInput): Promise<OrderDto> {
  await assertInvestmentReady(input.mfInvestmentAccountId, input.folioNumber);
  const account = await requireAccount(input.mfInvestmentAccountId);
  await validateRedemption(input.isin, input.amount, input.units);
  const sourceRefId = input.sourceRefId ?? crypto.randomUUID();

  try {
    const created = await fpOrders.createRedemption({
      mf_investment_account: account.fpId,
      scheme: input.isin,
      folio_number: input.folioNumber,
      // Omitting both is a real instruction: redeem the entire holding.
      ...(input.amount !== undefined && { amount: Number(input.amount) }),
      ...(input.units !== undefined && { units: Number(input.units) }),
      source_ref_id: sourceRefId,
      user_ip: input.userIp,
      ...(input.serverIp && { server_ip: input.serverIp }),
      ...(input.euin && { euin: input.euin }),
      ...(input.initiatedVia && { initiated_via: input.initiatedVia }),
      initiated_by: "investor",
      gateway: fpConfig().orderGateway,
    });
    await syncRedemption(created, account.id);
    return loadRedemption(created.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Confirm a redemption.
 *
 * Unlike a purchase this needs no settlement — the money flows the other way —
 * so consent and confirm can travel together, which the sandbox accepts.
 */
export async function confirmRedemption(
  id: string,
  input: OrderConsentInput,
): Promise<OrderDto> {
  const order = await db.mfRedemption.findUnique({
    where: { id },
    select: { fpId: true, mfInvestmentAccountId: true, folioNumber: true, state: true },
  });
  if (!order) throw HttpError.notFound("No such order");
  if (order.state !== MfOrderState.PENDING) {
    throw HttpError.conflict("Only a pending order can be confirmed", { state: order.state });
  }

  const contact = await resolveConsentContact(order.mfInvestmentAccountId, order.folioNumber);
  await requireConsentProof(input, contact, id);

  try {
    const updated = await fpOrders.updateRedemption({
      id: order.fpId,
      state: "confirmed",
      consent: { email: contact.email, isd_code: contact.isdCode, mobile: contact.mobile },
    });
    await syncRedemption(updated, order.mfInvestmentAccountId);
    await db.mfRedemption.update({
      where: { id },
      data: {
        consentEmail: contact.email,
        consentIsdCode: contact.isdCode,
        consentMobile: contact.mobile,
        consentAt: new Date(),
      },
    });
    return loadRedemption(order.fpId);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function createSwitch(input: CreateSwitchInput): Promise<OrderDto> {
  await assertInvestmentReady(input.mfInvestmentAccountId, input.folioNumber);
  const account = await requireAccount(input.mfInvestmentAccountId);
  await validateSwitch(input.switchOutIsin, input.switchInIsin, input.amount, input.units);
  const sourceRefId = input.sourceRefId ?? crypto.randomUUID();

  try {
    const created = await fpOrders.createSwitch({
      mf_investment_account: account.fpId,
      switch_out_scheme: input.switchOutIsin,
      switch_in_scheme: input.switchInIsin,
      folio_number: input.folioNumber,
      ...(input.amount !== undefined && { amount: Number(input.amount) }),
      ...(input.units !== undefined && { units: Number(input.units) }),
      source_ref_id: sourceRefId,
      user_ip: input.userIp,
      ...(input.serverIp && { server_ip: input.serverIp }),
      ...(input.euin && { euin: input.euin }),
      ...(input.initiatedVia && { initiated_via: input.initiatedVia }),
      initiated_by: "investor",
      gateway: fpConfig().orderGateway,
    });
    await syncSwitch(created, account.id);
    return loadSwitch(created.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function confirmSwitch(id: string, input: OrderConsentInput): Promise<OrderDto> {
  const order = await db.mfSwitch.findUnique({
    where: { id },
    select: { fpId: true, mfInvestmentAccountId: true, folioNumber: true, state: true },
  });
  if (!order) throw HttpError.notFound("No such order");
  if (order.state !== MfOrderState.PENDING) {
    throw HttpError.conflict("Only a pending order can be confirmed", { state: order.state });
  }

  const contact = await resolveConsentContact(order.mfInvestmentAccountId, order.folioNumber);
  await requireConsentProof(input, contact, id);

  try {
    const updated = await fpOrders.updateSwitch({
      id: order.fpId,
      state: "confirmed",
      consent: { email: contact.email, isd_code: contact.isdCode, mobile: contact.mobile },
    });
    await syncSwitch(updated, order.mfInvestmentAccountId);
    await db.mfSwitch.update({
      where: { id },
      data: {
        consentEmail: contact.email,
        consentIsdCode: contact.isdCode,
        consentMobile: contact.mobile,
        consentAt: new Date(),
      },
    });
    return loadSwitch(order.fpId);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadPurchase(fpId: string): Promise<OrderDto> {
  const row = await db.mfPurchase.findUnique({ where: { fpId }, select: purchaseSelect });
  if (!row) throw HttpError.notFound("No such order");
  return toPurchaseDto(row);
}

async function loadRedemption(fpId: string): Promise<OrderDto> {
  const row = await db.mfRedemption.findUnique({ where: { fpId }, select: redemptionSelect });
  if (!row) throw HttpError.notFound("No such order");
  return toRedemptionDto(row);
}

async function loadSwitch(fpId: string): Promise<OrderDto> {
  const row = await db.mfSwitch.findUnique({ where: { fpId }, select: switchSelect });
  if (!row) throw HttpError.notFound("No such order");
  return toSwitchDto(row);
}

export async function getOrder(id: string): Promise<OrderDto> {
  const purchase = await db.mfPurchase.findUnique({ where: { id }, select: purchaseSelect });
  if (purchase) return toPurchaseDto(purchase);
  const redemption = await db.mfRedemption.findUnique({ where: { id }, select: redemptionSelect });
  if (redemption) return toRedemptionDto(redemption);
  const switchOrder = await db.mfSwitch.findUnique({ where: { id }, select: switchSelect });
  if (switchOrder) return toSwitchDto(switchOrder);
  throw HttpError.notFound("No such order");
}

/**
 * Re-read an order from FP.
 *
 * Webhooks are the normal path; this is for when the investor is staring at a
 * screen and will not wait for one.
 */
export async function refreshOrder(id: string): Promise<OrderDto> {
  const purchase = await db.mfPurchase.findUnique({
    where: { id },
    select: { fpId: true, mfInvestmentAccountId: true },
  });
  if (purchase) {
    try {
      const fresh = await fpOrders.fetchPurchase(purchase.fpId);
      await syncPurchase(fresh, purchase.mfInvestmentAccountId);
      return loadPurchase(purchase.fpId);
    } catch (error) {
      fpErrorToHttpError(error);
    }
  }

  const redemption = await db.mfRedemption.findUnique({
    where: { id },
    select: { fpId: true, mfInvestmentAccountId: true },
  });
  if (redemption) {
    try {
      const fresh = await fpOrders.fetchRedemption(redemption.fpId);
      await syncRedemption(fresh, redemption.mfInvestmentAccountId);
      return loadRedemption(redemption.fpId);
    } catch (error) {
      fpErrorToHttpError(error);
    }
  }

  const switchOrder = await db.mfSwitch.findUnique({
    where: { id },
    select: { fpId: true, mfInvestmentAccountId: true },
  });
  if (switchOrder) {
    try {
      const fresh = await fpOrders.fetchSwitch(switchOrder.fpId);
      await syncSwitch(fresh, switchOrder.mfInvestmentAccountId);
      return loadSwitch(switchOrder.fpId);
    } catch (error) {
      fpErrorToHttpError(error);
    }
  }

  throw HttpError.notFound("No such order");
}

/**
 * Every order on an account, newest first.
 *
 * Three tables merged in memory rather than a UNION: the page size is small,
 * an investor's order history is bounded, and keeping the query per-table lets
 * each one use its own `(account, created)` index.
 */
export async function listOrders(
  mfInvestmentAccountId: string,
  limit: number,
): Promise<OrderDto[]> {
  const take = Math.min(Math.max(limit, 1), 100);
  const where = { mfInvestmentAccountId };
  const orderBy = { fpCreatedAt: "desc" } as const;

  const [purchases, redemptions, switches] = await Promise.all([
    db.mfPurchase.findMany({ where, select: purchaseSelect, orderBy, take }),
    db.mfRedemption.findMany({ where, select: redemptionSelect, orderBy, take }),
    db.mfSwitch.findMany({ where, select: switchSelect, orderBy, take }),
  ]);

  return [
    ...purchases.map(toPurchaseDto),
    ...redemptions.map(toRedemptionDto),
    ...switches.map(toSwitchDto),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, take);
}
