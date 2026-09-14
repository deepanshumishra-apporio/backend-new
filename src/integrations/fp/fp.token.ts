// Access token caches.
//
// FP's tokens last 1800s and FP explicitly asks callers not to mint one per
// request — doing so is both a rate-limit risk and a documented anti-pattern.
// So: cache it, refresh it early, and make sure a burst of concurrent callers
// triggers exactly ONE refresh (single flight) rather than twenty.
//
// There are two token realms, not one. The main tenant realm covers the object
// APIs; pre-verification lives behind a different tenant, a different client
// and a different host. Same mechanics, separate caches — a token from one is
// not accepted by the other.
import { fpConfig, fpPreVerifyConfig } from "./fp.config.ts";
import { FpTransportError, parseFpError } from "./fp.errors.ts";

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

interface CachedToken {
  accessToken: string;
  /** Epoch ms at which we stop trusting it, skew already subtracted. */
  expiresAt: number;
}

interface TokenSource {
  readonly label: string;
  readonly authUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs: number;
  readonly refreshSkewSeconds: number;
}

/** Floor for `expires_in`, in case FP ever returns something absurdly small. */
const MIN_TOKEN_LIFETIME_SECONDS = 30;

async function requestToken(source: TokenSource): Promise<CachedToken> {
  const endpoint = `POST ${source.label} token`;

  let response: Response;
  try {
    response = await fetch(source.authUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: source.clientId,
        client_secret: source.clientSecret,
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(source.timeoutMs),
      redirect: "error",
    });
  } catch (cause) {
    throw new FpTransportError("FP token request failed", endpoint, "token", cause);
  }

  const body = await response.text();
  if (!response.ok) {
    // The body of a failed token call echoes the client_id back. Parse it for
    // the status, then discard it — parseFpError keeps only status and message.
    throw parseFpError(response.status, body, "token", endpoint);
  }

  let payload: TokenResponse;
  try {
    payload = JSON.parse(body) as TokenResponse;
  } catch {
    throw new FpTransportError("FP token response was not JSON", endpoint, "token");
  }

  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new FpTransportError("FP token response carried no access_token", endpoint, "token");
  }

  if (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new FpTransportError("Invalid FP token lifetime", endpoint, "token");
  }
  const lifetime = payload.expires_in - Math.min(source.refreshSkewSeconds, payload.expires_in / 2);

  return { accessToken, expiresAt: Date.now() + lifetime * 1_000 };
}

/**
 * One cache per realm.
 *
 * Concurrent callers during a refresh all await the same promise. If that
 * refresh fails the promise is cleared, so the next caller retries rather than
 * inheriting a permanently rejected one.
 */
function createTokenCache(resolveSource: () => TokenSource) {
  let cached: CachedToken | undefined;
  let inFlight: Promise<CachedToken> | undefined;

  return {
    async get(): Promise<string> {
      if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

      inFlight ??= requestToken(resolveSource())
        .then((token) => {
          cached = token;
          return token;
        })
        .finally(() => {
          inFlight = undefined;
        });

      return (await inFlight).accessToken;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}

const tenantTokens = createTokenCache(() => {
  const config = fpConfig();
  return {
    label: `tenant ${config.tenantId}`,
    authUrl: `${config.baseUrl}/v2/auth/${config.tenantId}/token`,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    timeoutMs: config.timeoutMs,
    refreshSkewSeconds: config.tokenRefreshSkewSeconds,
  };
});

const preVerifyTokens = createTokenCache(() => {
  const config = fpConfig();
  const preVerify = fpPreVerifyConfig();
  return {
    label: "pre-verification",
    authUrl: preVerify.authUrl,
    clientId: preVerify.clientId,
    clientSecret: preVerify.clientSecret,
    timeoutMs: config.timeoutMs,
    refreshSkewSeconds: config.tokenRefreshSkewSeconds,
  };
});

/** Which set of credentials a call should authenticate with. */
export type FpRealm = "tenant" | "preverify";

export async function getAccessToken(realm: FpRealm = "tenant"): Promise<string> {
  return realm === "preverify" ? preVerifyTokens.get() : tenantTokens.get();
}

/**
 * Drop a cached token so the next call mints a fresh one.
 *
 * Called on a 401: the token was valid when issued but is no longer accepted
 * (a not-before-policy bump, or clock skew), and one retry with a new token is
 * the correct response.
 */
export function invalidateAccessToken(realm: FpRealm = "tenant"): void {
  if (realm === "preverify") preVerifyTokens.invalidate();
  else tenantTokens.invalidate();
}
