import { Router } from "express";
import * as portfolio from "../controllers/portfolio.controller.ts";

export const portfolioRouter = Router();

portfolioRouter.get("/:accountId/summary", portfolio.getSummary);
portfolioRouter.get("/:accountId/holdings", portfolio.listHoldings);
portfolioRouter.get("/:accountId/folios", portfolio.listFolios);
portfolioRouter.get("/:accountId/returns", portfolio.schemeReturns);
// Read from our own holdings projection — FP publishes no dividend report.
portfolioRouter.get("/:accountId/dividends", portfolio.dividends);
portfolioRouter.get("/:accountId/capital-gains", portfolio.capitalGains);
// Explicit: RTA feeds update daily, so refreshing on every read would burn
// rate limit on data that has not changed.
portfolioRouter.post("/:accountId/refresh", portfolio.refresh);
