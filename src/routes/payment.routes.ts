import { Router } from "express";
import * as payment from "../controllers/payment.controller.ts";

export const paymentRouter = Router();

paymentRouter.post("/mandates", payment.createMandate);
paymentRouter.get("/mandates", payment.listMandates);
paymentRouter.get("/mandates/:mandateId", payment.getMandate);
paymentRouter.post("/mandates/:mandateId/authorize", payment.authorizeMandate);
paymentRouter.post("/mandates/:mandateId/refresh", payment.refreshMandate);
paymentRouter.post("/mandates/:mandateId/cancel", payment.cancelMandate);
paymentRouter.post("/mandates/:mandateId/pay", payment.payByMandate);

paymentRouter.post("/netbanking", payment.payByNetbanking);
paymentRouter.get("/:paymentId", payment.getPayment);
paymentRouter.post("/:paymentId/refresh", payment.refreshPayment);
