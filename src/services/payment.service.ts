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
  OrderGateway,
  PaymentStatus,
  PlanState,
} from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import {
  FpApiError,
  FpTransportError,
  fpConfig,
  fpErrorToHttpError,
  fpOrders,
  fpPayments,
  fpSimulation,
} from "../integrations/fp/index.ts";
import { canMoveMoney, isOndcRoute, LEGACY_GATEWAY_MESSAGE } from "../utils/gateway.ts";
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
/**
 * Did a *failed* payment-create call prove that FP created nothing?
 *
 * Only two outcomes are safe to release a claim on: an FP 4xx (received and
 * rejected — 429 excluded, since a rate limit is not a verdict), and a non-FP
 * error, which the transport's own guards throw before the request is ever sent.
 * An FP 5xx or a transport error is an *unknown* outcome — the payment may well
 * exist — so the claim is kept and the order waits for reconciliation.
 *
 * This only ever sees errors from the create call itself: post-create bookkeeping
 * runs outside `createPaymentOrReleaseClaim`, so a database error there can never
 * reach here and wrongly release a claim on money already submitted.
 */
export function createFailureCreatedNothing(error: unknown): boolean {
  if (error instanceof FpApiError) return error.isClientError;
  return !(error instanceof FpTransportError);
}

async function releaseClaimIfNothingHappened(orderIds: string[], error: unknown): Promise<void> {
  if (!createFailureCreatedNothing(error)) return;
  await db.paymentSubmission.deleteMany({ where: { orderId: { in: orderIds }, fpPaymentId: null } });
}

/**
 * Create the payment at FP, releasing the claim ONLY if that call itself proves
 * nothing was created.
 *
 * The release boundary is deliberately drawn around the create call and nothing
 * else. Once it returns, FP has created the payment — and, on a mandate, is
 * already auto-debiting it — so everything after (recording the provider id,
 * fetching, syncing) is bookkeeping. A failure there is a reconciliation task,
 * never a reason to hand back a claim on money that has already been submitted:
 * doing so is precisely what would let a retry debit the investor twice, and FP
 * does not dedupe payments. Keeping those steps out of this try is the fix.
 *
 * `onError` runs on failure only, before the error is translated — the
 * netbanking path uses it to turn "provider not configured" into an outage.
 */
async function createPaymentOrReleaseClaim<T>(
  orderIds: string[],
  create: () => Promise<T>,
  onError?: (error: unknown) => void,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    await releaseClaimIfNothingHappened(orderIds, error);
    onError?.(error);
    fpErrorToHttpError(error);
  }
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
const TERMINAL_PAYMENT_STATUSES: PaymentStatus[] = [PaymentStatus.FAILED, PaymentStatus.REJECTED];

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
 * Refuse to pay for an order that already has a payment against it.
 *
 * FP performs no such check, so without this a double-tapped button debits the
 * investor twice for one purchase. Two distinct cases, two distinct answers:
 *
 *  - A live (non-terminal) payment: one is already under way, so a second must
 *    not start.
 *  - A payment that already ran and failed: on this ONDC route FP does not
 *    support re-paying the same order — its retry facility is not available
 *    here (see `retryPurchase`), and a failed purchase stays failed. The remedy
 *    is a new order, not another payment. Saying so here is what stops the
 *    caller meeting the claim's primary-key collision as an opaque "already
 *    submitted" 409 and being unable to tell that a new order is the way out.
 *
 * One query, branched in memory: the payment path is a deliberate, low-volume
 * action, not a hot read.
 */
export type ExistingPaymentVerdict = "none" | "live" | "failed";

/**
 * Classify the payments already recorded against an order.
 *
 * `live` (a non-terminal payment exists) takes precedence over `failed`: while
 * one attempt is in flight, that is the fact that must block a second, whatever
 * else happened before it.
 */
export function classifyExistingPayments(statuses: PaymentStatus[]): ExistingPaymentVerdict {
  if (statuses.length === 0) return "none";
  if (statuses.some((status) => !TERMINAL_PAYMENT_STATUSES.includes(status))) return "live";
  return "failed";
}

