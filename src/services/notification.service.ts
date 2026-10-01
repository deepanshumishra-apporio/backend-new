// Notifications: what the investor should hear about their money.
//
// Raised from the mirror, not from the request that caused the change. Every
// state an order, plan or payment reaches arrives through `fp-sync` — from the
// create response, a refresh, the reconciler or a webhook — so hooking the
// sync is the one place that sees all of them, including the ones no request
// of ours caused (a registrar failing an order hours later).
//
// Each event has a `dedupeKey` (`order:<id>:successful`), unique per user, so
// the same state synced ten times raises one notification. Events older than a
// week are not raised at all: the first sync after this shipped would
// otherwise bury the investor under their entire history.
import { NotificationCategory, PlanState } from "../../generated/prisma/enums.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import type { NotificationDto, NotificationPage } from "../types/notification.types.ts";

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE = 30;

export interface NotifyInput {
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
  dedupeKey: string;
  targetType?: "order" | "plan" | "ticket";
  targetId?: string;
  /** When the event happened; defaults to now. */
  at?: Date | null;
}

const rupees = (value: Prisma.Decimal | string | number | null | undefined) =>
  value == null ? "" : `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** FP's failure codes, in words an investor can act on. */
function failureText(code: string | null | undefined): string {
  if (!code) return "";
  const known: Record<string, string> = {
    payment_failure: "The payment did not go through.",
    order_expiry: "It expired before it was paid.",
    payout_account_verification_pending: "Your payout bank account is not verified yet.",
    insufficient_balance: "There was not enough balance in your account.",
  };
  const text = known[code] ?? `${code.replaceAll("_", " ")}.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Raise one notification. Never throws: a notification is never worth a failed sync. */
export async function notify(input: NotifyInput): Promise<void> {
  const at = input.at ?? new Date();
  if (Date.now() - at.getTime() > RECENT_MS) return;
  try {
    await db.notification.createMany({
      data: [
        {
          userId: input.userId,
          category: input.category,
          title: input.title.slice(0, 160),
          body: input.body.slice(0, 500),
          dedupeKey: input.dedupeKey.slice(0, 160),
          ...(input.targetType && { targetType: input.targetType }),
          ...(input.targetId && { targetId: input.targetId }),
          createdAt: at,
        },
      ],
      skipDuplicates: true,
    });
  } catch (error) {
    console.warn(`[notifications] could not raise ${input.dedupeKey}`, error instanceof Error ? error.message : error);
  }
}

/** The investor behind an investment account — who hears about it. */
async function userForAccount(mfInvestmentAccountId: string): Promise<string | null> {
  const link = await db.userInvestorProfile.findFirst({
    where: { relationship: "SELF", investorProfile: { primaryFor: { some: { id: mfInvestmentAccountId } } } },
    select: { userId: true },
  });
  return link?.userId ?? null;
}

