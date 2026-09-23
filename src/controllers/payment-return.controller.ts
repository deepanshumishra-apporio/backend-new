import type { Request, Response } from "express";
import * as paymentService from "../services/payment.service.ts";

type ReturnParams = { orderId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Plain page for when no app redirect is configured. Deliberately says nothing
 * about the order: this URL is unauthenticated, so the outcome is shown in the
 * app, where the investor is signed in.
 */
const RETURN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment received</title></head>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center">
<h1 style="font-size:1.25rem">Thanks — we are confirming your payment</h1>
<p>You can close this window and return to the app to see your investment.</p>
</body></html>`;

/**
 * Where FP sends the investor after the payment page (`payment_postback_url`).
 *
 * A browser redirect with no session, so it reveals nothing and changes
 * nothing FP has not decided: it pulls the order's current state into the
 * mirror — saving the folio if the order is already allotted — then hands the
 * investor back to the app. A malformed or unknown id gets the same page.
 */
export async function paymentReturn(req: Request<ReturnParams>, res: Response) {
  const { orderId } = req.params;
  if (UUID.test(orderId)) await paymentService.handlePaymentReturn(orderId);

  const redirect = UUID.test(orderId) ? paymentService.paymentReturnRedirect(orderId) : undefined;
  if (redirect) {
    res.redirect(303, redirect);
    return;
  }
  res
    .status(200)
    .type("html")
    .setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
    .send(RETURN_PAGE);
}
