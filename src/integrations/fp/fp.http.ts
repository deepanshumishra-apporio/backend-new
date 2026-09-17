// The single place every FP call goes through.
//
// Responsibilities: auth header, tenant header, timeout, retry policy, error
// translation, and logging that cannot leak PII.
import { fpConfig, fpPreVerifyConfig } from "./fp.config.ts";
import { FpTransportError, parseFpError } from "./fp.errors.ts";
import { getAccessToken, invalidateAccessToken } from "./fp.token.ts";
import type { FpRealm } from "./fp.token.ts";

export type FpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface FpRequestOptions {
  method: FpMethod;
  /** Path beginning with a slash, e.g. "/v2/investor_profiles". */
  path: string;
  /** Values that are undefined or null are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /**
   * Request body. Serialised as JSON, except a FormData, which is passed
   * through so fetch can set its own multipart boundary (the Files API).
   */
  body?: unknown;
  /**
   * Override the default retry policy.
   *
   * The default retries GET only. That is not timidity: FP's order-creation
   * APIs are explicitly NOT idempotent, so a retried POST that actually
   * succeeded upstream would place a SECOND order. Writes may opt in only when
   * FP itself guarantees idempotency for them — which, for order creation,
   * means passing a `source_ref_id` so the duplicate is rejected.
   */
  retry?: boolean;
  /** Caller-supplied correlation id, propagated into logs. */
  requestId?: string;
  /** Per-call timeout override. */
  timeoutMs?: number;
  /**
   * Which credentials and host to use. "tenant" (the default) is the object
   * API; "preverify" is the separate pre-verification service, which has its
   * own tenant, client and base URL and takes no `x-tenant-id` header.
   */
  realm?: FpRealm;
}

/** Retry ceiling, including the first attempt. */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 8_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

/**
 * FP's unversioned top-level resources.
 *
 * Everything else lives under /v2, /api or /poa, but these three predate that
 * and FP still serves them at the root. Named one by one rather than loosening
 * the pattern to "any top-level path": the point of the check is that a path
 * built from caller input cannot reach an endpoint nobody vetted.
 *
 * `/files` was already being called by `identity.uploadFile` and had never
 * worked — the pattern rejected it before the request was built.
 */
const ROOT_RESOURCES = ["files", "file_operations", "transactions"] as const;
const ROOT_PATH = new RegExp(`^/(?:${ROOT_RESOURCES.join("|")})(?:/[a-zA-Z0-9_-]+)*$`);

function buildUrl(path: string, query: FpRequestOptions["query"], realm: FpRealm): string {
  const allowed = /^\/(?:v2|api|poa)\/[a-zA-Z0-9_/-]+$/.test(path) || ROOT_PATH.test(path);
  if (!allowed || path.includes("..")) {
    throw new Error("Invalid provider resource path");
  }
  const baseUrl = realm === "preverify" ? fpPreVerifyConfig().baseUrl : fpConfig().baseUrl;
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Exponential backoff with full jitter, honouring Retry-After when FP sends it.
 *
 * Jitter matters more than it looks: without it, a burst of callers that all
 * hit the same 429 would retry in lockstep and trip the limiter again.
 */
function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1_000, MAX_BACKOFF_MS);
  }
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

