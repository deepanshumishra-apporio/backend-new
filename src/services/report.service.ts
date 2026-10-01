// Reports for the admin portal: a fixed catalogue of tabular extracts.
//
// Each report is one SELECT that yields `id`, `sort_at` and the columns it
// needs, and a mapper from that raw row to display cells. The same source
// feeds the on-screen preview, the total count and the CSV export, so what
// staff see and what they download can never disagree.
//
// Investor counts read `investor_journey_snapshots`, the read model the
// dashboard uses, so a report's numbers match the dashboard's. Orders, plans,
// payments and holdings read the FP mirror directly; AUM is the holdings
// report's market value, never a sum of our own orders.
//
// Identifiers leave masked, as on every other admin screen: an export ends up
// in inboxes and shared drives, so it must carry nothing reusable. Date ranges
// are India-local days, as on the dashboard.
import { Prisma } from "../../generated/prisma/client.ts";
import { MfOrderState, PaymentStatus, PlanState, SchemeCategory } from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { humanise, JOURNEY_STAGE_LABELS, KYC_NEXT_STEP_LABELS, KYC_STATUS_LABELS } from "../utils/admin-labels.ts";
import { maskEmail, maskPan, maskTail } from "../utils/mask.ts";
import { guardFormula, toCsv } from "../utils/csv.ts";
import { ORDER_TYPE_LABELS, orderUnionSql } from "./admin-order-union.ts";
import { nextStepOf } from "./investor-facts.service.ts";
import {
  JOURNEY_STAGES,
  KYC_STATUSES,
  type AdminKycStatus,
  type JourneyStage,
} from "../types/admin-investor.types.ts";
import type { OrderType } from "../types/admin-transaction.types.ts";
import type {
  ReportCell,
  ReportColumnDto,
  ReportDefinitionDto,
  ReportFilters,
  ReportKey,
  ReportOptionDto,
  ReportResultDto,
  ReportRow,
} from "../types/report.types.ts";
import type { StaffPrincipal } from "../types/staff.types.ts";

/** Rows shown on screen; the count says how many more the export would carry. */
export const PREVIEW_LIMIT = 100;
/** A ceiling on one export, so a wide range cannot build an unbounded file in memory. */
export const EXPORT_LIMIT = 50_000;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type RawRow = Record<string, unknown>;

interface ReportSpec {
  definition: Omit<ReportDefinitionDto, "key">;
  /** A SELECT yielding `id`, `sort_at` and the raw columns `toRow` reads. */
  source: (filters: ReportFilters) => Prisma.Sql;
  toRow: (raw: RawRow) => ReportRow;
}

// --- cells --------------------------------------------------------------------

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);

const decimal = (value: unknown, dp: number): string | null =>
  value === null || value === undefined ? null : new Prisma.Decimal(value as Prisma.Decimal | string | number).toFixed(dp);

const money = (value: unknown) => decimal(value, 2);
const units = (value: unknown) => decimal(value, 4);
const count = (value: unknown): number => Number(value ?? 0);
const instant = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);
/** A Postgres `date` arrives as UTC midnight; its first ten characters are the calendar day. */
const day = (value: unknown): string | null => (value instanceof Date ? value.toISOString().slice(0, 10) : null);
const label = (value: unknown): string | null => (typeof value === "string" && value ? humanise(value) : null);

// --- filters ------------------------------------------------------------------

/** `[from, to]` in India time as a half-open range of instants. */
function rangeOn(column: Prisma.Sql, filters: ReportFilters): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.from) {
    conditions.push(Prisma.sql`${column} >= ${new Date(Date.parse(`${filters.from}T00:00:00Z`) - IST_OFFSET_MS)}`);
  }
  if (filters.to) {
    conditions.push(Prisma.sql`${column} < ${new Date(Date.parse(`${filters.to}T00:00:00Z`) - IST_OFFSET_MS + DAY_MS)}`);
  }
  return conditions;
}

const where = (conditions: Prisma.Sql[]): Prisma.Sql =>
  conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;

const options = <K extends string>(keys: readonly K[], labels: Record<K, string> | ((key: K) => string)): ReportOptionDto[] =>
  keys.map((key) => ({ value: key, label: typeof labels === "function" ? labels(key) : labels[key] }));

