// Which channel delivers an OTP, and — when it is email — the local code.
//
// MSG91 generates, stores and verifies its own codes, so nothing about an SMS
// OTP exists in our database. Email has no such service behind it: we generate
// the code, store only its hash, and verify it ourselves. That difference is
// the whole reason this module exists.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { hasEmailConfig, sendMail } from "../integrations/email.client.ts";

/**
 * Emailing OTPs sends **every** code — for every phone number anyone types —
 * to one fixed inbox. Whoever reads that inbox can sign in as anybody, so this
 * is a development affordance and nothing else.
 *
 * It is opt-in, and the boot check below refuses to let it coexist with
 * `NODE_ENV=production` rather than quietly downgrading a real deployment.
 */
export function emailOtpRequested(): boolean {
  return process.env["OTP_EMAIL_FALLBACK"]?.trim().toLowerCase() === "true";
}

/** The single inbox every emailed code goes to. */
export function otpEmailRecipient(): string | null {
  return process.env["OTP_EMAIL_RECIPIENT"]?.trim() || null;
}

/**
 * Fail at boot rather than at the first login.
 *
 * A misconfiguration that only shows up when a real investor cannot receive a
 * code is the worst time to discover it, and a fallback that silently survives
 * into production is a standing account-takeover path.
 */
export function assertOtpChannelConfig(): void {
  const devCode = devOtpCode();
  if (devCode !== null) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "OTP_DEV_CODE must not be set in production — it is a fixed code that verifies for every number",
      );
    }
    // Length is checked here because the OTP field on the client is fixed to
    // OTP_LENGTH: a code that cannot be typed is not a working bypass.
    const length = Number(process.env["OTP_LENGTH"]?.trim() || 6);
    if (!new RegExp(`^[0-9]{${length}}$`).test(devCode)) {
      throw new Error(`OTP_DEV_CODE must be exactly ${length} digits`);
    }
    console.warn(
      "[otp] OTP_DEV_CODE is set — every verification code is fixed and nothing is delivered. Development only.",
    );
    // A fixed code makes the delivery channel irrelevant, so the email
    // configuration below is not required alongside it.
    return;
  }

  if (!emailOtpRequested()) return;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "OTP_EMAIL_FALLBACK must not be enabled in production — every OTP would be delivered to one inbox",
    );
  }
  if (!otpEmailRecipient()) {
    throw new Error("OTP_EMAIL_FALLBACK is enabled but OTP_EMAIL_RECIPIENT is not set");
  }
  if (!hasEmailConfig()) {
    throw new Error(
      "OTP_EMAIL_FALLBACK is enabled but SMTP_HOST / SMTP_USER / SMTP_PASSWORD are not all set",
    );
  }
}

/**
 * A fixed code that always verifies, for environments with no SMS or email
 * provider at all.
 *
 * Nothing is delivered when this is set — `requestOtp` still creates a real
 * challenge, with every rate limit, attempt cap and lockout intact, but the
 * code is this constant instead of a random one. That keeps the whole flow
 * exercisable end to end without a provider, while leaving the code path the
 * same one production uses.
 *
 * It is, obviously, a total authentication bypass for anyone who knows the
 * value. `assertOtpChannelConfig` refuses to boot if it is set alongside
 * `NODE_ENV=production`.
 */
export function devOtpCode(): string | null {
  return process.env["OTP_DEV_CODE"]?.trim() || null;
}

/** True when every OTP is the fixed development code. */
export function usingDevOtp(): boolean {
  return devOtpCode() !== null && process.env.NODE_ENV !== "production";
}

/** True when this process delivers OTPs by email instead of SMS. */
export function usingEmailOtp(): boolean {
  return emailOtpRequested() && process.env.NODE_ENV !== "production";
}

/**
 * A numeric code of exactly `length` digits, including leading zeros.
 *
 * `randomInt` is the CSPRNG, not `Math.random` — an OTP a caller can predict is
 * not an OTP. Padding matters: trimming a leading zero would both shrink the
 * keyspace and produce a code the field cannot accept.
 */
export function generateCode(length: number): string {
  const max = 10 ** length;
  return String(randomInt(0, max)).padStart(length, "0");
}

/**
 * Hash a code for storage, salted with the challenge it belongs to.
 *
 * A six-digit code is trivially brute-forced from a bare hash — a million
 * entries is a rounding error — so the challenge id is mixed in. That makes a
 * leaked table require a fresh search per row rather than one rainbow table for
 * all of them. It is not a substitute for the attempt limit, which is what
 * actually bounds guessing.
 */
export function hashCode(challengeId: string, code: string): string {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

/** Constant-time comparison, so a wrong code cannot be narrowed by timing. */
export function codeMatches(challengeId: string, code: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashCode(challengeId, code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export interface DeliverCodeInput {
  code: string;
  /** Masked. The full number is never put in an email we do not control. */
  maskedPhone: string;
  expiryMinutes: number;
}

/**
 * Email the code to the configured inbox.
 *
 * The body names the number the code was requested for, because one inbox
 * receives codes for every number and a bare six digits would be unusable.
 */
export async function deliverCodeByEmail(input: DeliverCodeInput): Promise<void> {
  const to = otpEmailRecipient();
  if (!to) throw new Error("OTP_EMAIL_RECIPIENT is not set");

  await sendMail({
    to,
    subject: `${input.code} is your verification code`,
    text: [
      `Verification code: ${input.code}`,
      "",
      `Requested for: ${input.maskedPhone}`,
      `Valid for ${input.expiryMinutes} minutes.`,
      "",
      "This code was delivered by email because no SMS provider is configured",
      "on this environment. Do not use this setup in production.",
    ].join("\n"),
  });
}
