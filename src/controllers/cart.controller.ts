import type { Request, Response } from "express";
import { investorId } from "../middleware/investor-auth.ts";
import * as cartService from "../services/cart.service.ts";
import {
  asBody,
  clientIpv4,
  oneOf,
  optionalInt,
  optionalString,
  requiredDecimal,
  requiredIsin,
  requiredString,
} from "../utils/validate.ts";
import { HttpError } from "../utils/http-error.ts";

const ITEM_TYPES = ["LUMPSUM", "SIP"] as const;
const PAYMENT_METHODS = ["NETBANKING", "UPI"] as const;
const INITIATED_VIA = [
  "web",
  "mobile_app",
  "mobile_app_android",
  "mobile_app_ios",
  "mobile_web",
  "mobile_web_android",
  "mobile_web_ios",
] as const;

type ItemParams = { cartItemId: string };
type CheckoutParams = { checkoutId: string };

export async function getCart(req: Request, res: Response) {
  res.json({ data: await cartService.getCart(investorId(req)) });
}

export async function putItem(req: Request, res: Response) {
  const body = asBody(req.body);
  const amount = requiredDecimal(body, "amount", { maxDecimalPlaces: 2 });
  if (Number(amount) <= 0) throw HttpError.badRequest("amount must be more than zero");
  res.json({
    data: await cartService.putCartItem({
      userId: investorId(req),
      isin: requiredIsin(body),
      type: oneOf(body, "type", ITEM_TYPES)!,
      amount,
    }),
  });
}

export async function removeItem(req: Request<ItemParams>, res: Response) {
  res.json({ data: await cartService.removeCartItem(investorId(req), req.params.cartItemId) });
}

export async function createCheckout(req: Request, res: Response) {
  const body = asBody(req.body);
  const mandateId = optionalString(body, "mandateId");
  const installmentDay = optionalInt(body, "installmentDay", { min: 1, max: 28 });
  const initiatedVia = oneOf(body, "initiatedVia", INITIATED_VIA, false);
  res.status(201).json({
    data: await cartService.createCheckout({
      userId: investorId(req),
      mfInvestmentAccountId: requiredString(body, "mfInvestmentAccountId"),
      ...(mandateId && { mandateId }),
      ...(installmentDay !== undefined && { installmentDay }),
      userIp: clientIpv4({}, req.ip ?? req.socket.remoteAddress),
      ...(initiatedVia && { initiatedVia }),
    }),
  });
}

export async function getCheckout(req: Request<CheckoutParams>, res: Response) {
  res.json({ data: await cartService.getCheckout(investorId(req), req.params.checkoutId) });
}

export async function refreshCheckout(req: Request<CheckoutParams>, res: Response) {
  res.json({ data: await cartService.refreshCheckout(investorId(req), req.params.checkoutId) });
}

export async function consentCheckout(req: Request<CheckoutParams>, res: Response) {
  const body = asBody(req.body);
  res.json({
    data: await cartService.consentCheckout(
      investorId(req),
      req.params.checkoutId,
      requiredString(body, "verificationToken"),
    ),
  });
}

export async function payCheckout(req: Request<CheckoutParams>, res: Response) {
  const body = asBody(req.body);
  const method = oneOf(body, "method", PAYMENT_METHODS, false);
  const bankAccountId = optionalString(body, "bankAccountId");
  res.status(201).json({
    data: await cartService.payCheckout(investorId(req), req.params.checkoutId, {
      ...(method && { method }),
      ...(bankAccountId && { bankAccountId }),
    }),
  });
}