/** Run a notifier after a sync without ever failing the sync. */
export function afterSync(run: () => Promise<void>): Promise<void> {
  return run().catch((error: unknown) => {
    console.warn("[notifications] skipped", error instanceof Error ? error.message : error);
  });
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export async function notifyPurchase(id: string): Promise<void> {
  const row = await db.mfPurchase.findUnique({
    where: { id },
    select: {
      state: true, amount: true, allottedUnits: true, purchasedPrice: true, failureCode: true, planId: true,
      mfInvestmentAccountId: true, createdAt: true, fpCreatedAt: true, succeededAt: true, failedAt: true,
      cancelledAt: true, reversedAt: true, scheme: { select: { name: true } },
    },
  });
  if (!row) return;
  const userId = await userForAccount(row.mfInvestmentAccountId);
  if (!userId) return;
  const fund = row.scheme.name;
  const amount = rupees(row.amount);
  const base = { userId, targetType: "order" as const, targetId: id };
  const instalment = row.planId !== null;

  switch (row.state) {
    case "UNDER_REVIEW":
    case "PENDING":
    case "CONFIRMED":
    case "SUBMITTED":
      // A plan's instalment is not something the investor placed.
      if (instalment) return;
      return notify({ ...base, category: "ORDER", dedupeKey: `order:${id}:placed`, at: row.fpCreatedAt ?? row.createdAt,
        title: "Order placed", body: `Your ${amount} one-time investment in ${fund} is placed.` });
    case "SUCCESSFUL":
      return notify({ ...base, category: instalment ? "PLAN" : "ORDER", dedupeKey: `order:${id}:successful`, at: row.succeededAt,
        title: instalment ? "SIP instalment invested" : "Units allotted",
        body: row.allottedUnits
          ? `${row.allottedUnits.toFixed(3)} units of ${fund} allotted${row.purchasedPrice ? ` at NAV ${rupees(row.purchasedPrice)}` : ""}.`
          : `${amount} invested in ${fund}.` });
    case "FAILED":
      return notify({ ...base, category: "ACTION", dedupeKey: `order:${id}:failed`, at: row.failedAt,
        title: instalment ? "SIP instalment failed" : "Order failed",
        body: `Your ${amount} ${instalment ? "SIP instalment" : "order"} in ${fund} did not go through. ${failureText(row.failureCode)}`.trim() });
    case "CANCELLED":
      return notify({ ...base, category: "ORDER", dedupeKey: `order:${id}:cancelled`, at: row.cancelledAt,
        title: "Order cancelled", body: `Your ${amount} order in ${fund} was cancelled. Nothing was debited for it.` });
    case "REVERSED":
      return notify({ ...base, category: "ACTION", dedupeKey: `order:${id}:reversed`, at: row.reversedAt,
        title: "Order reversed", body: `The registrar reversed your ${amount} order in ${fund}; its units have been taken back.` });
  }
}

export async function notifyRedemption(id: string): Promise<void> {
  const row = await db.mfRedemption.findUnique({
    where: { id },
    select: {
      state: true, amount: true, units: true, redeemedAmount: true, failureCode: true, planId: true,
      mfInvestmentAccountId: true, createdAt: true, fpCreatedAt: true, succeededAt: true, failedAt: true,
      cancelledAt: true, scheme: { select: { name: true } },
    },
  });
  if (!row) return;
  const userId = await userForAccount(row.mfInvestmentAccountId);
  if (!userId) return;
  const fund = row.scheme.name;
  const what = row.amount ? rupees(row.amount) : row.units ? `${row.units.toFixed(3)} units` : "all units";
  const base = { userId, targetType: "order" as const, targetId: id };
  const swp = row.planId !== null;

  switch (row.state) {
    case "UNDER_REVIEW":
    case "PENDING":
    case "CONFIRMED":
    case "SUBMITTED":
      if (swp) return;
      return notify({ ...base, category: "ORDER", dedupeKey: `order:${id}:placed`, at: row.fpCreatedAt ?? row.createdAt,
        title: "Redemption placed", body: `Your request to redeem ${what} of ${fund} is placed.` });
    case "SUCCESSFUL":
      return notify({ ...base, category: swp ? "PLAN" : "ORDER", dedupeKey: `order:${id}:successful`, at: row.succeededAt,
        title: swp ? "SWP withdrawal processed" : "Redemption complete",
        body: `${row.redeemedAmount ? rupees(row.redeemedAmount) : what} from ${fund} is on its way to your bank — usually 2–3 working days.` });
    case "FAILED":
      return notify({ ...base, category: "ACTION", dedupeKey: `order:${id}:failed`, at: row.failedAt,
        title: swp ? "SWP withdrawal failed" : "Redemption failed",
        body: `Redeeming ${what} of ${fund} did not go through; your units are untouched. ${failureText(row.failureCode)}`.trim() });
    case "CANCELLED":
      return notify({ ...base, category: "ORDER", dedupeKey: `order:${id}:cancelled`, at: row.cancelledAt,
        title: "Redemption cancelled", body: `Your request to redeem ${what} of ${fund} was cancelled.` });
  }
}

export async function notifySwitch(id: string): Promise<void> {
  const row = await db.mfSwitch.findUnique({
    where: { id },
    select: {
      state: true, amount: true, units: true, switchedInAmount: true, failureCode: true, planId: true,
      mfInvestmentAccountId: true, createdAt: true, fpCreatedAt: true, succeededAt: true, failedAt: true,
      cancelledAt: true, switchOutScheme: { select: { name: true } }, switchInScheme: { select: { name: true } },
    },
  });
  if (!row) return;
  const userId = await userForAccount(row.mfInvestmentAccountId);
  if (!userId) return;
  const from = row.switchOutScheme.name;
  const into = row.switchInScheme.name;
  const what = row.amount ? rupees(row.amount) : row.units ? `${row.units.toFixed(3)} units` : "all units";
  const base = { userId, targetType: "order" as const, targetId: id };
  const stp = row.planId !== null;

  switch (row.state) {
    case "UNDER_REVIEW":
    case "PENDING":
    case "CONFIRMED":
    case "SUBMITTED":
      if (stp) return;
      return notify({ ...base, category: "ORDER", dedupeKey: `order:${id}:placed`, at: row.fpCreatedAt ?? row.createdAt,
        title: "Switch placed", body: `Switching ${what} from ${from} to ${into}.` });
    case "SUCCESSFUL":
      return notify({ ...base, category: stp ? "PLAN" : "ORDER", dedupeKey: `order:${id}:successful`, at: row.succeededAt,
        title: stp ? "STP transfer done" : "Switch complete",
        body: `${row.switchedInAmount ? rupees(row.switchedInAmount) : what} moved from ${from} into ${into}.` });
    case "FAILED":
      return notify({ ...base, category: "ACTION", dedupeKey: `order:${id}:failed`, at: row.failedAt,
        title: stp ? "STP transfer failed" : "Switch failed",
        body: `Switching ${what} from ${from} did not go through; your units are untouched. ${failureText(row.failureCode)}`.trim() });
    case "CANCELLED":
      return notify({ ...base, category: "ORDER", dedupeKey: `order:${id}:cancelled`, at: row.cancelledAt,
        title: "Switch cancelled", body: `Your switch from ${from} to ${into} was cancelled.` });
  }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

type PlanKind = "sip" | "swp" | "stp";

const planNoun: Record<PlanKind, string> = { sip: "SIP", swp: "SWP", stp: "STP" };

export async function notifyPlan(kind: PlanKind, id: string): Promise<void> {
  const select = {
    state: true, amount: true, reason: true, nextInstallmentDate: true, mfInvestmentAccountId: true,
    activatedAt: true, cancelledAt: true, failedAt: true, completedAt: true,
  } as const;
  const named = { ...select, scheme: { select: { name: true } } } as const;
  const found =
    kind === "sip"
      ? await db.mfPurchasePlan.findUnique({ where: { id }, select: named })
      : kind === "swp"
        ? await db.mfRedemptionPlan.findUnique({ where: { id }, select: named })
        : await db.mfSwitchPlan
            .findUnique({ where: { id }, select: { ...select, switchOutScheme: { select: { name: true } } } })
            .then((plan) => plan && { ...plan, scheme: plan.switchOutScheme });
  if (!found) return;
  const row = found;
  const userId = await userForAccount(row.mfInvestmentAccountId);
  if (!userId) return;
  const fund = row.scheme.name;
  const noun = planNoun[kind];
  const amount = row.amount ? `${rupees(row.amount)}/month` : "";
  const base = { userId, targetType: "plan" as const, targetId: id };
  const next = row.nextInstallmentDate
    ? row.nextInstallmentDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })
    : null;

  switch (row.state) {
    case PlanState.ACTIVE:
      return notify({ ...base, category: "PLAN", dedupeKey: `plan:${id}:active`, at: row.activatedAt,
        title: `${noun} started`,
        body: `Your ${amount ? `${amount} ` : ""}${noun} in ${fund} is active${next ? ` — next instalment on ${next}` : ""}.` });
    case PlanState.CANCELLED:
      return notify({ ...base, category: "PLAN", dedupeKey: `plan:${id}:cancelled`, at: row.cancelledAt,
        title: `${noun} cancelled`, body: `Your ${noun} in ${fund} is cancelled. No further instalments will be taken.` });
    case PlanState.FAILED:
      return notify({ ...base, category: "ACTION", dedupeKey: `plan:${id}:failed`, at: row.failedAt,
        title: `${noun} could not start`, body: `Your ${noun} in ${fund} was not accepted. ${row.reason ?? ""}`.trim() });
    case PlanState.COMPLETED:
      return notify({ ...base, category: "PLAN", dedupeKey: `plan:${id}:completed`, at: row.completedAt,
        title: `${noun} completed`, body: `Every instalment of your ${noun} in ${fund} is done.` });
  }
}