const col = (key: string, labelText: string, kind: ReportColumnDto["kind"] = "text"): ReportColumnDto => ({
  key, label: labelText, kind,
});

// FP-mirroring enums are stored as FP's wire strings; the order and plan ones
// are the lowercased enum names, payments keep FP's uppercase.
const ORDER_STATES = Object.values(MfOrderState);
const PLAN_STATES = Object.values(PlanState);
const PAYMENT_STATUSES = Object.values(PaymentStatus);
const CATEGORIES = Object.values(SchemeCategory);

// --- the catalogue ----------------------------------------------------------------

const investors: ReportSpec = {
  definition: {
    name: "Investor register",
    description: "Every investor with their onboarding stage, KYC status, investment and SIP totals.",
    dateField: "Signed up",
    statusLabel: "Stage",
    statuses: options(JOURNEY_STAGES, JOURNEY_STAGE_LABELS),
    columns: [
      col("name", "Name"), col("email", "Email"), col("phone", "Phone"), col("pan", "PAN"),
      col("accountStatus", "Account status"), col("stage", "Stage"), col("kycStatus", "KYC status"),
      col("signedUpAt", "Signed up", "datetime"), col("investedAmount", "Invested", "money"),
      col("currentValue", "Current value", "money"), col("activeSips", "Active SIPs", "count"),
      col("sipMonthlyAmount", "SIP / month", "money"), col("lastLoginAt", "Last login", "datetime"),
    ],
  },
  source: (filters) => Prisma.sql`
    SELECT "userId" AS id, "signedUpAt" AS sort_at, name, email, phone, pan, "userStatus", stage, "kycStatus",
           "signedUpAt", "investedAmount", "currentValue", "activeSips", "sipMonthlyAmount", "lastLoginAt"
    FROM investor_journey_snapshots
    ${where([
      ...rangeOn(Prisma.sql`"signedUpAt"`, filters),
      ...(filters.status ? [Prisma.sql`stage = ${filters.status}`] : []),
    ])}`,
  toRow: (r) => ({
    name: text(r["name"]),
    email: maskEmail(text(r["email"])),
    phone: maskTail(text(r["phone"])),
    pan: maskPan(text(r["pan"])),
    accountStatus: label(r["userStatus"]),
    stage: JOURNEY_STAGE_LABELS[r["stage"] as JourneyStage] ?? label(r["stage"]),
    kycStatus: KYC_STATUS_LABELS[r["kycStatus"] as AdminKycStatus] ?? label(r["kycStatus"]),
    signedUpAt: instant(r["signedUpAt"]),
    investedAmount: money(r["investedAmount"]),
    currentValue: money(r["currentValue"]),
    activeSips: count(r["activeSips"]),
    sipMonthlyAmount: money(r["sipMonthlyAmount"]),
    lastLoginAt: instant(r["lastLoginAt"]),
  }),
};

const kyc: ReportSpec = {
  definition: {
    name: "KYC status",
    description: "Where each investor's KYC stands, how it was completed and the step an open form is waiting on.",
    dateField: "Signed up",
    statusLabel: "KYC status",
    statuses: options(KYC_STATUSES, KYC_STATUS_LABELS),
    columns: [
      col("name", "Name"), col("phone", "Phone"), col("pan", "PAN"), col("kycStatus", "KYC status"),
      col("completedVia", "Completed via"), col("nextStep", "Waiting on"),
      col("lastMovedAt", "Last KYC activity", "datetime"), col("completedAt", "KYC completed", "datetime"),
      col("signedUpAt", "Signed up", "datetime"),
    ],
  },
  source: (filters) => Prisma.sql`
    SELECT "userId" AS id, "signedUpAt" AS sort_at, name, phone, pan, "kycStatus", "kycVia", "kycFormStatus",
           "kycProofStatus", "kycSignatureProvided", "kycFieldsNeeded", "kycMovedAt", "kycCompletedAt", "signedUpAt"
    FROM investor_journey_snapshots
    ${where([
      ...rangeOn(Prisma.sql`"signedUpAt"`, filters),
      ...(filters.status ? [Prisma.sql`"kycStatus" = ${filters.status}`] : []),
    ])}`,
  toRow: (r) => {
    const status = r["kycStatus"] as AdminKycStatus;
    const step = status === "IN_PROGRESS"
      ? nextStepOf({
          status: text(r["kycFormStatus"]), proofStatus: text(r["kycProofStatus"]),
          signatureProvided: (r["kycSignatureProvided"] as boolean | null) ?? null,
          fieldsNeeded: (r["kycFieldsNeeded"] as string[] | null) ?? [],
        })
      : null;
    return {
      name: text(r["name"]),
      phone: maskTail(text(r["phone"])),
      pan: maskPan(text(r["pan"])),
      kycStatus: KYC_STATUS_LABELS[status] ?? label(status),
      completedVia: r["kycVia"] === "KRA" ? "KRA" : r["kycVia"] === "KYC_FORM" ? "KYC form" : null,
      nextStep: step ? KYC_NEXT_STEP_LABELS[step] : null,
      lastMovedAt: instant(r["kycMovedAt"]),
      completedAt: instant(r["kycCompletedAt"]),
      signedUpAt: instant(r["signedUpAt"]),
    };
  },
};

