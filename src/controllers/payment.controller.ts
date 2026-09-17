import type { Request, Response } from "express";
import * as paymentService from "../services/payment.service.ts";
import {
  asBody,
  oneOf,
  optionalString,
  requiredDecimal,
  requiredString,
  requiredStringArray,
} from "../utils/validate.ts";
import { HttpError } from "../utils/http-error.ts";

const MANDATE_TYPES = ["E_MANDATE", "UPI"] as const;
const PROVIDERS = ["CYBRILLAPOA"] as const;
const PAYMENT_METHODS = ["NETBANKING", "UPI"] as const;

type MandateParams = { mandateId: string };
type PaymentParams = { paymentId: string };

export async function createMandate(req: Request, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await paymentService.createMandate({
      bankAccountId: requiredString(body, "bankAccountId"),
      mandateType: oneOf(body, "mandateType", MANDATE_TYPES) as string,
      mandateLimit: requiredDecimal(body, "mandateLimit", { maxDecimalPlaces: 2 }),
      // Not optional in practice: without it FP falls back to the tenant
      // default, which fails outright when that default is ONDC.
      providerName: oneOf(body, "providerName", PROVIDERS, false),
      validFrom: optionalString(body, "validFrom"),
      validTo: optionalString(body, "validTo"),
    }),
  });
}

/**
 * Sandbox only. Outside it the route is not mounted at all, so this is a second
 * guard rather than the only one.
 */
export async function simulateMandate(req: Request<MandateParams>, res: Response) {
  if (!paymentService.mandateSimulationAvailable()) throw HttpError.notFound("Route not found");
  const body = asBody(req.body ?? {});
  res.json({
    data: await paymentService.simulateMandateSettlement(
      req.params.mandateId,
      oneOf(body, "status", ["APPROVED", "REJECTED"] as const, false) ?? "APPROVED",
    ),
  });
}

export async function authorizeMandate(req: Request<MandateParams>, res: Response) {
  const body = asBody(req.body ?? {});
  res.json({
    data: await paymentService.authorizeMandate(
      req.params.mandateId,
      optionalString(body, "postbackUrl", { maxLength: 1000 }),
    ),
  });
}

export async function getMandate(req: Request<MandateParams>, res: Response) {
  res.json({ data: await paymentService.getMandate(req.params.mandateId) });
}

export async function refreshMandate(req: Request<MandateParams>, res: Response) {
  res.json({ data: await paymentService.refreshMandate(req.params.mandateId) });
}

export async function listMandates(req: Request, res: Response) {
  const profileId = req.query["investorProfileId"];
  if (typeof profileId !== "string") {
    throw HttpError.badRequest("investorProfileId is required");
  }
  res.json({ data: await paymentService.listMandates(profileId) });
}

/**
 * Cancelling a mandate fails the future payments of every SIP it funds, so the
 * count of affected plans is returned alongside — the client should have
 * warned the investor before calling.
 */
export async function cancelMandate(req: Request<MandateParams>, res: Response) {
  const affectedPlans = await paymentService.plansFundedByMandate(req.params.mandateId);
  const mandate = await paymentService.cancelMandate(req.params.mandateId);
  res.json({ data: { ...mandate, affectedPlans } });
}

export async function payByNetbanking(req: Request, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await paymentService.payByNetbanking({
      orderIds: requiredStringArray(body, "orderIds"),
      method: oneOf(body, "method", PAYMENT_METHODS, false),
      postbackUrl: optionalString(body, "postbackUrl", { maxLength: 1000 }),
      bankAccountId: optionalString(body, "bankAccountId"),
      providerName: oneOf(body, "providerName", PROVIDERS, false),
    }),
  });
}

export async function payByMandate(req: Request<MandateParams>, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await paymentService.payByMandate(
      req.params.mandateId,
      requiredStringArray(body, "orderIds"),
    ),
  });
}

export async function getPayment(req: Request<PaymentParams>, res: Response) {
  res.json({ data: await paymentService.getPayment(req.params.paymentId) });
}

export async function refreshPayment(req: Request<PaymentParams>, res: Response) {
  res.json({ data: await paymentService.refreshPayment(req.params.paymentId) });
}
