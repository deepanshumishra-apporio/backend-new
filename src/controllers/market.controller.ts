import type { Request, Response } from "express";
import * as marketService from "../services/market.service.ts";

export async function status(_req: Request, res: Response) {
  // Changes at most at the cut-off or at midnight; a short cache is plenty.
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ data: await marketService.getMarketStatus() });
}
