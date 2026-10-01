// Compliance alerts: conditions a distributor has to act on, raised by a scan
// of the mirror rather than typed in by anyone.
//
// Each detector below is one rule and yields `Detection`s, each keyed by a
// `dedupeKey` that names the condition and, where it has one, its episode:
// a SIP's failure streak is keyed by the streak's first failed instalment, so
// a new streak after a recovery is a new alert, and a streak that grows keeps
// its one alert.
//
// The scan reconciles detections with what is stored:
//   - a new condition raises an alert;
//   - a condition still present refreshes its alert's severity and wording;
//   - an open alert whose condition has gone is resolved by the scan;
//   - a condition that returns reopens an alert the scan resolved at once, and
//     one a person resolved only after a week — a person who resolved it
//     while the data still showed it had a reason, and a queue that reopens
//     their work every ten minutes stops being worked;
//   - a dismissed alert is never reopened for the same condition.
//
// One instance scans at a time, under a lease row in `projection_checkpoints`
// (session locks do not survive the transaction-mode pooler). The scan only
// reads the mirror and writes these two tables; it never calls FP.
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { KYC_NEXT_STEP_LABELS, KYC_STATUS_LABELS } from "../utils/admin-labels.ts";
import { maskEmail, maskPan, maskTail } from "../utils/mask.ts";
import { flaggedOrders } from "./admin-transaction.service.ts";
import { acquireJobLease, intervalFromEnv, jobLastCompleted, jobLoop, releaseJobLease } from "./job-lease.ts";
import { stalledWhere } from "./admin-investor.service.ts";
import { nextStepOf } from "./investor-facts.service.ts";
import { notify, type NotifyInput } from "./notification.service.ts";
import {
  ALERT_KINDS,
  type AlertAction,
  type AlertDetailDto,
  type AlertEntityType,
  type AlertKind,
  type AlertListDto,
  type AlertListItemDto,
  type AlertListQuery,
  type AlertStatus,
  type AlertSummaryDto,
  type Detection,
  type ScanResultDto,
} from "../types/compliance.types.ts";
import type { AdminKycStatus } from "../types/admin-investor.types.ts";
import type { StaffPrincipal } from "../types/staff.types.ts";
import type { TicketInvestorDto } from "../types/support.types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A person's resolution stands this long before a condition still present reopens it. */
const MANUAL_RESOLVE_GRACE_MS = 7 * DAY_MS;
/** A mandate the investor has not authorised in this long is abandoned, not in progress. */
const MANDATE_PENDING_DAYS = 3;
/** Consecutive failed SIP instalments that make a pattern rather than a bad day. */
const SIP_FAILURE_STREAK = 2;

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  KYC_STALLED: "KYC stalled",
  KYC_FAILED: "KYC failed",
  SIP_FAILURES: "SIP failures",
  MANDATE_REJECTED: "Mandate rejected",
  MANDATE_PENDING: "Mandate pending",
  PAID_NOT_ALLOTTED: "Paid, not allotted",
  ORDER_STUCK: "Order stuck",
  NOMINEE_MISSING: "Nominee missing",
};

const rupees = (value: Prisma.Decimal | string | number | null | undefined) =>
  value == null ? "" : `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const day = (value: Date) => value.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** The investor behind an investor profile, as a SQL lateral join yielding `user_id`. */
const selfLink = (profileId: Prisma.Sql) => Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT l."userId" AS user_id FROM user_investor_profiles l
    WHERE l."investorProfileId" = ${profileId} AND l.relationship = 'SELF' LIMIT 1
  ) link ON true`;

// --- detectors ----------------------------------------------------------------------

