// Announcements: offers, product updates and notices the business sends to
// investors, as an in-app notification, a home banner with a one-time modal,
// or both.
//
// Maker-checker: the person who composed an announcement cannot approve or
// reject it. Approval schedules it; a background loop delivers it at
// `startsAt`, and ends its banner at `endsAt`.
//
// Promotional announcements are held to three rules at delivery, all judged
// then rather than when composed, because an audience is a rule and changes:
//   - investors who turned off offers are skipped (`User.promoOptOutAt`);
//   - nothing promotional is sent in quiet hours, 21:00–08:00 India time — it
//     waits for the morning;
//   - no investor gets more than two promotional announcements in seven days.
// Informational announcements (a product change, a notice) go to everyone in
// the audience.
//
// Each delivery is one notification per investor with the dedupe key
// `announcement:<promo|info>:<id>`, so a delivery retried after a crash can
// never notify anyone twice, and the weekly cap can count promotional ones.
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { acquireJobLease, intervalFromEnv, jobLoop, releaseJobLease } from "./job-lease.ts";
import type {
  ActiveBannerDto,
  AnnouncementAudience,
  AnnouncementCategory,
  AnnouncementDetailDto,
  AnnouncementInput,
  AnnouncementListDto,
  AnnouncementListItemDto,
  AnnouncementStatus,
  AudienceReachDto,
  CtaAction,
} from "../types/announcement.types.ts";
import type { StaffPrincipal } from "../types/staff.types.ts";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const QUIET_FROM_HOUR = 21;
export const QUIET_TO_HOUR = 8;
export const WEEKLY_PROMO_CAP = 2;
const BATCH = 1000;

/** Whether an instant falls in promotional quiet hours, India time. */
export function inQuietHours(at: Date): boolean {
  const hour = new Date(at.getTime() + IST_OFFSET_MS).getUTCHours();
  return hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR;
}

/** `{{firstName}}` → the investor's first name, or a friendly fallback. Pure. */
export function personalise(text: string, name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return text.replaceAll("{{firstName}}", first || "there");
}

const dedupeKey = (category: AnnouncementCategory, id: string) =>
  `announcement:${category === "PROMOTIONAL" ? "promo" : "info"}:${id}`;

/** An audience as a condition on `investor_journey_snapshots s`. Only active accounts ever receive anything. */
function audienceSql(audience: AnnouncementAudience): Prisma.Sql {
  const segment = {
    ALL_INVESTORS: Prisma.sql`TRUE`,
    KYC_PENDING: Prisma.sql`s."kycStatus" <> 'COMPLETED'`,
    READY_NOT_INVESTED: Prisma.sql`s.stage = 'READY_TO_INVEST'`,
    INVESTED: Prisma.sql`s.stage = 'INVESTED'`,
    ACTIVE_SIP: Prisma.sql`s."activeSips" > 0`,
    NO_SIP: Prisma.sql`s.stage = 'INVESTED' AND s."activeSips" = 0`,
  }[audience];
  return Prisma.sql`s."userStatus" = 'ACTIVE' AND ${segment}`;
}

// --- reading --------------------------------------------------------------------------

const listSelect = {
  id: true, name: true, category: true, audience: true, status: true, title: true, sendNotification: true,
  showBanner: true, startsAt: true, endsAt: true, sentAt: true, deliveredCount: true, createdAt: true,
  createdByStaff: { select: { id: true, fullName: true } },
  approvedByStaff: { select: { id: true, fullName: true } },
} as const satisfies Prisma.AnnouncementSelect;

type ListRow = Prisma.AnnouncementGetPayload<{ select: typeof listSelect }>;

const staffRef = (staff: { id: string; fullName: string } | null) => (staff ? { id: staff.id, name: staff.fullName } : null);