function isRetryableStatus(status: number): boolean {
  // 429 is FP's rate limiter (25 ops/sec in sandbox). 5xx is FP being unwell.
  // 408 is a request timeout at their edge.
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Make one FP call and return its parsed JSON body.
 *
 * Throws FpApiError for a non-2xx that survived the retry policy, and
 * FpTransportError when no response arrived at all.
 */
export async function fpRequest<T>(options: FpRequestOptions): Promise<T> {
  // The RTA route exists here for one reason: the ONDC gateway cannot be driven
  // to an allotment in the sandbox. It refuses `/api/oms/simulate/orders/:id`
  // ("ONDC gateway orders can't be simulated") and its RTA batch rejects
  // everything, so no folio is ever issued and redemption and switch cannot be
  // exercised at all. On the RTA route the same orders settle on demand, via a
  // settlement detail and the order simulation.
  //
  // Gated on `simulationEnabled`, which is `hostname === "s.finprim.com" &&
  // NODE_ENV !== "production"` — a computed fact, not a flag, so no environment
  // variable can open this against production. Production stays ONDC-only.
  const sandbox = fpConfig().simulationEnabled;
  if (
    options.method !== "GET" &&
    options.path.startsWith("/v2/mf_settlement_details") &&
    !sandbox
  ) {
    throw new Error("RTA settlements are disabled outside the sandbox");
  }
  if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
    const body = options.body as Record<string, unknown>;
    const routes = sandbox ? ["ondc", "cybrillapoa", "rta"] : ["ondc", "cybrillapoa"];
    if (body.gateway !== undefined && !routes.includes(String(body.gateway))) {
      throw new Error(
        sandbox
          ? "Only ONDC and (in the sandbox) RTA routing are supported"
          : "Only ONDC routing is supported",
      );
    }
    // Defence in depth against a non-ONDC provider reaching a money call.
    // The two halves of /api/pg do not agree on what the ONDC gateway is
    // called — mandates want CYBRILLAPOA, payments want ONDC, and each rejects
    // the other's name — so the expected value is per path, not one constant.
    // See ONDC_MANDATE_PROVIDER / ONDC_PAYMENT_PROVIDER in resources/payments.ts;
    // duplicated here deliberately, because a guard that trusts its caller is
    // not a guard.
    if (body.provider_name !== undefined) {
      const expected = options.path.startsWith("/api/pg/mandates")
        ? "CYBRILLAPOA"
        : options.path.startsWith("/api/pg/payments")
          ? "ONDC"
          : null;
      if (expected === null || body.provider_name !== expected) {
        throw new Error(`provider_name is not accepted on ${options.path}, or is not the ONDC provider for it`);
      }
    }
    if (options.method === "POST" && /^\/v2\/mf_(purchases|redemptions|switches|purchase_plans|redemption_plans|switch_plans)$/.test(options.path) && body.mf_investment_account) {
      options = { ...options, body: { ...body, gateway: sandbox && body.gateway === "rta" ? "rta" : "cybrillapoa" } };
    }
  }
  const config = fpConfig();
  const realm = options.realm ?? "tenant";
  const requestId = options.requestId ?? randomId();
  const endpoint = `${options.method} ${options.path}`;
  const url = buildUrl(options.path, options.query, realm);
  const retryEnabled = options.retry ?? options.method === "GET";
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;

  // Retried once on a 401, after dropping the cached token.
  let tokenRefreshed = false;

  // FormData must reach fetch untouched: stringifying it yields "[object
  // FormData]", and setting content-type ourselves omits the multipart
  // boundary, so FP would reject the upload.
  const isMultipart = options.body instanceof FormData;
  const payload =
    options.body === undefined
      ? undefined
      : isMultipart
        ? (options.body as FormData)
        : JSON.stringify(options.body);

  for (let attempt = 1; ; attempt++) {
    const startedAt = performance.now();
    let response: Response;

    try {
      response = await fetch(url, {
        redirect: "error",
        method: options.method,
        headers: {
          authorization: `Bearer ${await getAccessToken(realm)}`,
          // The pre-verification service resolves the tenant from the token
          // and rejects the header.
          ...(realm === "tenant" && { "x-tenant-id": config.tenantId }),
          accept: "application/json",
          ...(payload !== undefined && !isMultipart && { "content-type": "application/json" }),
        },
        ...(payload !== undefined && { body: payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // No response: DNS, TCP, TLS, or our AbortSignal fired.
      const isLast = !retryEnabled || attempt >= MAX_ATTEMPTS;
      // The cause, not just the fact. Without it every transport failure logs
      // the same line whether the token expired, DNS went, or we timed out.
      console.warn(
        `[fp] ${endpoint} transport failure (attempt ${attempt}) req=${requestId}` +
          (isLast ? "" : ", retrying"),
        cause,
      );
      if (isLast) {
        throw new FpTransportError(`FP request failed: ${endpoint}`, endpoint, requestId, cause);
      }
      await sleep(backoffMs(attempt, null));
      continue;
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const body = await response.text();

    if (response.ok) {
      if (durationMs >= 2_000) {
        console.warn(`[fp] ${endpoint} slow: ${durationMs}ms req=${requestId}`);
      }
      // 204 and empty bodies are legitimate for some FP write endpoints.
      if (body === "") return undefined as T;
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new FpTransportError(
          `FP returned a non-JSON body for ${endpoint}`,
          endpoint,
          requestId,
        );
      }
    }

    // A 401 on a token we believed was valid: refresh once, then give up.
    if (response.status === 401 && !tokenRefreshed) {
      tokenRefreshed = true;
      invalidateAccessToken(realm);
      console.warn(`[fp] ${endpoint} 401, refreshing token req=${requestId}`);
      continue;
    }

    const shouldRetry = retryEnabled && isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS;
    if (!shouldRetry) {
      // Log status and endpoint only. FP error bodies quote back the values we
      // sent, which for these APIs means PAN, bank accounts and names.
      console.warn(
        `[fp] ${endpoint} failed ${response.status} in ${durationMs}ms req=${requestId}`,
      );
      throw parseFpError(response.status, body, requestId, endpoint);
    }

    const waitMs = backoffMs(attempt, response.headers.get("retry-after"));
    console.warn(
      `[fp] ${endpoint} ${response.status} (attempt ${attempt}), retrying in ${waitMs}ms req=${requestId}`,
    );
    await sleep(waitMs);
  }
}

/** FP's list envelope: `{ object: "list", data: [...] }`. */
export interface FpList<T> {
  object: "list";
  data: T[];
}

/**
 * GET a list endpoint and return the rows.
 *
 * FP caps these at 100 records and offers no cursor on most of them, so a
 * caller that might exceed 100 must narrow with query filters rather than
 * paginate. Where that cap is load-bearing the calling service says so.
 */
export async function fpList<T>(
  path: string,
  query?: FpRequestOptions["query"],
  requestId?: string,
): Promise<T[]> {
  const response = await fpRequest<FpList<T> | T[]>({
    method: "GET",
    path,
    ...(query && { query }),
    ...(requestId && { requestId }),
  });
  if (Array.isArray(response)) return response;
  return response?.data ?? [];
}
