// Review meetings: what was discussed with an investor and the risk profile it
// leads to. Until now these lived only as sample data in the admin portal.
//
// The record is evidence, so it is written once: after creation only the
// status moves (forward, one step at a time) and the notes can be completed
// while the meeting is still open. A meeting marked PROFILE_UPDATED is final.
// Every write also goes to `audit_logs` in the same transaction.
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { maskTail } from "../utils/mask.ts";
import { investorsById } from "./compliance-alert.service.ts";
import { listInvestors } from "./admin-investor.service.ts";
import type { StaffPrincipal } from "../types/staff.types.ts";
import {
  MEETING_STATUSES,
  type CreateReviewMeetingInput,
  type MeetingInvestorOptionDto,
  type MeetingStatus,
  type ReviewMeetingDto,
  type ReviewMeetingListDto,
  type ReviewMeetingListQuery,
  type UpdateReviewMeetingInput,
} from "../types/review-meeting.types.ts";

/** Notes shorter than this are not a record of a conversation. */
const MIN_NOTES = 20;

/** The only moves a meeting's status may make. */
const NEXT_STATUS: Record<MeetingStatus, MeetingStatus | null> = {
  SCHEDULED: "CAPTURED",
  CAPTURED: "PROFILE_UPDATED",
  PROFILE_UPDATED: null,
};

const select = {
  id: true, userId: true, mode: true, meetingDate: true, currentProfile: true, recommendedProfile: true,
  status: true, notes: true, createdAt: true, updatedAt: true,
  conductedBy: { select: { id: true, fullName: true } },
  recordedBy: { select: { id: true, fullName: true } },
} as const;

type Row = {
  id: string; userId: string; mode: ReviewMeetingDto["mode"]; meetingDate: Date;
  currentProfile: ReviewMeetingDto["currentProfile"]; recommendedProfile: ReviewMeetingDto["recommendedProfile"];
  status: MeetingStatus; notes: string; createdAt: Date; updatedAt: Date;
  conductedBy: { id: string; fullName: string }; recordedBy: { id: string; fullName: string };
};

/** Today in India, as yyyy-mm-dd: a meeting "in the future" is judged on the business's calendar. */
const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

