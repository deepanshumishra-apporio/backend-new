// One holding, plan, order or payment of an investor, in full — the admin
// investor record's side panel.
//
// Every lookup is scoped to the investor named in the URL: the item is fetched
// *through* their investment account (or, for payments, their profile's bank
// accounts), so an id belonging to someone else is simply not found. A staff
// member can never read another investor's order by editing an id.
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { maskTail } from "../utils/mask.ts";
import {
  dec,
  day,
  events,
  holdingSelect,
  instalmentCounts,
  iso,
  maskedAccount,
  orderConsent,
  orderEvents,
  paymentSelect,
  purchaseSelect,
  purchaseToOrder,
  redemptionSelect,
  redemptionToOrder,
  schemeFactsSelect,
  sipSelect,
  sipToPlan,
  planEvents,
  stpSelect,
  stpToPlan,
  swpSelect,
  swpToPlan,
  switchSelect,
  switchToOrder,
  toHolding,
  toPayment,
  toSchemeFacts,
} from "./admin-money-mapping.ts";
import { paymentsOfProfile } from "./admin-investor-portfolio.service.ts";
import type {
  InvestorItemDto,
  InvestorItemType,
  OrderDetailDto,
  PlanDetailDto,
} from "../types/admin-investor.types.ts";

const notFound = () => HttpError.notFound("That item doesn't belong to this investor, or no longer exists");
const INSTALMENT_LIMIT = 200;
const RELATED_LIMIT = 50;

