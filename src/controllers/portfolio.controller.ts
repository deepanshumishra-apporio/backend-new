import type { Request, Response } from "express";
import * as portfolioService from "../services/portfolio.service.ts";
import { lockStatementPdf } from "../services/statement-lock.service.ts";
import { previewPurchaseFolio } from "../services/folio-resolution.service.ts";
import { optionalDate, requiredIsin } from "../utils/validate.ts";
import { HttpError } from "../utils/http-error.ts";

type AccountParams = { accountId: string };

/** Read an optional string query param, rejecting a non-string. */
function optionalStringParam(
  query: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = query[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw HttpError.badRequest(`${field} must be a string`);
  return value;
}

export async function getSummary(req: Request<AccountParams>, res: Response) {
  res.json({ data: await portfolioService.getPortfolioSummary(req.params.accountId) });
}

export async function listHoldings(req: Request<AccountParams>, res: Response) {
  res.json({ data: await portfolioService.listHoldings(req.params.accountId) });
}

export async function purchaseFolio(req: Request<AccountParams & { isin: string }>, res: Response) {
  const isin = requiredIsin({ isin: req.params.isin });
  res.json({ data: await previewPurchaseFolio(req.params.accountId, isin) });
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
  const isin = optionalStringParam(query, "isin");
  const folio = optionalStringParam(query, "folio");

  res.json({
    data: await portfolioService.getCapitalGains(req.params.accountId, {
      ...(isin && { isin }),
      ...(folio && { folio }),
      ...(optionalDate(query, "from") && { from: optionalDate(query, "from") }),
      ...(optionalDate(query, "to") && { to: optionalDate(query, "to") }),
    }),
  });
}

/** Account-level returns — the Portfolio Performance summary. */
export async function performance(req: Request<AccountParams>, res: Response) {
  res.json({ data: await portfolioService.getAccountReturns(req.params.accountId) });
}

/** The transaction types FP reports; a filter must name one of these. */
const TRANSACTION_TYPES = [
  "purchase",
  "redemption",
  "switch_in",
  "switch_out",
  "transfer_in",
  "transfer_out",
  "dividend_payout",
  "dividend_reinvestment",
] as const;

export async function transactions(req: Request<AccountParams>, res: Response) {
  const query = req.query as Record<string, unknown>;
  const isin = optionalStringParam(query, "isin");
  const folio = optionalStringParam(query, "folio");
  const type = query["type"];
  if (
    type !== undefined &&
    (typeof type !== "string" || !TRANSACTION_TYPES.includes(type as (typeof TRANSACTION_TYPES)[number]))
  ) {
    throw HttpError.badRequest(`type must be one of: ${TRANSACTION_TYPES.join(", ")}`);
  }

  res.json({
    data: await portfolioService.getTransactions(req.params.accountId, {
      ...(isin && { isin }),
      ...(folio && { folio }),
      ...(type && { type: type as string }),
      ...(optionalDate(query, "from") && { from: optionalDate(query, "from") }),
      ...(optionalDate(query, "to") && { to: optionalDate(query, "to") }),
    }),
  });
}

/**
 * Lock a client-rendered statement PDF with the account holder's PAN.
 *
 * The raw PDF arrives as the request body (see the route's `express.raw`); the
 * encrypted PDF goes back base64-encoded in the standard envelope so the client
 * can write it straight to a file.
 */
export async function lockStatement(req: Request<AccountParams>, res: Response) {
  const body = req.body as unknown;
  if (typeof body !== "string" || body.trim() === "") {
    throw HttpError.badRequest("Send the base64-encoded PDF as a text/plain body");
  }
  const pdf = Buffer.from(body, "base64");
  if (pdf.byteLength === 0) throw HttpError.badRequest("The request body is not valid base64 PDF data");

  const encrypted = await lockStatementPdf(req.params.accountId, new Uint8Array(pdf));
  res.json({ data: { pdfBase64: Buffer.from(encrypted).toString("base64") } });
}
