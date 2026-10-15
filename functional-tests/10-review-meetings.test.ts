// FT-MTG: review meetings are real records — written through the admin API,
// audit-logged, and locked once the investor's profile has been updated.
//
// PARKED: the feature is held back for a later release and its routes are not
// mounted (see admin.routes.ts). Set PARKED to false when they are.
import { beforeAll, describe, expect, test } from "bun:test";
import { expectError, expectStatus, signIn, type Client } from "./lib.ts";
import { onboardStaff } from "./staff.ts";

const { db } = await import("../src/db/client.ts");
const { runProjection } = await import("../src/services/admin-projection.service.ts");

const NOTES = "Income up after a promotion; horizon now 15 years. Comfortable with deeper drawdowns.";
const ist = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const PARKED = true;

let admin: Client;
let investor: Client;
let meetingId: string;

beforeAll(async () => {
  if (PARKED) return;
  admin = await onboardStaff("SUPER_ADMIN");
  investor = await signIn();
  await runProjection({ forceFull: true });
});

const record = (extra: Record<string, unknown> = {}) =>
  admin.post("/api/v1/admin/review-meetings", {
    userId: investor.userId, mode: "IN_PERSON", meetingDate: ist(-1),
    currentProfile: "MODERATE", recommendedProfile: "AGGRESSIVE", notes: NOTES, ...extra,
  }, { idem: false });

describe.skipIf(PARKED)("FT-MTG review meetings", () => {
  test("FT-MTG-01 a past meeting is recorded as captured, conducted by the recorder by default", async () => {
    const reply = await record();
    expectStatus(reply, 201);
    meetingId = reply.body.data.id;
    expect(reply.body.data.status).toBe("CAPTURED");
    expect(reply.body.data.investor.id).toBe(investor.userId);
    expect(reply.body.data.conductedBy.name).toBe("FT SUPER_ADMIN");
    expect(reply.body.data.recordedBy.name).toBe("FT SUPER_ADMIN");
  });

  test("FT-MTG-02 the recording is in the audit log", async () => {
    const rows = await db.auditLog.findMany({ where: { entityType: "review_meeting", entityId: meetingId }, select: { action: true } });
    expect(rows.map((row) => row.action)).toEqual(["REVIEW_MEETING_RECORDED"]);
  });

  test("FT-MTG-03 a future meeting is scheduled and may have no notes yet", async () => {
    const reply = await record({ meetingDate: ist(3), notes: "" });
    expectStatus(reply, 201);
    expect(reply.body.data.status).toBe("SCHEDULED");
  });

  test.each([
    ["a meeting that happened, with no real notes", { notes: "ok" }],
    ["an unknown mode", { mode: "CARRIER_PIGEON" }],
    ["an unknown profile", { recommendedProfile: "YOLO" }],
    ["a malformed date", { meetingDate: "03/09/2026" }],
    ["a user id that is not an investor", { userId: crypto.randomUUID() }],
  ])("FT-MTG-04 refuses %s", async (_label, extra) => {
    expectError(await record(extra), 400);
  });

  test("FT-MTG-05 the list shows it, with counts by status", async () => {
    const reply = await admin.get(`/api/v1/admin/review-meetings?userId=${investor.userId}`);
    expectStatus(reply, 200);
    expect(reply.body.data.items.map((item: { id: string }) => item.id)).toContain(meetingId);
    expect(reply.body.data.counts.CAPTURED).toBeGreaterThanOrEqual(1);
    expect(reply.body.data.counts.SCHEDULED).toBeGreaterThanOrEqual(1);
  });

  test("FT-MTG-06 status moves forward one step only", async () => {
    const scheduled = await record({ meetingDate: ist(5), notes: "" });
    expectError(await admin.patch(`/api/v1/admin/review-meetings/${scheduled.body.data.id}`, { status: "PROFILE_UPDATED" }, { idem: false }), 409);
    // Capturing it needs the notes of the conversation.
    expectError(await admin.patch(`/api/v1/admin/review-meetings/${scheduled.body.data.id}`, { status: "CAPTURED" }, { idem: false }), 400);
    expectStatus(await admin.patch(`/api/v1/admin/review-meetings/${scheduled.body.data.id}`, { status: "CAPTURED", notes: NOTES }, { idem: false }), 200);
  });

  test("FT-MTG-07 once the profile is updated the record is final", async () => {
    const done = await admin.patch(`/api/v1/admin/review-meetings/${meetingId}`, { status: "PROFILE_UPDATED" }, { idem: false });
    expectStatus(done, 200);
    expect(done.body.data.status).toBe("PROFILE_UPDATED");
    expectError(await admin.patch(`/api/v1/admin/review-meetings/${meetingId}`, { notes: `${NOTES} Edited later.` }, { idem: false }), 409);
    const actions = await db.auditLog.findMany({ where: { entityType: "review_meeting", entityId: meetingId }, orderBy: { createdAt: "asc" }, select: { action: true } });
    expect(actions.map((row) => row.action)).toEqual(["REVIEW_MEETING_RECORDED", "REVIEW_MEETING_UPDATED"]);
  });

  test("FT-MTG-08 the investor picker finds real investors, phone masked", async () => {
    const tail = (investor as Client & { phone: string }).phone.slice(-6);
    const reply = await admin.get(`/api/v1/admin/review-meetings/investors?search=${tail}`);
    expectStatus(reply, 200);
    const match = reply.body.data.find((option: { id: string }) => option.id === investor.userId);
    expect(match).toBeDefined();
    expect(match.phone).toContain("X");
  });

  test("FT-MTG-09 staff without meetings.manage cannot read or write meetings", async () => {
    const support = await onboardStaff("SUPPORT");
    expectError(await support.get("/api/v1/admin/review-meetings"), 403, "FORBIDDEN");
    expectError(await support.post("/api/v1/admin/review-meetings", {}, { idem: false }), 403, "FORBIDDEN");
  });
});
