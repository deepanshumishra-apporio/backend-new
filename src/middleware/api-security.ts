import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";

export const apiRateLimit: RequestHandler = async (req, _res, next) => {
  const group = /\/(?:otp|sessions|transaction-otp)(?:\/|$)/.test(req.path) ? "auth" : "api";
  const key = createHash("sha256").update(`${group}:${req.ip ?? req.socket.remoteAddress}`).digest("hex");
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO api_rate_limits (key, count, "windowStartedAt") VALUES (${key}, 1, CURRENT_TIMESTAMP)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN api_rate_limits."windowStartedAt" < CURRENT_TIMESTAMP - INTERVAL '1 minute' THEN 1 ELSE api_rate_limits.count + 1 END,
      "windowStartedAt" = CASE WHEN api_rate_limits."windowStartedAt" < CURRENT_TIMESTAMP - INTERVAL '1 minute' THEN CURRENT_TIMESTAMP ELSE api_rate_limits."windowStartedAt" END
    RETURNING count`;
  if (!rows[0] || rows[0].count > (group === "auth" ? 15 : 120)) throw HttpError.tooManyRequests("Too many requests", { retryAfterSeconds: 60 });
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