async function assertNotAlreadyPaid(mfPurchaseIds: string[]): Promise<void> {
  const links = await db.paymentPurchase.findMany({
    where: { mfPurchaseId: { in: mfPurchaseIds } },
    select: { mfPurchaseId: true, payment: { select: { id: true, status: true } } },
  });

  const verdict = classifyExistingPayments(links.map((link) => link.payment.status));
  if (verdict === "none") return;

  if (verdict === "live") {
    const live = links.find((link) => !TERMINAL_PAYMENT_STATUSES.includes(link.payment.status))!;
    throw HttpError.conflict("A payment is already in progress for this order", {
      orderId: live.mfPurchaseId,
      paymentId: live.payment.id,
      paymentStatus: live.payment.status,
    });
  }

  const failed = links[0]!;
  throw HttpError.conflict(
    "This order's payment did not go through, and it cannot be retried on this route. Place a new order instead.",
    {
      orderId: failed.mfPurchaseId,
      paymentId: failed.payment.id,
      paymentStatus: failed.payment.status,
      retryable: false,
    },
  );
}

/** Resolve our order ids to the integer ids the payment gateway understands. */
/** A SIP in one of these states was confirmed with the investor's OTP. */
const CONSENTED_PLAN_STATES: PlanState[] = [PlanState.CONFIRMED, PlanState.SUBMITTED, PlanState.ACTIVE];

/**
 * A SIP installment the investor may pay by netbanking / UPI.
 *
 * An installment carries no consent of its own: the investor consented, with
 * an OTP, to the plan that generated it. And FP moves it straight to
 * `submitted`, not `pending`, because it expects a mandate debit. The first
 * installment of a SIP started "now" is paid on the payment page instead —
 * a page payment is what ONDC allots (it carries the `pay_…` reference a
 * mandate debit lacks in the sandbox), so the SIP's first units land at once.
 */
function isConsentedInstallment(order: { plan: { state: PlanState } | null }): boolean {
  return order.plan !== null && CONSENTED_PLAN_STATES.includes(order.plan.state);
}

async function resolvePayableOrders(mfPurchaseIds: string[]) {
  if (mfPurchaseIds.length === 0) throw HttpError.badRequest("No orders given");
  if (mfPurchaseIds.length > 10) {
    throw HttpError.badRequest("At most ten orders can share one payment");
  }

  const orders = await db.mfPurchase.findMany({
    where: { id: { in: mfPurchaseIds } },
    select: { id: true, fpOldId: true, state: true, gateway: true, mfInvestmentAccountId: true, consentAt: true, folioNumber: true, amount: true, plan: { select: { state: true } } },
  });
  if (orders.length !== mfPurchaseIds.length) throw HttpError.notFound("Unknown order");
  const legacy = orders.find((order) => isOndcRoute(order.gateway) && !canMoveMoney(order.gateway));
  if (legacy) throw HttpError.conflict(LEGACY_GATEWAY_MESSAGE, { orderId: legacy.id, gateway: legacy.gateway, retryable: false });
  if (orders.some(order => !canMoveMoney(order.gateway) || (!order.consentAt && !isConsentedInstallment(order)))) throw HttpError.conflict("Only consented ONDC orders can be paid");
  // This API creates single orders. Batch checkout requires FP batch-order creation.
  if (orders.length !== 1) throw HttpError.badRequest("Use one order per payment; batch-order creation is not exposed");
  for (const order of orders) await assertInvestmentReady(order.mfInvestmentAccountId, order.folioNumber);

  const notPending = orders.filter((order) =>
    isConsentedInstallment(order)
      ? !DEBITABLE_INSTALLMENT_STATES.includes(order.state)
      : order.state !== MfOrderState.PENDING,
  );
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
  // Where FP sends the investor once they have paid. Defaults to our own return
  // endpoint, which reads the order straight back — on ONDC it is often already
  // `successful`, with its folio, by the time the investor lands there.
  const postbackUrl = input.postbackUrl ?? paymentReturnUrl(orders[0]!.id);
  await claimPayment(input.orderIds);

  const created = await createPaymentOrReleaseClaim(
    input.orderIds,
    () =>
      createNetbankingWithRetry({
        amc_order_ids: orders.map((order) => order.fpOldId),
        // Mandatory on the ONDC provider, and its absence is reported terribly:
        // FP answers `400 "payment method has to present for ondc provider"`, or
        // in some combinations the actively misleading
        // `422 "Provider ONDC not configured"`, which reads as though the whole
        // gateway were switched off. NETBANKING is the default because it is the
        // one every bank supports; UPI is the caller's opt-in.
        method: input.method ?? "NETBANKING",
        ...(postbackUrl && { payment_postback_url: postbackUrl }),
        ...(bankAccount?.fpOldId && { bank_account_id: bankAccount.fpOldId }),
        // NOT the mandate's provider name. The payments half of /api/pg rejects
        // CYBRILLAPOA outright — see ONDC_PAYMENT_PROVIDER.
        provider_name: fpPayments.ONDC_PAYMENT_PROVIDER,
      }),
    rejectUnconfiguredProvider,
  );

  // FP has created the payment; the claim is now permanent. Every step below is
  // bookkeeping — a failure here is reconciled, never released.
  await recordSubmittedPayment(input.orderIds, created.id);
  const payment = await fpPayments.fetchPayment(created.id);
  const row = await syncPayment(payment);
  // The redirect URL is only in the create response, never in a fetch.
  if (created.token_url) {
    await db.payment.update({ where: { id: row.id }, data: { tokenUrl: created.token_url } });
  }
  return getPayment(row.id);
}

