// Pure phone-number helpers. No I/O.
import { HttpError } from "./http-error.ts";

/** India. MSG91 is an Indian gateway and this platform serves Indian investors. */
const COUNTRY_CODE = "91";

/** Indian mobile numbers are 10 digits and start with 6-9. */
const NATIONAL_NUMBER = /^[6-9]\d{9}$/;

/**
 * Normalise user input to E.164 (+919876543210).
 *
 * Normalising is a security control, not a convenience: rate limits and
 * uniqueness are keyed on this string, so "+91 98765-43210", "09876543210" and
 * "919876543210" must collapse to one value or a caller could evade send caps
 * just by reformatting.
 *
 * Accepts: 9876543210, 09876543210, 919876543210, +919876543210, and any of
 * those with spaces, dashes, brackets or dots.
 */
export function normalisePhone(input: string): string {
  if (typeof input !== "string") throw HttpError.badRequest("phone must be a string");

  // Strip everything that is not a digit or a leading plus.
  const cleaned = input.trim().replace(/[\s()\-.]/g, "");
  const digits = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;

  if (!/^\d+$/.test(digits)) {
    throw HttpError.badRequest("phone must contain only digits, spaces, dashes or a leading +");
  }

  let national: string;
  if (digits.length === 10) {
    national = digits;
  } else if (digits.length === 11 && digits.startsWith("0")) {
    // Domestic trunk prefix.
    national = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith(COUNTRY_CODE)) {
    national = digits.slice(2);
  } else {
    throw HttpError.badRequest("phone must be a 10-digit Indian mobile number");
  }

  if (!NATIONAL_NUMBER.test(national)) {
    throw HttpError.badRequest("phone must be a valid Indian mobile number starting with 6-9");
  }

  return `+${COUNTRY_CODE}${national}`;
}

/**
 * MSG91 expects the number with the country code and no plus.
 * Input must already be E.164 from `normalisePhone`.
 */
export function toProviderFormat(e164: string): string {
  return e164.replace(/^\+/, "");
}

/**
 * Mask for responses, logs and audit metadata.
 * `+919876543210` -> `+91******3210`
 */
export function maskPhone(e164: string): string {
  if (e164.length < 4) return "****";
  return `+${COUNTRY_CODE}******${e164.slice(-4)}`;
}
