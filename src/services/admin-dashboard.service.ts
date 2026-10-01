// Headline numbers for the admin dashboard.
//
// Investor counts aggregate `investor_journey_snapshots`, the read model the
// admin projection keeps current, so the dashboard costs a few index scans on
// one narrow table however many investors there are — and a KPI tile and the
// investor list filtered to it read the same rows, so they always agree.
// `dataAsOf` says how current those rows are.
//
// Money comes from the mirrored order and holdings tables; current value is the
// holdings report's, never a sum of our own orders (allotment is net of stamp
// duty).
//
// "Today", "7 days" and signup buckets are India time: the business and its
// investors live in IST, and a UTC day would split an evening in two.
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { projectionFreshness } from "./admin-projection.service.ts";
import { stalledWhere } from "./admin-investor.service.ts";
import { nextStepOf } from "./investor-facts.service.ts";
import { monthlyFactorSql } from "../utils/plan-frequency.ts";
import { humanise, JOURNEY_STAGE_LABELS, KYC_NEXT_STEP_LABELS, KYC_STATUS_LABELS } from "../utils/admin-labels.ts";
import {
  JOURNEY_STAGES,
  KYC_STATUSES,
  type CountByKey,
  type DashboardSummaryDto,
  type KycNextStep,
  type SignupBucket,
  type SignupSeriesDto,
} from "../types/admin-investor.types.ts";

const USER_STATUSES = ["ACTIVE", "PENDING_VERIFICATION", "SUSPENDED", "CLOSED"] as const;
const MANDATE_STATUSES = ["CREATED", "RECEIVED", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED"] as const;
const NEXT_STEPS: KycNextStep[] = ["PROVIDE_DETAILS", "FETCH_PROOF", "UPLOAD_SIGNATURE", "ESIGN", "WAITING_ON_PROVIDER"];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight in India, `daysAgo` days back, as an instant. */
function istMidnight(daysAgo: number): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS;
  return new Date(midnight - daysAgo * DAY_MS);
}

function countBy<K extends string>(
  keys: readonly K[],
  labels: Record<K, string> | ((key: K) => string),
  counts: Map<string, number>,
): CountByKey<K>[] {
  return keys.map((key) => ({
    key,
    label: typeof labels === "function" ? labels(key) : labels[key],
    count: counts.get(key) ?? 0,
  }));
}

function tally<T>(rows: T[], key: (row: T) => string | null, weight: (row: T) => number): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    if (k !== null) map.set(k, (map.get(k) ?? 0) + weight(row));
  }
  return map;
}

