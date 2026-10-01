import type { Request, Response } from "express";
import { staffPrincipal } from "../middleware/staff-auth.ts";
import * as staffAuth from "../services/staff-auth.service.ts";
import { HttpError } from "../utils/http-error.ts";
import { asBody, requiredString } from "../utils/validate.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Passwords are never trimmed: whitespace is a legitimate character. */
function password(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) throw HttpError.badRequest(`${field} is required`);
  // Capped before argon2 sees it, so a megabyte "password" cannot tie up a worker.
  if (value.length > staffAuth.MAX_PASSWORD_LENGTH) throw HttpError.badRequest(`${field} is too long`);
  return value;
}

function context(req: Request) {
  const userAgent = req.get("user-agent");
  return {
    ...(req.ip && { ipAddress: req.ip.replace(/^::ffff:/, "") }),
    ...(userAgent && { userAgent }),
  };
}

export async function login(req: Request, res: Response) {
  const body = asBody(req.body);
  const email = requiredString(body, "email", { maxLength: 255 }).toLowerCase();
  if (!EMAIL.test(email)) throw HttpError.badRequest("Enter a valid email address");
  const session = await staffAuth.login({ email, password: password(body, "password"), ...context(req) });
  res.status(201).json({ data: session });
}

export async function current(req: Request, res: Response) {
  res.json({ data: await staffAuth.sessionState(staffPrincipal(req)) });
}

export async function mfaSetup(req: Request, res: Response) {
  res.status(201).json({ data: await staffAuth.beginMfaSetup(staffPrincipal(req)) });
}

export async function mfaVerify(req: Request, res: Response) {
  const code = requiredString(asBody(req.body), "code", { maxLength: 6, pattern: /^\d{6}$/, patternHint: "code must be 6 digits" });
  res.json({ data: await staffAuth.verifyMfa(staffPrincipal(req), code, context(req)) });
}

export async function logout(req: Request, res: Response) {
  await staffAuth.logout(staffPrincipal(req));
  res.status(204).end();
}

export async function me(req: Request, res: Response) {
  res.json({ data: await staffAuth.me(staffPrincipal(req)) });
}

export async function changePassword(req: Request, res: Response) {
  const body = asBody(req.body);
  await staffAuth.changePassword(staffPrincipal(req), password(body, "currentPassword"), password(body, "newPassword"));
  res.status(204).end();
}
