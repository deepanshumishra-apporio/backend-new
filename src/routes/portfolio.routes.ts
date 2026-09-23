import { Router, text } from "express";
import * as portfolio from "../controllers/portfolio.controller.ts";

export const portfolioRouter = Router();

portfolioRouter.get("/:accountId/summary", portfolio.getSummary);
portfolioRouter.get("/:accountId/holdings", portfolio.listHoldings);
portfolioRouter.get("/:accountId/folios", portfolio.listFolios);
portfolioRouter.get("/:accountId/returns", portfolio.schemeReturns);
// Account-level returns — the Portfolio Performance summary.
portfolioRouter.get("/:accountId/performance", portfolio.performance);
// Read from our own holdings projection — FP publishes no dividend report.
portfolioRouter.get("/:accountId/dividends", portfolio.dividends);
portfolioRouter.get("/:accountId/capital-gains", portfolio.capitalGains);
// The Transaction Statement; a `type` filter also serves the IDCW statement.
portfolioRouter.get("/:accountId/transactions", portfolio.transactions);
// Explicit: RTA feeds update daily, so refreshing on every read would burn
// rate limit on data that has not changed.
portfolioRouter.post("/:accountId/refresh", portfolio.refresh);
// Lock a client-rendered statement PDF with the holder's PAN. The body is the
// base64 PDF as text/plain — a string body is the reliable shape from React
// Native, and a non-JSON content type sidesteps the global 100kb JSON limit.
portfolioRouter.post(
  "/:accountId/statements/lock",
  text({ type: "text/plain", limit: "20mb" }),
  portfolio.lockStatement,
);
