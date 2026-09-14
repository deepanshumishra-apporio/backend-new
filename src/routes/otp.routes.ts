import { Router } from "express";
import * as otp from "../controllers/otp.controller.ts";

export const otpRouter = Router();

// Express 5 forwards rejected promises to the error handler, so no wrapper.
//
// Both routes are unauthenticated by design — they run before an account
// exists. The abuse controls live in the service (send caps, resend cooldown,
// attempt cap, lockout). Put a network/edge rate limit in front of them too:
// per-IP limits belong at the edge, not in application code.
otpRouter.post("/request", otp.request);
otpRouter.post("/verify", otp.verify);