/** Is this FP's "the ONDC payment provider is not wired up" answer? */
export function isUnconfiguredProvider(error: unknown): boolean {
  return (
    error instanceof FpApiError &&
    // A 4xx, and only a 4xx. Retrying the create POST is safe exclusively
    // because FP received the request and rejected it, so nothing was created.
    // A 5xx (or a 429) carrying the same wording is an unknown outcome — the
    // payment may exist — and must never be retried, or the investor is debited
    // twice. Matching on the message alone would have let that through.
    error.isClientError &&
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
 * and only here: `isUnconfiguredProvider` matches only a 4xx, which means FP
 * received the request, rejected it and created nothing — the same reasoning
 * `releaseClaimIfNothingHappened` already relies on to hand the claim back.
 * Every other failure, including a 5xx and any transport error, falls straight
 * through untouched.
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

  const created = await createPaymentOrReleaseClaim(orderIds, () =>
    fpPayments.createMandatePayment({
      mandate_id: mandate.fpId,
      amc_order_ids: orders.map((order) => order.fpOldId),
    }),
  );

  // FP has created the payment and is auto-debiting the mandate; the claim is
  // now permanent. A failure in the bookkeeping below is reconciled, never
  // released — releasing here is exactly what would let a retry debit twice.
  await recordSubmittedPayment(orderIds, created.id);
  const payment = await fpPayments.fetchPayment(created.id);
  const row = await syncPayment(payment);
  return getPayment(row.id);
}

export async function getPayment(id: string): Promise<PaymentDto> {
  const row = await db.payment.findUnique({ where: { id }, select: paymentSelect });
  if (!row) throw HttpError.notFound("No such payment");
  return toPaymentDto(row);
}

/** Every payment attempted against one purchase, newest first. One query. */
export async function listOrderPayments(mfPurchaseId: string): Promise<PaymentDto[]> {
  const rows = await db.payment.findMany({
    where: { purchases: { some: { mfPurchaseId } } },
    select: paymentSelect,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toPaymentDto);
}

// ---------------------------------------------------------------------------
// SIP installments
// ---------------------------------------------------------------------------

/** Installment states in which FP is still waiting for the money. */
const DEBITABLE_INSTALLMENT_STATES: MfOrderState[] = [
  MfOrderState.PENDING,
  MfOrderState.CONFIRMED,
  MfOrderState.SUBMITTED,
];

export type InstallmentDebitOutcome = "debited" | "already_claimed" | "not_debitable";

/**
 * Debit the SIP's mandate for one installment.
 *
 * FP generates each installment as an ordinary purchase but does NOT collect
 * it: without a `POST /api/pg/payments/nach` for the installment's `old_id`,
 * it is never paid and expires. The plan's consent covers every installment,
 * so no fresh OTP is involved — which is also why this cannot go through
 * `payByMandate`, whose rules are for one-off orders the investor approves.
 *
 * Exactly once per installment, across retries and processes: the
 * `paymentSubmission` claim is keyed on the order, and a debit whose outcome
 * is unknown keeps it, exactly as a one-off payment does. A debit FP rejects
 * outright (4xx) releases it, so the next sweep tries again.
 */
export async function debitInstallment(mfPurchaseId: string): Promise<InstallmentDebitOutcome> {
  const order = await db.mfPurchase.findUnique({
    where: { id: mfPurchaseId },
    select: {
      fpOldId: true,
      state: true,
      gateway: true,
      amount: true,
      paymentSubmission: { select: { orderId: true } },
      payments: { select: { paymentId: true }, take: 1 },
      plan: { select: { mandateId: true, paymentSourceRef: true, state: true } },
    },
  });
  if (!order?.plan || order.fpOldId === null) return "not_debitable";
  // `ondc` only, not every ONDC-looking route. An installment on the old
  // `cybrillapoa` gateway is never allotted (utils/gateway.ts), so debiting its
  // mandate would take the investor's money for units that never arrive.
  // Those plans stay readable; they are just not collected.
  if (!canMoveMoney(order.gateway)) {
    console.warn(`[sip] installment ${mfPurchaseId} is on the ${order.gateway} gateway, which never allots; not debiting`);
    return "not_debitable";
  }
  if (!DEBITABLE_INSTALLMENT_STATES.includes(order.state)) return "not_debitable";
  if (order.paymentSubmission || order.payments.length > 0) return "already_claimed";

  // The plan row links our mandate when we created the plan; a plan mirrored
  // from elsewhere only carries FP's mandate id in `payment_source`.
  const mandate = await db.mandate.findFirst({
    where: order.plan.mandateId
      ? { id: order.plan.mandateId }
      : { fpId: Number(order.plan.paymentSourceRef ?? Number.NaN) },
    select: { id: true, fpId: true, mandateStatus: true, mandateLimit: true },
  });
  if (!mandate || mandate.mandateStatus !== MandateStatus.APPROVED) {
    console.warn(`[sip] installment ${mfPurchaseId} has no approved mandate to debit`);
    return "not_debitable";
  }
  if (mandate.mandateLimit.lessThan(order.amount)) {
    console.warn(`[sip] installment ${mfPurchaseId} exceeds its mandate's limit`);
    return "not_debitable";
  }

  try {
    await claimPayment([mfPurchaseId]);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) return "already_claimed";
    throw error;
  }

  const created = await createPaymentOrReleaseClaim([mfPurchaseId], () =>
    fpPayments.createMandatePayment({ mandate_id: mandate.fpId, amc_order_ids: [order.fpOldId as number] }),
  );
  // FP has created the debit; from here on the claim is permanent.
  await recordSubmittedPayment([mfPurchaseId], created.id);
  await syncPayment(await fpPayments.fetchPayment(created.id));
  return "debited";
}

// ---------------------------------------------------------------------------
// Returning from the payment page
// ---------------------------------------------------------------------------

/**
 * `PUBLIC_API_BASE_URL`: this server's origin as the investor's browser can
 * reach it. Unset means no default postback, and FP falls back to its own page.
 * HTTPS is required in production, where the URL is handed to a third party.
 */
function publicApiBaseUrl(): string | undefined {
  const raw = process.env["PUBLIC_API_BASE_URL"]?.trim().replace(/\/+$/, "");
  if (!raw) return undefined;
  const url = new URL(raw);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("PUBLIC_API_BASE_URL must be https in production");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Our return endpoint for one order, or undefined when not configured. */
export function paymentReturnUrl(orderId: string): string | undefined {
  const base = publicApiBaseUrl();
  return base ? `${base}/api/v1/payments/return/${encodeURIComponent(orderId)}` : undefined;
}

/**
 * Where to send the investor after the return has been handled: the app, when
 * `PAYMENT_RETURN_REDIRECT_URL` names it (a deep link such as
 * `risips://payment-return`), with only our order id attached.
 */
export function paymentReturnRedirect(orderId: string): string | undefined {
  const raw = process.env["PAYMENT_RETURN_REDIRECT_URL"]?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  url.searchParams.set("orderId", orderId);
  return url.toString();
}

/**
 * The investor is back from the payment page: read the payment and the order
 * straight back from FP.
 *
 * Reached by an unauthenticated browser redirect, so it only ever pulls FP's
 * own state into the mirror — it changes nothing FP has not already decided,
 * returns nothing, and an unknown or foreign id is simply a no-op. Best-effort
 * by design: a slow FP must not strand the investor on an error page, and the
 * background reconciler picks up whatever this misses.
 */
export async function handlePaymentReturn(orderId: string): Promise<void> {
  const order = await db.mfPurchase.findUnique({
    where: { id: orderId },
    select: {
      fpId: true,
      gateway: true,
      mfInvestmentAccountId: true,
      payments: { select: { payment: { select: { fpId: true } } } },
    },
  });
  if (!order || !isOndcRoute(order.gateway)) return;

  try {
    for (const link of order.payments) {
      await syncPayment(await fpPayments.fetchPayment(link.payment.fpId));
    }
    const { applyPurchaseUpdate } = await import("./order.service.ts");
    await applyPurchaseUpdate(await fpOrders.fetchPurchase(order.fpId), order.mfInvestmentAccountId);
  } catch (error) {
    console.warn(
      `[payments] return for order ${orderId} could not be refreshed; the reconciler will retry:`,
      error instanceof Error ? error.message : error,
    );
  }
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
