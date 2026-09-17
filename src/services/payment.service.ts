// Mandates and payments.
//
// Two things about FP's payment gateway drive the shape of this file:
//
//  1. It addresses everything by the legacy INTEGER id — a bank account's
//     `fpOldId`, a purchase's `fpOldId`. Passing the `bac_…` or `mfp_…` string
//     fails, so every call here resolves the integer first and refuses to
//     proceed without one.
//  2. It does NOT check whether a payment already exists for an order. Nothing
//     upstream stops us debiting an investor twice for the same purchase, so
//     that check lives here and is not optional.
import {
  MandateStatus,
  MfOrderState,
  PaymentStatus,
} from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import {
  FpApiError,
  FpTransportError,
  fpConfig,
  fpErrorToHttpError,
  fpPayments,
  fpSimulation,
} from "../integrations/fp/index.ts";
import { HttpError } from "../utils/http-error.ts";
import { asAmount, asDate, istToday } from "../utils/money.ts";
import { syncMandate, syncPayment } from "./fp-sync/index.ts";
import {
  assertInvestmentReady,
  bankIsVerified,
  payoutVerificationRequired,
} from "./investor-readiness.service.ts";

function requireOndcProvider(provider?: string): void {
  if (provider !== undefined && provider !== "CYBRILLAPOA") throw HttpError.badRequest("Only CYBRILLAPOA payments are supported");
}

/**
 * Stake a claim on these orders before anything is sent to FP.
 *
 * The row is the record that a payment request for this order left the
 * building. It is written first and deliberately never rolled back on an
 * unknown outcome: if the request may have reached FP, a second attempt could
 * debit the investor twice, and a stuck claim needing an operator is strictly
 * better than a double debit.
 *
 * Sorted, because two concurrent multi-order payments that overlap would
 * otherwise be able to deadlock each other taking the same rows in
 * different orders.
 */
