// MSG91 transport layer.
//
// This file is the ONLY place that knows MSG91's wire format. Everything above
// it depends on the normalised result types below, so if MSG91 changes an
// endpoint, a parameter name or a response shape, this file is the only edit.
//
// It lives in integrations/ rather than utils/ because it does network I/O —
// utils/ is for pure functions. It is the same role src/db/client.ts plays for
// Postgres: infrastructure that services orchestrate.
//
// ⚠ VERIFY BEFORE GOING LIVE: MSG91's public docs page does not publish the v5
// response schemas, so the classification table in `classify()` is built from
// the documented v5 behaviour. Send one real OTP, one wrong OTP and one expired
// OTP against your account and confirm the `message` strings match. Unknown
// messages fall through to PROVIDER_REJECTED and are logged verbatim, so a
// mismatch is visible rather than silent — but it will read as a 502 to callers.

const BASE_URL = process.env.MSG91_BASE_URL?.trim() || "https://control.msg91.com/api/v5";
const TIMEOUT_MS = Number(process.env.MSG91_TIMEOUT_MS ?? 8_000);
const MAX_RETRIES = Number(process.env.MSG91_MAX_RETRIES ?? 2);

export type SendFailureReason = "RATE_LIMITED" | "INVALID_NUMBER" | "PROVIDER_REJECTED";
export type VerifyFailureReason =
  | "MISMATCH"
  | "EXPIRED"
  | "ALREADY_VERIFIED"
  | "NOT_FOUND"
  | "PROVIDER_REJECTED";

export type SendOtpResult =
  | { ok: true; requestId: string | null }
  | { ok: false; reason: SendFailureReason; message: string };

export type VerifyOtpResult = { ok: true } | { ok: false; reason: VerifyFailureReason; message: string };

/** Transport or configuration failure — not a business outcome. */
export class Msg91Error extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "Msg91Error";
  }
}

interface Msg91Config {
  authKey: string;
  templateId: string;
}

/**
 * Resolved on first use so a missing key surfaces as a clear configuration
 * error. In production this is also called at import time (bottom of file) so
 * the process fails at boot rather than on a user's first OTP request.
 */
function config(): Msg91Config {
  const authKey = process.env.MSG91_AUTH_KEY?.trim();
  const templateId = process.env.MSG91_OTP_TEMPLATE_ID?.trim();

  const missing = [
    !authKey && "MSG91_AUTH_KEY",
    !templateId && "MSG91_OTP_TEMPLATE_ID",
  ].filter(Boolean);

  if (missing.length > 0) {
    // Deliberately no development fallback and no "test OTP" bypass: a bypass
    // in an OTP path is an authentication bypass waiting to be shipped.
    throw new Msg91Error(`MSG91 is not configured — missing ${missing.join(", ")}`, false);
  }

  return { authKey: authKey as string, templateId: templateId as string };
}

interface Msg91Response {
  type?: string;
  message?: string;
  request_id?: string;
  requestId?: string;
}

/**
 * One HTTP call. Retries only on transport failures and 5xx, and only when the
 * caller says the operation is safe to repeat.
 */
