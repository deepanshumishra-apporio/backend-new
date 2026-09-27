import { Router } from "express";
import * as market from "../controllers/market.controller.ts";

/** Public: the market calendar carries no investor data. */
export const marketRouter = Router();

marketRouter.get("/status", market.status);
