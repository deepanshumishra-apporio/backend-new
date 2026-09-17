import type { RequestHandler } from "express";

/**
 * Native apps do not use CORS. Browser builds must name their exact origins.
 *
 * Outside production the allowlist is not enforced: a dev machine's LAN address
 * changes with the network it joins, so every move meant editing
 * `APP_ALLOWED_ORIGINS` before the web build could talk to the API at all.
 * Reflecting the caller's origin there costs nothing — there is no real money
 * and no real investor behind a sandbox tenant. Production still answers only
 * the origins it was told about, and `NODE_ENV` is the one switch that decides.
 */
export const browserCors: RequestHandler = (req, res, next) => {
  const allowed = (process.env["APP_ALLOWED_ORIGINS"] ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const origin = req.get("origin");
  const anyOrigin = process.env["NODE_ENV"] !== "production";
  const permitted = Boolean(origin) && (anyOrigin || allowed.includes(origin as string));
  if (origin && permitted) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.vary("Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    res.setHeader("Access-Control-Expose-Headers", "Retry-After, Idempotency-Replayed");
  }
  if (req.method === "OPTIONS") { res.status(permitted ? 204 : 403).end(); return; }
  next();
};
