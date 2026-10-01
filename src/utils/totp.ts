// RFC 6238 time-based one-time passwords (HMAC-SHA1, 6 digits, 30 seconds) —
// what Google Authenticator, Microsoft Authenticator and 1Password speak.
//
// Pure: the clock is a parameter. Written against node:crypto rather than a
// library because it is forty lines, and every dependency on an auth path is
// one more thing to audit.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PERIOD_SECONDS = 30;
const DIGITS = 6;
/** Codes one step either side are accepted, for clock drift. */
const WINDOW = 1;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("Invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the size RFC 4226 recommends for SHA-1. */
export const newTotpSecret = () => randomBytes(20);

export const timeStep = (at: Date) => Math.floor(at.getTime() / 1000 / PERIOD_SECONDS);

export function totpAt(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return binary.toString().padStart(DIGITS, "0");
}

/**
 * The time-step `code` belongs to, or null when it matches none in the window.
 * A step at or before `lastUsedStep` never matches, so a code that has been
 * used (or one older than it) cannot be replayed.
 */
export function verifyTotp(secret: Uint8Array, code: string, at: Date, lastUsedStep: number | null): number | null {
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(code)) return null;
  const now = timeStep(at);
  for (let step = now - WINDOW; step <= now + WINDOW; step++) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUri(secret: Uint8Array, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
