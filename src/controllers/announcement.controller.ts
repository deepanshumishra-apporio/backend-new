import type { Request, Response } from "express";
import { investorId } from "../middleware/investor-auth.ts";
import { staffPrincipal } from "../middleware/staff-auth.ts";
import * as announcements from "../services/announcement.service.ts";
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_STATUSES,
  CTA_ACTIONS,
  type AnnouncementInput,
} from "../types/announcement.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { isUuid, queryList, queryString } from "../utils/query.ts";
import { asBody, oneOf, optionalString, requiredString } from "../utils/validate.ts";

type Params = { announcementId: string };

function announcementId(req: Request<Params>): string {
  if (!isUuid(req.params.announcementId)) throw HttpError.notFound("No announcement with that id");
  return req.params.announcementId;
}

function instant(body: Record<string, unknown>, field: string, required: boolean): Date | null {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw HttpError.badRequest(`${field} is required`);
    return null;
  }
  const value = typeof raw === "string" ? new Date(raw) : null;
  if (!value || Number.isNaN(value.getTime())) throw HttpError.badRequest(`${field} must be an ISO date-time`);
  return value;
}

function flag(body: Record<string, unknown>, field: string): boolean {
  const raw = body[field] ?? false;
  if (typeof raw !== "boolean") throw HttpError.badRequest(`${field} must be true or false`);
  return raw;
}

/** The whole announcement off the body: create and edit take the same shape. */
function parseInput(body: Record<string, unknown>): AnnouncementInput {
  const text = (field: string, maxLength: number) => optionalString(body, field, { maxLength }) ?? null;
  return {
    name: requiredString(body, "name", { maxLength: 120 }),
    category: oneOf(body, "category", ANNOUNCEMENT_CATEGORIES)!,
    audience: oneOf(body, "audience", ANNOUNCEMENT_AUDIENCES)!,
    title: requiredString(body, "title", { maxLength: 80 }),
    body: requiredString(body, "body", { maxLength: 240 }),
    sendNotification: flag(body, "sendNotification"),
    showBanner: flag(body, "showBanner"),
    tag: text("tag", 30),
    bannerTitle: text("bannerTitle", 60),
    bannerBody: text("bannerBody", 120),
    highlight: text("highlight", 80),
    ctaLabel: text("ctaLabel", 30),
    ctaAction: oneOf(body, "ctaAction", CTA_ACTIONS, false) ?? null,
    startsAt: instant(body, "startsAt", true)!,
    endsAt: instant(body, "endsAt", false),
  };
}

// --- staff ----------------------------------------------------------------------

export async function list(req: Request, res: Response) {
  const status = queryList(req.query, "status", ANNOUNCEMENT_STATUSES);
  res.json({ data: await announcements.listAnnouncements(status) });
}

export async function getOne(req: Request<Params>, res: Response) {
  res.json({ data: await announcements.getAnnouncement(announcementId(req), staffPrincipal(req)) });
}

export async function reach(req: Request, res: Response) {
  const audience = queryString(req.query, "audience")?.toUpperCase();
  const category = queryString(req.query, "category")?.toUpperCase() ?? "PROMOTIONAL";
  if (!audience || !(ANNOUNCEMENT_AUDIENCES as readonly string[]).includes(audience)) {
    throw HttpError.badRequest(`audience must be one of: ${ANNOUNCEMENT_AUDIENCES.join(", ")}`);
  }
  if (!(ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(category)) {
    throw HttpError.badRequest(`category must be one of: ${ANNOUNCEMENT_CATEGORIES.join(", ")}`);
  }
  res.json({
    data: await announcements.audienceReach(audience as AnnouncementInput["audience"], category as AnnouncementInput["category"]),
  });
}

export async function create(req: Request, res: Response) {
  res.status(201).json({ data: await announcements.createAnnouncement(parseInput(asBody(req.body)), staffPrincipal(req)) });
}

export async function update(req: Request<Params>, res: Response) {
  res.json({ data: await announcements.updateAnnouncement(announcementId(req), parseInput(asBody(req.body)), staffPrincipal(req)) });
}

const TRANSITIONS = ["submit", "approve", "reject", "cancel", "end"] as const;

export async function act(req: Request<Params>, res: Response) {
  const body = asBody(req.body);
  const action = oneOf(body, "action", TRANSITIONS)!;
  const reason = action === "reject" ? requiredString(body, "reason", { maxLength: 300 }) : undefined;
  res.json({ data: await announcements.transition(announcementId(req), action, staffPrincipal(req), reason) });
}

// --- investor ---------------------------------------------------------------------

export async function activeBanner(req: Request, res: Response) {
  res.json({ data: await announcements.activeBanner(investorId(req)) });
}

export async function seen(req: Request<Params>, res: Response) {
  await announcements.recordView(investorId(req), req.params.announcementId, false);
  res.json({ data: { recorded: true } });
}

export async function clicked(req: Request<Params>, res: Response) {
  await announcements.recordView(investorId(req), req.params.announcementId, true);
  res.json({ data: { recorded: true } });
}

export async function getPreferences(req: Request, res: Response) {
  res.json({ data: await announcements.getPreferences(investorId(req)) });
}

export async function setPreferences(req: Request, res: Response) {
  const body = asBody(req.body);
  if (typeof body["promotions"] !== "boolean") throw HttpError.badRequest("promotions must be true or false");
  res.json({ data: await announcements.setPreferences(investorId(req), body["promotions"]) });
}
