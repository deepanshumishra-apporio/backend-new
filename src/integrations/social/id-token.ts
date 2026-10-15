// Apple and Google ID tokens: RS256 JWTs signed with keys each provider
// publishes as a JWKS. Verified here with node:crypto — no JWT library — and
// only the claims sign-in needs are read.
import { createHash, createPublicKey, verify } from "node:crypto";

export type SocialProviderKey = "APPLE" | "GOOGLE";

export interface ProviderConfig {
  issuers: readonly string[];
  jwksUrl: string;
  /** Client ids the token's `aud` may name: bundle id / Services id for Apple, OAuth client ids for Google. */
  audiences: readonly string[];
}

export interface VerifiedIdToken {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

export class IdTokenError extends Error {}

/** One entry of a JWKS. Only RSA keys are ever used. */
export interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

const CLOCK_SKEW_SECONDS = 60;

function decodePart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IdTokenError("Malformed token");
  return value as Record<string, unknown>;
}

/** Apple sends `email_verified` as the string "true"; Google as a boolean. */
const truthy = (value: unknown) => value === true || value === "true";

/**
 * Check signature, issuer, audience, expiry and (when the app sent one) the
 * nonce. Pure: the caller supplies the provider's current keys.
 *
 * The nonce is compared hashed — the app hands the provider sha256(nonce) and
 * keeps the raw value — so a token lifted from one sign-in cannot be replayed
 * in another.
 */
export function verifyIdToken(
  token: string,
  keys: readonly Jwk[],
  config: ProviderConfig,
  options: { nonce?: string; now?: Date } = {},
): VerifiedIdToken {
  const parts = token.split(".");
  if (parts.length !== 3) throw new IdTokenError("Malformed token");
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodePart(rawHeader);
    claims = decodePart(rawPayload);
  } catch {
    throw new IdTokenError("Malformed token");
  }
  // Pinned: accepting the header's own `alg` is how "none" and HS256-with-the-
  // public-key forgeries get through.
  if (header["alg"] !== "RS256") throw new IdTokenError("Unsupported algorithm");
  const key = keys.find((candidate) => candidate.kid === header["kid"] && candidate.kty === "RSA");
  if (!key) throw new IdTokenError("Unknown signing key");
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${rawHeader}.${rawPayload}`),
    createPublicKey({ key, format: "jwk" }),
    Buffer.from(rawSignature, "base64url"),
  );
  if (!valid) throw new IdTokenError("Bad signature");

  if (typeof claims["iss"] !== "string" || !config.issuers.includes(claims["iss"])) {
    throw new IdTokenError("Wrong issuer");
  }
  const aud = claims["aud"];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.some((value) => typeof value === "string" && config.audiences.includes(value))) {
    throw new IdTokenError("Wrong audience");
  }
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const exp = claims["exp"];
  if (typeof exp !== "number" || exp + CLOCK_SKEW_SECONDS < nowSeconds) throw new IdTokenError("Token expired");
  const iat = claims["iat"];
  if (typeof iat === "number" && iat - CLOCK_SKEW_SECONDS > nowSeconds) throw new IdTokenError("Token not yet valid");

  if (options.nonce !== undefined || claims["nonce"] !== undefined) {
    const expected = options.nonce === undefined ? undefined : createHash("sha256").update(options.nonce).digest("hex");
    if (expected === undefined || claims["nonce"] !== expected) throw new IdTokenError("Nonce mismatch");
  }

  const subject = claims["sub"];
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 255) {
    throw new IdTokenError("Missing subject");
  }
  const email = typeof claims["email"] === "string" && claims["email"].length <= 255
    ? claims["email"].trim().toLowerCase()
    : null;
  return { subject, email, emailVerified: email !== null && truthy(claims["email_verified"]) };
}

const KEY_CACHE_MS = 60 * 60 * 1000;
const keyCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

/**
 * The provider's signing keys, cached for an hour. A `kid` the cache does not
 * know forces one refetch, because providers rotate keys without notice.
 */
export async function providerKeys(jwksUrl: string, kid?: string): Promise<Jwk[]> {
  const cached = keyCache.get(jwksUrl);
  const fresh = cached && Date.now() - cached.fetchedAt < KEY_CACHE_MS;
  if (cached && fresh && (!kid || cached.keys.some((key) => key.kid === kid))) return cached.keys;
  const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
  const body = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error("JWKS response has no keys");
  const keys = body.keys as Jwk[];
  keyCache.set(jwksUrl, { keys, fetchedAt: Date.now() });
  return keys;
}

/** The `kid` a token claims, read without trusting anything else in it. */
export function tokenKeyId(token: string): string | undefined {
  try {
    const kid = decodePart(token.split(".")[0] ?? "")["kid"];
    return typeof kid === "string" ? kid : undefined;
  } catch {
    return undefined;
  }
}