/** The investor behind an investment account, for the order and plan reports. */
const investorJoin = Prisma.sql`
  JOIN mf_investment_accounts a ON a.id = t.account_id
  JOIN investor_profiles ip ON ip.id = a."primaryInvestorProfileId"`;

const transactions: ReportSpec = {
  definition: {
    name: "Transactions",
    description: "Purchases, redemptions and switches — lump sum and plan installments — with their outcome.",
    dateField: "Placed",
    statusLabel: "Order state",
    statuses: options(ORDER_STATES, humanise),
    columns: [
      col("placedAt", "Placed", "datetime"), col("type", "Type"), col("investor", "Investor"), col("pan", "PAN"),
      col("scheme", "Scheme"), col("toScheme", "Switched into"), col("folio", "Folio"),
      col("amount", "Amount", "money"), col("units", "Units", "units"), col("state", "State"),
      col("completedAt", "Completed", "datetime"), col("failureReason", "Failure reason"),
    ],
  },
  source: (filters) => Prisma.sql`
    SELECT t.*, t.placed_at AS sort_at, ip.name AS investor, ip.pan
    FROM (${orderUnionSql}) t
    ${investorJoin}
    ${where([
      ...rangeOn(Prisma.sql`t.placed_at`, filters),
      ...(filters.status ? [Prisma.sql`t.state = ${filters.status.toLowerCase()}`] : []),
    ])}`,
  toRow: (r) => ({
    placedAt: instant(r["placed_at"]),
    type: ORDER_TYPE_LABELS[r["type"] as OrderType] ?? text(r["type"]),
    investor: text(r["investor"]),
    pan: maskPan(text(r["pan"])),
    scheme: text(r["scheme"]),
    toScheme: text(r["to_scheme"]),
    folio: text(r["folio"]),
    amount: money(r["amount"]),
    units: units(r["units"]),
    state: label(r["state"]),
    completedAt: instant(r["completed_at"]),
    failureReason: text(r["failure_reason"]),
  }),
};