async function detectKyc(): Promise<Detection[]> {
  const [stalled, failed] = await Promise.all([
    db.investorJourneySnapshot.findMany({
      where: stalledWhere(),
      select: {
        userId: true, kycMovedAt: true, kycFormStatus: true, kycProofStatus: true,
        kycSignatureProvided: true, kycFieldsNeeded: true,
      },
    }),
    db.investorJourneySnapshot.findMany({
      where: { kycStatus: { in: ["FAILED", "EXPIRED", "PAN_CHECK_FAILED"] } },
      select: { userId: true, kycStatus: true },
    }),
  ]);
  const now = Date.now();
  return [
    ...stalled.map((row): Detection => {
      const step = nextStepOf({
        status: row.kycFormStatus, proofStatus: row.kycProofStatus,
        signatureProvided: row.kycSignatureProvided, fieldsNeeded: row.kycFieldsNeeded,
      });
      const since = row.kycMovedAt ?? new Date(now);
      const days = Math.floor((now - since.getTime()) / DAY_MS);
      return {
        kind: "KYC_STALLED",
        // A week without movement is an investor we are about to lose.
        severity: days >= 7 ? "HIGH" : "MEDIUM",
        dedupeKey: `kyc_stalled:${row.userId}`,
        userId: row.userId,
        entityType: null,
        entityId: null,
        title: "KYC has not moved in over two days",
        detail: `The KYC form has been waiting on ${step ? KYC_NEXT_STEP_LABELS[step].toLowerCase() : "the investor"} since ${day(since)} (${days} days). The investor cannot transact until it completes.`,
      };
    }),
    ...failed.map((row): Detection => {
      const status = row.kycStatus as AdminKycStatus;
      return {
        kind: "KYC_FAILED",
        severity: "MEDIUM",
        dedupeKey: `kyc_failed:${row.userId}:${status}`,
        userId: row.userId,
        entityType: null,
        entityId: null,
        title: status === "PAN_CHECK_FAILED" ? "PAN check not passed" : `KYC ${KYC_STATUS_LABELS[status].toLowerCase()}`,
        detail: status === "PAN_CHECK_FAILED"
          ? "The PAN check did not pass (invalid PAN, or not linked to Aadhaar). The investor has to fix it with the tax department before KYC can continue."
          : status === "EXPIRED"
            ? "The KYC form expired before it was completed. The investor has to start KYC again."
            : "The KYC registration failed at the KRA. The investor has to redo KYC with corrected details.",
      };
    }),
  ];
}

async function detectSipFailures(): Promise<Detection[]> {
  const rows = await db.$queryRaw<{
    plan_id: string; id: string; state: string; reason: string | null; amount: Prisma.Decimal; scheme: string; user_id: string | null;
  }[]>`
    SELECT p."planId" AS plan_id, p.id, p.state::text AS state, p."failureReason" AS reason,
           pl.amount, s.name AS scheme, link.user_id
    FROM (
      SELECT id, "planId", state, "failureReason",
             row_number() OVER (PARTITION BY "planId" ORDER BY COALESCE("fpCreatedAt", "createdAt") DESC, id DESC) AS rn
      FROM mf_purchases WHERE "planId" IS NOT NULL
    ) p
    JOIN mf_purchase_plans pl ON pl.id = p."planId" AND pl.state = 'active'
    JOIN mf_schemes s ON s.isin = pl."schemeIsin"
    JOIN mf_investment_accounts a ON a.id = pl."mfInvestmentAccountId"
    ${selfLink(Prisma.sql`a."primaryInvestorProfileId"`)}
    WHERE p.rn <= 12
    ORDER BY p."planId", p.rn`;

  const byPlan = new Map<string, typeof rows>();
  for (const row of rows) byPlan.set(row.plan_id, [...(byPlan.get(row.plan_id) ?? []), row]);

  const detections: Detection[] = [];
  for (const [planId, installments] of byPlan) {
    // Newest first: count failures until the first instalment that did not fail.
    let streak = 0;
    while (streak < installments.length && installments[streak]!.state === "failed") streak++;
    if (streak < SIP_FAILURE_STREAK) continue;
    const latest = installments[0]!;
    const firstOfStreak = installments[streak - 1]!;
    detections.push({
      kind: "SIP_FAILURES",
      severity: streak >= 3 ? "HIGH" : "MEDIUM",
      dedupeKey: `sip_failures:${planId}:${firstOfStreak.id}`,
      userId: latest.user_id,
      entityType: "plan",
      entityId: planId,
      title: `${streak} SIP instalments failed in a row`,
      detail: `${latest.scheme}, ${rupees(latest.amount)} a month. Latest reason: ${latest.reason ?? "not given"}. Repeated failures usually mean low balance or a mandate problem.`,
    });
  }
  return detections;
}

