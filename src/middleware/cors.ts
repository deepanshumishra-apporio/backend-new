import type { RequestHandler } from "express";

/** Native apps do not use CORS. Browser builds must name their exact origins. */
export const browserCors: RequestHandler = (req, res, next) => {
  const allowed = (process.env["APP_ALLOWED_ORIGINS"] ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const origin = req.get("origin");
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.vary("Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    res.setHeader("Access-Control-Expose-Headers", "Retry-After, Idempotency-Replayed");
  }
  if (req.method === "OPTIONS") { res.status(origin && allowed.includes(origin) ? 204 : 403).end(); return; }
  next();
};