const plans: ReportSpec = {
  definition: {
    name: "SIP, SWP and STP plans",
    description: "Every systematic plan with its schedule, amount and state.",
    dateField: "Created",
    statusLabel: "Plan state",
    statuses: options(PLAN_STATES, humanise),
    columns: [
      col("createdAt", "Created", "datetime"), col("type", "Type"), col("investor", "Investor"), col("pan", "PAN"),
      col("scheme", "Scheme"), col("toScheme", "Switched into"), col("frequency", "Frequency"),
      col("amount", "Amount", "money"), col("units", "Units", "units"),
      col("installments", "Installments", "count"), col("remaining", "Remaining", "count"), col("state", "State"),
      col("startDate", "Start date", "date"), col("nextDate", "Next installment", "date"),
    ],
  },
  source: (filters) => Prisma.sql`
    SELECT t.*, t.created_at AS sort_at, ip.name AS investor, ip.pan
    FROM (
      SELECT p.id, COALESCE(p."fpCreatedAt", p."createdAt") AS created_at, 'SIP' AS type,
             p."mfInvestmentAccountId" AS account_id, s.name AS scheme, NULL::text AS to_scheme,
             p.frequency::text AS frequency, p.amount, NULL::numeric AS units,
             p."numberOfInstallments" AS installments, p."remainingInstallments" AS remaining, p.state::text AS state,
             p."startDate" AS start_date, p."nextInstallmentDate" AS next_date
      FROM mf_purchase_plans p JOIN mf_schemes s ON s.isin = p."schemeIsin"
      UNION ALL
      SELECT r.id, COALESCE(r."fpCreatedAt", r."createdAt"), 'SWP', r."mfInvestmentAccountId", s.name, NULL::text,
             r.frequency::text, r.amount, r.units, r."numberOfInstallments", r."remainingInstallments", r.state::text,
             r."startDate", r."nextInstallmentDate"
      FROM mf_redemption_plans r JOIN mf_schemes s ON s.isin = r."schemeIsin"
      UNION ALL
      SELECT w.id, COALESCE(w."fpCreatedAt", w."createdAt"), 'STP', w."mfInvestmentAccountId", so.name, si.name,
             w.frequency::text, w.amount, w.units, w."numberOfInstallments", w."remainingInstallments", w.state::text,
             w."startDate", w."nextInstallmentDate"
      FROM mf_switch_plans w
      JOIN mf_schemes so ON so.isin = w."switchOutSchemeIsin"
      JOIN mf_schemes si ON si.isin = w."switchInSchemeIsin"
    ) t
    ${investorJoin}
    ${where([
      ...rangeOn(Prisma.sql`t.created_at`, filters),
      ...(filters.status ? [Prisma.sql`t.state = ${filters.status.toLowerCase()}`] : []),
    ])}`,
  toRow: (r) => ({
    createdAt: instant(r["created_at"]),
    type: text(r["type"]),
    investor: text(r["investor"]),
    pan: maskPan(text(r["pan"])),
    scheme: text(r["scheme"]),
    toScheme: text(r["to_scheme"]),
    frequency: label(r["frequency"]),
    amount: money(r["amount"]),
    units: units(r["units"]),
    installments: count(r["installments"]),
    remaining: r["remaining"] === null ? null : count(r["remaining"]),
    state: label(r["state"]),
    startDate: day(r["start_date"]),
    nextDate: day(r["next_date"]),
  }),
};

const payments: ReportSpec = {
  definition: {
    name: "Payments",
    description: "Every payment collected through the gateway — UPI, netbanking and mandate debits — with its status.",
    dateField: "Initiated",
    statusLabel: "Payment status",
    statuses: options(PAYMENT_STATUSES, humanise),
    columns: [
      col("initiatedAt", "Initiated", "datetime"), col("investor", "Investor"), col("pan", "PAN"),
      col("type", "Type"), col("method", "Method"), col("amount", "Amount", "money"),
      col("orders", "Orders", "count"), col("status", "Status"),
      col("settledAt", "Settled", "datetime"), col("failureReason", "Failure reason"),
    ],
  },
  // The payer is the bank account's owner; a payment with no bank account on
  // file (some UPI collects) falls back to the investor of the first order it
  // paid for.
  source: (filters) => {
    const initiated = Prisma.sql`COALESCE(pay."fpCreatedAt", pay."createdAt")`;
    return Prisma.sql`
      SELECT pay.id, ${initiated} AS sort_at, ${initiated} AS initiated_at,
             pay."paymentType"::text AS type, pay.method::text AS method, pay.amount, pay.status::text AS status,
             pay."settledAt" AS settled_at, COALESCE(pay."failedReason", pay."failureCode") AS failure_reason,
             COALESCE(bip.name, oip.name) AS investor, COALESCE(bip.pan, oip.pan) AS pan,
             (SELECT count(*)::int FROM payment_purchases pp WHERE pp."paymentId" = pay.id) AS orders
      FROM payments pay
      LEFT JOIN bank_accounts ba ON ba.id = pay."fromBankAccountId"
      LEFT JOIN investor_profiles bip ON bip.id = ba."investorProfileId"
      LEFT JOIN LATERAL (
        SELECT a."primaryInvestorProfileId" AS profile_id
        FROM payment_purchases pp
        JOIN mf_purchases p ON p.id = pp."mfPurchaseId"
        JOIN mf_investment_accounts a ON a.id = p."mfInvestmentAccountId"
        WHERE pp."paymentId" = pay.id
        ORDER BY pp."createdAt" LIMIT 1
      ) first_order ON true
      LEFT JOIN investor_profiles oip ON oip.id = first_order.profile_id
      ${where([
        ...rangeOn(initiated, filters),
        ...(filters.status ? [Prisma.sql`pay.status::text = ${filters.status}`] : []),
      ])}`;
  },
  toRow: (r) => ({
    initiatedAt: instant(r["initiated_at"]),
    investor: text(r["investor"]),
    pan: maskPan(text(r["pan"])),
    type: label(r["type"]),
    method: label(r["method"]),
    amount: money(r["amount"]),
    orders: count(r["orders"]),
    status: label(r["status"]),
    settledAt: instant(r["settled_at"]),
    failureReason: text(r["failure_reason"]),
  }),
};

