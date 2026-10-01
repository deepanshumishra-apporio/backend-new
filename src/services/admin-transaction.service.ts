// Transaction monitoring: every order across investors, and the ones that
// need someone's attention.
//
// Reads the FP mirror through `orderUnionSql`, the same definition the
// transactions report uses. A flag is judged at read time against now(),
// because an order going stale changes no row. The thresholds are generous on
// purpose: an order a few hours into an RTA cycle is normal, and a queue that
// cries wolf stops being read.
//
// The one write is a refresh: re-reading an order from FP through
// `refreshOrder`, the same path the investor's own refresh takes. It never
// places, confirms or cancels anything.
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { humanise } from "../utils/admin-labels.ts";
import { HttpError } from "../utils/http-error.ts";
import { maskPan } from "../utils/mask.ts";
import { orderUnionSql } from "./admin-order-union.ts";
import { refreshOrder } from "./order.service.ts";
import {
  ORDER_FLAGS,
  type CountByKey,
  type MonitoredOrderDto,
  type MonitorOrderState,
  type OrderFlag,
  type OrderKind,
  type OrderType,
  type TransactionListDto,
  type TransactionListQuery,
  type TransactionSummaryDto,
} from "../types/admin-transaction.types.ts";
import type { StaffPrincipal } from "../types/staff.types.ts";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const FLAG_LABELS: Record<OrderFlag, string> = {
  FAILED: "Failed (7 days)",
  PAID_NOT_CONFIRMED: "Paid, not confirmed",
  NOT_SUBMITTED: "Confirmed, not submitted",
  STUCK_AT_RTA: "Stuck at RTA",
  AWAITING_INVESTOR: "Waiting on investor",
};

/** Midnight in India, `daysAgo` days back, as an instant. */
function istMidnight(daysAgo = 0): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS - daysAgo * DAY_MS);
}

/**
 * Orders with their investor, their latest payment and their flag. The order
 * of the CASE matters: an order is shown under its most urgent problem.
 */
const monitoredSql = Prisma.sql`
  SELECT o.*, link."userId" AS user_id, ip.name AS investor, ip.pan, pay.status AS payment_status, pay.at AS payment_at,
    CASE
      WHEN o.state IN ('failed', 'reversed') THEN 'FAILED'
      WHEN o.kind = 'purchase' AND o.state IN ('pending', 'under_review') AND pay.status = 'SUCCESS'
           AND COALESCE(pay.at, o.updated_at) < now() - interval '1 hour' THEN 'PAID_NOT_CONFIRMED'
      WHEN o.state = 'confirmed' AND COALESCE(o.confirmed_at, o.updated_at) < now() - interval '24 hours' THEN 'NOT_SUBMITTED'
      WHEN o.state = 'submitted' AND COALESCE(o.submitted_at, o.updated_at) < now() - interval '72 hours' THEN 'STUCK_AT_RTA'
      WHEN o.state IN ('pending', 'under_review') AND o.placed_at < now() - interval '24 hours' THEN 'AWAITING_INVESTOR'
    END AS flag
  FROM (${orderUnionSql}) o
  JOIN mf_investment_accounts a ON a.id = o.account_id
  JOIN investor_profiles ip ON ip.id = a."primaryInvestorProfileId"
  LEFT JOIN LATERAL (
    SELECT l."userId" FROM user_investor_profiles l
    WHERE l."investorProfileId" = ip.id AND l.relationship = 'SELF' LIMIT 1
  ) link ON true
  LEFT JOIN LATERAL (
    SELECT p.status::text AS status, COALESCE(p."debitConfirmedAt", p."settledAt", p."updatedAt") AS at
    FROM payment_purchases pp JOIN payments p ON p.id = pp."paymentId"
    WHERE o.kind = 'purchase' AND pp."mfPurchaseId" = o.id
    ORDER BY p."createdAt" DESC LIMIT 1
  ) pay ON true`;

type Raw = Record<string, unknown>;

const text = (value: unknown): string | null => (value === null || value === undefined || value === "" ? null : String(value));
const decimal = (value: unknown, dp: number): string | null =>
  value === null || value === undefined ? null : new Prisma.Decimal(value as Prisma.Decimal | string | number).toFixed(dp);
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);

