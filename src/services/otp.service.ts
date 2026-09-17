import { createHash, randomBytes } from "node:crypto";
import { db } from "../db/client.ts";
import * as msg91 from "../integrations/msg91.client.ts";
import { Msg91Error } from "../integrations/msg91.client.ts";
import { HttpError } from "../utils/http-error.ts";
import { maskPhone, normalisePhone, toProviderFormat } from "../utils/phone.ts";
import {
  codeMatches,
  deliverCodeByEmail,
  devOtpCode,
  generateCode,
  hashCode,
  usingDevOtp,
  usingEmailOtp,
} from "./otp-channel.ts";
import { EmailError } from "../integrations/email.client.ts";
import type {
  ConsumedVerification,
  RequestOtpDto,
  RequestOtpInput,
  VerifyOtpDto,
  VerifyOtpInput,
} from "../types/otp.types.ts";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

/**
 * Abuse controls. MSG91 cannot enforce these for us — every OTP it sends costs
 * money and every unthrottled endpoint is an SMS-bombing vector aimed at
 * whatever number the caller types.
 */
const POLICY = {
  otpLength: envInt("OTP_LENGTH", 6),
  ttlMinutes: envInt("OTP_TTL_MINUTES", 10),
  maxAttempts: envInt("OTP_MAX_ATTEMPTS", 5),
  resendCooldownSeconds: envInt("OTP_RESEND_COOLDOWN_SECONDS", 60),
  maxSendsPerHour: envInt("OTP_MAX_SENDS_PER_HOUR", 5),
  maxSendsPerDay: envInt("OTP_MAX_SENDS_PER_DAY", 10),
  lockoutMinutes: envInt("OTP_LOCKOUT_MINUTES", 30),
  tokenTtlMinutes: envInt("OTP_TOKEN_TTL_MINUTES", 15),
} as const;

export const otpLength = POLICY.otpLength;

const secondsUntil = (when: Date) => Math.max(1, Math.ceil((when.getTime() - Date.now()) / 1000));

/** Tokens are stored hashed so a database leak yields nothing usable. */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Translate a transport/config failure into a client-safe response. */
function toHttpError(error: unknown): never {
  if (error instanceof EmailError) {
    throw error.retryable
      ? HttpError.badGateway("Could not send the code, please try again")
      : HttpError.serviceUnavailable("Code delivery is not configured");
  }
  if (error instanceof Msg91Error) {
    // retryable = provider blip. Not retryable = our misconfiguration, which is
    // a 503 because the caller can do nothing about it.
    throw error.retryable
      ? HttpError.badGateway("Could not reach the SMS provider, please try again")
      : HttpError.serviceUnavailable("SMS delivery is not configured");
  }
  throw error;
}

async function writeAudit(
  action: string,
  entityId: string,
  input: { phone: string; ipAddress?: string; userAgent?: string },
  metadata: Record<string, unknown>,
) {
  await db.auditLog.create({
    data: {
      action,
      entityType: "PhoneVerification",
      entityId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      // Masked, always. An audit table is not a place for full phone numbers,
      // and never for the OTP itself.
      metadata: { phone: maskPhone(input.phone), ...metadata },
    },
  });
}

/**
 * Reject if this number has burnt its send budget.
 *
 * Windows are measured from record creation. A challenge lives at most
 * OTP_TTL_MINUTES, so a resend can in principle be attributed to the window in
 * which its challenge started rather than the one it happened in — bounded and
 * far smaller than the window, so it does not matter in practice.
 */
async function assertSendBudget(phone: string) {
  const now = Date.now();
  const windows = [
    { since: new Date(now - 3_600_000), cap: POLICY.maxSendsPerHour, label: "hour" },
    { since: new Date(now - 86_400_000), cap: POLICY.maxSendsPerDay, label: "day" },
  ];

  for (const window of windows) {
    const { _sum } = await db.phoneVerification.aggregate({
      _sum: { sendCount: true },
      where: { phone, createdAt: { gte: window.since } },
    });

    if ((_sum.sendCount ?? 0) >= window.cap) {
      throw HttpError.tooManyRequests(
        `Too many OTP requests for this number. Try again later.`,
        { limit: window.cap, window: window.label },
      );
    }
  }
}

/**
 * Send an OTP, or redeliver the active one.
 *
 * MSG91 generates and stores the code; we store only the challenge metadata, so
 * there is no OTP anywhere in our database or logs to leak.
 */
