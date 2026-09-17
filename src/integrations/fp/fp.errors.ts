import { HttpError } from "../../utils/http-error.ts";

/** One field-level complaint from FP's validation error envelope. */
export interface FpFieldError {
  field: string;
  message: string;
}

/**
 * A non-2xx response from FP.
 *
 * FP answers with `{ error: { status, code, message, errors } }`. `code` is
 * often null, so `message` plus the per-field `errors` is usually the only
 * thing worth showing — and only after deciding it is safe to: FP messages can
 * name another investor's PAN when a folio lookup collides.
 */
export class FpApiError extends Error {
  override readonly name = "FpApiError";

  constructor(
    /** HTTP status FP returned. */
    readonly status: number,
    /** FP's `error.code`, when it sent one. */
    readonly code: string | null,
    message: string,
    readonly fieldErrors: FpFieldError[] = [],
    /** Our correlation id for the call, so logs and traces line up. */
    readonly requestId?: string,
    /** Method and path, never the body — request bodies carry PII. */
    readonly endpoint?: string,
  ) {
    super(message);
  }

  /** Retrying will not change the answer. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /**
   * Translate to the envelope our own API speaks.
   *
   * The rule: a 4xx caused by what the caller sent is theirs to fix and the
   * detail is worth forwarding; anything else is ours and becomes a 502, so we
   * never blame the caller for FP being down.
   */
  toHttpError(): HttpError {
    if (this.status === 400 || this.status === 422) {
      // Folded into the message, not just the details. FP's own sentence for a
      // rejected field is "Validation failed. 1 error(s)" — which names neither
      // the field nor the problem — and the message is the only part a client
      // shows. The field errors it sends alongside are the entire content of
      // the failure, and they were being carried as far as `details` and then
      // never read.
      const detail = this.fieldErrors
        .map((error) => `${error.field}: ${error.message}`)
        .join("; ");
      return HttpError.badRequest(detail === "" ? this.message : `${this.message} — ${detail}`, {
        provider: "fp",
        ...(this.code && { providerCode: this.code }),
        ...(this.fieldErrors.length > 0 && { fields: this.fieldErrors }),
      });
    }
    if (this.status === 404) return HttpError.notFound(this.message);
    if (this.status === 409) return HttpError.conflict(this.message, { provider: "fp" });
    if (this.status === 429) {
      return HttpError.tooManyRequests("Upstream rate limit reached, retry shortly", {
        provider: "fp",
      });
    }
    // 401/403 mean OUR credentials are wrong, not the caller's. Never leak that
    // distinction outward; it is an operational failure.
    return HttpError.badGateway("Upstream provider rejected the request");
  }
}

/** The request never got an answer: DNS, TCP, TLS, or our own timeout. */
export class FpTransportError extends Error {
  override readonly name = "FpTransportError";

  constructor(
    message: string,
    readonly endpoint: string,
    readonly requestId: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }

  toHttpError(): HttpError {
    // Outside production the cause travels with it. "Could not reach the
    // upstream provider" is the right thing to tell an investor and a useless
    // thing to debug against: it is the same sentence for an expired token, a
    // DNS failure and our own timeout, and the one fact that separates them is
    // on the cause this error has been carrying, unread, all along.
    if (process.env.NODE_ENV === "production") {
      return HttpError.serviceUnavailable("Could not reach the upstream provider");
    }
    const cause = this.cause;
    return HttpError.serviceUnavailable("Could not reach the upstream provider", {
      endpoint: this.endpoint,
      requestId: this.requestId,
      cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? "unknown"),
      ...(cause instanceof Error && cause.stack
        ? { causeStack: cause.stack.split(String.fromCharCode(10)).slice(0, 6) }
        : {}),
    });
  }
}

export type FpError = FpApiError | FpTransportError;

export function isFpError(error: unknown): error is FpError {
  return error instanceof FpApiError || error instanceof FpTransportError;
}

/**
 * Convert anything thrown by the FP client into an HttpError.
 *
 * Use at the service boundary so a controller never has to know FP exists.
 * Non-FP errors are re-thrown untouched — they are bugs, and the error handler
 * should see them as 500s rather than have them disguised as upstream faults.
 */
export function toHttpError(error: unknown): never {
  if (isFpError(error)) throw error.toHttpError();
  throw error;
}

interface FpErrorEnvelope {
  error?: {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    errors?: unknown;
  };
}

function toFieldErrors(raw: unknown): FpFieldError[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const { field, message } = entry as Record<string, unknown>;
    if (typeof field !== "string" || typeof message !== "string") return [];
    return [{ field, message }];
  });
}

/**
 * Parse FP's error envelope out of a response body.
 *
 * Deliberately forgiving: a gateway timeout or a WAF block returns HTML, not
 * JSON, and that must still produce a usable FpApiError rather than a parse
 * crash that hides the status code.
 */
export function parseFpError(
  status: number,
  body: string,
  requestId: string,
  endpoint: string,
): FpApiError {
  let envelope: FpErrorEnvelope | undefined;
  try {
    envelope = JSON.parse(body) as FpErrorEnvelope;
  } catch {
    envelope = undefined;
  }

  const error = envelope?.error;
  const message =
    typeof error?.message === "string" && error.message.trim() !== ""
      ? error.message
      : `FP returned ${status}`;
  const code = typeof error?.code === "string" ? error.code : null;

  return new FpApiError(status, code, message, toFieldErrors(error?.errors), requestId, endpoint);
}
