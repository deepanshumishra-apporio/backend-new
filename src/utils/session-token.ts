import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes, base64url: always 43 characters. */
export const newSessionToken = () => randomBytes(32).toString("base64url");

/** Only the SHA-256 is stored, so a database leak yields no usable tokens. */
export const sessionTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** `Authorization: Bearer <token>` → the token, or null when absent or malformed. */
export function bearerToken(header: string | undefined): string | null {
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1] ?? null;
}