const aum: ReportSpec = {
  definition: {
    name: "AUM by scheme",
    description: "Assets under management per scheme from the latest holdings sync: investors, units, cost and market value.",
    dateField: null,
    statusLabel: "Category",
    statuses: options(CATEGORIES, humanise),
    columns: [
      col("scheme", "Scheme"), col("isin", "ISIN"), col("amc", "AMC"), col("category", "Category"),
      col("investors", "Investors", "count"), col("folios", "Folios", "count"), col("units", "Units", "units"),
      col("investedValue", "Invested value", "money"), col("marketValue", "Market value", "money"),
      col("valuedOn", "Valued on", "date"),
    ],
  },
  source: (filters) => Prisma.sql`
    SELECT h."schemeIsin" AS id, sum(COALESCE(h."marketValue", 0)) AS sort_at,
           COALESCE(s.name, max(h."schemeName")) AS scheme, h."schemeIsin" AS isin, amc.name AS amc,
           s.category::text AS category, count(DISTINCT h."mfInvestmentAccountId")::int AS investors,
           count(*)::int AS folios, sum(h.units) AS units, sum(h."investedValue") AS invested_value,
           sum(h."marketValue") AS market_value, max(h."marketValueAsOn") AS valued_on
    FROM mf_holdings h
    LEFT JOIN mf_schemes s ON s.isin = h."schemeIsin"
    LEFT JOIN mf_amcs amc ON amc.id = s."amcId"
    ${where([
      Prisma.sql`h.units > 0`,
      ...(filters.status ? [Prisma.sql`s.category::text = ${filters.status.toLowerCase()}`] : []),
    ])}
    GROUP BY h."schemeIsin", s.name, amc.name, s.category`,
  toRow: (r) => ({
    scheme: text(r["scheme"]),
    isin: text(r["isin"]),
    amc: text(r["amc"]),
    category: label(r["category"]),
    investors: count(r["investors"]),
    folios: count(r["folios"]),
    units: units(r["units"]),
    investedValue: money(r["invested_value"]),
    marketValue: money(r["market_value"]),
    valuedOn: day(r["valued_on"]),
  }),
};

const COMPLIANCE_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"] as const;

const compliance: ReportSpec = {
  definition: {
    name: "Compliance alerts",
    description: "Every alert the compliance checks raised, with who worked it and how it was closed.",
    dateField: "Detected",
    statusLabel: "Alert status",
    statuses: options(COMPLIANCE_STATUSES, humanise),
    columns: [
      col("detectedAt", "Detected", "datetime"), col("kind", "Alert"), col("severity", "Severity"), col("status", "Status"),
      col("investor", "Investor"), col("pan", "PAN"), col("title", "Title"), col("detail", "Detail"),
      col("assignee", "Assignee"), col("resolvedAt", "Closed", "datetime"), col("resolvedBy", "Closed by"),
      col("resolution", "Resolution"),
    ],
  },
  source: (filters) => Prisma.sql`
    SELECT ca.id, ca."firstDetectedAt" AS sort_at, ca."firstDetectedAt" AS detected_at, ca.kind::text AS kind,
           ca.severity::text AS severity, ca.status::text AS status, ca.title, ca.detail, ca."resolvedAt" AS resolved_at,
           ca.resolution, ca."autoResolved" AS auto_resolved, s.name AS investor, s.pan,
           assignee."fullName" AS assignee, resolver."fullName" AS resolved_by
    FROM compliance_alerts ca
    LEFT JOIN investor_journey_snapshots s ON s."userId" = ca."userId"
    LEFT JOIN staff_users assignee ON assignee.id = ca."assignedStaffId"
    LEFT JOIN staff_users resolver ON resolver.id = ca."resolvedByStaffId"
    ${where([
      ...rangeOn(Prisma.sql`ca."firstDetectedAt"`, filters),
      ...(filters.status ? [Prisma.sql`ca.status::text = ${filters.status}`] : []),
    ])}`,
  toRow: (r) => ({
    detectedAt: instant(r["detected_at"]),
    kind: label(r["kind"]),
    severity: label(r["severity"]),
    status: label(r["status"]),
    investor: text(r["investor"]),
    pan: maskPan(text(r["pan"])),
    title: text(r["title"]),
    detail: text(r["detail"]),
    assignee: text(r["assignee"]),
    resolvedAt: instant(r["resolved_at"]),
    resolvedBy: r["auto_resolved"] === true ? "Automatic" : text(r["resolved_by"]),
    resolution: text(r["resolution"]),
  }),
};

