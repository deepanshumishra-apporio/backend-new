import type { Request, Response } from "express";
import * as planService from "../services/plan.service.ts";
import {
  asBody,
  clientIpv4,
  oneOf,
  optionalDecimal,
  optionalInt,
  optionalString,
  requiredDecimal,
  requiredInt,
  requiredIsin,
  requiredString,
} from "../utils/validate.ts";
import { HttpError } from "../utils/http-error.ts";

/** Our enum names, which is what the service passes to scheme-rules. */
const FREQUENCIES = [
  "DAILY",
  "CALENDAR_DAY_DAILY",
  "DAY_IN_A_WEEK",
  "FOUR_TIMES_A_MONTH",
  "DAY_IN_A_FORTNIGHT",
  "TWICE_A_MONTH",
  "MONTHLY",
  "QUARTERLY",
  "HALF_YEARLY",
  "YEARLY",
] as const;

const PURPOSES = [
  "children_education",
  "children_marriage",
  "house",
  "car",
  "travel",
  "retirement",
  "others",
] as const;

const CANCELLATION_CODES = [
  "amount_not_available",
  "investment_returns_not_as_expected",
  "custom_reason",
] as const;

type PlanParams = { planId: string };

function shared(req: Request, body: Record<string, unknown>) {
  // Our enum name, e.g. MONTHLY. The service translates it to FP's wire form
  // — controllers and services share one vocabulary, and only the FP client
  // speaks FP's.
  return {
    mfInvestmentAccountId: requiredString(body, "mfInvestmentAccountId"),
    frequency: oneOf(body, "frequency", FREQUENCIES) as string,
    installmentDay: optionalInt(body, "installmentDay", { min: 1, max: 28 }),
    numberOfInstallments: requiredInt(body, "numberOfInstallments", { min: 1, max: 1200 }),
    userIp: clientIpv4({}, req.ip ?? req.socket.remoteAddress),
    sourceRefId: optionalString(body, "sourceRefId", { maxLength: 64 }),
  };
}

export async function createSip(req: Request, res: Response) {
  const body = asBody(req.body);
  const base = shared(req, body);

  res.status(201).json({
    data: await planService.createSip({
      ...base,
      isin: requiredIsin(body),
      amount: requiredDecimal(body, "amount", { maxDecimalPlaces: 2 }),
      folioNumber: optionalString(body, "folioNumber", { maxLength: 30 }),
      mandateId: optionalString(body, "mandateId"),
      purpose: oneOf(body, "purpose", PURPOSES, false),
    }),
  });
}

export async function createSwp(req: Request, res: Response) {
  const body = asBody(req.body);
  const base = shared(req, body);
  const amount = optionalDecimal(body, "amount", { maxDecimalPlaces: 2 });
  const units = optionalDecimal(body, "units", { maxDecimalPlaces: 4 });
  if (amount === undefined && units === undefined) {
    throw HttpError.badRequest("An SWP needs either an amount or a number of units");
  }

  res.status(201).json({
    data: await planService.createSwp({
      ...base,
      isin: requiredIsin(body),
      folioNumber: requiredString(body, "folioNumber", { maxLength: 30 }),
      ...(amount !== undefined && { amount }),
      ...(units !== undefined && { units }),
    }),
  });
}

export async function createStp(req: Request, res: Response) {
  const body = asBody(req.body);
  const base = shared(req, body);
  const amount = optionalDecimal(body, "amount", { maxDecimalPlaces: 2 });
  const units = optionalDecimal(body, "units", { maxDecimalPlaces: 4 });
  if (amount === undefined && units === undefined) {
    throw HttpError.badRequest("An STP needs either an amount or a number of units");
  }

  res.status(201).json({
    data: await planService.createStp({
      ...base,
      switchOutIsin: requiredIsin(body, "switchOutIsin"),
      switchInIsin: requiredIsin(body, "switchInIsin"),
      folioNumber: requiredString(body, "folioNumber", { maxLength: 30 }),
      ...(amount !== undefined && { amount }),
      ...(units !== undefined && { units }),
    }),
  });
}

export async function getPlan(req: Request<PlanParams>, res: Response) {
  res.json({ data: await planService.getPlan(req.params.planId) });
}

export async function listPlans(req: Request, res: Response) {
  const accountId = req.query["mfInvestmentAccountId"];
  if (typeof accountId !== "string") {
    throw HttpError.badRequest("mfInvestmentAccountId is required");
  }
  res.json({ data: await planService.listPlans(accountId) });
}

export async function cancelPlan(req: Request<PlanParams>, res: Response) {
  const body = asBody(req.body);
  const code = oneOf(body, "cancellationCode", CANCELLATION_CODES) as string;
  const reason = optionalString(body, "cancellationReason", { maxLength: 500 });
  if (code === "custom_reason" && !reason) {
    throw HttpError.badRequest("cancellationReason is required with custom_reason");
  }
  res.json({ data: await planService.cancelPlan(req.params.planId, code, reason) });
}

export async function refreshPlan(req: Request<PlanParams>, res: Response) {
  res.json({ data: await planService.refreshPlan(req.params.planId) });
}
export async function confirmPlan(req: Request<PlanParams>, res: Response) {
  res.json({ data: await planService.confirmPlan(req.params.planId, requiredString(asBody(req.body), "verificationToken")) });
}