async function detectMandates(): Promise<Detection[]> {
  const rows = await db.$queryRaw<{
    id: string; status: string; reason: string | null; created: Date; mandate_limit: Prisma.Decimal; last4: string; user_id: string | null; live_plans: number;
  }[]>`
    SELECT m.id, m."mandateStatus"::text AS status, m."rejectedReason" AS reason,
           COALESCE(m."fpCreatedAt", m."createdAt") AS created, m."mandateLimit" AS mandate_limit,
           ba."accountNumberLast4" AS last4, link.user_id,
           (SELECT count(*)::int FROM mf_purchase_plans pl
             WHERE pl."mandateId" = m.id AND pl.state IN ('created', 'review_completed', 'confirmed', 'submitted', 'active')) AS live_plans
    FROM mandates m
    JOIN bank_accounts ba ON ba.id = m."bankAccountId"
    ${selfLink(Prisma.sql`ba."investorProfileId"`)}
    WHERE m."mandateStatus" = 'REJECTED'
       OR (m."mandateStatus" IN ('CREATED', 'RECEIVED', 'SUBMITTED')
           AND COALESCE(m."fpCreatedAt", m."createdAt") < now() - make_interval(days => ${MANDATE_PENDING_DAYS}))`;

  const detections: Detection[] = [];
  for (const row of rows) {
    const bank = `bank account XXXXXX${row.last4}`;
    if (row.status === "REJECTED") {
      // A rejected mandate nobody relies on is history; one behind a live SIP stops the SIP.
      if (row.live_plans === 0) continue;
      detections.push({
        kind: "MANDATE_REJECTED",
        severity: "HIGH",
        dedupeKey: `mandate_rejected:${row.id}`,
        userId: row.user_id,
        entityType: "mandate",
        entityId: row.id,
        title: "Mandate rejected behind a live SIP",
        detail: `The bank rejected the AutoPay mandate on ${bank}${row.reason ? ` (${row.reason})` : ""}. ${row.live_plans} SIP${row.live_plans === 1 ? "" : "s"} cannot be debited until a new mandate is approved.`,
      });
    } else {
      detections.push({
        kind: "MANDATE_PENDING",
        severity: row.live_plans > 0 ? "MEDIUM" : "LOW",
        dedupeKey: `mandate_pending:${row.id}`,
        userId: row.user_id,
        entityType: "mandate",
        entityId: row.id,
        title: "Mandate authorisation not completed",
        detail: `An AutoPay mandate of ${rupees(row.mandate_limit)} on ${bank} has been waiting for the investor's bank authorisation since ${day(row.created)}${row.live_plans > 0 ? `, with ${row.live_plans} SIP${row.live_plans === 1 ? "" : "s"} depending on it` : ""}.`,
      });
    }
  }
  return detections;
}

async function detectOrders(): Promise<Detection[]> {
  const orders = await flaggedOrders(["PAID_NOT_CONFIRMED", "NOT_SUBMITTED", "STUCK_AT_RTA"]);
  return orders.map((order): Detection => {
    const what = `${order.scheme}${order.amount ? `, ${rupees(order.amount)}` : ""}`;
    if (order.flag === "PAID_NOT_CONFIRMED") {
      return {
        kind: "PAID_NOT_ALLOTTED",
        severity: "HIGH",
        dedupeKey: `paid_not_allotted:${order.id}`,
        userId: order.investor.id,
        entityType: "order",
        entityId: order.id,
        title: "Payment collected, order not confirmed",
        detail: `${what}. The payment succeeded but the order is still ${order.state.toLowerCase().replaceAll("_", " ")}: the investor's money has moved and no units are on the way. Refresh it from FP, then escalate.`,
      };
    }
    return {
      kind: "ORDER_STUCK",
      severity: "MEDIUM",
      dedupeKey: `order_stuck:${order.id}`,
      userId: order.investor.id,
      entityType: "order",
      entityId: order.id,
      title: order.flag === "STUCK_AT_RTA" ? "Order with the RTA for over three days" : "Order confirmed but not submitted",
      detail: `${what}, placed ${day(new Date(order.placedAt))}. ${order.flag === "STUCK_AT_RTA" ? "The registrar has not reported an outcome." : "It has not been sent to the registrar a day after confirmation."}`,
    };
  });
}

