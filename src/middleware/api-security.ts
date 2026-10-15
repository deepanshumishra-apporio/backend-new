import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";

/**
 * Requests allowed per one-minute window, per client IP, by request group.
 * `webhook` is the anonymous FP delivery route: each new event id costs an FP
 * lookup, so it gets a tighter allowance than the general API.
 */
const LIMIT_PER_MINUTE = { auth: 15, webhook: 60, api: 120 } as const;

/** Which allowance a request counts against. Lower-cased: Express routes case-insensitively. */
function rateLimitGroup(path: string): keyof typeof LIMIT_PER_MINUTE {
  const lower = path.toLowerCase();
  if (/\/(?:otp|sessions|transaction-otp)(?:\/|$)/.test(lower)) return "auth";
  if (/^\/webhooks\/fp\/?$/.test(lower)) return "webhook";
  return "api";
}

/**
 * The bucket a client address counts against.
 *
 * IPv6 is grouped by its /64: one subscriber is routinely handed a whole /64,
 * so keying the full address gave an attacker 2^64 fresh buckets.
 */
export function rateLimitSubject(ip: string | undefined): string {
  const address = (ip ?? "unknown").replace(/^::ffff:/, "");
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * Fixed-window rate limit, one row per (group, client) in `api_rate_limits`.
 *
 * The counter lives in Postgres so it holds across a restart and, if the API is
 * ever run as more than one process, across instances. That costs one round
 * trip per request. If the database is briefly unreachable, ordinary API calls
 * are let through (session auth still guards them) rather than turning a
 * database blip into an outage — but the `auth` group fails closed, because an
 * open limiter on OTP and sign-in is a brute-force window.
 */
export const apiRateLimit: RequestHandler = async (req, _res, next) => {
  // `/OTP/verify` used to reach the OTP handler while counting against the much
  // larger `api` allowance; `rateLimitGroup` lower-cases first.
  const group = rateLimitGroup(req.path);
  const key = createHash("sha256").update(`${group}:${rateLimitSubject(req.ip ?? req.socket.remoteAddress)}`).digest("hex");

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
    // Sign-in and OTP fail closed: an open limiter there is an unthrottled
    // brute-force window, and those routes need the database to work anyway.
    if (group === "auth") {
      console.error(`[rate-limit] check unavailable, refusing auth request: ${(error as Error).message}`);
      throw HttpError.serviceUnavailable("Please try again in a moment");
    }
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
