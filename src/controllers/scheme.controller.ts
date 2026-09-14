import type { Request, Response } from "express";
import {
  SchemeCategory,
  SchemeInvestmentOption,
  SchemePlanType,
} from "../../generated/prisma/enums.ts";
import * as schemeService from "../services/scheme.service.ts";
import { HttpError } from "../utils/http-error.ts";

/** An ISIN is 12 alphanumerics; Indian MF ISINs start with INF. */
const ISIN_PATTERN = /^INF[0-9A-Z]{9}$/;

function parseEnum<T extends Record<string, string>>(values: T, raw: unknown, field: string) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !Object.values(values).includes(raw)) {
    throw HttpError.badRequest(`${field} must be one of: ${Object.values(values).join(", ")}`);
  }
  return raw as T[keyof T];
}

function parseCount(raw: unknown, field: string, fallback: number) {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw HttpError.badRequest(`${field} must be a positive integer`);
  }
  return Number(raw);
}

function parseBoolean(raw: unknown, field: string) {
  if (raw === undefined) return undefined;
  if (raw !== "true" && raw !== "false") {
    throw HttpError.badRequest(`${field} must be "true" or "false"`);
  }
  return raw === "true";
}

/** Reject a malformed ISIN here so the service never queries on junk. */
function parseIsin(raw: string): string {
  const isin = raw.toUpperCase();
  if (!ISIN_PATTERN.test(isin)) {
    throw HttpError.badRequest(`"${raw}" is not a valid mutual fund ISIN`);
  }
  return isin;
}

export async function list(req: Request, res: Response) {
  const search = req.query["q"];
  if (search !== undefined && (typeof search !== "string" || search.length > 100)) throw HttpError.badRequest("q must be at most 100 characters");
  const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : undefined;
  const sipOnly = parseBoolean(req.query["sipOnly"], "sipOnly");

  res.json(
    await schemeService.listSchemes({
      ...(typeof search === "string" && search.trim() && { search: search.trim() }),
      category: parseEnum(SchemeCategory, req.query["category"], "category"),
      planType: parseEnum(SchemePlanType, req.query["planType"], "planType"),
      investmentOption: parseEnum(
        SchemeInvestmentOption,
        req.query["investmentOption"],
        "investmentOption",
      ),
      ...(sipOnly !== undefined && { sipOnly }),
      limit: Math.min(parseCount(req.query["limit"], "limit", 20), 100),
      ...(cursor && { cursor }),
    }),
  );
}

// Params are only inferred from the path when the handler is inline, so a
// standalone controller has to declare them.
type IsinParams = { isin: string };

export async function getOne(req: Request<IsinParams>, res: Response) {
  res.json({ data: await schemeService.getScheme(parseIsin(req.params.isin)) });
}

export async function navHistory(req: Request<IsinParams>, res: Response) {
  const days = parseCount(req.query["days"], "days", 30);
  res.json({ data: await schemeService.getNavHistory(parseIsin(req.params.isin), days) });
}