async function detectNominees(): Promise<Detection[]> {
  // SEBI requires every folio to carry a nomination or a signed opt-out. An
  // account holding units with neither, at account or folio level, is out of line.
  const rows = await db.$queryRaw<{ id: string; user_id: string | null; value: Prisma.Decimal | null; folios: number }[]>`
    SELECT a.id, link.user_id, sum(h."marketValue") AS value, count(DISTINCT h."folioNumber")::int AS folios
    FROM mf_investment_accounts a
    JOIN mf_holdings h ON h."mfInvestmentAccountId" = a.id AND h.units > 0
    LEFT JOIN investor_onboardings o ON o."investorProfileId" = a."primaryInvestorProfileId"
    ${selfLink(Prisma.sql`a."primaryInvestorProfileId"`)}
    WHERE o."nominationOptOutAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM mf_investment_account_nominees n WHERE n."mfInvestmentAccountId" = a.id)
      AND NOT EXISTS (
        SELECT 1 FROM mf_folio_nominees fn JOIN mf_folios f ON f.id = fn."mfFolioId"
        WHERE f."mfInvestmentAccountId" = a.id
      )
    GROUP BY a.id, link.user_id`;
  return rows.map((row): Detection => ({
    kind: "NOMINEE_MISSING",
    severity: "MEDIUM",
    dedupeKey: `nominee_missing:${row.id}`,
    userId: row.user_id,
    entityType: "account",
    entityId: row.id,
    title: "Holdings with no nominee and no opt-out",
    detail: `${row.folios} folio${row.folios === 1 ? "" : "s"} worth ${rupees(row.value)} carry no nomination and no opt-out declaration. SEBI requires one or the other on every folio.`,
  }));
}

const DETECTORS = [detectKyc, detectSipFailures, detectMandates, detectOrders, detectNominees];

// --- the scan -----------------------------------------------------------------------

const LEASE_NAME = "compliance_alerts";
const LEASE_MS = 5 * 60_000;

/** One pass of every rule. Exported for the "Run checks now" button and for tests. */
export async function runComplianceScan(): Promise<ScanResultDto> {
  const at = new Date();
  if (!(await acquireJobLease(LEASE_NAME, LEASE_MS))) return { mode: "skipped", detected: 0, raised: 0, reopened: 0, autoResolved: 0, at: at.toISOString() };
  try {
    const detections = new Map<string, Detection>();
    for (const detector of DETECTORS) for (const found of await detector()) detections.set(found.dedupeKey, found);

    const existing = await db.complianceAlert.findMany({
      where: {
        OR: [{ status: { in: ["OPEN", "ACKNOWLEDGED"] } }, { dedupeKey: { in: [...detections.keys()] } }],
      },
      select: { id: true, dedupeKey: true, status: true, autoResolved: true, resolvedAt: true },
    });
    const byKey = new Map(existing.map((alert) => [alert.dedupeKey, alert]));
    let raised = 0;
    let reopened = 0;
    let autoResolved = 0;

    for (const found of detections.values()) {
      const current = byKey.get(found.dedupeKey);
      const facts = { severity: found.severity, title: found.title, detail: found.detail, lastDetectedAt: at };
      if (!current) {
        await db.complianceAlert.create({
          data: {
            ...facts, kind: found.kind, dedupeKey: found.dedupeKey, userId: found.userId,
            entityType: found.entityType, entityId: found.entityId, firstDetectedAt: at,
            events: { create: { type: "DETECTED" } },
          },
        });
        raised++;
        continue;
      }
      const reopen = current.status === "RESOLVED" &&
        (current.autoResolved || !current.resolvedAt || at.getTime() - current.resolvedAt.getTime() > MANUAL_RESOLVE_GRACE_MS);
      await db.complianceAlert.update({
        where: { id: current.id },
        data: {
          ...facts,
          ...(reopen && {
            status: "OPEN", resolvedAt: null, resolvedByStaffId: null, resolution: null, autoResolved: false,
            events: { create: { type: "REOPENED", note: "The condition was detected again." } },
          }),
        },
      });
      if (reopen) reopened++;
    }

    for (const alert of existing) {
      if (detections.has(alert.dedupeKey) || (alert.status !== "OPEN" && alert.status !== "ACKNOWLEDGED")) continue;
      await db.complianceAlert.update({
        where: { id: alert.id },
        data: {
          status: "RESOLVED", resolvedAt: at, autoResolved: true, resolution: "The condition cleared.",
          events: { create: { type: "AUTO_RESOLVED", note: "The condition is no longer present." } },
        },
      });
      autoResolved++;
    }

    await releaseJobLease(LEASE_NAME, at);
    return { mode: "ran", detected: detections.size, raised, reopened, autoResolved, at: at.toISOString() };
  } catch (error) {
    await releaseJobLease(LEASE_NAME, null).catch(() => undefined);
    throw error;
  }
}

