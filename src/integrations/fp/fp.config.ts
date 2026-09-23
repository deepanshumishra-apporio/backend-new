// FP connection settings, resolved once at import and validated up front.
//
// Failing here — at boot — beats failing on the first investor's first order
// with a confusing 401.

export interface FpConfig {
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs: number;
  /** Refresh the token this many seconds before `expires_in` runs out. */
  readonly tokenRefreshSkewSeconds: number;
  /**
   * Which order gateway to route through: always `ondc`.
   *
   * Sent explicitly rather than left to FP's tenant default. `cybrillapoa` is
   * NOT an alias for it — FP's ONDC payment provider refuses `cybrillapoa`
   * orders and they are never allotted. See src/utils/gateway.ts.
   */
  readonly orderGateway: "ondc";
  /**
   * Simulation endpoints (`/api/oms/simulate/*`) exist only in the sandbox.
   * Derived from the base URL rather than configured, so production can never
   * be pointed at them by a stray environment variable.
   */
  readonly simulationEnabled: boolean;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set — FP integration cannot start`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

/**
 * Pre-verification lives behind its own tenant, client and host.
 *
 * On the sandbox tenant we were given, this — not `/api/kyc/check` — is the
 * working way to check whether an investor is transaction-ready, so it is a
 * first-class realm rather than an add-on.
 */
export interface FpPreVerifyConfig {
  readonly baseUrl: string;
  readonly authUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

function orderGateway(): "ondc" {
  const raw = process.env["FP_ORDER_GATEWAY"]?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "ondc") return "ondc";
  // Refused loudly rather than mapped: a config still saying `cybrillapoa`
  // was written under the old belief that it is the ONDC gateway, and orders
  // on it can be neither paid by UPI/netbanking nor allotted.
  throw new Error(
    'Only ONDC is supported: FP_ORDER_GATEWAY must be "ondc" ("cybrillapoa" is a different FP gateway whose orders cannot be paid or allotted)',
  );
}

let cached: FpConfig | undefined;
let cachedPreVerify: FpPreVerifyConfig | undefined;

function httpsUrl(raw: string, name: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be HTTPS without credentials, query or fragment`);
  }
  return raw;
}

export function fpConfig(): FpConfig {
  if (cached) return cached;

  const baseUrl = required("FP_BASE_URL").replace(/\/+$/, "");
  httpsUrl(baseUrl, "FP_BASE_URL");
  if (new URL(baseUrl).pathname !== "/") throw new Error("FP_BASE_URL must be an origin");
  if (!/^[a-zA-Z0-9_-]+$/.test(required("FP_TENANT_ID"))) throw new Error("Invalid FP_TENANT_ID");
  if (process.env.NODE_ENV === "production" && new URL(baseUrl).hostname === "s.finprim.com") {
    throw new Error("Production cannot use the FP sandbox");
  }
  if (!baseUrl.startsWith("https://")) {
    // The bearer token is tenant-wide. It must never cross the wire in clear.
    throw new Error("FP_BASE_URL must be an https:// URL");
  }

  cached = {
    baseUrl,
    tenantId: required("FP_TENANT_ID"),
    clientId: required("FP_CLIENT_ID"),
    clientSecret: required("FP_CLIENT_SECRET"),
    timeoutMs: positiveInt("FP_TIMEOUT_MS", 15_000),
    orderGateway: orderGateway(),
    tokenRefreshSkewSeconds: positiveInt("FP_TOKEN_REFRESH_SKEW_SECONDS", 120),
    // s.finprim.com is the sandbox host; production is a different hostname.
    simulationEnabled: new URL(baseUrl).hostname === "s.finprim.com" && process.env.NODE_ENV !== "production",
  };
  return cached;
}

/**
 * Pre-verification settings.
 *
 * Resolved lazily and separately: a deployment that does not use
 * pre-verification should still boot, and only fail if something actually
 * calls it.
 */
export function fpPreVerifyConfig(): FpPreVerifyConfig {
  if (cachedPreVerify) return cachedPreVerify;

  const baseUrl = required("FP_PREVERIFY_BASE_URL").replace(/\/+$/, "");
  httpsUrl(baseUrl, "FP_PREVERIFY_BASE_URL");
  if (new URL(baseUrl).pathname !== "/") throw new Error("FP_PREVERIFY_BASE_URL must be an origin");
  if (!baseUrl.startsWith("https://")) {
    throw new Error("FP_PREVERIFY_BASE_URL must be an https:// URL");
  }

  cachedPreVerify = {
    baseUrl,
    authUrl: httpsUrl(required("FP_PREVERIFY_AUTH_URL"), "FP_PREVERIFY_AUTH_URL"),
    clientId: required("FP_PREVERIFY_CLIENT_ID"),
    clientSecret: required("FP_PREVERIFY_CLIENT_SECRET"),
  };
  return cachedPreVerify;
}

/** True when pre-verification credentials are present at all. */
export function hasPreVerifyConfig(): boolean {
  return Boolean(
    process.env["FP_PREVERIFY_BASE_URL"]?.trim() &&
      process.env["FP_PREVERIFY_AUTH_URL"]?.trim() &&
      process.env["FP_PREVERIFY_CLIENT_ID"]?.trim() &&
      process.env["FP_PREVERIFY_CLIENT_SECRET"]?.trim(),
  );
}

/** Test seam — drops the memoised config so a changed env is picked up. */
export function resetFpConfig(): void {
  cached = undefined;
  cachedPreVerify = undefined;
}
