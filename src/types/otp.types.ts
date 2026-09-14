import type { OtpPurpose } from "../../generated/prisma/enums.ts";

/** Where the caller came from — recorded for abuse investigation. */
export interface RequestOrigin {
  ipAddress?: string;
  userAgent?: string;
}

export interface RequestOtpInput extends RequestOrigin {
  context?: string;
  /** Raw, as typed by the user. Normalised inside the service. */
  phone: string;
  purpose: OtpPurpose;
}

export interface VerifyOtpInput extends RequestOrigin {
  context?: string;
  phone: string;
  otp: string;
  purpose: OtpPurpose;
}

export interface RequestOtpDto {
  /** Masked (+91******3210) — never echo a full number back. */
  phone: string;
  expiresAt: string;
  /** Seconds until a resend is allowed. */
  retryAfterSeconds: number;
  attemptsRemaining: number;
}

export interface VerifyOtpDto {
  phone: string;
  verified: true;
  /**
   * Single-use proof of ownership. Returned exactly once — only the hash is
   * stored — and consumed by the later signup / login / link step.
   */
  verificationToken: string;
  tokenExpiresAt: string;
}

/** Result of spending a verification token. */
export interface ConsumedVerification {
  phone: string;
  purpose: OtpPurpose;
  verifiedAt: string;
}