// --- reading ------------------------------------------------------------------------

const listSelect = {
  id: true, kind: true, severity: true, status: true, title: true, detail: true, userId: true,
  entityType: true, entityId: true, firstDetectedAt: true, lastDetectedAt: true, resolvedAt: true, autoResolved: true,
  assignedStaff: { select: { id: true, fullName: true } },
} as const satisfies Prisma.ComplianceAlertSelect;

type ListRow = Prisma.ComplianceAlertGetPayload<{ select: typeof listSelect }>;

async function investorsById(userIds: (string | null)[]): Promise<Map<string, TicketInvestorDto>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();
  const rows = await db.investorJourneySnapshot.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, name: true, phone: true, email: true, pan: true },
  });
  return new Map(rows.map((row) => [row.userId, {
    id: row.userId, name: row.name, phone: maskTail(row.phone), email: maskEmail(row.email), pan: maskPan(row.pan),
  }]));
}

function toListItem(row: ListRow, investors: Map<string, TicketInvestorDto>): AlertListItemDto {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    title: row.title,
    detail: row.detail,
    investor: row.userId ? investors.get(row.userId) ?? { id: row.userId, name: null, phone: null, email: null, pan: null } : null,
    entity: row.entityType && row.entityId ? { type: row.entityType as AlertEntityType, id: row.entityId } : null,
    assignee: row.assignedStaff ? { id: row.assignedStaff.id, name: row.assignedStaff.fullName } : null,
    firstDetectedAt: row.firstDetectedAt.toISOString(),
    lastDetectedAt: row.lastDetectedAt.toISOString(),
    ageDays: Math.floor(((row.resolvedAt ?? new Date()).getTime() - row.firstDetectedAt.getTime()) / DAY_MS),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    autoResolved: row.autoResolved,
  };
}

const LIVE: AlertStatus[] = ["OPEN", "ACKNOWLEDGED"];

async function summary(): Promise<AlertSummaryDto> {
  const live = { status: { in: LIVE } } satisfies Prisma.ComplianceAlertWhereInput;
  const [open, high, ageing, unassigned, byKind, [closed], checkpoint] = await Promise.all([
    db.complianceAlert.count({ where: live }),
    db.complianceAlert.count({ where: { ...live, severity: "HIGH" } }),
    db.complianceAlert.count({ where: { ...live, firstDetectedAt: { lt: new Date(Date.now() - 7 * DAY_MS) } } }),
    db.complianceAlert.count({ where: { ...live, assignedStaffId: null } }),
    db.complianceAlert.groupBy({ by: ["kind"], where: live, _count: { _all: true } }),
    db.$queryRaw<{ n: number; median: number | null }[]>`
      SELECT count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ("resolvedAt" - "firstDetectedAt")) / 3600) AS median
      FROM compliance_alerts WHERE status = 'RESOLVED' AND "resolvedAt" >= now() - interval '30 days'`,
    jobLastCompleted(LEASE_NAME),
  ]);
  const counts = new Map(byKind.map((row) => [row.kind, row._count._all]));
  return {
    open,
    high,
    ageingOver7Days: ageing,
    unassigned,
    byKind: ALERT_KINDS.map((key) => ({ key, label: ALERT_KIND_LABELS[key], count: counts.get(key) ?? 0 })),
    resolvedLast30Days: closed?.n ?? 0,
    medianHoursToClose: closed?.median == null ? null : Math.round(Number(closed.median) * 10) / 10,
    lastScanAt: checkpoint?.toISOString() ?? null,
  };
}