async function call(
  path: string,
  params: Record<string, string>,
  { retryable }: { retryable: boolean },
): Promise<Msg91Response> {
  const { authKey } = config();
  const url = `${BASE_URL}${path}?${new URLSearchParams(params).toString()}`;
  const attempts = retryable ? MAX_RETRIES + 1 : 1;

  let lastError: Msg91Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          // Never logged. Never included in an error message.
          authkey: authKey,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      // 5xx is worth another go; 4xx means we sent something wrong.
      if (response.status >= 500) {
        lastError = new Msg91Error(`MSG91 returned ${response.status}`, true, response.status);
      } else {
        const text = await response.text();
        try {
          return JSON.parse(text) as Msg91Response;
        } catch {
          throw new Msg91Error(
            `MSG91 returned non-JSON (status ${response.status})`,
            false,
            response.status,
          );
        }
      }
    } catch (error) {
      if (error instanceof Msg91Error) {
        if (!error.retryable) throw error;
        lastError = error;
      } else if (error instanceof Error && error.name === "TimeoutError") {
        lastError = new Msg91Error(`MSG91 request timed out after ${TIMEOUT_MS}ms`, true);
      } else {
        lastError = new Msg91Error(
          `MSG91 request failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    }

    // Exponential backoff with jitter, so a provider blip does not turn into a
    // synchronised retry storm from every instance at once.
    if (attempt < attempts) {
      const backoff = 200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw lastError ?? new Msg91Error("MSG91 request failed", true);
}

const isSuccess = (body: Msg91Response) => body.type?.toLowerCase() === "success";

/**
 * Map MSG91's human-readable `message` onto a stable reason code.
 *
 * Matching on message text is unpleasant but is what the v5 OTP API gives us —
 * it does not return machine error codes on these endpoints. Keeping the whole
 * mapping here means the fragility is in one auditable place.
 */
function classify(message: string): VerifyFailureReason {
  const m = message.toLowerCase();
  if (m.includes("already verified")) return "ALREADY_VERIFIED";
  if (m.includes("expire")) return "EXPIRED";
  if (m.includes("not match") || m.includes("mismatch") || m.includes("incorrect")) return "MISMATCH";
  if (m.includes("not found") || m.includes("no otp")) return "NOT_FOUND";
  return "PROVIDER_REJECTED";
}

function classifySend(message: string): SendFailureReason {
  const m = message.toLowerCase();
  if (m.includes("limit") || m.includes("too many")) return "RATE_LIMITED";
  if (m.includes("invalid") && m.includes("number")) return "INVALID_NUMBER";
  if (m.includes("mobile")) return "INVALID_NUMBER";
  return "PROVIDER_REJECTED";
}

/**
 * Send a fresh OTP. MSG91 generates and stores the code — we never see it, so
 * it cannot leak from our database or our logs.
 *
 * @param providerPhone country code without a plus, e.g. 919876543210
 */
export async function sendOtp(
  providerPhone: string,
  { otpLength, expiryMinutes }: { otpLength: number; expiryMinutes: number },
): Promise<SendOtpResult> {
  const { templateId } = config();

  // Safe to retry: MSG91 reuses the active OTP for a number rather than
  // issuing a second one, so a retry after a timeout does not send two codes.
  const body = await call(
    "/otp",
    {
      template_id: templateId,
      mobile: providerPhone,
      otp_length: String(otpLength),
      otp_expiry: String(expiryMinutes),
    },
    { retryable: true },
  );

  if (isSuccess(body)) {
    return { ok: true, requestId: body.request_id ?? body.requestId ?? null };
  }

  const message = body.message ?? "MSG91 rejected the send request";
  return { ok: false, reason: classifySend(message), message };
}

/** Ask MSG91 to redeliver the active OTP for this number. */
export async function resendOtp(
  providerPhone: string,
  channel: "text" | "voice" = "text",
): Promise<SendOtpResult> {
  const body = await call(
    "/otp/retry",
    { mobile: providerPhone, retrytype: channel },
    { retryable: true },
  );

  if (isSuccess(body)) {
    return { ok: true, requestId: body.request_id ?? body.requestId ?? null };
  }

  const message = body.message ?? "MSG91 rejected the resend request";
  return { ok: false, reason: classifySend(message), message };
}

/**
 * Verify a code against MSG91.
 *
 * NOT retried. MSG91 counts verification attempts on its side, so replaying a
 * timed-out verify could burn the user's remaining attempts. A transport
 * failure here surfaces as a 502 and the user retries deliberately.
 */
export async function verifyOtp(providerPhone: string, otp: string): Promise<VerifyOtpResult> {
  const body = await call(
    "/otp/verify",
    { mobile: providerPhone, otp },
    { retryable: false },
  );

  if (isSuccess(body)) return { ok: true };

  const message = body.message ?? "MSG91 rejected the verification";
  return { ok: false, reason: classify(message), message };
}

// Fail at boot, not on a user's first request.
if (process.env.NODE_ENV === "production") config();
