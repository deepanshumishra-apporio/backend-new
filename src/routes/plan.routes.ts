import { Router } from "express";
import * as plan from "../controllers/plan.controller.ts";

export const planRouter = Router();

planRouter.get("/", plan.listPlans);
planRouter.post("/sips", plan.createSip);
planRouter.post("/swps", plan.createSwp);
planRouter.post("/stps", plan.createStp);
planRouter.get("/:planId", plan.getPlan);
planRouter.get("/:planId/installments", plan.listInstallments);
planRouter.post("/:planId/refresh", plan.refreshPlan);
planRouter.post("/:planId/confirm", plan.confirmPlan);
planRouter.post("/:planId/cancel", plan.cancelPlan);

// A running SIP: pause it, end the pause early, change its amount. Each is an
// FP instruction, carried out asynchronously; see plan-change.service.ts.
planRouter.get("/:planId/pause", plan.getPlanPause);
planRouter.post("/:planId/pause", plan.pausePlan);
planRouter.post("/:planId/resume", plan.resumePlan);
planRouter.post("/:planId/amount-changes", plan.changePlanAmount);
planRouter.get("/:planId/amount-changes/:changeId", plan.getPlanAmountChange);
