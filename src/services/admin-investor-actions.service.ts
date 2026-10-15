// The investor list's header and its actions: where everyone is (the stage
// counts and the counts behind each quick filter), the list as a spreadsheet,
// and a nudge — a reminder notification for investors who have not finished.
//
// Counts read `investor_journey_snapshots`, like the list itself, so a filter
// and the number on its button can never disagree.
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { JOURNEY_STAGE_LABELS, KYC_STATUS_LABELS } from "../utils/admin-labels.ts";
import { guardFormula, toCsv } from "../utils/csv.ts";
import { maskEmail, maskPan, maskTail } from "../utils/mask.ts";
import { attentionWhere, listWhere, snapshotSelect, stalledWhere } from "./admin-investor.service.ts";
import { notify } from "./notification.service.ts";
import { personalise } from "./announcement.service.ts";
import {
  JOURNEY_STAGES,
  type AdminKycStatus,
  type InvestorExportDto,
  type InvestorListQuery,
  type InvestorOverviewDto,
  type JourneyStage,
  type NudgeResultDto,
} from "../types/admin-investor.types.ts";
import type { StaffPrincipal } from "../types/staff.types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** A spreadsheet of the whole book; past this the export says it was cut. */
export const EXPORT_LIMIT = 50_000;
/** One nudge per investor per this many days, however many staff press the button. */
export const NUDGE_INTERVAL_DAYS = 7;
/** One press of "Nudge" reaches at most this many investors. */
export const NUDGE_BATCH_LIMIT = 500;

const istToday = () => new Date(new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10));

// --- overview ------------------------------------------------------------------

export async function getInvestorOverview(): Promise<InvestorOverviewDto> {
  const today = istToday();
  const [stages, kycPending, kycStalled, attentionKyc, attentionSetup, sips, sipDue] = await Promise.all([
    db.investorJourneySnapshot.groupBy({ by: ["stage"], _count: { _all: true } }),
    db.investorJourneySnapshot.count({ where: { kycStatus: { not: "COMPLETED" } } }),
    db.investorJourneySnapshot.count({ where: stalledWhere() }),
    db.investorJourneySnapshot.count({ where: attentionWhere("KYC") }),
    db.investorJourneySnapshot.count({ where: attentionWhere("SETUP") }),
    db.investorJourneySnapshot.aggregate({ _sum: { activeSips: true } }),
    db.investorJourneySnapshot.count({
      where: { activeSips: { gt: 0 }, nextSipDate: { gte: today, lte: new Date(today.getTime() + 7 * DAY_MS) } },
    }),
  ]);

  const byStage = Object.fromEntries(JOURNEY_STAGES.map((stage) => [stage, 0])) as Record<JourneyStage, number>;
  for (const row of stages) byStage[row.stage as JourneyStage] = row._count._all;

  return {
    total: Object.values(byStage).reduce((sum, count) => sum + count, 0),
    byStage,
    kycPending,
    kycStalled,
    attention: { KYC: attentionKyc, SETUP: attentionSetup },
    activeSips: sips._sum.activeSips ?? 0,
    sipDueIn7Days: sipDue,
  };
}

// --- export ----------------------------------------------------------------------

const Columns = [
  "Name", "Email", "Phone", "PAN", "Stage", "KYC status", "Signed up", "Invested (INR)", "Current value (INR)",
  "Active SIPs", "SIP per month (INR)", "Next SIP", "Last active",
] as const;

