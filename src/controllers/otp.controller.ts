import type { Request, Response } from "express";
import { OtpPurpose } from "../../generated/prisma/enums.ts";
import * as otpService from "../services/otp.service.ts";
import { HttpError } from "../utils/http-error.ts";

/**
 * Which purposes a client is allowed to ask for.
 *
 * TRANSACTION_APPROVAL is deliberately excluded: approving a transaction must
 * be initiated by an authenticated server-side flow, never by an anonymous
 * caller naming the purpose it wants.
 */
const CLIENT_PURPOSES = [OtpPurpose.PHONE_VERIFICATION, OtpPurpose.LOGIN] as const;

function parsePurpose(raw: unknown): OtpPurpose {
  if (raw === undefined) return OtpPurpose.PHONE_VERIFICATION;
  if (typeof raw !== "string" || !CLIENT_PURPOSES.includes(raw as (typeof CLIENT_PURPOSES)[number])) {
    throw HttpError.badRequest(`purpose must be one of: ${CLIENT_PURPOSES.join(", ")}`);
  }
  return raw as OtpPurpose;
}

function requireString(body: Record<string, unknown> | undefined, field: string): string {
  const value = body?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw HttpError.badRequest(`${field} is required`);
  }
  return value.trim();
}

/** Origin metadata for rate-limit forensics and the audit trail. */
function origin(req: Request) {
  return {
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  };
}

// POST /api/v1/otp/request   { phone, purpose? }
export async function request(req: Request, res: Response) {
  const body = req.body as Record<string, unknown> | undefined;

  const result = await otpService.requestOtp({
    phone: requireString(body, "phone"),
    purpose: parsePurpose(body?.["purpose"]),
    ...origin(req),
  });

  // 202: the OTP is on its way via a third party, not delivered by this response.
  res.status(202).json({ data: result });
}

// POST /api/v1/otp/verify    { phone, otp, purpose? }
export async function verify(req: Request, res: Response) {
  const body = req.body as Record<string, unknown> | undefined;
  const otp = requireString(body, "otp");

  // Shape-check only. Whether it is the *right* code is MSG91's answer, and
  // this must not become a way to probe the expected length.
  if (!new RegExp(`^\\d{${otpService.otpLength}}$`).test(otp)) {
    throw HttpError.badRequest(`otp must be ${otpService.otpLength} digits`);
  }

  const result = await otpService.verifyOtp({
    phone: requireString(body, "phone"),
    otp,
    purpose: parsePurpose(body?.["purpose"]),
    ...origin(req),
  });

  res.json({ data: result });
}