async function toDtos(rows: Row[]): Promise<ReviewMeetingDto[]> {
  const investors = await investorsById(rows.map((row) => row.userId));
  return rows.map((row) => ({
    id: row.id,
    investor: investors.get(row.userId) ?? { id: row.userId, name: null, phone: null, email: null, pan: null },
    conductedBy: { id: row.conductedBy.id, name: row.conductedBy.fullName },
    recordedBy: { id: row.recordedBy.id, name: row.recordedBy.fullName },
    mode: row.mode,
    meetingDate: row.meetingDate.toISOString().slice(0, 10),
    currentProfile: row.currentProfile,
    recommendedProfile: row.recommendedProfile,
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function listMeetings(query: ReviewMeetingListQuery): Promise<ReviewMeetingListDto> {
  const where = {
    ...(query.status && { status: query.status }),
    ...(query.userId && { userId: query.userId }),
  };
  const [rows, grouped] = await Promise.all([
    db.reviewMeeting.findMany({
      where,
      select,
      orderBy: [{ meetingDate: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
    }),
    db.reviewMeeting.groupBy({ by: ["status"], _count: { _all: true }, ...(query.userId && { where: { userId: query.userId } }) }),
  ]);
  const page = rows.slice(0, query.limit);
  const counts = Object.fromEntries(MEETING_STATUSES.map((status) => [status, 0])) as Record<MeetingStatus, number>;
  for (const group of grouped) counts[group.status] = group._count._all;
  return {
    items: await toDtos(page),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    counts,
  };
}

export async function getMeeting(id: string): Promise<ReviewMeetingDto> {
  const row = await db.reviewMeeting.findUnique({ where: { id }, select });
  if (!row) throw HttpError.notFound("No review meeting with that id");
  return (await toDtos([row]))[0]!;
}

/** Staff who may conduct a review, for the form's picker. */
export async function listConductors(): Promise<{ id: string; name: string }[]> {
  const rows = await db.staffUser.findMany({
    where: { status: "ACTIVE", roles: { some: { role: { permissions: { some: { permissionKey: "meetings.manage" } } } } } },
    select: { id: true, fullName: true },
    orderBy: { fullName: "asc" },
  });
  return rows.map((row) => ({ id: row.id, name: row.fullName }));
}

/** Investors matching a search, for the form's picker. Masked: the picker needs a name, not the number. */
export async function searchInvestors(search: string): Promise<MeetingInvestorOptionDto[]> {
  const { items } = await listInvestors({ search, limit: 10 });
  return items.map((item) => ({ id: item.id, name: item.name, phone: maskTail(item.phone) }));
}

export async function recordMeeting(input: CreateReviewMeetingInput, actor: StaffPrincipal): Promise<ReviewMeetingDto> {
  const investor = await db.user.findFirst({
    where: { id: input.userId, role: "INVESTOR", deletedAt: null },
    select: { id: true },
  });
  if (!investor) throw HttpError.badRequest("No such investor");

  const conductorId = input.conductedByStaffId ?? actor.staffId;
  if (!(await listConductors()).some((staff) => staff.id === conductorId)) {
    throw HttpError.badRequest("That staff member cannot conduct review meetings");
  }

  // A meeting still to happen is scheduled; one that happened needs its notes.
  const status: MeetingStatus = input.meetingDate > todayIst() ? "SCHEDULED" : "CAPTURED";
  if (status === "CAPTURED" && input.notes.trim().length < MIN_NOTES) {
    throw HttpError.badRequest(`Record what was discussed: at least ${MIN_NOTES} characters of notes`);
  }

  const id = await db.$transaction(async (tx) => {
    const created = await tx.reviewMeeting.create({
      data: {
        userId: input.userId,
        conductedByStaffId: conductorId,
        recordedByStaffId: actor.staffId,
        mode: input.mode,
        meetingDate: new Date(`${input.meetingDate}T00:00:00Z`),
        currentProfile: input.currentProfile,
        recommendedProfile: input.recommendedProfile,
        status,
        notes: input.notes.trim(),
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        actorStaffId: actor.staffId, action: "REVIEW_MEETING_RECORDED", entityType: "review_meeting", entityId: created.id,
        metadata: { userId: input.userId, status, currentProfile: input.currentProfile, recommendedProfile: input.recommendedProfile },
      },
    });
    return created.id;
  });
  return getMeeting(id);
}

export async function updateMeeting(id: string, input: UpdateReviewMeetingInput, actor: StaffPrincipal): Promise<ReviewMeetingDto> {
  const current = await db.reviewMeeting.findUnique({ where: { id }, select: { status: true, notes: true } });
  if (!current) throw HttpError.notFound("No review meeting with that id");
  if (current.status === "PROFILE_UPDATED") {
    throw HttpError.conflict("This meeting is final: the investor's profile has already been updated from it");
  }
  if (input.status && input.status !== current.status && input.status !== NEXT_STATUS[current.status]) {
    throw HttpError.conflict(`A ${current.status.toLowerCase().replace("_", " ")} meeting can only move to ${NEXT_STATUS[current.status]!.toLowerCase().replace("_", " ")}`);
  }

  const status = input.status ?? current.status;
  const notes = input.notes?.trim() ?? current.notes;
  if (status !== "SCHEDULED" && notes.length < MIN_NOTES) {
    throw HttpError.badRequest(`Record what was discussed: at least ${MIN_NOTES} characters of notes`);
  }

  await db.$transaction([
    db.reviewMeeting.update({ where: { id }, data: { status, notes } }),
    db.auditLog.create({
      data: {
        actorStaffId: actor.staffId, action: "REVIEW_MEETING_UPDATED", entityType: "review_meeting", entityId: id,
        metadata: { from: current.status, to: status, notesChanged: notes !== current.notes },
      },
    }),
  ]);
  return getMeeting(id);
}
