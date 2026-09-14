import type { Prisma } from "../../generated/prisma/client.ts";

// Pure helpers for turning FP wire values into database values.
//
// The enums in schema.prisma `@map` to FP's exact wire strings, and Prisma's
// generated TypeScript uses the SCREAMING_SNAKE member names while writing the
// mapped value to Postgres. So the whole normalisation is an upper-case:
// FP's "resident_individual" -> TS `RESIDENT_INDIVIDUAL` -> column
// 'resident_individual'. The /api/pg enums already shout, and upper-casing
// those is a no-op, so one rule covers both vocabularies.
//
// Everything here is total: FP can and does send values that are not in our
// enums yet (a new occupation, a new failure code). Mapping returns null for
// those rather than throwing, because losing one attribute is survivable and
// dropping a whole webhook is not. Required fields are the caller's problem to
// check.

/**
 * Map an FP wire value onto one of our enums.
 *
 * `onUnknown` is called when FP sends something we do not model, so the caller
 * can log it — that is the signal to add the value to the schema.
 */
export function fpEnum<T extends Record<string, string>>(
  values: T,
  raw: unknown,
  onUnknown?: (value: string) => void,
): T[keyof T] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const key = raw.trim().toUpperCase().replaceAll("-", "_");
  // `Object.hasOwn`, not a bare index: the key comes from an FP payload, and
  // an inherited one ("CONSTRUCTOR", "TO_STRING") would otherwise resolve to a
  // function and be handed to Prisma as an enum value.
  const match = Object.hasOwn(values, key) ? (values as Record<string, string>)[key] : undefined;
  if (match === undefined || typeof match !== "string") {
    onUnknown?.(raw);
    return null;
  }
  return match as T[keyof T];
}

/** Same, but falls back instead of returning null. */
export function fpEnumOr<T extends Record<string, string>>(
  values: T,
  raw: unknown,
  fallback: T[keyof T],
  onUnknown?: (value: string) => void,
): T[keyof T] {
  return fpEnum(values, raw, onUnknown) ?? fallback;
}

/**
 * FP sends money and units as JSON numbers; Decimal columns take strings.
 *
 * Going through the number is unavoidable — it is what arrived — but the string
 * is what gets stored, so no further precision is lost on the way in. `dp`
 * matches the column's scale so Prisma never has to round.
 */
export function fpDecimal(raw: unknown, dp = 4): string | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value.toFixed(dp);
}

/** Money: 2dp. */
export const fpAmount = (raw: unknown) => fpDecimal(raw, 2);
/** Units: 4dp. */
export const fpUnits = (raw: unknown) => fpDecimal(raw, 4);
/** NAV and prices: 4dp. */
export const fpNav = (raw: unknown) => fpDecimal(raw, 4);
/** Allocation percentage: 2dp. */
export const fpPercent = (raw: unknown) => fpDecimal(raw, 2);

/**
 * Parse an FP timestamp.
 *
 * FP sends ISO 8601 with an offset ("2026-09-11T11:16:11+05:30") and, on some
 * older endpoints, without a separator ("+0530"). Date handles both. An
 * unparseable value becomes null rather than an Invalid Date, which Prisma
 * would otherwise reject at write time with a far less obvious error.
 */
export function fpDateTime(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse an FP date-only value (yyyy-mm-dd) into a UTC midnight Date.
 *
 * Deliberately NOT `new Date(raw)` on a bare date string: that is parsed as UTC
 * midnight, then rendered in local time, so an installment day of the 15th can
 * display as the 14th west of Greenwich. Building the UTC date explicitly keeps
 * a @db.Date column holding exactly the day FP said.
 */
export function fpDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Trim to null, and cap at the column width so a write cannot overflow. */
export function fpText(raw: unknown, maxLength?: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return maxLength && trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Like `fpText`, but keeps a structured value instead of discarding it.
 *
 * FP is not consistent about the shape of some fields — `readiness.modification`
 * on a pre-verification is null, a string, or a `{status, requested_at}` object
 * depending on the record. Writing that straight to a text column throws a
 * Prisma validation error and surfaces as a 500 on a polling endpoint, and
 * dropping it (what `fpText` would do) loses the only record of what FP said.
 * So anything that is not a string is stored as compact JSON.
 */
export function fpFlatText(raw: unknown, maxLength?: number): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return fpText(raw, maxLength);
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  try {
    return fpText(JSON.stringify(raw), maxLength);
  } catch {
    return null;
  }
}

export function fpInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

export function fpBool(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/**
 * Prepare an arbitrary FP hash for a Json column.
 *
 * Round-trips through JSON rather than casting: FP payloads reach us as plain
 * parsed JSON, but a value built in code could carry `undefined` or a Date,
 * which Prisma's Json input rejects at runtime with an opaque error. The
 * round-trip makes "is this storable" true by construction, and returns
 * undefined for absent values so the column is simply left alone.
 */
export function fpJson(raw: unknown): Prisma.InputJsonValue | undefined {
  if (raw === null || raw === undefined) return undefined;
  return JSON.parse(JSON.stringify(raw)) as Prisma.InputJsonValue;
}

/** Array of non-empty strings, or an empty array. Never null — for String[]. */
export function fpStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** Last 4 digits of an identifier, which is all we are allowed to keep. */
export function lastFour(raw: unknown): string | null {
  const text = fpText(raw);
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : (digits || null);
}

/**
 * Stable fingerprint of a bank account, so we can recognise a duplicate
 * without storing the account number.
 *
 * Normalises first: leading zeros and case in the IFSC are not meaningful, and
 * an investor re-entering the same account should collide with the old row.
 */
export async function bankAccountFingerprint(
  accountNumber: string,
  ifsc: string,
): Promise<string> {
  const normalised = `${accountNumber.replace(/\D/g, "").replace(/^0+/, "")}|${ifsc.trim().toUpperCase()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalised));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Split "mf_purchase.successful" into its object type and its verb. */
export function splitEventType(type: string): { objectType: string; action: string } {
  const index = type.lastIndexOf(".");
  if (index <= 0) return { objectType: type, action: "" };
  return { objectType: type.slice(0, index), action: type.slice(index + 1) };
}