export async function getSummary(): Promise<DashboardSummaryDto> {
  const snapshot = db.investorJourneySnapshot;
  const [groups, today, last7, last30, stalled, openForms, money, mandates, freshness] = await Promise.all([
    snapshot.groupBy({
      by: ["userStatus", "kycStatus", "kycVia", "stage", "hasProfile", "hasAccount"],
      _count: { _all: true },
    }),
    snapshot.count({ where: { signedUpAt: { gte: istMidnight(0) } } }),
    snapshot.count({ where: { signedUpAt: { gte: istMidnight(6) } } }),
    snapshot.count({ where: { signedUpAt: { gte: istMidnight(29) } } }),
    snapshot.count({ where: stalledWhere() }),
    // Open forms are a small, bounded set (they expire in 7 days), so reading
    // them to classify with the app's own next-step rule stays cheap.
    snapshot.findMany({
      where: { kycStatus: "IN_PROGRESS" },
      select: { kycFormStatus: true, kycProofStatus: true, kycSignatureProvided: true, kycFieldsNeeded: true },
    }),
    db.$queryRaw<{ purchases: number; purchased: Prisma.Decimal; current_value: Prisma.Decimal; active_sips: number; sip_monthly: Prisma.Decimal }[]>`
      SELECT
        (SELECT count(*)::int FROM mf_purchases WHERE state = 'successful') AS purchases,
        (SELECT COALESCE(sum(COALESCE("purchasedAmount", amount)), 0) FROM mf_purchases WHERE state = 'successful') AS purchased,
        (SELECT COALESCE(sum("marketValue"), 0) FROM mf_holdings) AS current_value,
        (SELECT count(*)::int FROM mf_purchase_plans WHERE state = 'active') AS active_sips,
        -- Normalised to a monthly figure so plans of different frequencies add up.
        (SELECT COALESCE(sum(amount * ${monthlyFactorSql(Prisma.sql`frequency`)}), 0)
          FROM mf_purchase_plans WHERE state = 'active') AS sip_monthly`,
    db.mandate.groupBy({ by: ["mandateStatus"], _count: { _all: true } }),
    projectionFreshness(),
  ]);

  const n = (row: (typeof groups)[number]) => row._count._all;
  const sum = (predicate: (row: (typeof groups)[number]) => boolean) =>
    groups.filter(predicate).reduce((acc, row) => acc + n(row), 0);
  const total = sum(() => true);
  const kycByStatus = tally(groups, (r) => r.kycStatus, n);
  const byStage = tally(groups, (r) => r.stage, n);
  const steps = tally(
    openForms,
    (form) => nextStepOf({
      status: form.kycFormStatus, proofStatus: form.kycProofStatus,
      signatureProvided: form.kycSignatureProvided, fieldsNeeded: form.kycFieldsNeeded,
    }),
    () => 1,
  );
  const [m] = money;
  const decimal = (value: Prisma.Decimal | undefined) => new Prisma.Decimal(value ?? 0).toFixed(2);
  const ready = (byStage.get("READY_TO_INVEST") ?? 0) + (byStage.get("INVESTED") ?? 0);

  return {
    generatedAt: new Date().toISOString(),
    dataAsOf: freshness.refreshedAt?.toISOString() ?? null,
    signups: { total, today, last7Days: last7, last30Days: last30 },
    usersByStatus: countBy(USER_STATUSES, humanise, tally(groups, (r) => r.userStatus, n)),
    kyc: {
      byStatus: countBy(KYC_STATUSES, KYC_STATUS_LABELS, kycByStatus),
      completed: kycByStatus.get("COMPLETED") ?? 0,
      completedVia: {
        kra: sum((r) => r.kycVia === "KRA"),
        kycForm: sum((r) => r.kycVia === "KYC_FORM"),
      },
      inProgressByStep: countBy(NEXT_STEPS, KYC_NEXT_STEP_LABELS, steps),
    },
    journey: { byStage: countBy(JOURNEY_STAGES, JOURNEY_STAGE_LABELS, byStage) },
    funnel: [
      { key: "SIGNED_UP", label: "Signed up", count: total },
      { key: "KYC_STARTED", label: "Started KYC", count: total - (kycByStatus.get("NOT_STARTED") ?? 0) },
      { key: "KYC_COMPLETED", label: "KYC completed", count: kycByStatus.get("COMPLETED") ?? 0 },
      { key: "PROFILE", label: "Profile created", count: sum((r) => r.hasProfile) },
      { key: "INVESTMENT_ACCOUNT", label: "Investment account", count: sum((r) => r.hasAccount) },
      { key: "READY_TO_INVEST", label: "Ready to invest", count: ready },
      { key: "INVESTED", label: "Invested", count: byStage.get("INVESTED") ?? 0 },
    ],
    attention: {
      kycStalled: stalled,
      kycFailedOrExpired: (kycByStatus.get("FAILED") ?? 0) + (kycByStatus.get("EXPIRED") ?? 0),
      panCheckFailed: kycByStatus.get("PAN_CHECK_FAILED") ?? 0,
      accountNotReady: byStage.get("ACCOUNT_SETUP") ?? 0,
    },
    investments: {
      investedInvestors: byStage.get("INVESTED") ?? 0,
      successfulPurchases: m?.purchases ?? 0,
      purchasedAmount: decimal(m?.purchased),
      currentValue: decimal(m?.current_value),
      activeSips: m?.active_sips ?? 0,
      activeSipMonthlyAmount: decimal(m?.sip_monthly),
      mandatesByStatus: countBy(
        MANDATE_STATUSES,
        humanise,
        new Map(mandates.map((row) => [row.mandateStatus as string, row._count._all])),
      ),
    },
  };
}

const INTERVAL: Record<SignupBucket, string> = { day: "1 day", week: "1 week", month: "1 month" };

/** Signups and KYC completions per bucket between two India-local dates, inclusive. */
export async function getSignupSeries(from: string, to: string, bucket: SignupBucket): Promise<SignupSeriesDto> {
  // Range predicates on the raw instants (index-friendly); only the grouping
  // converts to India time.
  const start = new Date(Date.parse(`${from}T00:00:00Z`) - IST_OFFSET_MS);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) - IST_OFFSET_MS + DAY_MS);
  const rows = await db.$queryRaw<{ d: Date; signups: number; kyc: number }[]>`
    WITH series AS (
      SELECT generate_series(date_trunc(${bucket}, ${from}::date), ${to}::date, ${INTERVAL[bucket]}::interval)::date AS d
    ),
    s AS (
      SELECT date_trunc(${bucket}, "signedUpAt" AT TIME ZONE 'Asia/Kolkata')::date AS d, count(*)::int AS n
      FROM investor_journey_snapshots WHERE "signedUpAt" >= ${start} AND "signedUpAt" < ${end} GROUP BY 1
    ),
    k AS (
      SELECT date_trunc(${bucket}, "kycCompletedAt" AT TIME ZONE 'Asia/Kolkata')::date AS d, count(*)::int AS n
      FROM investor_journey_snapshots WHERE "kycCompletedAt" >= ${start} AND "kycCompletedAt" < ${end} GROUP BY 1
    )
    SELECT series.d, COALESCE(s.n, 0) AS signups, COALESCE(k.n, 0) AS kyc
    FROM series LEFT JOIN s USING (d) LEFT JOIN k USING (d)
    ORDER BY series.d`;
  return {
    bucket,
    from,
    to,
    points: rows.map((row) => ({ date: row.d.toISOString().slice(0, 10), signups: row.signups, kycCompleted: row.kyc })),
  };
}
