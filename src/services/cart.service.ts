// The cart: funds an investor means to buy, kept on the server, and the
// checkout that buys them all with one transaction OTP.
//
//   cart items (ours) ─► POST checkout ─► lumpsums: ONE FP batch purchase
//                                      └► SIPs:     one FP plan each
//   FP reviews every line ─► one OTP (context `cart:<id>`) ─► consent to all
//   ─► ONE payment for every lumpsum ─► batch confirm ─► investor pays
//
// Why a batch: on ONDC FP lets one payment cover several orders only when they
// were created together by `POST /v2/mf_purchases/batch`. A SIP is not part of
// that payment — its instalments are debited from the approved mandate, the
// first one today (`generate_first_installment_now`).
//
// Why one OTP is enough: SEBI's 2FA is that the investor approved the
// transaction on their registered mobile. The code is requested for the whole
// checkout, spent once, and then held against the registered contact of every
// order and plan in it before a single consent is sent — a line on a folio
// with a different mobile refuses the whole checkout rather than being
// approved by somebody else's number.
import { CartItemType, MfOrderState, PlanState } from "../../generated/prisma/enums.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { asAmount, asNav } from "../utils/money.ts";
import { consumeVerificationToken } from "./otp.service.ts";
import * as orderService from "./order.service.ts";
import * as paymentService from "./payment.service.ts";
import * as planService from "./plan.service.ts";
import type {
  CartDto,
  CartItemDto,
  CheckoutDto,
  CheckoutLineDto,
  CheckoutStage,
  CreateCheckoutInput,
  PayCheckoutInput,
  PutCartItemInput,
} from "../types/cart.types.ts";
import type { PaymentDto } from "../types/payment.types.ts";

/** FP pays at most ten orders together; the cart holds no more lines than that. */
const MAX_LUMPSUMS = 10;
const MAX_ITEMS = 20;
/** ONDC SIPs run monthly; the cart registers them for ten years unless stopped. */
const SIP_INSTALMENTS = 120;

const itemSelect = {
  id: true,
  type: true,
  amount: true,
  createdAt: true,
  scheme: {
    select: {
      isin: true,
      name: true,
      category: true,
      subCategory: true,
      latestNav: true,
      amc: { select: { name: true } },
    },
  },
} satisfies Prisma.CartItemSelect;

type ItemRow = Prisma.CartItemGetPayload<{ select: typeof itemSelect }>;

const toItemDto = (row: ItemRow): CartItemDto => ({
  id: row.id,
  isin: row.scheme.isin,
  type: row.type,
  amount: asAmount(row.amount) ?? "0.00",
  schemeName: row.scheme.name,
  category: row.scheme.category,
  subCategory: row.scheme.subCategory,
  amcName: row.scheme.amc.name,
  latestNav: asNav(row.scheme.latestNav),
  createdAt: row.createdAt.toISOString(),
});

const sum = (values: Prisma.Decimal[]) =>
  values.reduce((total, value) => total.plus(value), new Prisma.Decimal(0));

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export async function getCart(userId: string): Promise<CartDto> {
  const rows = await db.cartItem.findMany({
    where: { userId },
    select: itemSelect,
    orderBy: { createdAt: "asc" },
    take: MAX_ITEMS,
  });
  return {
    items: rows.map(toItemDto),
    sipMonthly: asAmount(sum(rows.filter((r) => r.type === CartItemType.SIP).map((r) => r.amount))) ?? "0.00",
    lumpsum: asAmount(sum(rows.filter((r) => r.type === CartItemType.LUMPSUM).map((r) => r.amount))) ?? "0.00",
  };
}

/**
 * Add a fund to the cart, or change its amount.
 *
 * One line per fund and type, so adding the same SIP again edits it instead of
 * stacking a second instalment the investor did not mean to start. The
 * scheme's own limits are checked at checkout, where FP enforces them — here
 * only that the fund can be bought at all.
 */
