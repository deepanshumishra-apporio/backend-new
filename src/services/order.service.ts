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
import { FpApiError, fpConfig, fpErrorToHttpError, fpOrders } from "../integrations/fp/index.ts";
import { HttpError } from "../utils/http-error.ts";
import { asAmount, asDate, asNav, asUnits } from "../utils/money.ts";
import { consumeVerificationToken } from "./otp.service.ts";
import { syncPayoutDetail, syncPurchase, syncRedemption, syncSwitch } from "./fp-sync/index.ts";
import {
  assertRedeemable,
  validatePurchase,
  validateRedemption,
  validateSwitch,
} from "./scheme-rules.service.ts";
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
  submittedAt: true,
  succeededAt: true,
  createdAt: true,
} as const;

const purchaseSelect = {
  ...orderSelect,
  schemeIsin: true,
  type: true,
  planId: true,
  amount: true,
  allottedUnits: true,
  purchasedAmount: true,
  purchasedPrice: true,
  allottedNavDate: true,
  scheme: { select: { name: true } },
} as const;

const redemptionSelect = {
  ...orderSelect,
  schemeIsin: true,
  planId: true,
  redemptionMode: true,
  amount: true,
  units: true,
  redeemedUnits: true,
  redeemedAmount: true,
  redeemedPrice: true,
  redeemedNavDate: true,
  scheme: { select: { name: true } },
  // Where the proceeds actually landed. Only ever populated once the registrar
  // has paid out, and it is the only place the UTR exists — an investor
  // chasing "the fund says it paid, my bank disagrees" has nothing else.
  payoutDetail: {
    select: {
      amount: true,
      utrNumber: true,
      bankAccountNumberMasked: true,
      bankIfsc: true,
      bankName: true,
      paidAt: true,
    },
  },
} as const;

const switchSelect = {
  ...orderSelect,
  switchOutSchemeIsin: true,
  switchInSchemeIsin: true,
  planId: true,
  amount: true,
  units: true,
  switchedOutUnits: true,
  switchedOutAmount: true,
  switchedOutPrice: true,
  // A switch is a redemption and a purchase in one instruction, and the half
  // the investor actually cares about is what they now own in the target
  // scheme. Reporting only the switch-out side describes money leaving and
  // never arriving.
  switchedInUnits: true,
  switchedInAmount: true,
  switchedInPrice: true,
  switchOutScheme: { select: { name: true } },
  switchInScheme: { select: { name: true } },
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
    // The gateway handed it to the registrar. Distinct from `confirmedAt` —
    // between the two the order is FP's, after it the registrar's — which is
    // the difference the lifecycle view turns into two separate stages.
    submittedAt: row.submittedAt?.toISOString() ?? null,
    succeededAt: row.succeededAt?.toISOString() ?? null,
  };
}

const toPurchaseDto = (row: PurchaseRow): OrderDto => ({
  ...baseDto(row),
  type: "PURCHASE",
  isin: row.schemeIsin,
  schemeName: row.scheme?.name ?? null,
  purchaseType: row.type,
  planId: row.planId,
  allottedNavDate: asDate(row.allottedNavDate),
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
  planId: row.planId,
  redemptionMode: row.redemptionMode,
  amount: asAmount(row.amount),
  units: asUnits(row.units),
  allottedUnits: asUnits(row.redeemedUnits),
  allottedPrice: asNav(row.redeemedPrice),
  allottedNavDate: asDate(row.redeemedNavDate),
  settledAmount: asAmount(row.redeemedAmount),
  payout: row.payoutDetail
    ? {
        amount: asAmount(row.payoutDetail.amount),
        utrNumber: row.payoutDetail.utrNumber,
        bankName: row.payoutDetail.bankName,
        bankAccountNumberMasked: row.payoutDetail.bankAccountNumberMasked,
        bankIfsc: row.payoutDetail.bankIfsc,
        paidAt: row.payoutDetail.paidAt?.toISOString() ?? null,
      }
    : null,
});