export async function requestOtp(input: RequestOtpInput): Promise<RequestOtpDto> {
  const phone = normalisePhone(input.phone);
  const providerPhone = toProviderFormat(phone);
  const now = new Date();

  const latest = await db.phoneVerification.findFirst({
    where: { phone },
    orderBy: { createdAt: "desc" },
  });

  // Checked before status, and on the newest record whatever its status: after
  // a lockout the record is FAILED, and only looking at PENDING rows here would
  // let a caller escape the lockout simply by asking for a new challenge.
  if (latest?.lockedUntil && latest.lockedUntil > now) {
    throw HttpError.tooManyRequests("Too many incorrect attempts. Try again later.", {
      retryAfterSeconds: secondsUntil(latest.lockedUntil),
    });
  }

  await assertSendBudget(phone);

  let active = latest?.status === "PENDING" && latest.expiresAt > now ? latest : null;
  // Older builds created transaction challenges without a resource context.
  // They cannot authorise anything. Retire them rather than attaching an old
  // code to a new transaction; lockout and phone-wide send budgets above remain.
  if (active?.purpose === "TRANSACTION_APPROVAL" && active.context === null &&
      input.purpose === "TRANSACTION_APPROVAL" && input.context) {
    await db.phoneVerification.updateMany({
      where: { id: active.id, status: "PENDING", context: null },
      data: { status: "EXPIRED" },
    });
    active = null;
  }
  if (active && (active.purpose !== input.purpose || active.context !== (input.context ?? null))) {
    throw HttpError.conflict("Complete or wait for the current OTP challenge before starting another action");
  }

  if (active) {
    const nextAllowedAt = new Date(
      active.lastSentAt.getTime() + POLICY.resendCooldownSeconds * 1000,
    );
    if (nextAllowedAt > now) {
      throw HttpError.tooManyRequests("An OTP was just sent. Please wait before requesting another.", {
        retryAfterSeconds: secondsUntil(nextAllowedAt),
      });
    }

    let updated;
    if (usingDevOtp()) {
      const code = devOtpCode();
      if (code === null) throw new Error("OTP_DEV_CODE disappeared between checks");
      // Nothing to deliver — the code is constant. The challenge is still
      // touched so the cooldown and send budget behave exactly as they would
      // with a real provider.
      updated = await db.phoneVerification.update({
        where: { id: active.id },
        data: { sendCount: { increment: 1 }, lastSentAt: now, codeHash: hashCode(active.id, code) },
      });
    } else if (usingEmailOtp()) {
      // A fresh code on every resend rather than redelivering the old one: we
      // store only a hash, so there is nothing to re-send, and rotating costs
      // nothing. The challenge itself is untouched, so attempts and expiry
      // carry over exactly as they would with MSG91.
      const code = generateCode(POLICY.otpLength);
      updated = await db.phoneVerification.update({
        where: { id: active.id },
        data: {
          sendCount: { increment: 1 },
          lastSentAt: now,
          codeHash: hashCode(active.id, code),
        },
      });
      await deliverCodeByEmail({
        code,
        maskedPhone: maskPhone(phone),
        expiryMinutes: POLICY.ttlMinutes,
      }).catch(toHttpError);
    } else {
      const result = await msg91.resendOtp(providerPhone).catch(toHttpError);
      if (!result.ok) throw mapSendFailure(result);

      updated = await db.phoneVerification.update({
        where: { id: active.id },
        data: {
          sendCount: { increment: 1 },
          lastSentAt: now,
          ...(result.requestId && { providerRequestId: result.requestId }),
        },
      });
    }

    await writeAudit("OTP_RESENT", updated.id, { phone, ipAddress: input.ipAddress, userAgent: input.userAgent }, {
      purpose: input.purpose,
      context: input.context ?? null,
      sendCount: updated.sendCount,
    });

    return {
      phone: maskPhone(phone),
      expiresAt: updated.expiresAt.toISOString(),
      retryAfterSeconds: POLICY.resendCooldownSeconds,
      attemptsRemaining: Math.max(0, POLICY.maxAttempts - updated.attempts),
    };
  }

  const challenge = {
    phone,
    purpose: input.purpose,
    // Persisted, not just audited. `verifyOtp` looks the challenge up by
    // `context`, and `consumeVerificationToken` refuses a token whose context
    // does not match the thing being approved — so a challenge stored without
    // one could never be verified for a transaction, and `confirmPlan` could
    // never be reached. Every SIP ever created sat unconfirmed because of this.
    context: input.context ?? null,
    status: "PENDING" as const,
    expiresAt: new Date(now.getTime() + POLICY.ttlMinutes * 60_000),
    lastSentAt: now,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
  };

  let created;
  if (usingDevOtp()) {
    const code = devOtpCode();
    if (code === null) throw new Error("OTP_DEV_CODE disappeared between checks");
    created = await db.phoneVerification.create({ data: challenge });
    created = await db.phoneVerification.update({
      where: { id: created.id },
      data: { codeHash: hashCode(created.id, code) },
    });
  } else if (usingEmailOtp()) {
    // The hash is salted with the row id, so the row has to exist first. The
    // window between the two writes holds a challenge whose code cannot match
    // anything — `codeMatches` fails closed on a null hash — so a crash here
    // leaves a dead challenge that expires, never an open one.
    const code = generateCode(POLICY.otpLength);
    created = await db.phoneVerification.create({ data: challenge });
    created = await db.phoneVerification.update({
      where: { id: created.id },
      data: { codeHash: hashCode(created.id, code) },
    });

    try {
      await deliverCodeByEmail({
        code,
        maskedPhone: maskPhone(phone),
        expiryMinutes: POLICY.ttlMinutes,
      });
    } catch (error) {
      // Undeliverable: retire the challenge so it does not occupy the "active"
      // slot and block the caller from trying again for the full TTL.
      await db.phoneVerification.update({
        where: { id: created.id },
        data: { status: "EXPIRED" },
      });
      toHttpError(error);
    }
  } else {
    const result = await msg91
      .sendOtp(providerPhone, { otpLength: POLICY.otpLength, expiryMinutes: POLICY.ttlMinutes })
      .catch(toHttpError);
    if (!result.ok) throw mapSendFailure(result);

    created = await db.phoneVerification.create({
      data: { ...challenge, providerRequestId: result.requestId },
    });
  }

  await writeAudit("OTP_SENT", created.id, { phone, ipAddress: input.ipAddress, userAgent: input.userAgent }, { purpose: input.purpose });

  return {
    phone: maskPhone(phone),
    expiresAt: created.expiresAt.toISOString(),
    retryAfterSeconds: POLICY.resendCooldownSeconds,
    attemptsRemaining: POLICY.maxAttempts,
  };
}