/** A change the investor made to a running plan: pause, resume, amount. */
export async function notifyPlanChange(
  planId: string,
  event: { key: string; title: string; body: string; category?: NotificationCategory },
): Promise<void> {
  const plan = await db.mfPurchasePlan.findUnique({ where: { id: planId }, select: { mfInvestmentAccountId: true } });
  if (!plan) return;
  const userId = await userForAccount(plan.mfInvestmentAccountId);
  if (!userId) return;
  await notify({
    userId, category: event.category ?? "PLAN", targetType: "plan", targetId: planId,
    dedupeKey: `plan:${planId}:${event.key}`, title: event.title, body: event.body,
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export async function notifyPayment(id: string): Promise<void> {
  const row = await db.payment.findUnique({
    where: { id },
    select: {
      status: true, amount: true, mandateId: true, failedReason: true, settledAt: true, failedAt: true, rejectedAt: true,
      debitConfirmedAt: true,
      purchases: { select: { mfPurchase: { select: { id: true, mfInvestmentAccountId: true, planId: true } } } },
    },
  });
  // A mandate debit is an instalment; its order's own notification says it all.
  if (!row || row.mandateId || row.purchases.length === 0) return;
  const first = row.purchases[0]!.mfPurchase;
  const userId = await userForAccount(first.mfInvestmentAccountId);
  if (!userId) return;
  const orders = row.purchases.length;
  const base = { userId, targetType: "order" as const, targetId: first.id };
  const what = orders > 1 ? `your ${orders} orders` : "your order";

  if (row.status === "SUCCESS" || row.status === "APPROVED") {
    return notify({ ...base, category: "PAYMENT", dedupeKey: `payment:${id}:paid`, at: row.debitConfirmedAt ?? row.settledAt,
      title: "Payment received", body: `${rupees(row.amount)} received for ${what}. Units are allotted at the applicable NAV.` });
  }
  if (row.status === "FAILED" || row.status === "REJECTED") {
    return notify({ ...base, category: "ACTION", dedupeKey: `payment:${id}:failed`, at: row.failedAt ?? row.rejectedAt,
      title: "Payment failed",
      body: `The ${rupees(row.amount)} payment for ${what} did not go through. Nothing was debited. ${row.failedReason ?? ""}`.trim() });
  }
}

// ---------------------------------------------------------------------------
// Reading them
// ---------------------------------------------------------------------------

const select = {
  id: true, category: true, title: true, body: true, targetType: true, targetId: true, readAt: true, createdAt: true,
} satisfies Prisma.NotificationSelect;

type Row = Prisma.NotificationGetPayload<{ select: typeof select }>;

const toDto = (row: Row): NotificationDto => ({
  id: row.id,
  category: row.category,
  title: row.title,
  body: row.body,
  target: row.targetType && row.targetId ? { type: row.targetType as "order" | "plan" | "ticket", id: row.targetId } : null,
  read: row.readAt !== null,
  createdAt: row.createdAt.toISOString(),
});

/** Newest first, a page at a time; the cursor is the last id seen. */
export async function listNotifications(
  userId: string,
  options: { cursor?: string; unreadOnly?: boolean } = {},
): Promise<NotificationPage> {
  const where = { userId, ...(options.unreadOnly && { readAt: null }) };
  const [rows, unread] = await Promise.all([
    db.notification.findMany({
      where,
      select,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE + 1,
      ...(options.cursor && { cursor: { id: options.cursor }, skip: 1 }),
    }),
    db.notification.count({ where: { userId, readAt: null } }),
  ]);
  const more = rows.length > PAGE;
  const page = rows.slice(0, PAGE);
  return { data: page.map(toDto), unreadCount: unread, nextCursor: more ? (page.at(-1)?.id ?? null) : null };
}

export async function unreadCount(userId: string): Promise<number> {
  return db.notification.count({ where: { userId, readAt: null } });
}

export async function markRead(userId: string, id: string): Promise<NotificationDto> {
  const row = await db.notification.findFirst({ where: { id, userId }, select: { id: true, readAt: true } });
  if (!row) throw HttpError.notFound("No such notification");
  const updated = await db.notification.update({
    where: { id },
    data: { readAt: row.readAt ?? new Date() },
    select,
  });
  return toDto(updated);
}

export async function markAllRead(userId: string): Promise<{ unreadCount: number }> {
  await db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return { unreadCount: 0 };
}
