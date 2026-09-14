export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra machine-readable fields merged into the error response. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }

  static badRequest = (m: string, d?: Record<string, unknown>) =>
    new HttpError(400, "BAD_REQUEST", m, d);
  static notFound = (m = "Not found") => new HttpError(404, "NOT_FOUND", m);
  static conflict = (m: string, d?: Record<string, unknown>) =>
    new HttpError(409, "CONFLICT", m, d);

  /** Include `retryAfterSeconds` so the client can back off correctly. */
  static tooManyRequests = (m: string, d?: Record<string, unknown>) =>
    new HttpError(429, "TOO_MANY_REQUESTS", m, d);

  /** An upstream provider failed. Ours to retry, not the caller's problem. */
  static badGateway = (m = "Upstream provider is unavailable") =>
    new HttpError(502, "BAD_GATEWAY", m);
  static serviceUnavailable = (m = "Service temporarily unavailable") =>
    new HttpError(503, "SERVICE_UNAVAILABLE", m);
}
