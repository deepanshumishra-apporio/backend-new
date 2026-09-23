import { Router } from "express";
import * as order from "../controllers/order.controller.ts";

export const orderRouter = Router();

orderRouter.get("/", order.listOrders);
orderRouter.get("/:orderId", order.getOrder);
orderRouter.get("/:orderId/payments", order.listOrderPayments);
orderRouter.post("/:orderId/refresh", order.refreshOrder);

// The ONDC purchase sequence is ordered and each step enforces it:
//   create -> (poll /refresh until pending) -> consent -> payment -> confirm
// There is no settlement step on this route.
orderRouter.post("/purchases", order.createPurchase);
orderRouter.post("/purchases/:orderId/consent", order.recordConsent);
orderRouter.post("/purchases/:orderId/confirm", order.confirmPurchase);
orderRouter.post("/purchases/:orderId/retry", order.retryPurchase);
orderRouter.post("/purchases/:orderId/cancel", order.cancelPurchase);

// Redemptions and switches move money outward, so there is nothing to pay:
// consent and confirm travel together.
orderRouter.post("/redemptions", order.createRedemption);
orderRouter.post("/redemptions/:orderId/confirm", order.confirmRedemption);
orderRouter.post("/switches", order.createSwitch);
orderRouter.post("/switches/:orderId/confirm", order.confirmSwitch);