const toSwitchDto = (row: SwitchRow): OrderDto => ({
  ...baseDto(row),
  type: "SWITCH",
  isin: row.switchOutSchemeIsin,
  switchOutIsin: row.switchOutSchemeIsin,
  switchInIsin: row.switchInSchemeIsin,
  schemeName: row.switchOutScheme?.name ?? null,
  switchInSchemeName: row.switchInScheme?.name ?? null,
  planId: row.planId,
  amount: asAmount(row.amount),
  units: asUnits(row.units),
  allottedUnits: asUnits(row.switchedOutUnits),
  allottedPrice: asNav(row.switchedOutPrice),
  settledAmount: asAmount(row.switchedOutAmount),
  switchedInUnits: asUnits(row.switchedInUnits),
  switchedInAmount: asAmount(row.switchedInAmount),
  switchedInPrice: asNav(row.switchedInPrice),
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
): Promise<ConsentContact> {
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

export interface ConsentContact {
  email: string;
  isdCode: string;
  mobile: string;
}

/**
 * Send a consent, dropping the mobile if FP will not accept it.
 *
 * FP validates the consent mobile against the number the registrar holds and
 * rejects a mismatch with `consent.mobile: investor's mobile number is
 * invalid`. That is fatal today: the order sits at `pending` until it expires,
 * and no amount of retrying with the same — correct, registered — number will
 * ever get past it.
 *
 * Email alone is a legitimate consent. FP's own rule is "either email or mobile
 * or both", and the 2FA that SEBI actually requires happened on our side
 * before this: `requireConsentProof` has already spent an OTP verified against
 * the folio's registered mobile. So the mobile in this payload is FP's record
 * of where the OTP went, not the OTP itself, and dropping it loses nothing that
 * protects the investor.
 *
 * Tried with the mobile first, every time. The fallback is for the accounts FP
 * refuses, not a way to stop sending the number.
 */
export async function sendConsent<T>(
  contact: ConsentContact,
  send: (consent: { email: string; isd_code?: string; mobile?: string }) => Promise<T>,
): Promise<T> {
  try {
    return await send({ email: contact.email, isd_code: contact.isdCode, mobile: contact.mobile });
  } catch (error) {
    if (!rejectedTheMobile(error)) throw error;
    return await send({ email: contact.email });
  }
}

/** Did FP reject this specifically because of the consent mobile? */
function rejectedTheMobile(error: unknown): boolean {
  return (
    error instanceof FpApiError &&
    error.isClientError &&
    error.fieldErrors.some((field) => field.field.toLowerCase().includes("consent.mobile"))
  );
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
      gateway: input.gateway ?? fpConfig().orderGateway,
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
    const updated = await sendConsent(contact, (consent) =>
      fpOrders.updatePurchase({ id: order.fpId, consent }),
    );
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
      folioNumber: true,
      state: true,
      gateway: true,
      consentAt: true,
      payments: {
        select: { payment: { select: { status: true } } },
      },
    },
  });
  if (!order) throw HttpError.notFound("No such order");

  if (fpConfig().simulationEnabled && order.gateway === OrderGateway.RTA) {
    if (order.state === MfOrderState.SUCCESSFUL) return loadPurchase(order.fpId);
    if (order.state !== MfOrderState.PENDING && order.state !== MfOrderState.CONFIRMED && order.state !== MfOrderState.SUBMITTED) {
      throw HttpError.conflict("This order cannot be confirmed", { state: order.state });
    }
    if (!order.consentAt) throw HttpError.conflict("Record the investor's consent before confirming");
    await assertInvestmentReady(order.mfInvestmentAccountId, order.folioNumber);
    const { settlePurchase } = await import("./sandbox-settle.service.ts");
    return settlePurchase(id);
  }

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

  await assertInvestmentReady(order.mfInvestmentAccountId, order.folioNumber);

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

/**
 * The only two failures FP will reopen an order for.
 *
 * Everything else — a rejection at the registrar, a bank that would not verify,
 * the gateway's own refusal — is a verdict on the order, not on the attempt.
 * Retrying those re-submits the identical instruction to the thing that just
 * refused it, so FP declines and the investor learns nothing.
 */
const RETRYABLE_FAILURES = new Set(["payment_failure", "order_expiry"]);

/**
 * Reopen a failed order for another payment attempt.
 *
 * **Not available on this platform.** FP documents retry as "an upcoming
 * facility for ondc gateway purchases … not available in sandbox or production
 * yet", and we run exclusively on ONDC. FP's own answer is
 * `400 "Order is not eligible for retry"`, which reads as though this
 * particular order were the problem — so the refusal is made here, where it can
 * say what is actually true and what to do instead.
 *
 * The eligibility rules below are FP's, kept for the day the facility ships:
 * `payment_failure` while the expiry window is still open, or `order_expiry` on
 * an order that is not a plan installment. They are checked before the gateway
 * so that a caller retrying an unretryable failure is told the real reason
 * rather than a blanket "not on this route".
 */
