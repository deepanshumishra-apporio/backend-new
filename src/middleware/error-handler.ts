// Without this registered, every HttpError the controllers and services throw
// falls through to Express's default handler: the status becomes 500 instead of
// 400/404/409/429, and outside production the response body includes a stack
// trace. Both are why this exists.
//
// It lives in middleware/ rather than utils/ because it is Express-aware —
// utils/ is for pure functions.
import type { NextFunction, Request, Response } from "express";
import { Prisma } from "../../generated/prisma/client.ts";
import { HttpError } from "../utils/http-error.ts";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Map a Prisma error onto a client-safe HttpError.
 *
 * Prisma messages can quote table names, column names and the offending values,
 * so the original is logged and never returned. Returns null when this is not a
 * Prisma error we recognise — those become a generic 500.
 *
 * Codes: https://www.prisma.io/docs/orm/reference/error-reference
 */
function mapPrismaError(error: unknown): HttpError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2002": {
        // Unique constraint. The field names are safe to return and let the
        // client point at the right input; the values are not included.
        const target = error.meta?.["target"];
        const fields = Array.isArray(target) ? target.map(String) : undefined;
        return HttpError.conflict(
          fields?.length
            ? `A record with this ${fields.join(", ")} already exists`
            : "A record with these values already exists",
          fields ? { fields } : undefined,
        );
      }
      case "P2003":
      case "P2014":
        return HttpError.conflict("This operation violates a relation constraint");
      case "P2025":
        return HttpError.notFound("The requested record does not exist");
      case "P2000":
        return HttpError.badRequest("A submitted value is too long for its field");
      case "P2034":
        // Write conflict / deadlock — safe for the caller to retry.
        return new HttpError(409, "WRITE_CONFLICT", "Concurrent update, please retry");
      case "P2024":
        // Pool exhausted: we are over our connection budget, not the caller's
        // fault. Surfaces as backpressure.
        return new HttpError(503, "SERVICE_UNAVAILABLE", "Database is busy, please retry");
      case "P1001":
      case "P1002":
      case "P1008":
      case "P1017":
        return new HttpError(503, "SERVICE_UNAVAILABLE", "Database is unreachable");
      default:
        return null;
    }
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new HttpError(503, "SERVICE_UNAVAILABLE", "Database is unavailable");
  }

  // PrismaClientValidationError means the query was built wrong — a bug on our
  // side — so it deliberately falls through to a 500.
  return null;
}

/** 404 for unmatched routes. Register after all routers, before errorHandler. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(HttpError.notFound(`Cannot ${req.method} ${req.path}`));
}

/** Register last: `app.use(notFoundHandler); app.use(errorHandler);` */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Response already streaming — nothing safe to do but let Express abort it.
  if (res.headersSent) {
    next(error);
    return;
  }

  const mapped = error instanceof HttpError ? error : mapPrismaError(error);

  if (error && typeof error === "object" && "type" in error && ["entity.parse.failed", "entity.too.large"].includes(String(error.type))) {
    res.status(error.type === "entity.too.large" ? 413 : 400).json({ error: { code: "INVALID_BODY", message: "Invalid or oversized request body" } });
    return;
  }

  if (mapped) {
    if (mapped.status >= 500) console.error("[error]", mapped.code);
    if (mapped.status === 429) res.setHeader("Retry-After", String(mapped.details?.["retryAfterSeconds"] ?? 60));
    res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, ...mapped.details },
    });
    return;
  }

  // Unexpected: a bug. Log everything, tell the client nothing — no message,
  // no stack. Leaking either is how internals and dependency versions escape.
  //
  // "Everything" means the message and the stack, not just the class name: an
  // unexpected 500 is exactly the case where the name alone tells you nothing,
  // and this is the server's own log, not the response.
  console.error("[error] unhandled", error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : error);
  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
      // Non-production only, and only the message — never the stack.
    },
  });
}
