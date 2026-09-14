import { createHash, randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { Router } from "express";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { asBody, requiredString } from "../utils/validate.ts";

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