export async function retryPurchase(id: string): Promise<OrderDto> {
  const order = await db.mfPurchase.findUnique({
    where: { id },
    select: {
      fpId: true,
      mfInvestmentAccountId: true,
      state: true,
      gateway: true,
      planId: true,
      failureCode: true,
    },
  });
  if (!order) throw HttpError.notFound("No such order");
  if (order.state !== MfOrderState.FAILED) {
    throw HttpError.conflict("Only a failed order can be retried", { state: order.state });
  }

  const failureCode = order.failureCode?.toLowerCase() ?? null;
  if (!failureCode || !RETRYABLE_FAILURES.has(failureCode)) {
    throw HttpError.conflict(
      "This order cannot be retried — it did not fail for a reason another attempt would fix. Place a new order instead.",
      { failureCode: order.failureCode, retryable: false },
    );
  }
  // A systematic plan's installment is FP's to regenerate, not ours to reopen.
  if (failureCode === "order_expiry" && order.planId) {
    throw HttpError.conflict(
      "An expired plan installment cannot be retried — the plan places the next one on its own schedule",
      { failureCode: order.failureCode, planId: order.planId },
    );
  }

  if (order.gateway === OrderGateway.CYBRILLAPOA) {
    throw HttpError.conflict(
      "Retrying an order is not supported on this route yet. Place a new order instead.",
      { gateway: order.gateway, retryable: false },
    );
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
  // FP's step 3: the folio must actually be able to give up what is asked.
  await assertRedeemable(
    account.id,
    input.folioNumber,
    input.isin,
    input.amount,
    input.units,
  );
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
      gateway: input.gateway ?? fpConfig().orderGateway,
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
    select: { fpId: true, mfInvestmentAccountId: true, folioNumber: true, state: true, gateway: true },
  });
  if (!order) throw HttpError.notFound("No such order");
  if (order.state !== MfOrderState.PENDING) {
    throw HttpError.conflict("Only a pending order can be confirmed", { state: order.state });
  }

  const contact = await resolveConsentContact(order.mfInvestmentAccountId, order.folioNumber);
  await requireConsentProof(input, contact, id);

  if (fpConfig().simulationEnabled && order.gateway === OrderGateway.RTA) {
    const { settleRedemption } = await import("./sandbox-settle.service.ts");
    return settleRedemption(id);
  }

  try {
    const updated = await sendConsent(contact, (consent) =>
      fpOrders.updateRedemption({ id: order.fpId, state: "confirmed", consent }),
    );
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
  // A switch redeems from the source scheme, so the same eligibility applies.
  await assertRedeemable(
    account.id,
    input.folioNumber,
    input.switchOutIsin,
    input.amount,
    input.units,
  );
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
      gateway: input.gateway ?? fpConfig().orderGateway,
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
    const updated = await sendConsent(contact, (consent) =>
      fpOrders.updateSwitch({ id: order.fpId, state: "confirmed", consent }),
    );
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

/**
 * Pull the payout FP recorded against a redemption.
 *
 * This is the last hop of a redemption and the only one that talks about the
 * investor's bank rather than the fund: `redeemed_amount` says what the AMC
 * paid out, the payout detail says which account it reached and under what
 * UTR. Nothing announces it — there is no `mf_payout_detail` webhook — so it is
 * pulled whenever a redemption is read back and has succeeded.
 *
 * Never fatal. A redemption that succeeded is still a redemption that
 * succeeded if the payout has not been filed yet, and FP returns an empty list
 * for the whole window between allotment and the money actually moving.
 */
export async function pullRedemptionPayout(
  localId: string,
  fpId: string,
): Promise<void> {
  try {
    const [payout] = await fpOrders.listPayoutDetails(fpId);
    if (payout) await syncPayoutDetail(payout, localId);
  } catch (error) {
    console.warn(
      `[order] payout lookup failed for redemption ${fpId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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
      const row = await syncRedemption(fresh, redemption.mfInvestmentAccountId);
      // Only once the units are gone: before that FP has nothing to report and
      // the call is a wasted round trip on every poll of a pending order.
      if (fresh.state === "successful") await pullRedemptionPayout(row.id, redemption.fpId);
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
 * The installments a plan has actually placed.
 *
 * A plan is an instruction; its installments are ordinary orders that succeed
 * or fail on their own, which is why they live in the order tables with a
 * `planId` rather than inside the plan. An investor asking "did my SWP pay out
 * this month" is asking about these, and nothing else answers it — the plan
 * itself only says when the next one is due.
 *
 * Which table depends on the plan: a SIP generates purchases, an SWP
 * redemptions, an STP switches. The three plan tables share an id space, so
 * all three are asked and at most one answers. Querying only purchases — as
 * this did — reported every SWP and STP as having never paid out at all.
 */
export async function listPlanInstallments(planId: string): Promise<OrderDto[]> {
  const where = { planId };
  const orderBy = { fpCreatedAt: "desc" } as const;
  const take = 100;

  const [purchases, redemptions, switches] = await Promise.all([
    db.mfPurchase.findMany({ where, select: purchaseSelect, orderBy, take }),
    db.mfRedemption.findMany({ where, select: redemptionSelect, orderBy, take }),
    db.mfSwitch.findMany({ where, select: switchSelect, orderBy, take }),
  ]);

  return [
    ...purchases.map(toPurchaseDto),
    ...redemptions.map(toRedemptionDto),
    ...switches.map(toSwitchDto),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
