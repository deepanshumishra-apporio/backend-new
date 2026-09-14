// The Express application.
//
// Kept separate from the server entry point so tests can import an app without
// binding a port.
import express from "express";
import type { Express } from "express";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.ts";
import { apiRouter } from "./routes/index.ts";
import { apiRateLimit } from "./middleware/api-security.ts";
import { browserCors } from "./middleware/cors.ts";

export function createApp(): Express {
  const app = express();

  // Behind a load balancer, req.socket.remoteAddress is the balancer. Trusting
  // the proxy makes `x-forwarded-for` authoritative, which matters here because
  // the investor's IP is reported to the RTA as audit data.
  const trustProxy = process.env["TRUST_PROXY"]?.trim();
  if (trustProxy === "true") throw new Error("TRUST_PROXY must list trusted proxy IPs/CIDRs, not true");
  app.set("trust proxy", trustProxy && trustProxy !== "false" ? trustProxy.split(",").map(x => x.trim()) : false);
  // Express advertises itself by default; there is no reason to.
  app.disable("x-powered-by");
  app.use(browserCors);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  });

  // A 100kb ceiling is generous for every route here and stops a large body
  // from occupying a worker. File uploads go straight to FP, not through this.
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/v1/kyc/forms/:formId/signature", express.raw({ type: ["image/png", "image/jpeg", "application/pdf"], limit: "5mb" }));

  app.get("/health", (_req, res) => {
    res.json({ data: { status: "ok", uptimeSeconds: Math.round(process.uptime()) } });
  });

  app.use("/api/v1", apiRateLimit, apiRouter);

  // Order matters: 404 for anything unmatched, then the error handler LAST.
  // Registered any earlier and Express treats it as ordinary middleware, so
  // every HttpError would become a 500 with a stack trace in the body.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
