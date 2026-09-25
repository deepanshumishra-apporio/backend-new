import { Router } from "express";
import { db } from "../db/client.ts";
import { investorId } from "../middleware/investor-auth.ts";
import { ownResource } from "../middleware/investor-ownership.ts";
import { checkoutContext, consentTarget } from "../services/cart.service.ts";
import { resolveConsentContact } from "../services/order.service.ts";
import { requestOtp, verifyOtp, otpLength } from "../services/otp.service.ts";
import { asBody, oneOf, requiredString } from "../utils/validate.ts";
import { HttpError } from "../utils/http-error.ts";

/** Who the code goes to, and what it may be spent on. */
async function consentScope(
  userId: string,
  kind: "order" | "plan" | "planChange" | "cart",
  id: string,
): Promise<{ mfInvestmentAccountId: string; folioNumber: string | null; context: string }> {
  // `cart` approves every order and plan in one cart checkout with one code.
  // Its own context, so it can only ever be spent on that checkout.
  if (kind === "cart") {
    await ownResource(userId, "checkoutId", id);
    return { ...(await consentTarget(userId, id)), context: checkoutContext(id) };
  }
  await ownResource(userId, kind === "order" ? "orderId" : "planId", id);
  // Only the three fields this handler reads — see investor-ownership.ts.
  const select = { state: true, mfInvestmentAccountId: true, folioNumber: true } as const;
  const rows = kind === "order"
    ? await Promise.all([
        db.mfPurchase.findUnique({ where: { id }, select }),
        db.mfRedemption.findUnique({ where: { id }, select }),
        db.mfSwitch.findUnique({ where: { id }, select }),
      ])
    : await Promise.all([
        db.mfPurchasePlan.findUnique({ where: { id }, select }),
        db.mfRedemptionPlan.findUnique({ where: { id }, select }),
        db.mfSwitchPlan.findUnique({ where: { id }, select }),
      ]);
  const row = rows.find(Boolean);
  if (kind === "planChange") {
    if (!row || row.state !== "ACTIVE") throw HttpError.conflict("Only an active plan can be changed");
  } else if (!row || !["PENDING", "REVIEW_COMPLETED"].includes(row.state)) {
    throw HttpError.conflict("Wait for provider review before collecting transaction consent");
  }
  return { mfInvestmentAccountId: row.mfInvestmentAccountId, folioNumber: row.folioNumber, context: `${kind}:${id}` };
}

export const transactionOtpRouter = Router();
for (const operation of ["request", "verify"] as const) transactionOtpRouter.post(`/${operation}`, async (req, res) => {
  const body = asBody(req.body);
  // `planChange` approves a change to a plan that is already running — its
  // amount — rather than the plan's confirmation. It has its own context, so a
  // code issued for one can never be spent on the other.
  const kind = oneOf(body, "kind", ["order", "plan", "planChange", "cart"] as const)!;
  const id = requiredString(body, "id");
  const scope = await consentScope(investorId(req), kind, id);
  const contact = await resolveConsentContact(scope.mfInvestmentAccountId, scope.folioNumber);
  const input = { phone: `+${contact.isdCode}${contact.mobile}`, purpose: "TRANSACTION_APPROVAL" as const,
    context: scope.context, ipAddress: req.ip, userAgent: req.get("user-agent") };
  if (operation === "request") res.status(202).json({ data: await requestOtp(input) });
  else {
    const otp = requiredString(body, "otp", { pattern: new RegExp(`^\\d{${otpLength}}$`), patternHint: "Invalid OTP format" });
    res.json({ data: await verifyOtp({ ...input, otp }) });
  }
});