function toDto(r: Raw): MonitoredOrderDto {
  const paymentStatus = text(r["payment_status"]);
  return {
    id: String(r["id"]),
    kind: r["kind"] as OrderKind,
    type: r["type"] as OrderType,
    investor: { id: text(r["user_id"]), name: text(r["investor"]), pan: maskPan(text(r["pan"])) },
    scheme: String(r["scheme"]),
    toScheme: text(r["to_scheme"]),
    folio: text(r["folio"]),
    amount: decimal(r["amount"], 2),
    units: decimal(r["units"], 4),
    state: String(r["state"]).toUpperCase() as MonitorOrderState,
    gateway: String(r["gateway"]).toUpperCase(),
    payment: paymentStatus ? { status: paymentStatus, at: iso(r["payment_at"]) } : null,
    flag: (text(r["flag"]) as OrderFlag | null),
    failureReason: text(r["failure_reason"]) ?? (text(r["failure_code"]) ? humanise(String(r["failure_code"])) : null),
    placedAt: iso(r["placed_at"]) ?? new Date(0).toISOString(),
    updatedAt: iso(r["updated_at"]) ?? new Date(0).toISOString(),
    completedAt: iso(r["completed_at"]),
  };
}

export const encodeTransactionCursor = (row: { placedAt: string; id: string }) =>
  Buffer.from(`${row.placedAt}|${row.id}`).toString("base64url");

export async function listTransactions(query: TransactionListQuery): Promise<TransactionListDto> {
  const conditions: Prisma.Sql[] = [];
  if (query.type) conditions.push(Prisma.sql`m.type IN (${Prisma.join(query.type)})`);
  if (query.state) conditions.push(Prisma.sql`m.state IN (${Prisma.join(query.state.map((s) => s.toLowerCase()))})`);
  if (query.flag) conditions.push(Prisma.sql`m.flag IN (${Prisma.join(query.flag)})`);
  if (query.attention) conditions.push(Prisma.sql`m.flag IS NOT NULL`);
  // Failures stay on the attention view for a week; after that they are history, not a queue.
  if (query.attention || query.flag?.includes("FAILED")) {
    conditions.push(Prisma.sql`(m.flag <> 'FAILED' OR m.placed_at >= ${istMidnight(6)})`);
  }
  if (query.from) conditions.push(Prisma.sql`m.placed_at >= ${new Date(Date.parse(`${query.from}T00:00:00Z`) - IST_OFFSET_MS)}`);
  if (query.to) conditions.push(Prisma.sql`m.placed_at < ${new Date(Date.parse(`${query.to}T00:00:00Z`) - IST_OFFSET_MS + DAY_MS)}`);
  if (query.search) {
    const like = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(Prisma.sql`(
      m.investor ILIKE ${like} OR m.scheme ILIKE ${like} OR m.folio = ${query.search}
      OR (length(${query.search}) = 4 AND right(m.pan, 4) = upper(${query.search}))
    )`);
  }
  if (query.cursor) {
    conditions.push(Prisma.sql`(m.placed_at, m.id) < (${query.cursor.at}, ${query.cursor.id}::uuid)`);
  }
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
  const rows = await db.$queryRaw<Raw[]>`
    SELECT * FROM (${monitoredSql}) m ${where}
    ORDER BY m.placed_at DESC, m.id DESC
    LIMIT ${query.limit + 1}`;
  const items = rows.slice(0, query.limit).map(toDto);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > query.limit && last ? encodeTransactionCursor(last) : null };
}