function toListItem(row: ListRow): AnnouncementListItemDto {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    audience: row.audience,
    status: row.status,
    title: row.title,
    sendNotification: row.sendNotification,
    showBanner: row.showBanner,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    createdBy: staffRef(row.createdByStaff),
    approvedBy: staffRef(row.approvedByStaff),
    sentAt: row.sentAt?.toISOString() ?? null,
    deliveredCount: row.deliveredCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAnnouncements(status?: AnnouncementStatus[]): Promise<AnnouncementListDto> {
  const [rows, counts] = await Promise.all([
    db.announcement.findMany({
      where: status ? { status: { in: status } } : {},
      select: listSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    }),
    db.announcement.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const count = (key: AnnouncementStatus) => counts.find((row) => row.status === key)?._count._all ?? 0;
  return {
    items: rows.map(toListItem),
    summary: { drafts: count("DRAFT") + count("REJECTED"), awaitingApproval: count("PENDING_APPROVAL"), scheduled: count("SCHEDULED"), live: count("LIVE") },
  };
}

export async function getAnnouncement(id: string, viewer: StaffPrincipal): Promise<AnnouncementDetailDto> {
  const row = await db.announcement.findUnique({
    where: { id },
    select: {
      ...listSelect, body: true, tag: true, bannerTitle: true, bannerBody: true, highlight: true, ctaLabel: true,
      ctaAction: true, submittedAt: true, approvedAt: true, rejectionReason: true, cancelledAt: true,
      targetedCount: true, optedOutCount: true, cappedCount: true, createdByStaffId: true,
    },
  });
  if (!row) throw HttpError.notFound("No announcement with that id");
  const key = dedupeKey(row.category, row.id);
  const [read, seen, clicked] = await Promise.all([
    db.notification.count({ where: { dedupeKey: key, readAt: { not: null } } }),
    db.announcementView.count({ where: { announcementId: id } }),
    db.announcementView.count({ where: { announcementId: id, clickedAt: { not: null } } }),
  ]);
  const mine = row.createdByStaffId === viewer.staffId;
  return {
    ...toListItem(row),
    body: row.body,
    tag: row.tag,
    bannerTitle: row.bannerTitle,
    bannerBody: row.bannerBody,
    highlight: row.highlight,
    ctaLabel: row.ctaLabel,
    ctaAction: row.ctaAction as CtaAction | null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    stats: {
      targeted: row.targetedCount, delivered: row.deliveredCount, optedOut: row.optedOutCount, capped: row.cappedCount,
      read, bannerSeen: seen, bannerClicked: clicked,
    },
    can: {
      edit: mine && (row.status === "DRAFT" || row.status === "REJECTED"),
      submit: mine && (row.status === "DRAFT" || row.status === "REJECTED"),
      approve: !mine && row.status === "PENDING_APPROVAL",
      reject: !mine && row.status === "PENDING_APPROVAL",
      cancel: ["DRAFT", "PENDING_APPROVAL", "REJECTED", "SCHEDULED"].includes(row.status),
      end: row.status === "LIVE",
    },
  };
}

/** How many investors an audience reaches right now, and how many promotional opt-outs remove. */
export async function audienceReach(audience: AnnouncementAudience, category: AnnouncementCategory): Promise<AudienceReachDto> {
  const [row] = await db.$queryRaw<{ matched: number; opted_out: number }[]>`
    SELECT count(*)::int AS matched, count(*) FILTER (WHERE u."promoOptOutAt" IS NOT NULL)::int AS opted_out
    FROM investor_journey_snapshots s JOIN users u ON u.id = s."userId"
    WHERE ${audienceSql(audience)}`;
  const matched = row?.matched ?? 0;
  const optedOut = category === "PROMOTIONAL" ? row?.opted_out ?? 0 : 0;
  return { matched, optedOut, reachable: matched - optedOut };
}

// --- composing and approving ------------------------------------------------------------

/** Rules an announcement must meet before it can go to a checker. */
function assertComplete(input: AnnouncementInput): void {
  if (!input.sendNotification && !input.showBanner) throw HttpError.badRequest("Choose at least one of: notification, home banner");
  if (input.showBanner) {
    if (!input.tag || !input.bannerTitle || !input.bannerBody) {
      throw HttpError.badRequest("A banner needs a tag, a banner title and a banner line");
    }
    if (!input.endsAt) throw HttpError.badRequest("A banner needs an end date");
  }
  if (input.endsAt && input.endsAt <= input.startsAt) throw HttpError.badRequest("The end must be after the start");
}

const writable = (input: AnnouncementInput) => ({
  name: input.name, category: input.category, audience: input.audience, title: input.title, body: input.body,
  sendNotification: input.sendNotification, showBanner: input.showBanner, tag: input.tag, bannerTitle: input.bannerTitle,
  bannerBody: input.bannerBody, highlight: input.highlight, ctaLabel: input.ctaLabel, ctaAction: input.ctaAction,
  startsAt: input.startsAt, endsAt: input.endsAt,
});

export async function createAnnouncement(input: AnnouncementInput, viewer: StaffPrincipal): Promise<AnnouncementDetailDto> {
  const row = await db.announcement.create({ data: { ...writable(input), createdByStaffId: viewer.staffId }, select: { id: true } });
  return getAnnouncement(row.id, viewer);
}

async function load(id: string) {
  const row = await db.announcement.findUnique({
    where: { id },
    select: {
      id: true, status: true, createdByStaffId: true, name: true, category: true, audience: true, title: true, body: true,
      sendNotification: true, showBanner: true, tag: true, bannerTitle: true, bannerBody: true, highlight: true,
      ctaLabel: true, ctaAction: true, startsAt: true, endsAt: true,
    },
  });
  if (!row) throw HttpError.notFound("No announcement with that id");
  return row;
}

export async function updateAnnouncement(id: string, input: AnnouncementInput, viewer: StaffPrincipal): Promise<AnnouncementDetailDto> {
  const row = await load(id);
  if (row.createdByStaffId !== viewer.staffId) throw HttpError.conflict("Only the person who composed this can edit it");
  if (row.status !== "DRAFT" && row.status !== "REJECTED") throw HttpError.conflict("Only a draft or a rejected announcement can be edited");
  // Editing a rejected one takes it back to draft: it has to be approved again.
  await db.announcement.update({ where: { id }, data: { ...writable(input), status: "DRAFT", rejectionReason: null } });
  return getAnnouncement(id, viewer);
}

async function audit(viewer: StaffPrincipal, action: string, id: string, metadata?: Prisma.InputJsonValue) {
  await db.auditLog.create({
    data: { actorStaffId: viewer.staffId, action, entityType: "announcement", entityId: id, ...(metadata !== undefined && { metadata }) },
  });
}

export type AnnouncementTransition = "submit" | "approve" | "reject" | "cancel" | "end";

export async function transition(
  id: string,
  action: AnnouncementTransition,
  viewer: StaffPrincipal,
  reason?: string,
): Promise<AnnouncementDetailDto> {
  const row = await load(id);
  const now = new Date();
  const mine = row.createdByStaffId === viewer.staffId;
  const refuse = (message: string) => HttpError.conflict(message);

  switch (action) {
    case "submit": {
      if (!mine) throw refuse("Only the person who composed this can send it for approval");
      if (row.status !== "DRAFT" && row.status !== "REJECTED") throw refuse("Only a draft can be sent for approval");
      assertComplete({ ...row, ctaAction: row.ctaAction as CtaAction | null });
      await db.announcement.update({ where: { id }, data: { status: "PENDING_APPROVAL", submittedAt: now, rejectionReason: null } });
      await audit(viewer, "STAFF_SUBMITTED_ANNOUNCEMENT", id);
      break;
    }
    case "approve":
    case "reject": {
      if (mine) throw refuse("An announcement has to be approved by someone other than the person who composed it");
      if (row.status !== "PENDING_APPROVAL") throw refuse("Only an announcement awaiting approval can be approved or rejected");
      if (action === "approve") {
        await db.announcement.update({ where: { id }, data: { status: "SCHEDULED", approvedByStaffId: viewer.staffId, approvedAt: now } });
        await audit(viewer, "STAFF_APPROVED_ANNOUNCEMENT", id, { audience: row.audience, category: row.category });
        // Due now: deliver without waiting for the next tick. Its own failure is the loop's to retry.
        if (row.startsAt <= now) void runAnnouncementDispatch().catch(() => undefined);
      } else {
        await db.announcement.update({ where: { id }, data: { status: "REJECTED", rejectionReason: reason ?? null } });
        await audit(viewer, "STAFF_REJECTED_ANNOUNCEMENT", id, { reason: reason ?? null });
      }
      break;
    }
    case "cancel": {
      if (!["DRAFT", "PENDING_APPROVAL", "REJECTED", "SCHEDULED"].includes(row.status)) throw refuse("This announcement has already gone out");
      await db.announcement.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: now } });
      await audit(viewer, "STAFF_CANCELLED_ANNOUNCEMENT", id);
      break;
    }
    case "end": {
      if (row.status !== "LIVE") throw refuse("Only a live banner can be ended");
      await db.announcement.update({ where: { id }, data: { status: "COMPLETED", endsAt: now } });
      await audit(viewer, "STAFF_ENDED_ANNOUNCEMENT", id);
      break;
    }
  }
  return getAnnouncement(id, viewer);
}

