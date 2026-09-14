import type { Request, Response } from "express";
import * as portfolioService from "../services/portfolio.service.ts";
import { optionalDate } from "../utils/validate.ts";
import { HttpError } from "../utils/http-error.ts";

type AccountParams = { accountId: string };

export async function getSummary(req: Request<AccountParams>, res: Response) {
  res.json({ data: await portfolioService.getPortfolioSummary(req.params.accountId) });
}

export async function listHoldings(req: Request<AccountParams>, res: Response) {
  res.json({ data: await portfolioService.listHoldings(req.params.accountId) });
}

export async function listFolios(req: Request<AccountParams>, res: Response) {
  res.json({ data: await portfolioService.listFolios(req.params.accountId) });
}

/**
 * Pull fresh folios and holdings from FP.
 *
 * Explicitly triggered rather than implicit on read: the RTA feeds update
 * daily, so refreshing on every portfolio view would burn rate limit for data
 * that has not changed.
 */
export async function refresh(req: Request<AccountParams>, res: Response) {
  res.json({ data: await portfolioService.refreshPortfolio(req.params.accountId) });
}

export async function schemeReturns(req: Request<AccountParams>, res: Response) {
  res.json({ data: await portfolioService.getSchemeReturns(req.params.accountId) });
}

export async function dividends(req: Request<AccountParams>, res: Response) {
  res.json({ data: await portfolioService.getDividends(req.params.accountId) });
}

export async function capitalGains(req: Request<AccountParams>, res: Response) {
  const query = req.query as Record<string, unknown>;
  const isin = query["isin"];
  if (isin !== undefined && typeof isin !== "string") {
    throw HttpError.badRequest("isin must be a string");
  }

  res.json({
    data: await portfolioService.getCapitalGains(req.params.accountId, {
      ...(isin && { isin }),
      ...(optionalDate(query, "from") && { from: optionalDate(query, "from") }),
      ...(optionalDate(query, "to") && { to: optionalDate(query, "to") }),
    }),
  });
}