function mapSendFailure(result: { reason: msg91.SendFailureReason; message: string }): HttpError {
  switch (result.reason) {
    case "RATE_LIMITED":
      return HttpError.tooManyRequests("The SMS provider is rate limiting this number");
    case "INVALID_NUMBER":
      return HttpError.badRequest("The SMS provider rejected this number");
    default:
      // Provider message is not echoed to the caller — it can carry account
      // and template detail. The audit/log trail keeps it.
      return HttpError.badGateway("Could not send the OTP, please try again");
  }
}

/**
 * Verify a code and, on success, issue a single-use proof of ownership.
 *
 * There is no user id anywhere in this flow. Ownership is proved for a *phone
 * number*, and the returned token is what a later signup / login / link step
 * spends — so this endpoint cannot be pointed at somebody else's account.
 */
export async function verifyOtp(input: VerifyOtpInput): Promise<VerifyOtpDto> {
  const phone = normalisePhone(input.phone);
  const now = new Date();

  const challenge = await db.phoneVerification.findFirst({
    where: { phone, purpose: input.purpose, context: input.context ?? null },
    orderBy: { createdAt: "desc" },
  });

  if (!challenge) {
    throw HttpError.badRequest("No OTP was requested for this number");
  }
  if (challenge.lockedUntil && challenge.lockedUntil > now) {
    throw HttpError.tooManyRequests("Too many incorrect attempts. Try again later.", {
      retryAfterSeconds: secondsUntil(challenge.lockedUntil),
    });
  }
  if (challenge.status === "VERIFIED") {
    throw HttpError.conflict("This number is already verified. Request a new OTP.");
  }
  if (challenge.status !== "PENDING") {
    throw HttpError.badRequest("This OTP is no longer valid. Request a new one.");
  }
  if (challenge.expiresAt <= now) {
    await db.phoneVerification.update({
      where: { id: challenge.id },
      data: { status: "EXPIRED" },
    });
    throw HttpError.badRequest("This OTP has expired. Request a new one.");
  }

  // Incremented BEFORE calling the provider. If this request dies mid-flight
  // the attempt is still spent — otherwise a caller could brute force by
  // killing the connection after each guess.
  const { attempts } = await db.phoneVerification.update({
    where: { id: challenge.id },
    data: { attempts: { increment: 1 } },
    select: { attempts: true },
  });

  if (attempts > POLICY.maxAttempts) {
    const lockedUntil = new Date(now.getTime() + POLICY.lockoutMinutes * 60_000);
    await db.phoneVerification.update({
      where: { id: challenge.id },
      data: { status: "FAILED", lockedUntil },
    });
    throw HttpError.tooManyRequests("Too many incorrect attempts. Request a new OTP later.", {
      retryAfterSeconds: secondsUntil(lockedUntil),
    });
  }

  /*
   * Which side holds the code decides which side checks it. `codeHash` is set
   * only by the email path, so its presence — not the current environment — is
   * what routes this. A challenge created under one channel therefore still
   * verifies correctly if the deployment is switched while it is in flight.
   */
  const result: msg91.VerifyOtpResult =
    challenge.codeHash !== null
      ? codeMatches(challenge.id, input.otp, challenge.codeHash)
        ? { ok: true }
        : { ok: false, reason: "MISMATCH", message: "Incorrect code" }
      : await msg91.verifyOtp(toProviderFormat(phone), input.otp).catch(toHttpError);

  if (!result.ok) {
    const attemptsRemaining = Math.max(0, POLICY.maxAttempts - attempts);

    if (attemptsRemaining === 0) {
      const lockedUntil = new Date(now.getTime() + POLICY.lockoutMinutes * 60_000);
      await db.phoneVerification.update({
        where: { id: challenge.id },
        data: { status: "FAILED", lockedUntil },
      });
    }

    await writeAudit("OTP_VERIFY_FAILED", challenge.id, { phone, ipAddress: input.ipAddress, userAgent: input.userAgent }, {
      reason: result.reason,
      attempts,
    });

    throw mapVerifyFailure(result.reason, attemptsRemaining);
  }

  const token = randomBytes(32).toString("base64url");
  const tokenExpiresAt = new Date(now.getTime() + POLICY.tokenTtlMinutes * 60_000);

  // One transaction: the challenge must not be marked verified without the
  // token being stored, and if this number already belongs to an account that
  // account's phoneVerifiedAt moves in the same commit.
  await db.$transaction(async (tx) => {
    const verified = await tx.phoneVerification.updateMany({
      where: { id: challenge.id, status: "PENDING", attempts: { lte: POLICY.maxAttempts }, expiresAt: { gt: new Date() } },
      data: {
        status: "VERIFIED",
        verifiedAt: now,
        tokenHash: hashToken(token),
        tokenExpiresAt,
      },
    });
    if (verified.count !== 1) throw HttpError.conflict("OTP challenge has already been used or expired");

    // updateMany, not update: it is a no-op when no account holds this number
    // yet, which is the normal case during signup.
    await tx.user.updateMany({
      where: { phone, deletedAt: null },
      data: { phoneVerifiedAt: now },
    });
  });

  await writeAudit("OTP_VERIFIED", challenge.id, { phone, ipAddress: input.ipAddress, userAgent: input.userAgent }, { purpose: input.purpose });

  return {
    phone: maskPhone(phone),
    verified: true,
    verificationToken: token,
    tokenExpiresAt: tokenExpiresAt.toISOString(),
  };
}