// --- delivery ---------------------------------------------------------------------------

/** Notify everyone in the audience who may receive it; returns the counts written onto the announcement. */
async function deliver(row: { id: string; category: AnnouncementCategory; audience: AnnouncementAudience; title: string; body: string }) {
  const promo = row.category === "PROMOTIONAL";
  const recipients = await db.$queryRaw<{ user_id: string; name: string | null; opted_out: boolean; recent: number }[]>`
    SELECT s."userId" AS user_id, s.name, (u."promoOptOutAt" IS NOT NULL) AS opted_out,
           (SELECT count(*)::int FROM notifications n
             WHERE n."userId" = s."userId" AND n."dedupeKey" LIKE 'announcement:promo:%'
               AND n."dedupeKey" <> ${dedupeKey(row.category, row.id)}
               AND n."createdAt" > now() - interval '7 days') AS recent
    FROM investor_journey_snapshots s JOIN users u ON u.id = s."userId"
    WHERE ${audienceSql(row.audience)}`;

  let optedOut = 0;
  let capped = 0;
  const eligible: typeof recipients = [];
  for (const person of recipients) {
    if (promo && person.opted_out) optedOut++;
    else if (promo && person.recent >= WEEKLY_PROMO_CAP) capped++;
    else eligible.push(person);
  }

  let delivered = 0;
  const key = dedupeKey(row.category, row.id);
  for (let start = 0; start < eligible.length; start += BATCH) {
    const batch = eligible.slice(start, start + BATCH);
    const result = await db.notification.createMany({
      data: batch.map((person) => ({
        userId: person.user_id,
        category: "ANNOUNCEMENT" as const,
        title: personalise(row.title, person.name).slice(0, 160),
        body: personalise(row.body, person.name).slice(0, 500),
        dedupeKey: key,
      })),
      skipDuplicates: true,
    });
    delivered += result.count;
  }
  return { targetedCount: recipients.length, deliveredCount: delivered, optedOutCount: optedOut, cappedCount: capped };
}

