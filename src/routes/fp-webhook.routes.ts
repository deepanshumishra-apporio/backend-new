import { Router } from "express";
import * as webhook from "../controllers/fp-webhook.controller.ts";

export const fpWebhookRouter = Router();

// FP posts here. No shared secret is available on this endpoint — FP does not
// sign its deliveries — so the handler trusts nothing in the body beyond the
// event id, and re-reads every object from FP before applying it.
fpWebhookRouter.post("/", webhook.receive);

// Operator endpoints, behind a shared secret from the environment.
fpWebhookRouter.post("/process", (req, res, next) => {
  try {
    webhook.requireWebhookAdminSecret(req);
  } catch (error) {
    next(error);
    return;
  }
  void webhook.processPending(req, res).catch(next);
});

fpWebhookRouter.get("/backlog", (req, res, next) => {
  try {
    webhook.requireWebhookAdminSecret(req);
  } catch (error) {
    next(error);
    return;
  }
  void webhook.backlog(req, res).catch(next);
});