async function claimPayment(orderIds: string[]): Promise<void> {
  try {
    await db.$transaction(async tx => {
      for (const orderId of [...orderIds].sort()) await tx.paymentSubmission.create({ data: { orderId } });
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw HttpError.conflict("A payment was already submitted or has an unknown outcome; refresh or reconcile it before retrying");
    }
    throw error;
  }
}

/**
 * Give the claim back when FP definitively did not create a payment.
 *
 * "Unknown outcome" is the case the claim exists for, and it is narrower than
 * "the call threw". FP answering 4xx means it received the request, rejected it
 * and created nothing — as does a guard in our own transport that fires before
 * the request is sent. Keeping the claim in those cases permanently bricks an
 * order that nothing ever charged: a misconfigured provider, or one bad field,
 * would leave every order it touched unpayable and awaiting an operator.
 *
 * A transport error is the opposite — no response arrived, FP may well have
 * created the payment — so the claim stays and the order waits for a human.
 */
async function releaseClaimIfNothingHappened(orderIds: string[], error: unknown): Promise<void> {
  const definitelyRejected =
    error instanceof FpApiError
      ? error.isClientError
      : // Anything that is not an FP error at all never reached the network:
        // the transport's own guards throw plain Errors before sending.
        !(error instanceof FpTransportError);
  if (!definitelyRejected) return;
  await db.paymentSubmission.deleteMany({ where: { orderId: { in: orderIds }, fpPaymentId: null } });
}

async function recordSubmittedPayment(orderIds: string[], fpPaymentId: number): Promise<void> {
  await db.paymentSubmission.updateMany({ where: { orderId: { in: orderIds } }, data: { fpPaymentId } });
}
import type {
  CreateMandateInput,
  MandateAuthDto,
  MandateDto,
  PaymentDto,
  PayOrdersInput,
} from "../types/payment.types.ts";

/** Payment statuses from which no further money movement will happen. */
const TERMINAL_PAYMENT_STATUSES = [PaymentStatus.FAILED, PaymentStatus.REJECTED];

const mandateSelect = {
  id: true,
  fpId: true,
  mandateType: true,
  mandateStatus: true,
  mandateLimit: true,
  umrn: true,
  validFrom: true,
  validTo: true,
  providerName: true,
  rejectedReason: true,
  approvedAt: true,
  createdAt: true,
  fpCreatedAt: true,
  bankAccount: {
    select: { id: true, bankName: true, accountNumberLast4: true, ifscCode: true },
  },
} as const;

function toMandateDto(row: {
  id: string;
  fpId: number;
  mandateType: string;
  mandateStatus: string;
  mandateLimit: unknown;
  umrn: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  providerName: string | null;
  rejectedReason: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  fpCreatedAt: Date | null;
  bankAccount: {
    id: string;
    bankName: string | null;
    accountNumberLast4: string;
    ifscCode: string;
  };
}): MandateDto {
  return {
    id: row.id,
    fpId: row.fpId,
    type: row.mandateType,
    status: row.mandateStatus,
    limit: asAmount(row.mandateLimit as never),
    umrn: row.umrn,
    validFrom: asDate(row.validFrom),
    validTo: asDate(row.validTo),
    provider: row.providerName,
    rejectedReason: row.rejectedReason,
    bankAccount: {
      id: row.bankAccount.id,
      bankName: row.bankAccount.bankName,
      accountNumberLast4: row.bankAccount.accountNumberLast4,
      ifscCode: row.bankAccount.ifscCode,
    },
    usableForPlans: row.mandateStatus === MandateStatus.APPROVED,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: (row.fpCreatedAt ?? row.createdAt).toISOString(),
  };
}

/**
 * Register a mandate against one of the investor's bank accounts.
 *
 * The provider is always sent, never left to FP: its tenant default fails
 * outright with "Unexpected value: ONDC", which is a confusing error for
 * something we can decide correctly ourselves. It must also match the order
 * gateway, or a plan funded by this mandate is rejected with "Mandate passed is
 * incorrect, pass correct mandate for order gateway …".
 */
export async function createMandate(input: CreateMandateInput): Promise<MandateDto> {
  requireOndcProvider(input.providerName);
  // Same policy as every other money path — see investor-readiness.service.ts.
  // Checking it here and not there would leave one endpoint enforcing a
  // penny-drop the deployment has been told not to require.
  if (payoutVerificationRequired() && !(await bankIsVerified(input.bankAccountId))) {
    throw HttpError.conflict("Verify this bank account before creating a mandate");
  }
  const bankAccount = await db.bankAccount.findUnique({
    where: { id: input.bankAccountId },
    select: { id: true, fpOldId: true },
  });
  if (!bankAccount) throw HttpError.notFound("No such bank account");
  if (bankAccount.fpOldId === null) {
    // Without the integer id there is no way to address the account here.
    throw HttpError.conflict(
      "This bank account has not finished syncing with the payment gateway",
    );
  }

  try {
    const { id: fpId } = await fpPayments.createMandate({
      mandate_type: input.mandateType,
      bank_account_id: bankAccount.fpOldId,
      mandate_limit: Number(input.mandateLimit),
      // Fixed, not taken from the caller: there is one gateway, and the
      // mandates half of the API knows it by this name only.
      provider_name: fpPayments.ONDC_MANDATE_PROVIDER,
      ...(input.validFrom && { valid_from: input.validFrom }),
      ...(input.validTo && { valid_to: input.validTo }),
    });

    // Create returns only the id, so read the object back to mirror it.
    const mandate = await fpPayments.fetchMandate(fpId);
    const row = await syncMandate(mandate);
    return getMandate(row.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Get the URL the investor must visit to authorise the mandate.
 *
 * Several authorisations can run against one mandate while it is still in
 * CREATED, so an abandoned attempt is recoverable — ask for a new URL rather
 * than trying to resume the old one, which expires.
 */
export async function authorizeMandate(
  id: string,
  postbackUrl?: string,
): Promise<MandateAuthDto> {
  const mandate = await db.mandate.findUnique({
    where: { id },
    select: { fpId: true, mandateStatus: true },
  });
  if (!mandate) throw HttpError.notFound("No such mandate");
  if (mandate.mandateStatus === MandateStatus.APPROVED) {
    throw HttpError.conflict("This mandate is already approved");
  }
  if (mandate.mandateStatus === MandateStatus.CANCELLED) {
    throw HttpError.conflict("A cancelled mandate cannot be authorised again");
  }

  try {
    const auth = await fpPayments.authorizeMandate({
      mandate_id: mandate.fpId,
      ...(postbackUrl && { payment_postback_url: postbackUrl }),
    });
    return { mandateId: id, paymentId: auth.id, authorizationUrl: auth.token_url };
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function getMandate(id: string): Promise<MandateDto> {
  const row = await db.mandate.findUnique({ where: { id }, select: mandateSelect });
  if (!row) throw HttpError.notFound("No such mandate");
  return toMandateDto(row);
}

export async function listMandates(investorProfileId: string): Promise<MandateDto[]> {
  const rows = await db.mandate.findMany({
    where: { bankAccount: { investorProfileId } },
    select: mandateSelect,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toMandateDto);
}

/** Pull the current state from FP — used after the investor returns from the
 *  provider page, when waiting for a webhook would mean staring at a spinner. */
export async function refreshMandate(id: string): Promise<MandateDto> {
  const mandate = await db.mandate.findUnique({ where: { id }, select: { fpId: true } });
  if (!mandate) throw HttpError.notFound("No such mandate");
  try {
    const fresh = await fpPayments.fetchMandate(mandate.fpId);
    await syncMandate(fresh);
    return getMandate(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Sandbox only: drive a mandate to the state a real bank would have produced.
 *
 * Nothing in the sandbox reaches a bank, so a mandate created here stays
 * CREATED for ever and no UMRN is ever issued — which leaves every SIP path
 * untestable, because a plan can only be funded by an APPROVED mandate.
 *
 * `fpSimulation` refuses to run unless FP's own base URL is the sandbox host
 * *and* `NODE_ENV` is not production, so this cannot be turned on by a stray
 * environment variable. The route in front of it answers 404 off the same flag,
 * so outside the sandbox this endpoint does not appear to exist at all.
 */
export const mandateSimulationAvailable = (): boolean => fpConfig().simulationEnabled;

export async function simulateMandateSettlement(
  id: string,
  status: "APPROVED" | "REJECTED" = "APPROVED",
): Promise<MandateDto> {
  const mandate = await db.mandate.findUnique({
    where: { id },
    select: { fpId: true, mandateStatus: true },
  });
  if (!mandate) throw HttpError.notFound("No such mandate");
  if (mandate.mandateStatus === MandateStatus.APPROVED) return getMandate(id);
  try {
    await fpSimulation.simulateMandate(mandate.fpId, status);
    // Read it back rather than assuming: the UMRN is issued by FP during the
    // transition, and it is the whole point of doing this.
    const fresh = await fpPayments.fetchMandate(mandate.fpId);
    await syncMandate(fresh);
    return getMandate(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Cancel an approved mandate.
 *
 * This is not a quiet operation: FP marks the future payments of every SIP
 * still funded by this mandate as FAILED. The count of affected plans comes
 * back so the caller can warn the investor first.
 */
export async function cancelMandate(id: string): Promise<MandateDto> {
  const mandate = await db.mandate.findUnique({
    where: { id },
    select: { fpId: true, mandateStatus: true },
  });
  if (!mandate) throw HttpError.notFound("No such mandate");
  if (mandate.mandateStatus !== MandateStatus.APPROVED) {
    throw HttpError.conflict("Only an approved mandate can be cancelled", {
      status: mandate.mandateStatus,
    });
  }

  try {
    const cancelled = await fpPayments.cancelMandate(mandate.fpId);
    await syncMandate(cancelled);
    return getMandate(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** Plans that would stop working if this mandate were cancelled. */
export async function plansFundedByMandate(id: string): Promise<number> {
  return db.mfPurchasePlan.count({
    where: { mandateId: id, state: { in: ["ACTIVE", "CREATED"] } },
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const paymentSelect = {
  id: true,
  fpId: true,
  paymentType: true,
  method: true,
  status: true,
  amount: true,
  debitDate: true,
  provider: true,
  failureCode: true,
  failedReason: true,
  tokenUrl: true,
  createdAt: true,
  fpCreatedAt: true,
  settledAt: true,
  purchases: { select: { mfPurchaseId: true } },
} as const;

function toPaymentDto(row: {
  id: string;
  fpId: number;
  paymentType: string;
  method: string | null;
  status: string;
  amount: unknown;
  debitDate: Date | null;
  provider: string | null;
  failureCode: string | null;
  failedReason: string | null;
  tokenUrl: string | null;
  createdAt: Date;
  fpCreatedAt: Date | null;
  settledAt: Date | null;
  purchases: { mfPurchaseId: string }[];
}): PaymentDto {
  return {
    id: row.id,
    fpId: row.fpId,
    type: row.paymentType,
    method: row.method,
    status: row.status,
    amount: asAmount(row.amount as never),
    debitDate: asDate(row.debitDate),
    provider: row.provider,
    failureCode: row.failureCode,
    failureReason: row.failedReason,
    paymentUrl: row.tokenUrl,
    orderIds: row.purchases.map((link) => link.mfPurchaseId),
    createdAt: (row.fpCreatedAt ?? row.createdAt).toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}

/**
 * Refuse to pay for an order that already has a live payment.
 *
 * FP performs no such check, so without this a double-tapped button debits the
 * investor twice for one purchase.
 */
async function assertNotAlreadyPaid(mfPurchaseIds: string[]): Promise<void> {
  const live = await db.paymentPurchase.findFirst({
    where: {
      mfPurchaseId: { in: mfPurchaseIds },
      payment: { status: { notIn: TERMINAL_PAYMENT_STATUSES } },
    },
    select: { mfPurchaseId: true, payment: { select: { id: true, status: true } } },
  });
  if (live) {
    throw HttpError.conflict("A payment is already in progress for this order", {
      orderId: live.mfPurchaseId,
      paymentId: live.payment.id,
      paymentStatus: live.payment.status,
    });
  }
}

/** Resolve our order ids to the integer ids the payment gateway understands. */
async function resolvePayableOrders(mfPurchaseIds: string[]) {
  if (mfPurchaseIds.length === 0) throw HttpError.badRequest("No orders given");
  if (mfPurchaseIds.length > 10) {
    throw HttpError.badRequest("At most ten orders can share one payment");
  }

  const orders = await db.mfPurchase.findMany({
    where: { id: { in: mfPurchaseIds } },
    select: { id: true, fpOldId: true, state: true, gateway: true, mfInvestmentAccountId: true, consentAt: true, folioNumber: true, amount: true },
  });
  if (orders.length !== mfPurchaseIds.length) throw HttpError.notFound("Unknown order");
  if (orders.some(order => order.gateway !== "CYBRILLAPOA" || !order.consentAt)) throw HttpError.conflict("Only consented ONDC orders can be paid");
  // This API creates single orders. Batch checkout requires FP batch-order creation.
  if (orders.length !== 1) throw HttpError.badRequest("Use one order per payment; batch-order creation is not exposed");
  for (const order of orders) await assertInvestmentReady(order.mfInvestmentAccountId, order.folioNumber);

  const notPending = orders.filter((order) => order.state !== MfOrderState.PENDING);
  if (notPending.length > 0) {
    // An ONDC order sits in `under_review` until FP's asynchronous review
    // passes, and is not payable until then. Saying so beats "not pending",
    // because the caller's correct response is to wait and retry, not to give
    // up on the order.
    const underReview = notPending.filter((o) => o.state === MfOrderState.UNDER_REVIEW);
    throw HttpError.conflict(
      underReview.length > 0
        ? "This order is still under review by the gateway; retry once it is pending"
        : "Only pending orders can be paid for",
      { orders: notPending.map((order) => ({ id: order.id, state: order.state })) },
    );
  }

  // FP requires every order in one payment to sit on the same account.
  const accounts = new Set(orders.map((order) => order.mfInvestmentAccountId));
  if (accounts.size > 1) {
    throw HttpError.badRequest("All orders in one payment must belong to one investment account");
  }

  const missingOldId = orders.filter((order) => order.fpOldId === null);
  if (missingOldId.length > 0) {
    throw HttpError.conflict("Some orders have not finished syncing with the payment gateway");
  }

  return orders.map((order) => ({ ...order, fpOldId: order.fpOldId as number }));
}

/**
 * The account an investor pays from when the caller names none.
 *
 * The payout account first — it is the one already registered against the
 * folio — then any account on the profile, so an investor who has added a bank
 * but not yet chosen a payout default can still pay.
 */
async function defaultPayingAccount(mfInvestmentAccountId: string): Promise<string | null> {
  const account = await db.mfInvestmentAccount.findUnique({
    where: { id: mfInvestmentAccountId },
    select: { primaryInvestorProfileId: true, folioDefaults: { select: { payoutBankAccountId: true } } },
  });
  if (!account) return null;
  if (account.folioDefaults?.payoutBankAccountId) return account.folioDefaults.payoutBankAccountId;
  const any = await db.bankAccount.findFirst({
    where: { investorProfileId: account.primaryInvestorProfileId, fpOldId: { not: null } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return any?.id ?? null;
}

/**
 * Collect payment by netbanking or UPI. The investor completes it at
 * `paymentUrl`, and FP confirms the order itself once the money arrives.
 */
export async function payByNetbanking(input: PayOrdersInput): Promise<PaymentDto> {
  requireOndcProvider(input.providerName);
  const orders = await resolvePayableOrders(input.orderIds);
  await assertNotAlreadyPaid(input.orderIds);

  // The ONDC half of /api/pg requires the debiting account and answers a bare
  // 422 "Bank Account Id could not be null" without it — which reaches the
  // investor as an internal error on the one screen where they are trying to
  // pay. The account they are paying from is not really the caller's choice
  // anyway: it is the one registered on the investment account, so fall back to
  // it rather than making every caller remember to send it.
  const bankAccountId = input.bankAccountId ?? (await defaultPayingAccount(orders[0]!.mfInvestmentAccountId));
  if (!bankAccountId) {
    throw HttpError.conflict(
      "This investment account has no bank account to pay from — add one, or set a payout bank account, before paying by netbanking",
    );
  }

  const bankAccount = await db.bankAccount.findUnique({
    where: { id: bankAccountId },
    select: { fpOldId: true, investorProfileId: true },
  });
  if (!bankAccount?.fpOldId) throw HttpError.badRequest("Invalid payment bank account");
  const account = await db.mfInvestmentAccount.findUniqueOrThrow({ where: { id: orders[0]!.mfInvestmentAccountId }, select: { primaryInvestorProfileId: true } });
  if (bankAccount.investorProfileId !== account.primaryInvestorProfileId) throw HttpError.badRequest("Payment bank account must belong to the order investor");
  if (payoutVerificationRequired() && !(await bankIsVerified(bankAccountId))) {
    throw HttpError.conflict("Verify the selected bank account before making a payment");
  }
  await claimPayment(input.orderIds);

  try {
    const created = await createNetbankingWithRetry({
      amc_order_ids: orders.map((order) => order.fpOldId),
      // Mandatory on the ONDC provider, and its absence is reported terribly:
      // FP answers `400 "payment method has to present for ondc provider"`, or
      // in some combinations the actively misleading
      // `422 "Provider ONDC not configured"`, which reads as though the whole
      // gateway were switched off. NETBANKING is the default because it is the
      // one every bank supports; UPI is the caller's opt-in.
      method: input.method ?? "NETBANKING",
      ...(input.postbackUrl && { payment_postback_url: input.postbackUrl }),
      ...(bankAccount?.fpOldId && { bank_account_id: bankAccount.fpOldId }),
      // NOT the mandate's provider name. The payments half of /api/pg rejects
      // CYBRILLAPOA outright — see ONDC_PAYMENT_PROVIDER.
      provider_name: fpPayments.ONDC_PAYMENT_PROVIDER,
    });

    await recordSubmittedPayment(input.orderIds, created.id);

    const payment = await fpPayments.fetchPayment(created.id);
    const row = await syncPayment(payment);
    // The redirect URL is only in the create response, never in a fetch.
    if (created.token_url) {
      await db.payment.update({ where: { id: row.id }, data: { tokenUrl: created.token_url } });
    }
    return getPayment(row.id);
  } catch (error) {
    await releaseClaimIfNothingHappened(input.orderIds, error);
    rejectUnconfiguredProvider(error);
    fpErrorToHttpError(error);
  }
}

/** Is this FP's "the ONDC payment provider is not wired up" answer? */
function isUnconfiguredProvider(error: unknown): boolean {
  return (
    error instanceof FpApiError &&
    (error.code === "NO_PAYMENT_PROVIDER" ||
      /provider\s+\S+\s+not configured/i.test(error.message))
  );
}

/**
 * Create the payment, riding out a provider that is momentarily not wired up.
 *
 * The ONDC payment provider flaps on this tenant: the same payload that answers
 * `NO_PAYMENT_PROVIDER` one minute is accepted the next. Verified by sending
 * identical requests minutes apart — so the investor was being turned away from
 * checkout by a condition that had already passed.
 *
 * Retrying a payment POST is normally the one thing never to do, because a
 * request that actually succeeded upstream would debit twice. It is safe here
 * and only here: this is a 4xx, which means FP received the request, rejected
 * it and created nothing — the same reasoning `releaseClaimIfNothingHappened`
 * already relies on to hand the claim back. Every other failure, including any
 * transport error, falls straight through untouched.
 */
async function createNetbankingWithRetry(
  payload: Parameters<typeof fpPayments.createNetbankingPayment>[0],
) {
  // ~5s total. Measured: the provider answered 6/6 identical requests one
  // minute and refused a raw call and a service call alike the next, so the
  // outages run to minutes and this only covers the short blips. The honest
  // answer to a long one is the AutoPay fallback the 503 points at, not making
  // the investor watch a spinner.
  const backoffMs = [500, 1500, 3000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fpPayments.createNetbankingPayment(payload);
    } catch (error) {
      const delay = backoffMs[attempt];
      if (delay === undefined || !isUnconfiguredProvider(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Report an unprovisioned payment gateway as an outage, not as a bad request.
 *
 * FP answers `NO_PAYMENT_PROVIDER` / "Provider ONDC not configured" with a 4xx,
 * so the generic translation blamed the investor for a 400 and put FP's
 * internal wording — which names a provider they have never heard of — on the
 * checkout screen. Nothing about the request was wrong: the ONDC payment
 * provider comes and goes on this tenant, and while it is down UPI and
 * netbanking cannot be collected at all.
 *
 * 503 because it is temporary and the investor should retry, and because a
 * client that retries a 4xx is doing the wrong thing. The message names the
 * one route that still works, since an investor with an approved mandate is
 * not actually blocked.
 */
function rejectUnconfiguredProvider(error: unknown): void {
  if (!isUnconfiguredProvider(error)) return;
  throw HttpError.serviceUnavailable(
    "UPI and netbanking are unavailable from our payment provider right now. " +
      "Pay with AutoPay if you have one set up, or try again shortly.",
    { retryable: true, alternative: "mandate" },
  );
}

/** Debit an approved mandate instead of sending the investor to a bank page. */
export async function payByMandate(
  mandateId: string,
  orderIds: string[],
): Promise<PaymentDto> {
  const orders = await resolvePayableOrders(orderIds);
  await assertNotAlreadyPaid(orderIds);

  const mandate = await db.mandate.findUnique({
    where: { id: mandateId },
    select: { fpId: true, mandateStatus: true, providerName: true, mandateLimit: true, validFrom: true, validTo: true, bankAccount: { select: { investorProfileId: true } } },
  });
  if (!mandate) throw HttpError.notFound("No such mandate");
  requireOndcProvider(mandate.providerName ?? "");
  const account = await db.mfInvestmentAccount.findUniqueOrThrow({ where: { id: orders[0]!.mfInvestmentAccountId }, select: { primaryInvestorProfileId: true } });
  if (mandate.bankAccount.investorProfileId !== account.primaryInvestorProfileId) throw HttpError.badRequest("Mandate must belong to the order investor");
  if (mandate.mandateLimit.lessThan(orders[0]!.amount)) throw HttpError.badRequest("Order amount exceeds mandate limit");
  const today = istToday();
  if ((mandate.validFrom && mandate.validFrom.toISOString().slice(0, 10) > today) || (mandate.validTo && mandate.validTo.toISOString().slice(0, 10) < today)) throw HttpError.conflict("Mandate is outside its validity period");
  if (mandate.mandateStatus !== MandateStatus.APPROVED) {
    // FP would accept this and immediately fail the payment, which is a worse
    // experience than refusing now.
    throw HttpError.conflict("The mandate must be approved before it can be debited", {
      status: mandate.mandateStatus,
    });
  }

  await claimPayment(orderIds);
  try {
    const created = await fpPayments.createMandatePayment({
      mandate_id: mandate.fpId,
      amc_order_ids: orders.map((order) => order.fpOldId),
    });
    await recordSubmittedPayment(orderIds, created.id);
    const payment = await fpPayments.fetchPayment(created.id);
    const row = await syncPayment(payment);
    return getPayment(row.id);
  } catch (error) {
    await releaseClaimIfNothingHappened(orderIds, error);
    fpErrorToHttpError(error);
  }
}

export async function getPayment(id: string): Promise<PaymentDto> {
  const row = await db.payment.findUnique({ where: { id }, select: paymentSelect });
  if (!row) throw HttpError.notFound("No such payment");
  return toPaymentDto(row);
}

export async function refreshPayment(id: string): Promise<PaymentDto> {
  const payment = await db.payment.findUnique({ where: { id }, select: { fpId: true } });
  if (!payment) throw HttpError.notFound("No such payment");
  try {
    const fresh = await fpPayments.fetchPayment(payment.fpId);
    await syncPayment(fresh);
    return getPayment(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}
