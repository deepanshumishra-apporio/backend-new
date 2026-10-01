import type { Request, Response } from "express";
import { staffPrincipal } from "../middleware/staff-auth.ts";
import * as staffAdmin from "../services/staff-admin.service.ts";
import type { StaffStatusValue, UpdateStaffInput } from "../types/staff.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { asBody, oneOf, optionalString, requiredString } from "../utils/validate.ts";

type StaffParams = { staffId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = ["ACTIVE", "SUSPENDED", "DEACTIVATED"] as const;

function staffId(req: Request<StaffParams>): string {
  if (!UUID.test(req.params.staffId)) throw HttpError.notFound("No staff member with that id");
  return req.params.staffId;
}

function roleKeys(body: Record<string, unknown>, required: boolean): string[] | undefined {
  const raw = body["roleKeys"];
  if (raw === undefined && !required) return undefined;
  if (!Array.isArray(raw) || raw.some((key) => typeof key !== "string" || !/^[A-Z_]{2,40}$/.test(key))) {
    throw HttpError.badRequest("roleKeys must be a list of role keys");
  }
  if (raw.length > 20) throw HttpError.badRequest("Too many roles");
  return [...new Set(raw as string[])];
}

function phone(body: Record<string, unknown>): string | undefined {
  const value = optionalString(body, "phone", { maxLength: 20, pattern: /^\+?[0-9 ()-]{7,20}$/, patternHint: "phone is not a valid number" });
  return value?.replace(/[\s()-]/g, "");
}

export async function roles(_req: Request, res: Response) {
  res.json({ data: await staffAdmin.listRoles() });
}

export async function list(_req: Request, res: Response) {
  res.json({ data: await staffAdmin.listStaff() });
}

export async function getOne(req: Request<StaffParams>, res: Response) {
  res.json({ data: await staffAdmin.getStaff(staffId(req)) });
}

export async function create(req: Request, res: Response) {
  const body = asBody(req.body);
  const email = requiredString(body, "email", { maxLength: 255 }).toLowerCase();
  if (!EMAIL.test(email)) throw HttpError.badRequest("Enter a valid email address");
  const number = phone(body);
  const result = await staffAdmin.createStaff(staffPrincipal(req), {
    email,
    fullName: requiredString(body, "fullName", { maxLength: 150 }),
    ...(number && { phone: number }),
    roleKeys: roleKeys(body, true)!,
  });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ data: result });
}

export async function update(req: Request<StaffParams>, res: Response) {
  const body = asBody(req.body);
  const input: UpdateStaffInput = {};
  const fullName = optionalString(body, "fullName", { maxLength: 150 });
  if (fullName !== undefined) input.fullName = fullName;
  if (body["phone"] === null || body["phone"] === "") input.phone = null;
  else {
    const number = phone(body);
    if (number !== undefined) input.phone = number;
  }
  const keys = roleKeys(body, false);
  if (keys !== undefined) input.roleKeys = keys;
  res.json({ data: await staffAdmin.updateStaff(staffPrincipal(req), staffId(req), input) });
}

export async function setStatus(req: Request<StaffParams>, res: Response) {
  const status = oneOf(asBody(req.body), "status", STATUSES) as StaffStatusValue;
  res.json({ data: await staffAdmin.setStatus(staffPrincipal(req), staffId(req), status) });
}

export async function resetPassword(req: Request<StaffParams>, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: await staffAdmin.resetPassword(staffPrincipal(req), staffId(req)) });
}

export async function resetMfa(req: Request<StaffParams>, res: Response) {
  res.json({ data: await staffAdmin.resetMfa(staffPrincipal(req), staffId(req)) });
}

export async function revokeSessions(req: Request<StaffParams>, res: Response) {
  res.json({ data: await staffAdmin.revokeSessions(staffPrincipal(req), staffId(req)) });
}
