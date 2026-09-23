import type { Request, Response } from "express";
import * as orderService from "../services/order.service.ts";
import { listOrderPayments as listPaymentsForOrder } from "../services/payment.service.ts";
import {
  asBody,
  clientIpv4,
  oneOf,
  optionalDecimal,
  optionalString,
  requiredDecimal,
  requiredIsin,
  requiredString,
} from "../utils/validate.ts";
import { HttpError } from "../utils/http-error.ts";

const INITIATED_VIA = [
  "web",
  "mobile_app",
  "mobile_app_android",
  "mobile_app_ios",
  "mobile_web",
  "mobile_web_android",
  "mobile_web_ios",
] as const;

type OrderParams = { orderId: string };

/** Provenance every order create needs. The IP comes from the connection. */
function origin(req: Request, body: Record<string, unknown>) {
  return {
    userIp: clientIpv4({}, req.ip ?? req.socket.remoteAddress),
    initiatedVia: oneOf(body, "initiatedVia", INITIATED_VIA, false),
    ...(optionalString(body, "euin") && { euin: optionalString(body, "euin") }),
  };
}

export async function createPurchase(req: Request, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await orderService.createPurchase({
      mfInvestmentAccountId: requiredString(body, "mfInvestmentAccountId"),
      isin: requiredIsin(body),
      amount: requiredDecimal(body, "amount", { maxDecimalPlaces: 2 }),
      folioNumber: optionalString(body, "folioNumber", { maxLength: 30 }),
      // Pass the same value to retry the same intended order; a new order
      // needs a new one. FP rejects a reuse, which is what makes it safe.
      sourceRefId: optionalString(body, "sourceRefId", { maxLength: 64 }),
      ...origin(req, body),
    }),
  });
}

export async function createRedemption(req: Request, res: Response) {
  const body = asBody(req.body);
  const amount = optionalDecimal(body, "amount", { maxDecimalPlaces: 2 });
  const units = optionalDecimal(body, "units", { maxDecimalPlaces: 4 });

  res.status(201).json({
    data: await orderService.createRedemption({
      mfInvestmentAccountId: requiredString(body, "mfInvestmentAccountId"),
      isin: requiredIsin(body),
      folioNumber: requiredString(body, "folioNumber", { maxLength: 30 }),
      // Both absent is a real instruction: redeem the whole holding.
      ...(amount !== undefined && { amount }),
      ...(units !== undefined && { units }),
      sourceRefId: optionalString(body, "sourceRefId", { maxLength: 64 }),
      ...origin(req, body),
    }),
  });
}

export async function createSwitch(req: Request, res: Response) {
  const body = asBody(req.body);
  const amount = optionalDecimal(body, "amount", { maxDecimalPlaces: 2 });
  const units = optionalDecimal(body, "units", { maxDecimalPlaces: 4 });

  res.status(201).json({
    data: await orderService.createSwitch({
      mfInvestmentAccountId: requiredString(body, "mfInvestmentAccountId"),
      switchOutIsin: requiredIsin(body, "switchOutIsin"),
      switchInIsin: requiredIsin(body, "switchInIsin"),
      folioNumber: requiredString(body, "folioNumber", { maxLength: 30 }),
      ...(amount !== undefined && { amount }),
      ...(units !== undefined && { units }),
      sourceRefId: optionalString(body, "sourceRefId", { maxLength: 64 }),
      ...origin(req, body),
    }),
  });
}

/**
 * Record 2FA consent on a purchase.
 *
 * The client sends the token it got from verifying an OTP, never the contact
 * details — those are resolved from the folio, because FP checks them and
 * because a caller who could name the contact could redirect the OTP.
 *
 * Must be sent alone and before the payment: FP rejects `state` and `consent`
 * together on this route.
 */
export async function recordConsent(req: Request<OrderParams>, res: Response) {
  const body = asBody(req.body);
  res.json({
    data: await orderService.recordPurchaseConsent(req.params.orderId, {
      verificationToken: requiredString(body, "verificationToken"),
    }),
  });
}

export async function confirmPurchase(req: Request<OrderParams>, res: Response) {
  res.json({ data: await orderService.confirmPurchase(req.params.orderId) });
}

export async function confirmRedemption(req: Request<OrderParams>, res: Response) {
  const body = asBody(req.body);
  res.json({
    data: await orderService.confirmRedemption(req.params.orderId, {
      verificationToken: requiredString(body, "verificationToken"),
    }),
  });
}

export async function confirmSwitch(req: Request<OrderParams>, res: Response) {
  const body = asBody(req.body);
  res.json({
    data: await orderService.confirmSwitch(req.params.orderId, {
      verificationToken: requiredString(body, "verificationToken"),
    }),
  });
}

export async function retryPurchase(req: Request<OrderParams>, res: Response) {
  res.json({ data: await orderService.retryPurchase(req.params.orderId) });
}

export async function cancelPurchase(req: Request<OrderParams>, res: Response) {
  res.json({ data: await orderService.cancelPurchase(req.params.orderId) });
}

export async function getOrder(req: Request<OrderParams>, res: Response) {
  res.json({ data: await orderService.getOrder(req.params.orderId) });
}

export async function listOrderPayments(req: Request<OrderParams>, res: Response) {
  res.json({ data: await listPaymentsForOrder(req.params.orderId) });
}

export async function refreshOrder(req: Request<OrderParams>, res: Response) {
  res.json({ data: await orderService.refreshOrder(req.params.orderId) });
}

export async function listOrders(req: Request, res: Response) {
  const accountId = req.query["mfInvestmentAccountId"];
  if (typeof accountId !== "string") {
    throw HttpError.badRequest("mfInvestmentAccountId is required");
  }
  const rawLimit = req.query["limit"];
  const limit = typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : 20;
  res.json({ data: await orderService.listOrders(accountId, limit) });
}
