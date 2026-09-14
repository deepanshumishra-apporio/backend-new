import { Router } from "express";
import { investorWorkspaceRouter } from "./investor-workspace.routes.ts";
import { requireSession, sessionRouter } from "../middleware/investor-auth.ts";
import { authorizeInputs, protectParameters } from "../middleware/investor-ownership.ts";
import { investorCommand } from "../middleware/investor-command.ts";
import { transactionOtpRouter } from "./transaction-otp.routes.ts";
import { fpWebhookRouter } from "./fp-webhook.routes.ts";
import { investorRouter } from "./investor.routes.ts";
import { kycRouter } from "./kyc.routes.ts";
import { orderRouter } from "./order.routes.ts";
import { otpRouter } from "./otp.routes.ts";
import { paymentRouter } from "./payment.routes.ts";
import { planRouter } from "./plan.routes.ts";
import { portfolioRouter } from "./portfolio.routes.ts";
import { schemeRouter } from "./scheme.routes.ts";

/** Mount in your app with: app.use("/api/v1", apiRouter) */
export const apiRouter = Router();

// Catalogue and OTP need no investor context.
apiRouter.use("/schemes", schemeRouter);
apiRouter.use("/otp", otpRouter);
apiRouter.use("/sessions", sessionRouter);
apiRouter.use("/webhooks/fp", fpWebhookRouter);

apiRouter.use(requireSession, authorizeInputs, investorCommand);
apiRouter.use(investorWorkspaceRouter);

apiRouter.use("/transaction-otp", transactionOtpRouter);

for (const router of [investorRouter, 
    kycRouter, 
    orderRouter, 
    planRouter, 
    paymentRouter, 
    portfolioRouter
]) protectParameters(router);

// The investor journey.
apiRouter.use("/kyc", kycRouter);
apiRouter.use("/investors", investorRouter);
apiRouter.use("/orders", orderRouter);
apiRouter.use("/plans", planRouter);
apiRouter.use("/payments", paymentRouter);
apiRouter.use("/portfolio", portfolioRouter);

// Inbound from FP.
