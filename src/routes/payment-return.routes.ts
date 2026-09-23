import { Router } from "express";
import * as paymentReturn from "../controllers/payment-return.controller.ts";

export const paymentReturnRouter = Router();

// No session: FP redirects the investor's browser here after the payment page.
// FP may return with either verb depending on the provider, so accept both.
paymentReturnRouter.get("/:orderId", paymentReturn.paymentReturn);
paymentReturnRouter.post("/:orderId", paymentReturn.paymentReturn);