function mapVerifyFailure(reason: msg91.VerifyFailureReason, attemptsRemaining: number): HttpError {
  switch (reason) {
    case "MISMATCH":
      return HttpError.badRequest("Incorrect OTP", { attemptsRemaining });
    case "EXPIRED":
      return HttpError.badRequest("This OTP has expired. Request a new one.");
    case "ALREADY_VERIFIED":
      return HttpError.conflict("This OTP has already been used");
    case "NOT_FOUND":
      return HttpError.badRequest("No active OTP for this number. Request a new one.");
    default:
      return HttpError.badGateway("Could not verify the OTP, please try again");
  }
}

/**
 * Spend a verification token.
 *
 * Call this from signup / login / phone-linking to confirm the caller proved
 * ownership of the number. Single use: the token is consumed here, so it cannot
 * be replayed to verify a second account.
 */
export async function consumeVerificationToken(token: string, context?: string): Promise<ConsumedVerification> {
  const now = new Date();

  // Conditional update rather than read-then-write: two concurrent requests
  // cannot both consume the same token, because only one UPDATE can match the
  // `consumedAt: null` predicate.
  const { count } = await db.phoneVerification.updateMany({
    where: {
      tokenHash: hashToken(token),
      status: "VERIFIED",
      consumedAt: null,
      tokenExpiresAt: { gt: now },
      ...(context && { context, purpose: "TRANSACTION_APPROVAL" }),
    },
    data: { consumedAt: now },
  });

  if (count === 0) {
    throw HttpError.badRequest("This verification token is invalid, expired or already used");
  }

  const record = await db.phoneVerification.findFirstOrThrow({
    where: { tokenHash: hashToken(token) },
    select: { phone: true, purpose: true, verifiedAt: true },
  });

  return {
    phone: record.phone,
    purpose: record.purpose,
    verifiedAt: (record.verifiedAt ?? now).toISOString(),
  };
}