const REPORTS: Record<ReportKey, ReportSpec> = { investors, kyc, transactions, plans, payments, aum, compliance };

// --- running them ---------------------------------------------------------------

export function listReports(): ReportDefinitionDto[] {
  return (Object.keys(REPORTS) as ReportKey[]).map((key) => ({ key, ...REPORTS[key].definition }));
}

/** The report's definition, or a 404 for a key that is not in the catalogue. */
export function reportDefinition(key: string): ReportDefinitionDto {
  const spec = REPORTS[key as ReportKey];
  if (!spec) throw HttpError.notFound("No report with that name");
  return { key: key as ReportKey, ...spec.definition };
}

async function run(key: ReportKey, filters: ReportFilters, limit: number): Promise<ReportResultDto> {
  const spec = REPORTS[key];
  const source = spec.source(filters);
  const [rows, totals] = await Promise.all([
    db.$queryRaw<RawRow[]>`SELECT * FROM (${source}) q ORDER BY q.sort_at DESC NULLS LAST, q.id DESC LIMIT ${limit}`,
    db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM (${source}) q`,
  ]);
  const total = totals[0]?.n ?? 0;
  return {
    report: key,
    name: spec.definition.name,
    columns: spec.definition.columns,
    rows: rows.map(spec.toRow),
    total,
    limit,
    truncated: total > rows.length,
    filters,
    generatedAt: new Date().toISOString(),
  };
}

export function previewReport(key: ReportKey, filters: ReportFilters): Promise<ReportResultDto> {
  return run(key, filters, PREVIEW_LIMIT);
}

export interface ReportExport {
  filename: string;
  csv: string;
  rows: number;
  truncated: boolean;
}

/** The report as CSV. Exporting investor data is PII access, so it is audited. */
export async function exportReport(key: ReportKey, filters: ReportFilters, viewer: StaffPrincipal): Promise<ReportExport> {
  const result = await run(key, filters, EXPORT_LIMIT);
  await db.auditLog.create({
    data: {
      actorStaffId: viewer.staffId, action: "STAFF_EXPORTED_REPORT", entityType: "report", entityId: key,
      metadata: { filters: { ...filters }, rows: result.rows.length, total: result.total },
    },
  });
  const csv = toCsv(
    result.columns.map((column) => column.label),
    result.rows.map((row) => result.columns.map((column) => csvCell(row[column.key] ?? null, column.kind))),
  );
  const range = filters.from || filters.to ? `-${filters.from ?? "start"}-to-${filters.to ?? "today"}` : "";
  return {
    filename: `risips-${key}${range}-${istStamp()}.csv`,
    csv,
    rows: result.rows.length,
    truncated: result.truncated,
  };
}

/** Timestamps in a spreadsheet read best as India-local `yyyy-mm-dd hh:mm`. */
function csvCell(value: ReportCell, kind: ReportColumnDto["kind"]): string {
  if (value === null) return "";
  if (kind === "datetime" && typeof value === "string") {
    return new Date(Date.parse(value) + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
  }
  return kind === "text" ? guardFormula(String(value)) : String(value);
}

const istStamp = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