const LEASE_NAME = "announcements";
const LEASE_MS = 5 * 60_000;

/** Deliver what is due and end banners that are over. Exported for the approve path and for tests. */
export async function runAnnouncementDispatch(now = new Date()): Promise<{ delivered: number; ended: number; held: number }> {
  if (!(await acquireJobLease(LEASE_NAME, LEASE_MS))) return { delivered: 0, ended: 0, held: 0 };
  let delivered = 0;
  let held = 0;
  try {
    const due = await db.announcement.findMany({
      where: { status: "SCHEDULED", startsAt: { lte: now } },
      select: { id: true, category: true, audience: true, title: true, body: true, sendNotification: true, showBanner: true, endsAt: true },
      orderBy: { startsAt: "asc" },
    });
    for (const row of due) {
      if (row.category === "PROMOTIONAL" && row.sendNotification && inQuietHours(now)) {
        held++;
        continue;
      }
      const counts = row.sendNotification ? await deliver(row) : {};
      const bannerRunning = row.showBanner && row.endsAt !== null && row.endsAt > now;
      await db.announcement.update({
        where: { id: row.id },
        data: { ...counts, sentAt: now, status: bannerRunning ? "LIVE" : "COMPLETED" },
      });
      delivered++;
    }
    const ended = await db.announcement.updateMany({
      where: { status: "LIVE", endsAt: { lte: now } },
      data: { status: "COMPLETED" },
    });
    await releaseJobLease(LEASE_NAME, now);
    return { delivered, ended: ended.count, held };
  } catch (error) {
    await releaseJobLease(LEASE_NAME, null).catch(() => undefined);
    throw error;
  }
}