export async function listAlerts(query: AlertListQuery): Promise<AlertListDto> {
  const and: Prisma.ComplianceAlertWhereInput[] = [];
  const statuses = query.status ?? LIVE;
  and.push({ status: { in: statuses } });
  if (query.kind) and.push({ kind: { in: query.kind } });
  if (query.severity) and.push({ severity: { in: query.severity } });
  if (query.assignee === "unassigned") and.push({ assignedStaffId: null });
  else if (query.assignee) and.push({ assignedStaffId: query.assignee });
  if (query.search) {
    const matches = await db.investorJourneySnapshot.findMany({
      where: { name: { contains: query.search, mode: "insensitive" } },
      select: { userId: true },
      take: 200,
    });
    and.push({
      OR: [
        { title: { contains: query.search, mode: "insensitive" } },
        { detail: { contains: query.search, mode: "insensitive" } },
        ...(matches.length ? [{ userId: { in: matches.map((m) => m.userId) } }] : []),
      ],
    });
  }
  // The live queue is worked most urgent, then oldest, first; history reads newest first.
  const history = statuses.every((status) => !LIVE.includes(status));
  const orderBy: Prisma.ComplianceAlertOrderByWithRelationInput[] = history
    ? [{ updatedAt: "desc" }, { id: "desc" }]
    : [{ severity: "asc" }, { firstDetectedAt: "asc" }, { id: "asc" }];

  const [rows, counts] = await Promise.all([
    db.complianceAlert.findMany({
      where: { AND: and },
      select: listSelect,
      orderBy,
      take: query.limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
    }),
    summary(),
  ]);
  const shown = rows.slice(0, query.limit);
  const investors = await investorsById(shown.map((row) => row.userId));
  return {
    items: shown.map((row) => toListItem(row, investors)),
    nextCursor: rows.length > query.limit ? (shown.at(-1)?.id ?? null) : null,
    summary: counts,
  };
}