/** The investor's primary profile and account, resolved the same way `investorFacts` does. */
async function scopeOf(userId: string): Promise<{ accountId: string | null; profileId: string | null }> {
  const user = await db.user.findFirst({ where: { id: userId, role: "INVESTOR", deletedAt: null }, select: { id: true } });
  if (!user) throw HttpError.notFound("No investor with that id");
  const link = await db.userInvestorProfile.findFirst({
    where: { userId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { investorProfileId: true },
  });
  if (!link) return { accountId: null, profileId: null };
  const account = await db.mfInvestmentAccount.findFirst({
    where: { primaryInvestorProfileId: link.investorProfileId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return { accountId: account?.id ?? null, profileId: link.investorProfileId };
}

export async function getInvestorItem(userId: string, type: InvestorItemType, itemId: string): Promise<InvestorItemDto> {
  const { accountId, profileId } = await scopeOf(userId);
  if (type === "payment") {
    if (!profileId) throw notFound();
    return { type: "payment", payment: await payment(profileId, itemId) };
  }
  if (!accountId) throw notFound();
  switch (type) {
    case "holding":
      return { type: "holding", holding: await holding(accountId, itemId) };
    case "sip":
    case "swp":
    case "stp":
      return { type: "plan", plan: await plan(accountId, type, itemId) };
    case "purchase":
    case "redemption":
    case "switch":
      return { type: "order", order: await order(accountId, type, itemId) };
  }
}

// --- holding ---------------------------------------------------------------------

async function holding(accountId: string, id: string) {
  const row = await db.mfHolding.findFirst({ where: { id, mfInvestmentAccountId: accountId }, select: holdingSelect });
  if (!row) throw notFound();
  const onFolio = { mfInvestmentAccountId: accountId, folioNumber: row.folioNumber };
  const isin = row.schemeIsin;
  const newest = { orderBy: { createdAt: "desc" as const }, take: RELATED_LIMIT };

  const [scheme, folio, purchases, redemptions, switches, sips, swps, stps] = await Promise.all([
    db.mfScheme.findUnique({ where: { isin }, select: schemeFactsSelect }),
    db.mfFolio.findFirst({
      where: { mfInvestmentAccountId: accountId, number: row.folioNumber },
      select: { number: true, amcCode: true, holdingPattern: true },
    }),
    db.mfPurchase.findMany({ where: { ...onFolio, schemeIsin: isin }, ...newest, select: purchaseSelect }),
    db.mfRedemption.findMany({ where: { ...onFolio, schemeIsin: isin }, ...newest, select: redemptionSelect }),
    db.mfSwitch.findMany({
      where: { ...onFolio, OR: [{ switchOutSchemeIsin: isin }, { switchInSchemeIsin: isin }] },
      ...newest,
      select: switchSelect,
    }),
    db.mfPurchasePlan.findMany({ where: { mfInvestmentAccountId: accountId, schemeIsin: isin }, select: sipSelect }),
    db.mfRedemptionPlan.findMany({ where: { mfInvestmentAccountId: accountId, schemeIsin: isin }, select: swpSelect }),
    db.mfSwitchPlan.findMany({
      where: { mfInvestmentAccountId: accountId, OR: [{ switchOutSchemeIsin: isin }, { switchInSchemeIsin: isin }] },
      select: stpSelect,
    }),
  ]);

  const plans = [
    ...sips.map((p) => ({ id: p.id, kind: "SIP" as const, state: p.state, amount: dec(p.amount), frequency: p.frequency, nextInstallmentDate: day(p.nextInstallmentDate) })),
    ...swps.map((p) => ({ id: p.id, kind: "SWP" as const, state: p.state, amount: dec(p.amount), frequency: p.frequency, nextInstallmentDate: day(p.nextInstallmentDate) })),
    ...stps.map((p) => ({ id: p.id, kind: "STP" as const, state: p.state, amount: dec(p.amount), frequency: p.frequency, nextInstallmentDate: day(p.nextInstallmentDate) })),
  ];

  return {
    ...toHolding(row),
    unitsAsOn: day(row.unitsAsOn),
    currentValueAsOn: day(row.marketValueAsOn),
    investedValueAsOn: day(row.investedValueAsOn),
    payoutAmount: dec(row.payoutAmount),
    schemeFacts: scheme ? toSchemeFacts(scheme) : null,
    folio,
    orders: [...purchases.map(purchaseToOrder), ...redemptions.map(redemptionToOrder), ...switches.map(switchToOrder)]
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
      .slice(0, RELATED_LIMIT),
    plans,
  };
}

// --- plan --------------------------------------------------------------------------

async function plan(accountId: string, kind: "sip" | "swp" | "stp", id: string): Promise<PlanDetailDto> {
  const where = { id, mfInvestmentAccountId: accountId };
  const byPlan = { where: { planId: id }, orderBy: { createdAt: "desc" as const }, take: INSTALMENT_LIMIT };

  if (kind === "sip") {
    const row = await db.mfPurchasePlan.findFirst({ where, select: sipSelect });
    if (!row) throw notFound();
    const [counts, installments] = await Promise.all([
      instalmentCounts("mf_purchases", [id]),
      db.mfPurchase.findMany({ ...byPlan, select: purchaseSelect }),
    ]);
    return {
      ...sipToPlan(row, counts), ...planExtras(row),
      paymentMethod: row.paymentMethod, purpose: row.purpose,
      installments: installments.map(purchaseToOrder), events: planEvents(row), schemeFacts: toSchemeFacts(row.scheme),
    };
  }
  if (kind === "swp") {
    const row = await db.mfRedemptionPlan.findFirst({ where, select: swpSelect });
    if (!row) throw notFound();
    const [counts, installments] = await Promise.all([
      instalmentCounts("mf_redemptions", [id]),
      db.mfRedemption.findMany({ ...byPlan, select: redemptionSelect }),
    ]);
    return {
      ...swpToPlan(row, counts), ...planExtras(row), paymentMethod: null, purpose: null,
      installments: installments.map(redemptionToOrder), events: planEvents(row), schemeFacts: toSchemeFacts(row.scheme),
    };
  }
  const row = await db.mfSwitchPlan.findFirst({ where, select: stpSelect });
  if (!row) throw notFound();
  const [counts, installments] = await Promise.all([
    instalmentCounts("mf_switches", [id]),
    db.mfSwitch.findMany({ ...byPlan, select: switchSelect }),
  ]);
  return {
    ...stpToPlan(row, counts), ...planExtras(row), paymentMethod: null, purpose: null,
    installments: installments.map(switchToOrder), events: planEvents(row), schemeFacts: toSchemeFacts(row.switchOutScheme),
  };
}

function planExtras(row: {
  fpId: string; gateway: string; requestedActivationDate: Date | null; activatedAt: Date | null; completedAt: Date | null;
  failedAt: Date | null; autoCancelled: boolean | null; cancellationCode: string | null; cancellationScheduledOn: Date | null;
  consentAt: Date | null;
}) {
  return {
    fpId: row.fpId,
    gateway: row.gateway,
    requestedActivationDate: day(row.requestedActivationDate),
    activatedAt: iso(row.activatedAt),
    completedAt: iso(row.completedAt),
    failedAt: iso(row.failedAt),
    autoCancelled: row.autoCancelled,
    cancellationCode: row.cancellationCode,
    cancellationScheduledOn: day(row.cancellationScheduledOn),
    consentAt: iso(row.consentAt),
  };
}

// --- order ---------------------------------------------------------------------------

async function order(accountId: string, kind: "purchase" | "redemption" | "switch", id: string): Promise<OrderDetailDto> {
  const where = { id, mfInvestmentAccountId: accountId };
  const shared = (row: { fpId: string; sourceRefId: string | null; gateway: string; failureCode: string | null; scheduledOn: Date | null; tradedOn: Date | null; initiatedBy: string | null; initiatedVia: string | null }) => ({
    fpId: row.fpId,
    sourceRefId: row.sourceRefId,
    gateway: row.gateway,
    failureCode: row.failureCode,
    scheduledOn: day(row.scheduledOn),
    tradedOn: day(row.tradedOn),
    initiatedBy: row.initiatedBy,
    initiatedVia: row.initiatedVia,
  });

  if (kind === "purchase") {
    const row = await db.mfPurchase.findFirst({
      where,
      select: {
        ...purchaseSelect,
        plan: { select: { id: true, scheme: { select: { name: true } } } },
        payments: { orderBy: { createdAt: "desc" }, select: { payment: { select: paymentSelect } } },
      },
    });
    if (!row) throw notFound();
    return {
      ...purchaseToOrder(row), ...shared(row),
      subtype: row.type, navDate: day(row.allottedNavDate), consent: orderConsent(row), payoutAccount: null,
      plan: row.plan ? { id: row.plan.id, kind: "SIP", scheme: row.plan.scheme.name } : null,
      payments: row.payments.map((link) => toPayment(link.payment)),
      events: orderEvents(row, [[row.retriedAt, "Retried"]]),
      schemeFacts: toSchemeFacts(row.scheme),
    };
  }
  if (kind === "redemption") {
    const row = await db.mfRedemption.findFirst({
      where,
      select: { ...redemptionSelect, plan: { select: { id: true, scheme: { select: { name: true } } } } },
    });
    if (!row) throw notFound();
    return {
      ...redemptionToOrder(row), ...shared(row),
      subtype: row.redemptionMode, navDate: day(row.redeemedNavDate), consent: orderConsent(row),
      payoutAccount: row.redemptionBankAccountNumber
        ? { accountNumber: maskTail(row.redemptionBankAccountNumber) ?? "", ifsc: row.redemptionBankAccountIfsc }
        : null,
      plan: row.plan ? { id: row.plan.id, kind: "SWP", scheme: row.plan.scheme.name } : null,
      payments: [], events: orderEvents(row), schemeFacts: toSchemeFacts(row.scheme),
    };
  }
  const row = await db.mfSwitch.findFirst({
    where,
    select: { ...switchSelect, plan: { select: { id: true, switchOutScheme: { select: { name: true } } } } },
  });
  if (!row) throw notFound();
  return {
    ...switchToOrder(row), ...shared(row),
    subtype: null, navDate: null, consent: orderConsent(row), payoutAccount: null,
    plan: row.plan ? { id: row.plan.id, kind: "STP", scheme: row.plan.switchOutScheme.name } : null,
    payments: [], events: orderEvents(row), schemeFacts: toSchemeFacts(row.switchOutScheme),
  };
}

// --- payment ---------------------------------------------------------------------

async function payment(profileId: string, id: string) {
  const row = await db.payment.findFirst({
    where: { AND: [{ id }, paymentsOfProfile(profileId)] },
    select: {
      ...paymentSelect,
      mandate: { select: { mandateType: true, mandateStatus: true, umrn: true } },
      fromBankAccount: { select: { bankName: true, accountNumberLast4: true } },
      purchases: { select: { mfPurchase: { select: purchaseSelect } } },
    },
  });
  if (!row) throw notFound();
  return {
    ...toPayment(row),
    fpId: row.fpId,
    provider: row.provider,
    debitDate: day(row.debitDate),
    failureCode: row.failureCode,
    lateAuth: row.lateAuth,
    refund: row.refundStatus || row.refundReference
      ? { status: row.refundStatus, reference: row.refundReference, reason: row.refundReason, at: iso(row.refundCreatedAt) }
      : null,
    mandate: row.mandate
      ? { type: row.mandate.mandateType, status: row.mandate.mandateStatus, umrn: maskTail(row.mandate.umrn, 6) }
      : null,
    bankAccount: row.fromBankAccount
      ? { bankName: row.fromBankAccount.bankName, accountNumber: maskedAccount(row.fromBankAccount.accountNumberLast4) ?? "" }
      : null,
    purchases: row.purchases.map((link) => purchaseToOrder(link.mfPurchase)),
    events: events([
      [row.createdAt, "Created"],
      [row.submittedAt, "Submitted"],
      [row.debitConfirmedAt, "Debit confirmed"],
      [row.transferInitiatedAt, "Transfer initiated"],
      [row.settledAt, "Settled"],
      [row.failedAt, "Failed"],
      [row.rejectedAt, "Rejected"],
      [row.refundCreatedAt, "Refund raised"],
    ]),
  };
}