async function tick(): Promise<void> {
  try {
    const run = await runAnnouncementDispatch();
    if (run.delivered || run.ended) console.log(`[announcements] delivered=${run.delivered} ended=${run.ended} held=${run.held}`);
  } catch (error) {
    console.error("[announcements] dispatch failed:", error instanceof Error ? error.message : error);
  }
}

/** `ANNOUNCEMENT_DISPATCH_INTERVAL_MS` (default one minute); 0 turns delivery off. */
const loop = jobLoop(tick, intervalFromEnv("ANNOUNCEMENT_DISPATCH_INTERVAL_MS", 60_000));
export const startAnnouncementDispatch = () => loop.start();
export const stopAnnouncementDispatch = () => loop.stop();

// --- the investor's side ------------------------------------------------------------------

/** Whether this investor is in an audience right now. */
async function inAudience(userId: string, audience: AnnouncementAudience): Promise<boolean> {
  const [row] = await db.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM investor_journey_snapshots s WHERE s."userId" = ${userId}::uuid AND ${audienceSql(audience)}) AS ok`;
  return row?.ok ?? false;
}

/** The banner the investor's home screen should show: the newest live one they are in the audience for. */
export async function activeBanner(userId: string): Promise<ActiveBannerDto | null> {
  const now = new Date();
  const [user, snapshot, live] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { promoOptOutAt: true } }),
    db.investorJourneySnapshot.findUnique({ where: { userId }, select: { name: true } }),
    db.announcement.findMany({
      where: { status: "LIVE", showBanner: true, startsAt: { lte: now }, endsAt: { gt: now } },
      orderBy: { startsAt: "desc" },
      select: {
        id: true, category: true, audience: true, title: true, body: true, tag: true, bannerTitle: true,
        bannerBody: true, highlight: true, ctaLabel: true, ctaAction: true,
        views: { where: { userId }, select: { id: true } },
      },
      take: 10,
    }),
  ]);
  for (const row of live) {
    if (row.category === "PROMOTIONAL" && user?.promoOptOutAt) continue;
    if (!(await inAudience(userId, row.audience))) continue;
    return {
      id: row.id,
      tag: row.tag ?? "",
      title: personalise(row.title, snapshot?.name ?? null),
      body: personalise(row.body, snapshot?.name ?? null),
      highlight: row.highlight,
      bannerTitle: row.bannerTitle ?? row.title,
      bannerBody: row.bannerBody ?? "",
      ctaLabel: row.ctaAction && row.ctaAction !== "none" ? row.ctaLabel : null,
      ctaAction: (row.ctaAction as CtaAction | null) ?? "none",
      seen: row.views.length > 0,
    };
  }
  return null;
}

/** The investor saw the modal, or tapped its call to action. Idempotent. */
export async function recordView(userId: string, announcementId: string, clicked: boolean): Promise<void> {
  const exists = await db.announcement.findFirst({ where: { id: announcementId, showBanner: true }, select: { id: true } });
  if (!exists) throw HttpError.notFound("No such announcement");
  const now = new Date();
  await db.announcementView.upsert({
    where: { announcementId_userId: { announcementId, userId } },
    create: { announcementId, userId, seenAt: now, ...(clicked && { clickedAt: now }) },
    update: clicked ? { clickedAt: now } : {},
  });
}

export async function getPreferences(userId: string): Promise<{ promotions: boolean }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { promoOptOutAt: true } });
  return { promotions: !user?.promoOptOutAt };
}

/** Turning offers off is recorded with a time, like the other consent choices on this platform. */
export async function setPreferences(userId: string, promotions: boolean): Promise<{ promotions: boolean }> {
  if (promotions) await db.user.update({ where: { id: userId }, data: { promoOptOutAt: null } });
  // Keep the original opt-out time if they were already out: it is when they chose.
  else await db.user.updateMany({ where: { id: userId, promoOptOutAt: null }, data: { promoOptOutAt: new Date() } });
  return { promotions };
}
