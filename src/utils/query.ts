// Query-string parsing for admin list endpoints. Pure: each takes Express's
// parsed `req.query` and returns a narrowed value or throws an HttpError.
import { HttpError } from "./http-error.ts";
import { DATE_PATTERN } from "./validate.ts";

type Query = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);

/** One trimmed value; blank counts as absent. */
export function queryString(query: Query, name: string, maxLength = 100): string | undefined {
  const raw = query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw HttpError.badRequest(`${name} must be given once`);
  const value = raw.trim();
  if (value.length > maxLength) throw HttpError.badRequest(`${name} must be at most ${maxLength} characters`);
  return value === "" ? undefined : value;
}

/** `?status=OPEN,IN_PROGRESS` → a validated list. */
export function queryList<T extends string>(query: Query, name: string, allowed: readonly T[]): T[] | undefined {
  const raw = queryString(query, name, 500);
  if (!raw) return undefined;
  const values = raw.split(",").map((value) => value.trim().toUpperCase());
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw HttpError.badRequest(`${name} must be a comma-separated list of: ${allowed.join(", ")}`);
    }
  }
  return values as T[];
}

export function queryDate(query: Query, name: string): string | undefined {
  const raw = queryString(query, name);
  if (!raw) return undefined;
  if (!DATE_PATTERN.test(raw) || Number.isNaN(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 10) !== raw) {
    throw HttpError.badRequest(`${name} must be a date in yyyy-mm-dd format`);
  }
  return raw;
}

export function queryBoolean(query: Query, name: string): boolean | undefined {
  const raw = queryString(query, name);
  if (raw === undefined) return undefined;
  if (raw !== "true" && raw !== "false") throw HttpError.badRequest(`${name} must be true or false`);
  return raw === "true";
}

export function queryLimit(query: Query, fallback: number, max: number): number {
  const raw = queryString(query, "limit");
  const limit = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw HttpError.badRequest(`limit must be between 1 and ${max}`);
  return limit;
}

/** A `<iso instant>|<uuid>` keyset cursor, base64url-encoded. */
export function queryCursor(query: Query): { at: Date; id: string } | undefined {
  const raw = queryString(query, "cursor", 200);
  if (!raw) return undefined;
  const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const instant = new Date(at ?? "");
  if (!id || !UUID.test(id) || Number.isNaN(instant.getTime())) throw HttpError.badRequest("cursor is invalid");
  return { at: instant, id };
}