/** Every order currently carrying one of these flags, for the compliance scan. Not paged: flagged orders are a small set. */
export async function flaggedOrders(flags: OrderFlag[]): Promise<MonitoredOrderDto[]> {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT * FROM (${monitoredSql}) m WHERE m.flag IN (${Prisma.join(flags)})
    ORDER BY m.placed_at DESC LIMIT 2000`;
  return rows.map(toDto);
}

export async function getTransaction(id: string): Promise<MonitoredOrderDto> {
  const [row] = await db.$queryRaw<Raw[]>`SELECT * FROM (${monitoredSql}) m WHERE m.id = ${id}::uuid`;
  if (!row) throw HttpError.notFound("No order with that id");
  return toDto(row);
}

/** Re-read one order from FP. Audited: it is staff acting on an investor's order, even if only to look again. */
export async function refreshTransaction(id: string, viewer: StaffPrincipal): Promise<MonitoredOrderDto> {
  const before = await getTransaction(id);
  await refreshOrder(id);
  const after = await getTransaction(id);
  await db.auditLog.create({
    data: {
      actorStaffId: viewer.staffId, action: "STAFF_REFRESHED_ORDER", entityType: before.kind, entityId: id,
      metadata: { from: before.state, to: after.state },
    },
  });
  return after;
}

export async function getSummary(): Promise<TransactionSummaryDto> {
  const today = istMidnight(0);
  const weekAgo = istMidnight(6);
  const [[totals], flags, [payments], failures, daily] = await Promise.all([
    db.$queryRaw<{ placed: number; successful: number; failed: number; purchase_amount: Prisma.Decimal; redemption_amount: Prisma.Decimal; in_flight: number }[]>`
      SELECT
        count(*) FILTER (WHERE m.placed_at >= ${today})::int AS placed,
        count(*) FILTER (WHERE m.completed_at >= ${today} AND m.state = 'successful')::int AS successful,
        count(*) FILTER (WHERE m.placed_at >= ${today} AND m.state IN ('failed', 'reversed'))::int AS failed,
        COALESCE(sum(m.amount) FILTER (WHERE m.placed_at >= ${today} AND m.kind = 'purchase'), 0) AS purchase_amount,
        COALESCE(sum(m.amount) FILTER (WHERE m.placed_at >= ${today} AND m.kind = 'redemption'), 0) AS redemption_amount,
        count(*) FILTER (WHERE m.state IN ('under_review', 'pending', 'confirmed', 'submitted'))::int AS in_flight
      FROM (${orderUnionSql}) m`,
    db.$queryRaw<{ flag: OrderFlag; n: number }[]>`
      SELECT m.flag, count(*)::int AS n FROM (${monitoredSql}) m
      WHERE m.flag IS NOT NULL AND (m.flag <> 'FAILED' OR m.placed_at >= ${weekAgo})
      GROUP BY m.flag`,
    db.$queryRaw<{ successful: number; failed: number; pending: number; collected: Prisma.Decimal }[]>`
      SELECT
        count(*) FILTER (WHERE status = 'SUCCESS')::int AS successful,
        count(*) FILTER (WHERE status IN ('FAILED', 'REJECTED'))::int AS failed,
        count(*) FILTER (WHERE status IN ('INITIATED', 'PENDING', 'SUBMITTED', 'APPROVED'))::int AS pending,
        COALESCE(sum(amount) FILTER (WHERE status = 'SUCCESS'), 0) AS collected
      FROM payments WHERE COALESCE("fpCreatedAt", "createdAt") >= ${today}`,
    db.$queryRaw<{ reason: string; n: number }[]>`
      SELECT COALESCE(m.failure_reason, m.failure_code, 'No reason given') AS reason, count(*)::int AS n
      FROM (${orderUnionSql}) m
      WHERE m.state IN ('failed', 'reversed') AND m.placed_at >= ${istMidnight(29)}
      GROUP BY 1 ORDER BY n DESC LIMIT 5`,
    db.$queryRaw<{ d: Date; placed: number; successful: number; failed: number }[]>`
      WITH days AS (
        SELECT generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 13, (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day')::date AS d
      ),
      o AS (
        -- The order tables hold UTC in plain timestamp columns, so they are read as UTC before converting.
        SELECT ((m.placed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date AS d, m.state
        FROM (${orderUnionSql}) m WHERE m.placed_at >= ${istMidnight(13)}
      )
      SELECT days.d,
        count(o.d)::int AS placed,
        count(o.d) FILTER (WHERE o.state = 'successful')::int AS successful,
        count(o.d) FILTER (WHERE o.state IN ('failed', 'reversed'))::int AS failed
      FROM days LEFT JOIN o USING (d) GROUP BY days.d ORDER BY days.d`,
  ]);
  const flagCounts = new Map(flags.map((row) => [row.flag, row.n]));
  const money = (value: Prisma.Decimal | undefined) => new Prisma.Decimal(value ?? 0).toFixed(2);
  return {
    generatedAt: new Date().toISOString(),
    today: {
      placed: totals?.placed ?? 0,
      successful: totals?.successful ?? 0,
      failed: totals?.failed ?? 0,
      purchaseAmount: money(totals?.purchase_amount),
      redemptionAmount: money(totals?.redemption_amount),
    },
    inFlight: totals?.in_flight ?? 0,
    attention: ORDER_FLAGS.map((key): CountByKey<OrderFlag> => ({ key, label: FLAG_LABELS[key], count: flagCounts.get(key) ?? 0 })),
    paymentsToday: {
      successful: payments?.successful ?? 0,
      failed: payments?.failed ?? 0,
      pending: payments?.pending ?? 0,
      amountCollected: money(payments?.collected),
    },
    // FP often gives only a code (`order_failure_at_gateway`); those read better humanised.
    topFailures: failures.map((row) => ({ reason: /^[a-z_]+$/.test(row.reason) ? humanise(row.reason) : row.reason, count: row.n })),
    daily: daily.map((row) => ({
      date: row.d.toISOString().slice(0, 10), placed: row.placed, successful: row.successful, failed: row.failed,
    })),
  };
}
