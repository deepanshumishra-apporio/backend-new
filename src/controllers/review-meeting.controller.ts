import type { Request, Response } from "express";
import { staffPrincipal } from "../middleware/staff-auth.ts";
import * as meetings from "../services/review-meeting.service.ts";
import { MEETING_MODES, MEETING_STATUSES, RISK_PROFILES } from "../types/review-meeting.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { isUuid, queryLimit, queryString } from "../utils/query.ts";
import { asBody, oneOf, optionalString, requiredDate, requiredString } from "../utils/validate.ts";

type MeetingParams = { meetingId: string };

const NOTES_MAX = 4000;

/**
 * Notes may be empty — a scheduled meeting has none yet. `optionalString`
 * treats "" as a missing required value, so blank is handled here; whether
 * notes are long enough for the meeting's status is the service's rule.
 */
function notesField(body: Record<string, unknown>): string | undefined {
  const raw = body["notes"];
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && raw.trim() === "") return "";
  return optionalString(body, "notes", { maxLength: NOTES_MAX });
}

function meetingId(req: Request<MeetingParams>): string {
  if (!isUuid(req.params.meetingId)) throw HttpError.notFound("No review meeting with that id");
  return req.params.meetingId;
}

export async function list(req: Request, res: Response) {
  const cursor = queryString(req.query, "cursor");
  if (cursor && !isUuid(cursor)) throw HttpError.badRequest("cursor is invalid");
  const userId = queryString(req.query, "userId");
  if (userId && !isUuid(userId)) throw HttpError.badRequest("userId is invalid");
  const status = queryString(req.query, "status");
  if (status && !(MEETING_STATUSES as readonly string[]).includes(status)) {
    throw HttpError.badRequest(`status must be one of: ${MEETING_STATUSES.join(", ")}`);
  }
  res.json({
    data: await meetings.listMeetings({
      limit: queryLimit(req.query, 50, 100),
      ...(status && { status: status as (typeof MEETING_STATUSES)[number] }),
      ...(userId && { userId }),
      ...(cursor && { cursor }),
    }),
  });
}

export async function getOne(req: Request<MeetingParams>, res: Response) {
  res.json({ data: await meetings.getMeeting(meetingId(req)) });
}

export async function conductors(_req: Request, res: Response) {
  res.json({ data: await meetings.listConductors() });
}

export async function investors(req: Request, res: Response) {
  const search = queryString(req.query, "search")?.trim();
  if (!search || search.length < 2) throw HttpError.badRequest("Type at least 2 characters to search");
  if (search.length > 100) throw HttpError.badRequest("search must be at most 100 characters");
  res.json({ data: await meetings.searchInvestors(search) });
}

export async function create(req: Request, res: Response) {
  const body = asBody(req.body);
  const userId = requiredString(body, "userId");
  if (!isUuid(userId)) throw HttpError.badRequest("userId is invalid");
  const conductedByStaffId = optionalString(body, "conductedByStaffId");
  if (conductedByStaffId && !isUuid(conductedByStaffId)) throw HttpError.badRequest("conductedByStaffId is invalid");
  res.status(201).json({
    data: await meetings.recordMeeting({
      userId,
      ...(conductedByStaffId && { conductedByStaffId }),
      mode: oneOf(body, "mode", MEETING_MODES)!,
      meetingDate: requiredDate(body, "meetingDate"),
      currentProfile: oneOf(body, "currentProfile", RISK_PROFILES)!,
      recommendedProfile: oneOf(body, "recommendedProfile", RISK_PROFILES)!,
      notes: notesField(body) ?? "",
    }, staffPrincipal(req)),
  });
}

export async function update(req: Request<MeetingParams>, res: Response) {
  const body = asBody(req.body);
  const status = oneOf(body, "status", MEETING_STATUSES, false);
  const notes = notesField(body);
  if (!status && notes === undefined) throw HttpError.badRequest("Send a status, notes, or both");
  res.json({
    data: await meetings.updateMeeting(meetingId(req), { ...(status && { status }), ...(notes !== undefined && { notes }) }, staffPrincipal(req)),
  });
}
