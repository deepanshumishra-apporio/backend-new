import type { Request, Response } from "express";
import { staffPrincipal } from "../middleware/staff-auth.ts";
import * as compliance from "../services/compliance-alert.service.ts";
import { ALERT_KINDS, ALERT_SEVERITIES, ALERT_STATUSES, type AlertAction } from "../types/compliance.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { isUuid, queryLimit, queryList, queryString } from "../utils/query.ts";
import { asBody, oneOf, optionalString, requiredString } from "../utils/validate.ts";

type AlertParams = { alertId: string };

const ACTIONS = ["acknowledge", "assign", "resolve", "dismiss", "reopen", "note", "remind"] as const;

function alertId(req: Request<AlertParams>): string {
  if (!isUuid(req.params.alertId)) throw HttpError.notFound("No alert with that id");
  return req.params.alertId;
}

export async function list(req: Request, res: Response) {
  const viewer = staffPrincipal(req);
  const assigneeRaw = queryString(req.query, "assignee");
  const assignee = assigneeRaw === "me" ? viewer.staffId : assigneeRaw;
  if (assignee && assignee !== "unassigned" && !isUuid(assignee)) {
    throw HttpError.badRequest("assignee must be me, unassigned or a staff id");
  }
  const cursor = queryString(req.query, "cursor");
  if (cursor && !isUuid(cursor)) throw HttpError.badRequest("cursor is invalid");
  const status = queryList(req.query, "status", ALERT_STATUSES);
  const kind = queryList(req.query, "kind", ALERT_KINDS);
  const severity = queryList(req.query, "severity", ALERT_SEVERITIES);
  const search = queryString(req.query, "search");
  res.json({
    data: await compliance.listAlerts({
      limit: queryLimit(req.query, 50, 100),
      ...(status && { status }),
      ...(kind && { kind }),
      ...(severity && { severity }),
      ...(assignee && { assignee }),
      ...(search && { search }),
      ...(cursor && { cursor }),
    }),
  });
}

export async function getOne(req: Request<AlertParams>, res: Response) {
  res.json({ data: await compliance.getAlert(alertId(req)) });
}

export async function assignees(_req: Request, res: Response) {
  res.json({ data: await compliance.listAssignees() });
}

/** One staff action on an alert: `{ type, note?, assigneeId? }`. */
export async function act(req: Request<AlertParams>, res: Response) {
  const body = asBody(req.body);
  const type = oneOf(body, "type", ACTIONS)!;
  let action: AlertAction;
  if (type === "assign") {
    const raw = body["assigneeId"];
    if (raw !== null && (typeof raw !== "string" || !isUuid(raw))) throw HttpError.badRequest("assigneeId must be a staff id or null");
    action = { type, assigneeId: raw };
  } else if (type === "resolve" || type === "dismiss" || type === "note") {
    // A closed alert has to say why; that note is the compliance record.
    action = { type, note: requiredString(body, "note", { maxLength: 500 }) };
  } else if (type === "reopen") {
    const note = optionalString(body, "note", { maxLength: 500 });
    action = { type, ...(note && { note }) };
  } else {
    action = { type };
  }
  res.json({ data: await compliance.actOnAlert(alertId(req), action, staffPrincipal(req)) });
}

export async function scan(_req: Request, res: Response) {
  res.json({ data: await compliance.runComplianceScan() });
}
