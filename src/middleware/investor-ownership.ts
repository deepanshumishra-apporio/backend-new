import type { Request, RequestHandler, Router } from "express";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { investorId } from "./investor-auth.ts";
import { validateCallback } from "./api-security.ts";

function uuid(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw HttpError.badRequest("Invalid resource identifier");
  }
}
/**
 * Every check here selects only the columns it compares.
 *
 * This runs on every authenticated request carrying a resource id, and an
 * order or plan id fans out to three tables at once — reading whole rows to
 * answer a yes/no question multiplies the hottest query in the application by
 * the width of the widest tables in the schema.
 */
const ownershipSelect = { id: true } as const;
/** Enough to decide "is this ONDC, and whose is it?". */
const routedSelect = { gateway: true, mfInvestmentAccountId: true } as const;

export async function ownProfile(userId: string, id: string): Promise<void> {
  uuid(id);
  const link = await db.userInvestorProfile.findFirst({
    where: { userId, investorProfileId: id, relationship: "SELF" },
    select: ownershipSelect,
  });
  if (!link) throw HttpError.notFound();
}
export async function ownAccount(userId: string, id: string): Promise<void> {
  uuid(id);
  const account = await db.mfInvestmentAccount.findFirst({
    where: {
      id,
      holdingPattern: "SINGLE",
      primaryInvestorProfile: { userLinks: { some: { userId, relationship: "SELF" } } },
    },
    select: ownershipSelect,
  });
  if (!account) throw HttpError.notFound();
}
export async function ownResource(userId: string, kind: string, id: string): Promise<void> {
  if (kind === "profileId" || kind === "investorProfileId") return ownProfile(userId, id);
  if (kind === "accountId" || kind === "mfInvestmentAccountId") return ownAccount(userId, id);
  if (kind === "preVerificationId") {
    // An FP id (`pv_…`), not one of ours, so it skips the uuid check.
    const row = await db.preVerification.findFirst({ where: { fpId: id, userId }, select: ownershipSelect });
    if (!row) throw HttpError.notFound();
    return;
  }
  uuid(id);
  if (kind === "bankAccountId") {
    const row = await db.bankAccount.findUnique({ where: { id }, select: { investorProfileId: true } });
    if (!row) throw HttpError.notFound();
    return ownProfile(userId, row.investorProfileId);
  }
  if (kind === "mandateId") {
    const row = await db.mandate.findUnique({
      where: { id },
      select: { providerName: true, bankAccountId: true },
    });
    if (!row || row.providerName !== "CYBRILLAPOA") throw HttpError.notFound();
    return ownResource(userId, "bankAccountId", row.bankAccountId);
  }
  if (kind === "orderId" || kind === "planId") {
    // The three tables of each kind share one id space, so all three are asked.
    const rows = kind === "orderId"
      ? await Promise.all([
          db.mfPurchase.findUnique({ where: { id }, select: routedSelect }),
          db.mfRedemption.findUnique({ where: { id }, select: routedSelect }),
          db.mfSwitch.findUnique({ where: { id }, select: routedSelect }),
        ])
      : await Promise.all([
          db.mfPurchasePlan.findUnique({ where: { id }, select: routedSelect }),
          db.mfRedemptionPlan.findUnique({ where: { id }, select: routedSelect }),
          db.mfSwitchPlan.findUnique({ where: { id }, select: routedSelect }),
        ]);
    const row = rows.find(Boolean);
    if (!row || row.gateway !== "CYBRILLAPOA") throw HttpError.notFound();
    return ownAccount(userId, row.mfInvestmentAccountId);
  }
  if (kind === "paymentId") {
    const row = await db.payment.findUnique({
      where: { id },
      select: { provider: true, purchases: { select: { mfPurchaseId: true } } },
    });
    // A payment with no order behind it is not reachable by anyone: there is
    // nothing to check ownership against.
    if (!row || row.provider !== "CYBRILLAPOA" || !row.purchases.length) throw HttpError.notFound();
    for (const purchase of row.purchases) await ownResource(userId, "orderId", purchase.mfPurchaseId);
    return;
  }
  if (kind === "formId") {
    const row = await db.kycForm.findFirst({ where: { id, userId }, select: ownershipSelect });
    if (!row) throw HttpError.notFound();
    return;
  }
  // An unknown parameter name is a routing mistake, not a missing record — but
  // answering 404 is the safe default: a new `:somethingId` is unguarded until
  // it has a case above, and must not fall through as authorised.
  throw HttpError.notFound();
}
export const authorizeInputs: RequestHandler = async (req, _res, next) => {
  const userId = investorId(req);
  for (const input of [req.query, req.body]) {
    if (!input || typeof input !== "object") continue;
    if (input.userId !== undefined && input.userId !== userId) throw HttpError.notFound();
    for (const field of ["postbackUrl", "proofCallbackUrl", "esignCallbackUrl"]) if (input[field] !== undefined) validateCallback(input[field]);
    for (const kind of ["investorProfileId", "mfInvestmentAccountId", "bankAccountId", "mandateId"]) {
      if (input[kind] !== undefined) await ownResource(userId, kind, input[kind]);
    }
    if (input.orderIds !== undefined) {
      if (!Array.isArray(input.orderIds) || input.orderIds.length > 10) throw HttpError.badRequest("Invalid orderIds");
      for (const id of input.orderIds) await ownResource(userId, "orderId", id);
    }
  }
  next();
};
export function protectParameters(router: Router): void {
  for (const kind of ["profileId", "accountId", "bankAccountId", "mandateId", "orderId", "planId", "paymentId", "formId", "preVerificationId"]) {
    router.param(kind, (req: Request, _res, next, id: string) => {
      void ownResource(investorId(req), kind, id).then(() => next(), next);
    });
  }
}