export async function putCartItem(input: PutCartItemInput): Promise<CartDto> {
  const scheme = await db.mfScheme.findUnique({
    where: { isin: input.isin },
    select: { id: true, name: true, isActive: true, purchaseAllowed: true, sipAllowed: true },
  });
  if (!scheme || !scheme.isActive) throw HttpError.notFound("No such fund");
  if (input.type === CartItemType.SIP && !scheme.sipAllowed) {
    throw HttpError.badRequest(`${scheme.name} does not take SIPs`);
  }
  if (input.type === CartItemType.LUMPSUM && !scheme.purchaseAllowed) {
    throw HttpError.badRequest(`${scheme.name} is not open for one-time investments`);
  }
  const existing = await db.cartItem.count({ where: { userId: input.userId } });
  const key = { userId_schemeId_type: { userId: input.userId, schemeId: scheme.id, type: input.type } };
  const already = await db.cartItem.findUnique({ where: key, select: { id: true } });
  if (!already && existing >= MAX_ITEMS) throw HttpError.badRequest(`A cart holds at most ${MAX_ITEMS} funds`);
  if (!already && input.type === CartItemType.LUMPSUM) {
    const lumpsums = await db.cartItem.count({ where: { userId: input.userId, type: CartItemType.LUMPSUM } });
    if (lumpsums >= MAX_LUMPSUMS) {
      throw HttpError.badRequest(`At most ${MAX_LUMPSUMS} one-time investments can be paid together`);
    }
  }
  await db.cartItem.upsert({
    where: key,
    create: { userId: input.userId, schemeId: scheme.id, type: input.type, amount: new Prisma.Decimal(input.amount) },
    update: { amount: new Prisma.Decimal(input.amount) },
  });
  return getCart(input.userId);
}