export async function getAlert(id: string): Promise<AlertDetailDto> {
  const row = await db.complianceAlert.findUnique({
    where: { id },
    select: {
      ...listSelect, resolution: true, lastRemindedAt: true,
      resolvedByStaff: { select: { id: true, fullName: true } },
      events: {
        orderBy: { createdAt: "asc" },
        select: { id: true, type: true, note: true, createdAt: true, actorStaff: { select: { fullName: true } } },
      },
    },
  });
  if (!row) throw HttpError.notFound("No alert with that id");
  const investors = await investorsById([row.userId]);
  return {
    ...toListItem(row, investors),
    resolution: row.resolution,
    resolvedBy: row.resolvedByStaff ? { id: row.resolvedByStaff.id, name: row.resolvedByStaff.fullName } : null,
    lastRemindedAt: row.lastRemindedAt?.toISOString() ?? null,
    canRemind: Boolean(row.userId) && REMINDERS[row.kind] !== null,
    events: row.events.map((event) => ({
      id: event.id,
      type: event.type,
      staffName: event.actorStaff?.fullName ?? null,
      note: event.note,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

// --- acting on one ------------------------------------------------------------------

/** What the investor is told when staff send a reminder; null where the fix is ours, not theirs. */
const REMINDERS: Record<AlertKind, Pick<NotifyInput, "title" | "body"> | null> = {
  KYC_STALLED: { title: "Finish your KYC", body: "Your KYC is not complete yet, so you cannot invest. Open the app to pick up where you left off." },
  KYC_FAILED: { title: "Your KYC needs attention", body: "Your KYC could not be completed. Open the app to see what to fix and start again." },
  SIP_FAILURES: { title: "Your SIP instalments are failing", body: "The last few instalments of your SIP did not go through. Check your bank balance and your AutoPay mandate." },
  MANDATE_REJECTED: { title: "Your AutoPay was rejected", body: "Your bank rejected the AutoPay mandate behind your SIP. Set up AutoPay again so the next instalment goes through." },
  MANDATE_PENDING: { title: "Finish setting up AutoPay", body: "Your AutoPay mandate is still waiting for your bank's approval. Complete it in the app so your SIP can start." },
  NOMINEE_MISSING: { title: "Add a nominee", body: "SEBI asks every investor to add a nominee or confirm they choose not to. You can do it in the app under Profile." },
  PAID_NOT_ALLOTTED: null,
  ORDER_STUCK: null,
};

async function assertAgent(staffId: string): Promise<void> {
  const agent = await db.staffUser.findFirst({
    where: {
      id: staffId, status: "ACTIVE",
      roles: { some: { role: { permissions: { some: { permissionKey: "compliance.manage" } } } } },
    },
    select: { id: true },
  });
  if (!agent) throw HttpError.badRequest("That staff member cannot be assigned compliance alerts");
}

/** Active staff who can work alerts, for the assignee picker. */
export async function listAssignees(): Promise<{ id: string; name: string }[]> {
  const rows = await db.staffUser.findMany({
    where: { status: "ACTIVE", roles: { some: { role: { permissions: { some: { permissionKey: "compliance.manage" } } } } } },
    select: { id: true, fullName: true },
    orderBy: { fullName: "asc" },
  });
  return rows.map((row) => ({ id: row.id, name: row.fullName }));
}

export async function actOnAlert(id: string, action: AlertAction, viewer: StaffPrincipal): Promise<AlertDetailDto> {
  const alert = await db.complianceAlert.findUnique({
    where: { id },
    select: { id: true, kind: true, status: true, userId: true, entityType: true, entityId: true, assignedStaffId: true, lastRemindedAt: true },
  });
  if (!alert) throw HttpError.notFound("No alert with that id");
  const live = alert.status === "OPEN" || alert.status === "ACKNOWLEDGED";
  const now = new Date();
  const event = (type: string, note?: string | null) => ({ create: { type, actorStaffId: viewer.staffId, note: note ?? null } });
  const closed = () => HttpError.conflict("This alert is already closed. Reopen it first.");

  switch (action.type) {
    case "acknowledge":
      if (alert.status !== "OPEN") throw HttpError.conflict("Only an open alert can be acknowledged");
      await db.complianceAlert.update({
        where: { id },
        data: {
          status: "ACKNOWLEDGED",
          // Acknowledging something nobody owns makes it yours.
          ...(!alert.assignedStaffId && { assignedStaffId: viewer.staffId }),
          events: event("ACKNOWLEDGED"),
        },
      });
      break;
    case "assign": {
      if (!live) throw closed();
      if (action.assigneeId) await assertAgent(action.assigneeId);
      const name = action.assigneeId
        ? (await db.staffUser.findUnique({ where: { id: action.assigneeId }, select: { fullName: true } }))?.fullName
        : null;
      await db.complianceAlert.update({
        where: { id },
        data: { assignedStaffId: action.assigneeId, events: event("ASSIGNED", name ? `Assigned to ${name}` : "Unassigned") },
      });
      break;
    }
    case "resolve":
    case "dismiss":
      if (!live) throw closed();
      await db.complianceAlert.update({
        where: { id },
        data: {
          status: action.type === "resolve" ? "RESOLVED" : "DISMISSED",
          resolvedAt: now, resolvedByStaffId: viewer.staffId, resolution: action.note, autoResolved: false,
          events: event(action.type === "resolve" ? "RESOLVED" : "DISMISSED", action.note),
        },
      });
      break;
    case "reopen":
      if (live) throw HttpError.conflict("This alert is already open");
      await db.complianceAlert.update({
        where: { id },
        data: {
          status: "OPEN", resolvedAt: null, resolvedByStaffId: null, resolution: null, autoResolved: false,
          events: event("REOPENED", action.note),
        },
      });
      break;
    case "note":
      await db.complianceAlertEvent.create({ data: { alertId: id, type: "NOTE", actorStaffId: viewer.staffId, note: action.note } });
      break;
    case "remind": {
      const message = REMINDERS[alert.kind];
      if (!message || !alert.userId) throw HttpError.badRequest("There is nothing for the investor to do on this alert");
      if (!live) throw closed();
      if (alert.lastRemindedAt && now.getTime() - alert.lastRemindedAt.getTime() < DAY_MS) {
        throw HttpError.conflict("The investor was already reminded in the last 24 hours");
      }
      await notify({
        userId: alert.userId,
        category: "ACTION",
        ...message,
        dedupeKey: `compliance:${id}:${now.toISOString().slice(0, 10)}`,
        ...(alert.entityType === "plan" && alert.entityId && { targetType: "plan" as const, targetId: alert.entityId }),
      });
      await db.complianceAlert.update({ where: { id }, data: { lastRemindedAt: now, events: event("REMINDED", message.title) } });
      break;
    }
  }
  return getAlert(id);
}

// --- the loop -------------------------------------------------------------------------

async function tick(): Promise<void> {
  try {
    const run = await runComplianceScan();
    if (run.raised || run.reopened || run.autoResolved) {
      console.log(`[compliance] raised=${run.raised} reopened=${run.reopened} auto-resolved=${run.autoResolved} (${run.detected} conditions)`);
    }
  } catch (error) {
    // A missed scan is caught up by the next; a crashed loop is not.
    console.error("[compliance] scan failed:", error instanceof Error ? error.message : error);
  }
}

/** `COMPLIANCE_SCAN_INTERVAL_MS` (default 10 minutes); 0 turns the scan off. */
const loop = jobLoop(tick, intervalFromEnv("COMPLIANCE_SCAN_INTERVAL_MS", 10 * 60_000));
export const startComplianceScan = () => loop.start();
export const stopComplianceScan = () => loop.stop();
