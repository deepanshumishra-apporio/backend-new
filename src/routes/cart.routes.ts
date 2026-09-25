import { Router } from "express";
import * as cart from "../controllers/cart.controller.ts";

export const cartRouter = Router();

cartRouter.get("/", cart.getCart);
// PUT is keyed by fund and type: adding the same fund again edits its amount.
cartRouter.put("/items", cart.putItem);
cartRouter.delete("/items/:cartItemId", cart.removeItem);

cartRouter.post("/checkouts", cart.createCheckout);
cartRouter.get("/checkouts/:checkoutId", cart.getCheckout);
cartRouter.post("/checkouts/:checkoutId/refresh", cart.refreshCheckout);
cartRouter.post("/checkouts/:checkoutId/consent", cart.consentCheckout);
cartRouter.post("/checkouts/:checkoutId/pay", cart.payCheckout);
