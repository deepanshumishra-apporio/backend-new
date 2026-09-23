import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";

/** Requests allowed per one-minute window, per client IP, by request group. */
const LIMIT_PER_MINUTE = { auth: 15, api: 120 } as const;

/**
 * Fixed-window rate limit, one row per (group, IP) in `api_rate_limits`.
 *
 * The counter lives in Postgres so it holds across a restart and, if the API is
 * ever run as more than one process, across instances. That costs one round
 * trip per request, so the check is deliberately **fail-open**: if the database
 * is briefly unreachable the request is allowed through rather than turning a
 * database blip into a full API outage. Session auth still guards every
 * sensitive route, so an open limiter degrades protection, it does not remove
 * it. It re-arms the moment the database recovers.
 */
export const apiRateLimit: RequestHandler = async (req, _res, next) => {
  const group = /\/(?:otp|sessions|transaction-otp)(?:\/|$)/.test(req.path) ? "auth" : "api";
  const key = createHash("sha256").update(`${group}:${req.ip ?? req.socket.remoteAddress}`).digest("hex");

  let count: number;
  try {
    const rows = await db.$queryRaw<{ count: number }[]>`
      INSERT INTO api_rate_limits (key, count, "windowStartedAt") VALUES (${key}, 1, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN api_rate_limits."windowStartedAt" < CURRENT_TIMESTAMP - INTERVAL '1 minute' THEN 1 ELSE api_rate_limits.count + 1 END,
        "windowStartedAt" = CASE WHEN api_rate_limits."windowStartedAt" < CURRENT_TIMESTAMP - INTERVAL '1 minute' THEN CURRENT_TIMESTAMP ELSE api_rate_limits."windowStartedAt" END
      RETURNING count`;
    if (!rows[0]) return next();
    count = rows[0].count;
  } catch (error) {
    console.error(`[rate-limit] check unavailable, allowing request: ${(error as Error).message}`);
    return next();
  }

  if (count > LIMIT_PER_MINUTE[group]) {
    throw HttpError.tooManyRequests("Too many requests", { retryAfterSeconds: 60 });
  }
  next();
};

export function validateCallback(value: unknown): void {
  if (typeof value !== "string") throw HttpError.badRequest("Callback URL must be a string");
  let url: URL;
  try { url = new URL(value); } catch { 
    throw HttpError.badRequest("Invalid callback URL"); 
  }
  const allowed = (process.env["CALLBACK_ALLOWED_ORIGINS"] ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (!allowed.length) throw HttpError.serviceUnavailable("Callback origins are not configured");
  if (url.protocol !== "https:" || url.username || url.password || !allowed.includes(url.origin)) {
    throw HttpError.badRequest("Callback URL is not an approved HTTPS origin");
  }
}