/** India-local `yyyy-mm-dd hh:mm`, which a spreadsheet reads as a date. */
const stamp = (value: Date | null) =>
  value ? new Date(value.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") : "";

/** The list as it is filtered on screen, contact details masked as everywhere else in the portal. Audited. */
export async function exportInvestors(query: Omit<InvestorListQuery, "limit" | "cursor">, viewer: StaffPrincipal): Promise<InvestorExportDto> {
  const where = listWhere(query);
  const [rows, total] = await Promise.all([
    db.investorJourneySnapshot.findMany({
      where,
      orderBy: [{ signedUpAt: "desc" }, { userId: "desc" }],
      take: EXPORT_LIMIT,
      select: snapshotSelect,
    }),
    db.investorJourneySnapshot.count({ where }),
  ]);

  await db.auditLog.create({
    data: {
      actorStaffId: viewer.staffId, action: "STAFF_EXPORTED_REPORT", entityType: "report", entityId: "investor-list",
      metadata: { filters: JSON.parse(JSON.stringify(query)) as Prisma.InputJsonObject, rows: rows.length, total },
    },
  });

  const csv = toCsv(
    Columns,
    rows.map((row) => [
      guardFormula(row.name ?? ""),
      guardFormula(maskEmail(row.email) ?? ""),
      maskTail(row.phone) ?? "",
      maskPan(row.pan) ?? "",
      JOURNEY_STAGE_LABELS[row.stage as JourneyStage] ?? row.stage,
      KYC_STATUS_LABELS[row.kycStatus as AdminKycStatus] ?? row.kycStatus,
      stamp(row.signedUpAt),
      new Prisma.Decimal(row.investedAmount ?? 0).toFixed(2),
      new Prisma.Decimal(row.currentValue ?? 0).toFixed(2),
      String(row.activeSips),
      new Prisma.Decimal(row.sipMonthlyAmount ?? 0).toFixed(2),
      row.nextSipDate?.toISOString().slice(0, 10) ?? "",
      stamp(row.lastActivityAt),
    ]),
  );

  return {
    filename: `risips-investors-${new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10)}.csv`,
    csv,
    rows: rows.length,
    truncated: total > rows.length,
  };
}

// --- nudge -----------------------------------------------------------------------

/** What to say to someone who stopped at each stage. Invested investors are never nudged. */
const NUDGE_COPY: Record<Exclude<JourneyStage, "INVESTED">, { title: string; body: string }> = {
  SIGNED_UP: {
    title: "{{firstName}}, finish setting up RiSips",
    body: "Complete your KYC in a few minutes and you're ready to start investing.",
  },
  KYC: {
    title: "{{firstName}}, your KYC is nearly done",
    body: "Pick up where you left off — it only takes a few minutes to finish.",
  },
  KYC_COMPLETED: {
    title: "{{firstName}}, you're one step from investing",
    body: "Your KYC is done. Add your details and bank account to start your first SIP.",
  },
  PROFILE: {
    title: "{{firstName}}, you're one step from investing",
    body: "Add your bank account to start your first SIP.",
  },
  ACCOUNT_SETUP: {
    title: "{{firstName}}, your account is almost ready",
    body: "Finish linking your bank account to start investing.",
  },
  READY_TO_INVEST: {
    title: "{{firstName}}, you're all set to invest",
    body: "Your account is ready. Start your first SIP in a couple of taps.",
  },
};

/**
 * A reminder notification to each investor, worded for the stage they stopped
 * at. Skips anyone who has invested, turned off offers and reminders, or was
 * nudged in the last week; the dedupe key makes a double press harmless.
 */
export async function nudgeInvestors(userIds: readonly string[], viewer: StaffPrincipal): Promise<NudgeResultDto> {
  const ids = [...new Set(userIds)].slice(0, NUDGE_BATCH_LIMIT);
  const people = await db.$queryRaw<{ user_id: string; name: string | null; stage: JourneyStage; opted_out: boolean; recent: boolean }[]>`
    SELECT s."userId" AS user_id, s.name, s.stage::text AS stage, (u."promoOptOutAt" IS NOT NULL) AS opted_out,
           EXISTS (SELECT 1 FROM notifications n
                    WHERE n."userId" = s."userId" AND n."dedupeKey" LIKE 'nudge:%'
                      AND n."createdAt" > now() - make_interval(days => ${NUDGE_INTERVAL_DAYS})) AS recent
    FROM investor_journey_snapshots s JOIN users u ON u.id = s."userId"
    WHERE s."userId" = ANY(${ids}::uuid[])`;

  const result: NudgeResultDto = { sent: 0, skippedInvested: ids.length - people.length, skippedOptedOut: 0, skippedRecent: 0 };
  const day = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  for (const person of people) {
    if (person.stage === "INVESTED") result.skippedInvested++;
    else if (person.opted_out) result.skippedOptedOut++;
    else if (person.recent) result.skippedRecent++;
    else {
      const copy = NUDGE_COPY[person.stage];
      await notify({
        userId: person.user_id,
        category: "ACTION",
        title: personalise(copy.title, person.name),
        body: personalise(copy.body, person.name),
        dedupeKey: `nudge:${person.stage}:${day}`,
      });
      result.sent++;
    }
  }

  if (result.sent > 0) {
    await db.auditLog.create({
      data: {
        actorStaffId: viewer.staffId, action: "STAFF_NUDGED_INVESTORS", entityType: "investor", entityId: null,
        metadata: { requested: ids.length, ...result },
      },
    });
  }
  return result;
}
