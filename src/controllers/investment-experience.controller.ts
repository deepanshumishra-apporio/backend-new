import type { Request, Response } from "express";
import { investorId } from "../middleware/investor-auth.ts";
import * as experience from "../services/investment-experience.service.ts";
import { INVESTMENT_EXPERIENCE, type InvestmentExperienceValue } from "../types/investor.types.ts";
import { asBody, oneOf } from "../utils/validate.ts";

export async function get(req: Request, res: Response) {
  res.json({ data: await experience.getInvestmentExperience(investorId(req)) });
}

export async function set(req: Request, res: Response) {
  const value = oneOf(asBody(req.body), "value", INVESTMENT_EXPERIENCE) as InvestmentExperienceValue;
  res.json({ data: await experience.setInvestmentExperience(investorId(req), value) });
}
