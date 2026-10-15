import type { Request, Response } from "express";
import { staffPrincipal } from "../middleware/staff-auth.ts";
import * as dashboard from "../services/admin-dashboard.service.ts";
import * as investors from "../services/admin-investor.service.ts";
import * as investorActions from "../services/admin-investor-actions.service.ts";
import * as investorItems from "../services/admin-investor-item.service.ts";
import {
  INVESTOR_ATTENTION,
  JOURNEY_STAGES,
  KYC_STATUSES,
  type InvestorAttention,
  type InvestorItemType,
  type InvestorListQuery,
  type SignupBucket,
} from "../types/admin-investor.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { asBody, DATE_PATTERN, requiredStringArray } from "../utils/validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_STATUSES = ["ACTIVE", "PENDING_VERIFICATION", "SUSPENDED", "CLOSED"] as const;
const BUCKETS = ["day", "week", "month"] as const;
/** Upper bound on points in one series, so a wide daily range cannot scan forever. */
const MAX_POINTS = 400;

function queryString(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw HttpError.badRequest(`${name} must be given once`);
  return raw.trim() === "" ? undefined : raw.trim();
}

/** `?stage=KYC,PROFILE` → validated list. */
function queryList<T extends string>(req: Request, name: string, allowed: readonly T[]): T[] | undefined {
  const raw = queryString(req, name);
  if (!raw) return undefined;
  const values = raw.split(",").map((value) => value.trim().toUpperCase());
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw HttpError.badRequest(`${name} must be a comma-separated list of: ${allowed.join(", ")}`);
    }
  }
  return values as T[];
}

function queryDate(req: Request, name: string): string | undefined {
  const raw = queryString(req, name);
  if (!raw) return undefined;
  if (!DATE_PATTERN.test(raw) || Number.isNaN(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 10) !== raw) {
    throw HttpError.badRequest(`${name} must be a date in yyyy-mm-dd format`);
  }
  return raw;
}

/** Today's date in India. */
const istToday = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

export async function summary(_req: Request, res: Response) {
  res.json({ data: await dashboard.getSummary() });
}

export async function signups(req: Request, res: Response) {
  const bucketRaw = queryString(req, "bucket") ?? "day";
  if (!(BUCKETS as readonly string[]).includes(bucketRaw)) throw HttpError.badRequest("bucket must be day, week or month");
  const bucket = bucketRaw as SignupBucket;
  const to = queryDate(req, "to") ?? istToday();
  const from = queryDate(req, "from") ?? addDays(to, -29);
  if (from > to) throw HttpError.badRequest("from must be on or before to");
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  const points = bucket === "day" ? days : bucket === "week" ? days / 7 : days / 30;
  if (points > MAX_POINTS) throw HttpError.badRequest(`That range has too many ${bucket} buckets; widen the bucket or narrow the range`);
  res.json({ data: await dashboard.getSignupSeries(from, to, bucket) });
}

/** The list's filters, shared by the list and its export. */
function listFilters(req: Request): Omit<InvestorListQuery, "limit" | "cursor"> {
  const search = queryString(req, "search");
  if (search && search.length > 100) throw HttpError.badRequest("search must be at most 100 characters");

  const stalled = queryString(req, "kycStalled");
  if (stalled !== undefined && stalled !== "true" && stalled !== "false") {
    throw HttpError.badRequest("kycStalled must be true or false");
  }

  const sipDueRaw = queryString(req, "sipDueDays");
  const sipDueDays = sipDueRaw === undefined ? undefined : Number(sipDueRaw);
  if (sipDueDays !== undefined && (!Number.isInteger(sipDueDays) || sipDueDays < 0 || sipDueDays > 60)) {
    throw HttpError.badRequest("sipDueDays must be a whole number of days, 0 to 60");
  }

  const attention = queryString(req, "attention")?.toUpperCase();
  if (attention !== undefined && !(INVESTOR_ATTENTION as readonly string[]).includes(attention)) {
    throw HttpError.badRequest(`attention must be one of: ${INVESTOR_ATTENTION.join(", ")}`);
  }

  const stage = queryList(req, "stage", JOURNEY_STAGES);
  const kycStatus = queryList(req, "kycStatus", KYC_STATUSES);
  const status = queryList(req, "status", USER_STATUSES);
  return {
    ...(search && { search }),
    ...(stage && { stage }),
    ...(kycStatus && { kycStatus }),
    ...(status && { status }),
    ...(stalled === "true" && { kycStalled: true }),
    ...(sipDueDays !== undefined && { sipDueDays }),
    ...(attention && { attention: attention as InvestorAttention }),
  };
}

export async function list(req: Request, res: Response) {
  const limitRaw = queryString(req, "limit");
  const limit = limitRaw === undefined ? 25 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw HttpError.badRequest("limit must be between 1 and 100");

  const cursorRaw = queryString(req, "cursor");
  let cursor: { createdAt: Date; id: string } | undefined;
  if (cursorRaw) {
    const [at, id] = Buffer.from(cursorRaw, "base64url").toString("utf8").split("|");
    const createdAt = new Date(at ?? "");
    if (!id || !UUID.test(id) || Number.isNaN(createdAt.getTime())) throw HttpError.badRequest("cursor is invalid");
    cursor = { createdAt, id };
  }

  res.json({ data: await investors.listInvestors({ ...listFilters(req), limit, ...(cursor && { cursor }) }) });
}

/** Where everyone is: the stage counts and the counts behind the list's quick filters. */
export async function overview(_req: Request, res: Response) {
  res.json({ data: await investorActions.getInvestorOverview() });
}

/** The filtered list as a CSV file. */
export async function exportCsv(req: Request, res: Response) {
  const file = await investorActions.exportInvestors(listFilters(req), staffPrincipal(req));
  res
    .status(200)
    .set({
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.filename}"`,
      "cache-control": "no-store",
      "x-report-rows": String(file.rows),
      "x-report-truncated": String(file.truncated),
    })
    .send(file.csv);
}

/** A reminder notification to each of these investors. */
export async function nudge(req: Request, res: Response) {
  const userIds = requiredStringArray(asBody(req.body), "userIds");
  if (userIds.length > investorActions.NUDGE_BATCH_LIMIT) {
    throw HttpError.badRequest(`userIds can name at most ${investorActions.NUDGE_BATCH_LIMIT} investors`);
  }
  if (userIds.some((id) => !UUID.test(id))) throw HttpError.badRequest("userIds must be investor ids");
  res.json({ data: await investorActions.nudgeInvestors(userIds, staffPrincipal(req)) });
}

export async function getOne(req: Request<{ userId: string }>, res: Response) {
  if (!UUID.test(req.params.userId)) throw HttpError.notFound("No investor with that id");
  res.json({ data: await investors.getInvestor(req.params.userId, staffPrincipal(req)) });
}

const ITEM_TYPES: readonly InvestorItemType[] = ["holding", "sip", "swp", "stp", "purchase", "redemption", "switch", "payment"];

/** One holding, plan, order or payment of this investor, for the record's side panel. */
export async function getItem(req: Request<{ userId: string; type: string; itemId: string }>, res: Response) {
  const { userId, type, itemId } = req.params;
  if (!UUID.test(userId) || !UUID.test(itemId) || !(ITEM_TYPES as readonly string[]).includes(type)) {
    throw HttpError.notFound("No such item");
  }
  res.json({ data: await investorItems.getInvestorItem(userId, type as InvestorItemType, itemId) });
}
