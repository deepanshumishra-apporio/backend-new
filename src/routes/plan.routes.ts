import { Router } from "express";
import * as plan from "../controllers/plan.controller.ts";

export const planRouter = Router();

planRouter.get("/", plan.listPlans);
planRouter.post("/sips", plan.createSip);
planRouter.post("/swps", plan.createSwp);
planRouter.post("/stps", plan.createStp);
planRouter.get("/:planId", plan.getPlan);
planRouter.post("/:planId/refresh", plan.refreshPlan);
planRouter.post("/:planId/confirm", plan.confirmPlan);
planRouter.post("/:planId/cancel", plan.cancelPlan);