export async function removeCartItem(userId: string, id: string): Promise<CartDto> {
  await db.cartItem.deleteMany({ where: { id, userId } });
  return getCart(userId);
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

const checkoutSelect = {
  id: true,
  userId: true,
  mfInvestmentAccountId: true,
  mandateId: true,
  installmentDay: true,
  consentedAt: true,
  createdAt: true,
  items: {
    select: {
      id: true,
      isin: true,
      type: true,
      amount: true,
      error: true,
      mfPurchaseId: true,
      mfPurchasePlanId: true,
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.CartCheckoutSelect;

type CheckoutRow = Prisma.CartCheckoutGetPayload<{ select: typeof checkoutSelect }>;

async function requireCheckout(userId: string, id: string): Promise<CheckoutRow> {
  const row = await db.cartCheckout.findFirst({ where: { id, userId }, select: checkoutSelect });
  if (!row) throw HttpError.notFound("No such checkout");
  return row;
}

/** A line FP accepted and has not (yet) failed. */
const ENDED_ORDER: string[] = [MfOrderState.FAILED, MfOrderState.CANCELLED];
const ENDED_PLAN: string[] = [PlanState.FAILED, PlanState.CANCELLED];

async function toCheckoutDto(row: CheckoutRow): Promise<CheckoutDto> {
  const purchaseIds = row.items.flatMap((item) => (item.mfPurchaseId ? [item.mfPurchaseId] : []));
  const planIds = row.items.flatMap((item) => (item.mfPurchasePlanId ? [item.mfPurchasePlanId] : []));
  const [orders, plans, schemes, link] = await Promise.all([
    db.mfPurchase.findMany({
      where: { id: { in: purchaseIds } },
      select: { id: true, state: true, failureCode: true, folioNumber: true },
    }),
    db.mfPurchasePlan.findMany({
      where: { id: { in: planIds } },
      select: { id: true, state: true, reason: true, nextInstallmentDate: true },
    }),
    db.mfScheme.findMany({
      where: { isin: { in: row.items.map((item) => item.isin) } },
      select: { isin: true, name: true },
    }),
    purchaseIds.length
      ? db.paymentPurchase.findFirst({
          where: { mfPurchaseId: { in: purchaseIds } },
          select: { paymentId: true },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve(null),
  ]);
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const nameByIsin = new Map(schemes.map((scheme) => [scheme.isin, scheme.name]));

  const lines: CheckoutLineDto[] = row.items.map((item) => {
    const order = item.mfPurchaseId ? orderById.get(item.mfPurchaseId) : undefined;
    const plan = item.mfPurchasePlanId ? planById.get(item.mfPurchasePlanId) : undefined;
    return {
      id: item.id,
      isin: item.isin,
      schemeName: nameByIsin.get(item.isin) ?? null,
      type: item.type,
      amount: asAmount(item.amount) ?? "0.00",
      error: item.error,
      order: order
        ? { id: order.id, state: order.state, failureCode: order.failureCode, folioNumber: order.folioNumber }
        : null,
      plan: plan
        ? {
            id: plan.id,
            state: plan.state,
            reason: plan.reason,
            nextInstallmentDate: plan.nextInstallmentDate?.toISOString().slice(0, 10) ?? null,
          }
        : null,
    };
  });

  const live = lines.filter(isLive);
  const payment = link ? await paymentService.getPayment(link.paymentId) : null;
  return {
    id: row.id,
    stage: stageOf(row, live),
    mandateId: row.mandateId,
    installmentDay: row.installmentDay,
    consentedAt: row.consentedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lines,
    payableNow: total(live.filter((line) => line.type === CartItemType.LUMPSUM)),
    sipMonthly: total(live.filter((line) => line.type === CartItemType.SIP)),
    payment,
  };
}

function isLive(line: CheckoutLineDto): boolean {
  if (line.error) return false;
  if (line.order) return !ENDED_ORDER.includes(line.order.state);
  if (line.plan) return !ENDED_PLAN.includes(line.plan.state);
  return false;
}

function total(lines: CheckoutLineDto[]): string {
  return asAmount(sum(lines.map((line) => new Prisma.Decimal(line.amount)))) ?? "0.00";
}

function stageOf(row: CheckoutRow, live: CheckoutLineDto[]): CheckoutStage {
  if (live.length === 0) return "failed";
  if (row.consentedAt) return "consented";
  const reviewing = live.some((line) =>
    line.order ? line.order.state === MfOrderState.UNDER_REVIEW : line.plan?.state === PlanState.CREATED,
  );
  return reviewing ? "reviewing" : "ready";
}

export async function getCheckout(userId: string, id: string): Promise<CheckoutDto> {
  return toCheckoutDto(await requireCheckout(userId, id));
}

/** A refusal FP gave for one line: kept on the line, never thrown for the lot. */
function refusal(error: unknown): string {
  if (error instanceof HttpError && error.status < 500) return error.message.slice(0, 500);
  throw error;
}

/**
 * Place every line in the cart.
 *
 * The checkout and its lines are written first, each with its own
 * `source_ref_id`, so the orders FP creates can always be matched back. The
 * lumpsums go to FP as one batch — all or nothing there — and each SIP on its
 * own; a SIP FP refuses keeps its reason on its line while the rest go ahead.
 */
export async function createCheckout(input: CreateCheckoutInput): Promise<CheckoutDto> {
  const cart = await db.cartItem.findMany({
    where: { userId: input.userId },
    select: { type: true, amount: true, scheme: { select: { isin: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (cart.length === 0) throw HttpError.badRequest("Your cart is empty");
  const lumpsums = cart.filter((item) => item.type === CartItemType.LUMPSUM);
  const sips = cart.filter((item) => item.type === CartItemType.SIP);
  if (lumpsums.length > MAX_LUMPSUMS) {
    throw HttpError.badRequest(`At most ${MAX_LUMPSUMS} one-time investments can be paid together`);
  }
  if (sips.length > 0) {
    if (!input.mandateId) throw HttpError.badRequest("Choose the AutoPay mandate your SIPs are debited from");
    if (!input.installmentDay) throw HttpError.badRequest("Choose the day of the month your SIPs debit on");
  }

  const checkout = await db.cartCheckout.create({
    data: {
      userId: input.userId,
      mfInvestmentAccountId: input.mfInvestmentAccountId,
      mandateId: sips.length ? (input.mandateId ?? null) : null,
      installmentDay: sips.length ? (input.installmentDay ?? null) : null,
      items: {
        create: cart.map((item) => ({
          isin: item.scheme.isin,
          type: item.type,
          amount: item.amount,
          sourceRefId: crypto.randomUUID(),
        })),
      },
    },
    select: { id: true, items: { select: { id: true, isin: true, type: true, amount: true, sourceRefId: true } } },
  });

  const lumpsumLines = checkout.items.filter((item) => item.type === CartItemType.LUMPSUM);
  if (lumpsumLines.length > 0) {
    try {
      const orders = await orderService.createPurchaseBatch(
        lumpsumLines.map((line) => ({
          mfInvestmentAccountId: input.mfInvestmentAccountId,
          isin: line.isin,
          amount: line.amount.toFixed(2),
          sourceRefId: line.sourceRefId,
          userIp: input.userIp,
          ...(input.initiatedVia && { initiatedVia: input.initiatedVia }),
        })),
      );
      await db.$transaction(
        lumpsumLines.map((line, index) =>
          db.cartCheckoutItem.update({ where: { id: line.id }, data: { mfPurchaseId: orders[index]!.id } }),
        ),
      );
    } catch (error) {
      const message = refusal(error);
      await db.cartCheckoutItem.updateMany({
        where: { id: { in: lumpsumLines.map((line) => line.id) } },
        data: { error: message },
      });
    }
  }

  for (const line of checkout.items.filter((item) => item.type === CartItemType.SIP)) {
    try {
      const plan = await planService.createSip({
        mfInvestmentAccountId: input.mfInvestmentAccountId,
        isin: line.isin,
        amount: line.amount.toFixed(2),
        mandateId: input.mandateId,
        frequency: "MONTHLY",
        installmentDay: input.installmentDay,
        numberOfInstallments: SIP_INSTALMENTS,
        // Collected from the mandate today, so the SIP starts with the rest of
        // the cart rather than next month.
        firstInstallmentNow: true,
        sourceRefId: line.sourceRefId,
        userIp: input.userIp,
        ...(input.initiatedVia && { initiatedVia: input.initiatedVia }),
      });
      await db.cartCheckoutItem.update({ where: { id: line.id }, data: { mfPurchasePlanId: plan.id } });
    } catch (error) {
      // A SIP FP refused at activation still exists at FP; its id travels with
      // the error, so the line points at the plan that explains the refusal.
      const planId = error instanceof HttpError ? (error.details as { planId?: unknown } | undefined)?.planId : undefined;
      await db.cartCheckoutItem.update({
        where: { id: line.id },
        data: { error: refusal(error), ...(typeof planId === "string" && { mfPurchasePlanId: planId }) },
      });
    }
  }

  return getCheckout(input.userId, checkout.id);
}

/** Pull every line's state from FP. The review moves on its own; this reads it. */
export async function refreshCheckout(userId: string, id: string): Promise<CheckoutDto> {
  const row = await requireCheckout(userId, id);
  await Promise.all(
    row.items.map(async (item) => {
      if (item.error) return;
      if (item.mfPurchaseId) await orderService.refreshOrder(item.mfPurchaseId).catch(() => undefined);
      if (item.mfPurchasePlanId) await planService.refreshPlan(item.mfPurchasePlanId).catch(() => undefined);
    }),
  );
  const dto = await toCheckoutDto(row);
  if (dto.payment) await paymentService.refreshPayment(dto.payment.id).catch(() => undefined);
  return toCheckoutDto(row);
}

/**
 * What the checkout's OTP is sent against, for the transaction-OTP route.
 *
 * Refused until every live line has passed FP's review: a code requested
 * earlier would expire while the investor waits, or approve a line FP then
 * fails.
 */
export async function consentTarget(
  userId: string,
  id: string,
): Promise<{ mfInvestmentAccountId: string; folioNumber: string | null }> {
  const row = await requireCheckout(userId, id);
  const dto = await toCheckoutDto(row);
  if (dto.stage === "consented") throw HttpError.conflict("This checkout is already confirmed");
  if (dto.stage !== "ready") throw HttpError.conflict("Wait for provider review before collecting transaction consent");
  const first = dto.lines.find(isLive);
  return { mfInvestmentAccountId: row.mfInvestmentAccountId, folioNumber: first?.order?.folioNumber ?? null };
}

/** The OTP context a checkout's code is issued and spent under. */
export const checkoutContext = (id: string) => `cart:${id}`;

/**
 * Spend the checkout's one OTP and consent to every line with it.
 *
 * Everything that can refuse runs first — each order pending, each plan
 * prepared, each line's registered contact matched to the verified mobile — so
 * a refusal costs the investor nothing and no line is consented alone.
 */
export async function consentCheckout(userId: string, id: string, verificationToken: string): Promise<CheckoutDto> {
  const row = await requireCheckout(userId, id);
  if (row.consentedAt) return toCheckoutDto(row);
  const dto = await toCheckoutDto(row);
  if (dto.stage !== "ready") throw HttpError.conflict("Wait for provider review before confirming", { stage: dto.stage });
  const live = dto.lines.filter(isLive);

  const purchases = await db.mfPurchase.findMany({
    where: { id: { in: live.flatMap((line) => (line.order ? [line.order.id] : [])) } },
    select: { id: true, fpId: true, mfInvestmentAccountId: true, folioNumber: true, state: true, consentAt: true },
  });
  const toConsent = purchases.filter((order) => !order.consentAt);
  if (toConsent.some((order) => order.state !== MfOrderState.PENDING)) {
    throw HttpError.conflict("An order in this checkout is no longer pending");
  }
  const orderContacts = await Promise.all(
    toConsent.map((order) => orderService.resolveConsentContact(order.mfInvestmentAccountId, order.folioNumber)),
  );
  const prepared = (
    await Promise.all(live.flatMap((line) => (line.plan ? [planService.preparePlanConfirm(line.plan.id)] : [])))
  ).filter((plan): plan is planService.PlanConfirmation => plan !== null);

  const proof = await consumeVerificationToken(verificationToken, checkoutContext(id));
  for (const contact of [...orderContacts, ...prepared.map((plan) => plan.contact)]) {
    orderService.assertProofFor(proof, contact);
  }

  // Each consent is its own FP write; one refusing does not undo the others,
  // so it is recorded on its line and the rest carry on.
  for (const [index, order] of toConsent.entries()) {
    try {
      await orderService.applyPurchaseConsent(order.id, order, orderContacts[index]!);
    } catch (error) {
      await db.cartCheckoutItem.updateMany({ where: { checkoutId: id, mfPurchaseId: order.id }, data: { error: refusal(error) } });
    }
  }
  for (const plan of prepared) {
    try {
      await planService.sendPlanConfirm(plan);
    } catch (error) {
      await db.cartCheckoutItem.updateMany({ where: { checkoutId: id, mfPurchasePlanId: plan.id }, data: { error: refusal(error) } });
    }
  }

  await db.cartCheckout.update({ where: { id }, data: { consentedAt: new Date() } });
  // The lines are placed now; the cart keeps only what was not in this checkout.
  const placed = await requireCheckout(userId, id);
  await db.cartItem.deleteMany({
    where: {
      userId,
      OR: placed.items
        .filter((item) => !item.error)
        .map((item) => ({ type: item.type, scheme: { isin: item.isin } })),
    },
  });
  return toCheckoutDto(placed);
}

/**
 * One payment for every consented one-time line, then confirm them together.
 *
 * A payment already created for them is returned rather than a second one
 * raised — FP does not check for duplicates on a batch payment.
 */
export async function payCheckout(
  userId: string,
  id: string,
  input: PayCheckoutInput,
): Promise<{ checkout: CheckoutDto; payment: PaymentDto | null }> {
  const row = await requireCheckout(userId, id);
  if (!row.consentedAt) throw HttpError.conflict("Confirm the checkout with your code before paying");
  const dto = await toCheckoutDto(row);
  const orderIds = dto.lines
    .filter((line) => isLive(line) && line.type === CartItemType.LUMPSUM && line.order)
    .map((line) => line.order!.id);
  if (orderIds.length === 0) return { checkout: dto, payment: dto.payment };

  let payment = dto.payment;
  if (!payment || ["FAILED", "REJECTED"].includes(payment.status)) {
    payment = await paymentService.payByNetbanking(
      { orderIds, ...(input.method && { method: input.method }), ...(input.bankAccountId && { bankAccountId: input.bankAccountId }) },
      { batch: true },
    );
  }
  await orderService.confirmPurchaseBatch(orderIds);
  return { checkout: await getCheckout(userId, id), payment: await paymentService.getPayment(payment.id) };
}
