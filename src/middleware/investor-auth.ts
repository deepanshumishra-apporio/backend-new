import { createHash, randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { Router } from "express";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { asBody, requiredString } from "../utils/validate.ts";
import { assertSandboxAuth } from "../utils/sandbox-auth.ts";

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const unauthorized = () => new HttpError(401, "UNAUTHORIZED", "A valid investor session is required");
export function investorId(req: Request): string {
  const id = req.res?.locals["investorUserId"];
  if (typeof id !== "string") throw unauthorized();
  return id;
}
export const requireSession: RequestHandler = async (req, res, next) => {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get("authorization") ?? "");
  if (!match?.[1]) throw unauthorized();
  const session = await db.investorSession.findUnique({
    where: { tokenHash: tokenHash(match[1]) }, include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date() ||
      session.user.deletedAt || session.user.status !== "ACTIVE" || session.user.role !== "INVESTOR") throw unauthorized();
  res.locals["investorUserId"] = session.userId;
  res.locals["sessionId"] = session.id;
  res.setHeader("Cache-Control", "no-store");
  next();
};

export const sessionRouter = Router();

/**
 * The fixed code the sandbox accepts for both the email and the mobile step.
 * Nothing is sent: no SMS provider is wired to this route, and both app screens
 * state the code on themselves.
 */
const SANDBOX_OTP = '1234';

sessionRouter.post('/sandbox', async (req, res) => {
  assertSandboxAuth();
  const body = asBody(req.body);
  const phone = requiredString(body, 'phone', { maxLength: 16 });
  const email = requiredString(body, 'email', { maxLength: 255 }).trim().toLowerCase();
  if (!/^\+91[6-9]\d{9}$/.test(phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw HttpError.badRequest('Enter a valid email and Indian mobile number');
  }
  // Each way this can fail says which one it was. They used to share the
  // session 401, whose message is about sessions: the code screen could only
  // read it as "wrong code", so an address already taken by another number told
  // the investor their 1234 was wrong and left them retyping it for ever.
  if (body.emailOtp !== SANDBOX_OTP || body.mobileOtp !== SANDBOX_OTP)
    throw new HttpError(401, 'INVALID_OTP', `Incorrect code. Use ${SANDBOX_OTP} in the sandbox.`);
  const accessToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const user = await db.$transaction(async tx => {
    // Demo verification never stamps a real email/phone verification timestamp.
    const byEmail = await tx.user.findUnique({ where: { email } });
    if (byEmail && byEmail.phone !== phone)
      throw new HttpError(409, 'SANDBOX_IDENTITY_MISMATCH',
        'This email is already signed up with a different mobile number. Use that number, or a different email.');
    // Judged before the upsert, never after: the write below activates the
    // account, so asking afterwards would wave a suspended one straight
    // through. `PENDING_VERIFICATION` passes — a code accepted here *is* that
    // account's verification, and refusing it locked out every account the real
    // OTP flow had created but not yet activated.
    const existing = await tx.user.findUnique({ where: { phone } });
    if (existing && (existing.deletedAt || existing.role !== 'INVESTOR' ||
        !['ACTIVE', 'PENDING_VERIFICATION'].includes(existing.status)))
      throw new HttpError(403, 'ACCOUNT_UNAVAILABLE', 'This account cannot sign in. Contact support.');
    const account = await tx.user.upsert({
      where: { phone }, create: { phone, email, status: 'ACTIVE' },
      update: { email, status: 'ACTIVE', lastLoginAt: now },
    });
    await tx.investorSession.create({ data: {
      userId: account.id, tokenHash: tokenHash(accessToken), expiresAt,
    } });
    return account;
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ data: { accessToken, expiresAt: expiresAt.toISOString(), userId: user.id } });
});
sessionRouter.post("/", async (req, res) => {
  const token = requiredString(asBody(req.body), "verificationToken", { maxLength: 128 });
  const now = new Date();
  const accessToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const user = await db.$transaction(async tx => {
    const consumed = await tx.phoneVerification.updateMany({
      where: { tokenHash: tokenHash(token), status: "VERIFIED", purpose: { in: ["LOGIN", "PHONE_VERIFICATION"] }, consumedAt: null, tokenExpiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) throw unauthorized();
    const proof = await tx.phoneVerification.findUniqueOrThrow({ where: { tokenHash: tokenHash(token) } });
    const user = await tx.user.upsert({ where: { phone: proof.phone },
      create: { phone: proof.phone, status: "ACTIVE", phoneVerifiedAt: now },
      update: { lastLoginAt: now, phoneVerifiedAt: now },
    });
    if (user.deletedAt || !["ACTIVE", "PENDING_VERIFICATION"].includes(user.status) || user.role !== "INVESTOR") throw unauthorized();
    await tx.user.update({ where: { id: user.id }, data: { status: "ACTIVE", lastLoginAt: now } });
    await tx.investorSession.create({ data: { userId: user.id, tokenHash: tokenHash(accessToken), expiresAt } });
    return user;
  });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ data: { accessToken, tokenType: "Bearer", expiresAt: expiresAt.toISOString(), userId: user.id } });
});
sessionRouter.delete("/current", requireSession, async (_req, res) => {
  await db.investorSession.update({ where: { id: res.locals["sessionId"] }, data: { revokedAt: new Date() } });
  res.status(204).end();
});
