import { Router } from "express";
import * as payment from "../controllers/payment.controller.ts";

export const paymentRouter = Router();

paymentRouter.post("/mandates", payment.createMandate);
paymentRouter.get("/mandates", payment.listMandates);
paymentRouter.get("/mandates/:mandateId", payment.getMandate);
paymentRouter.post("/mandates/:mandateId/authorize", payment.authorizeMandate);
// Sandbox only, and it says so: outside it the handler answers 404. Nothing in
// the sandbox reaches a bank, so without this a mandate never leaves CREATED
// and no UMRN is ever issued — which makes every SIP path untestable.
paymentRouter.post("/mandates/:mandateId/simulate", payment.simulateMandate);
paymentRouter.post("/mandates/:mandateId/refresh", payment.refreshMandate);
paymentRouter.post("/mandates/:mandateId/cancel", payment.cancelMandate);
paymentRouter.post("/mandates/:mandateId/pay", payment.payByMandate);

paymentRouter.post("/netbanking", payment.payByNetbanking);
paymentRouter.post("/upi", payment.payByNetbanking);
paymentRouter.get("/:paymentId", payment.getPayment);
paymentRouter.post("/:paymentId/refresh", payment.refreshPayment);
