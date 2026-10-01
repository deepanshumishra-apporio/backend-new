// Gates for `/admin/*`, applied in this order:
//
//   authenticateStaff     a live staff session (pending MFA allowed)
//   requireMfaPending     only the MFA endpoints: the session is still pending
//   requireMfa            everything else: MFA passed
//   requirePasswordCurrent  refuse data while an issued password is unchanged
//   requirePermission(p)  the staff member holds p through one of their roles
//
// These are separate from `requireSession` (investors) on purpose — different
// tables, different tokens — so neither gate can admit the other's users.
import type { Request, RequestHandler } from "express";
import * as staffAuth from "../services/staff-auth.service.ts";
import type { Permission, StaffPrincipal } from "../types/staff.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { bearerToken } from "../utils/session-token.ts";

const unauthorized = () => new HttpError(401, "UNAUTHORIZED", "A valid staff session is required");

export function staffPrincipal(req: Request): StaffPrincipal {
  const principal = req.res?.locals["staff"] as StaffPrincipal | undefined;
  if (!principal) throw unauthorized();
  return principal;
}

export const authenticateStaff: RequestHandler = async (req, res, next) => {
  const token = bearerToken(req.get("authorization"));
  if (!token) throw unauthorized();
  const principal = await staffAuth.authenticate(token);
  if (!principal) throw unauthorized();
  res.locals["staff"] = principal;
  res.setHeader("Cache-Control", "no-store");
  next();
};

export const requireMfaPending: RequestHandler = (req, _res, next) => {
  if (staffPrincipal(req).mfa === "VERIFIED") {
    throw new HttpError(409, "MFA_ALREADY_VERIFIED", "This session has already passed MFA");
  }
  next();
};

export const requireMfa: RequestHandler = (req, _res, next) => {
  const { mfa } = staffPrincipal(req);
  if (mfa !== "VERIFIED") throw new HttpError(403, "MFA_REQUIRED", "Complete two-factor verification first", { mfa });
  next();
};

export const requirePasswordCurrent: RequestHandler = (req, _res, next) => {
  if (staffPrincipal(req).mustChangePassword) {
    throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "Set a new password before continuing");
  }
  next();
};

export const requirePermission = (...required: Permission[]): RequestHandler => (req, _res, next) => {
  const { permissions } = staffPrincipal(req);
  if (!required.every((permission) => permissions.includes(permission))) {
    throw new HttpError(403, "FORBIDDEN", "Your role does not allow this", { required });
  }
  next();
};
