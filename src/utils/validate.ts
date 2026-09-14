// Request validation helpers.
//
// Pure: each takes an unknown off the wire and either returns a narrowed value
// or throws an HttpError describing what was wrong. Controllers use these so
// services can trust their inputs, which is the contract the layering depends
// on.
import { HttpError } from "./http-error.ts";

/** Body values arrive as unknown. This is the only shape assumption made. */
export function asBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw HttpError.badRequest("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function requiredString(
  body: Record<string, unknown>,
  field: string,
  options: { maxLength?: number; pattern?: RegExp; patternHint?: string } = {},
): string {
  const raw = body[field];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw HttpError.badRequest(`${field} is required`);
  }
  const value = raw.trim();
  if (options.maxLength && value.length > options.maxLength) {
    throw HttpError.badRequest(`${field} must be at most ${options.maxLength} characters`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw HttpError.badRequest(options.patternHint ?? `${field} is not in the expected format`);
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  options: { maxLength?: number; pattern?: RegExp; patternHint?: string } = {},
): string | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requiredString(body, field, options);
}

/**
 * A money or units value, kept as a STRING all the way through.
 *
 * Never parsed to a float here: 0.1 + 0.2 is not 0.3, and an amount that has
 * been through a double cannot be trusted to match a scheme's multiple. A
 * JSON number is accepted because clients send them, but it is converted via
 * its string form rather than arithmetic.
 */
export function requiredDecimal(
  body: Record<string, unknown>,
  field: string,
  options: { maxDecimalPlaces?: number } = {},
): string {
  const raw = body[field];
  const value =
    typeof raw === "number" && Number.isFinite(raw)
      ? String(raw)
      : typeof raw === "string"
        ? raw.trim()
        : null;

  if (value === null || !/^\d+(\.\d+)?$/.test(value)) {
    throw HttpError.badRequest(`${field} must be a positive decimal number`);
  }
  const places = value.split(".")[1]?.length ?? 0;
  const max = options.maxDecimalPlaces ?? 4;
  if (places > max) {
    throw HttpError.badRequest(`${field} must have at most ${max} decimal places`);
  }
  return value;
}

export function optionalDecimal(
  body: Record<string, unknown>,
  field: string,
  options: { maxDecimalPlaces?: number } = {},
): string | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requiredDecimal(body, field, options);
}

export function requiredInt(
  body: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number } = {},
): number {
  const raw = body[field];
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value)) throw HttpError.badRequest(`${field} must be an integer`);
  if (options.min !== undefined && value < options.min) {
    throw HttpError.badRequest(`${field} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw HttpError.badRequest(`${field} must be at most ${options.max}`);
  }
  return value;
}

export function optionalInt(
  body: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requiredInt(body, field, options);
}

export function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw HttpError.badRequest(`${field} must be an array of strings`);
  }
  return raw as string[];
}

export function requiredStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = optionalStringArray(body, field);
  if (!value || value.length === 0) throw HttpError.badRequest(`${field} must not be empty`);
  return value;
}

/** One of a fixed set, e.g. an FP enum's wire values. */
export function oneOf<T extends readonly string[]>(
  body: Record<string, unknown>,
  field: string,
  allowed: T,
  required = true,
): T[number] | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    if (required) throw HttpError.badRequest(`${field} is required`);
    return undefined;
  }
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    throw HttpError.badRequest(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return raw;
}

// --- Domain formats --------------------------------------------------------

/** 10 characters, 5 letters + 4 digits + 1 letter. 4th is the holder type. */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** 11 characters: 4 letters, a 0, then 6 alphanumerics. */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ISIN_PATTERN = /^INF[0-9A-Z]{9}$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** IPv4 only — FP rejects IPv6 in `user_ip`. */
export const IPV4_PATTERN =
  /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Uppercase first, then match.
 *
 * PANs and ISINs are case-insensitive identifiers that FP stores upper case.
 * Validating before normalising rejects a perfectly valid `abcde1234f` as
 * malformed, which is a confusing 400 for the one input an investor is most
 * likely to type by hand.
 */
function upperCased(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const raw = body[field];
  return typeof raw === "string" ? { ...body, [field]: raw.trim().toUpperCase() } : body;
}

export function requiredPan(body: Record<string, unknown>, field = "pan"): string {
  return requiredString(upperCased(body, field), field, {
    pattern: PAN_PATTERN,
    patternHint: `${field} must be a valid PAN, e.g. ABCDE1234F`,
  });
}

export function requiredIsin(body: Record<string, unknown>, field = "isin"): string {
  return requiredString(upperCased(body, field), field, {
    pattern: ISIN_PATTERN,
    patternHint: `${field} must be a valid mutual fund ISIN`,
  });
}

export function requiredDate(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field, {
    pattern: DATE_PATTERN,
    patternHint: `${field} must be in yyyy-mm-dd format`,
  });
  if (Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw HttpError.badRequest(`${field} is not a real date`);
  }
  return value;
}

export function optionalDate(body: Record<string, unknown>, field: string): string | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requiredDate(body, field);
}

/**
 * The end user's IP, which FP reports to the RTA.
 *
 * Taken from the request rather than the body: a client-supplied value would
 * be unverifiable audit data. `x-forwarded-for` holds the chain when we sit
 * behind a proxy, and the first entry is the original client.
 */
export function clientIpv4(headers: Record<string, unknown>, socketIp?: string): string {
  const forwarded = headers["x-forwarded-for"];
  const candidate =
    typeof forwarded === "string"
      ? forwarded.split(",")[0]?.trim()
      : Array.isArray(forwarded)
        ? String(forwarded[0]).split(",")[0]?.trim()
        : undefined;

  for (const value of [candidate, socketIp?.replace(/^::ffff:/, "")]) {
    if (value && IPV4_PATTERN.test(value)) return value;
  }
  // FP requires an IPv4 and rejects the request without one. Localhost is the
  // honest fallback in development; behind a proxy, fix the proxy headers.
  return "127.0.0.1";
}
