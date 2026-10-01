import type { Request, Response } from "express";
import { staffPrincipal } from "../middleware/staff-auth.ts";
import * as reports from "../services/report.service.ts";
import type { ReportDefinitionDto, ReportFilters } from "../types/report.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { queryDate, queryString } from "../utils/query.ts";

/** The report's filters off the query string, checked against what that report offers. */
function parseFilters(req: Request, report: ReportDefinitionDto): ReportFilters {
  const from = queryDate(req.query, "from");
  const to = queryDate(req.query, "to");
  if ((from || to) && !report.dateField) throw HttpError.badRequest(`${report.name} has no date range`);
  if (from && to && from > to) throw HttpError.badRequest("from must be on or before to");

  const status = queryString(req.query, "status")?.toUpperCase();
  if (status && !report.statuses.some((option) => option.value === status)) {
    throw HttpError.badRequest(`status must be one of: ${report.statuses.map((option) => option.value).join(", ")}`);
  }
  return { ...(from && { from }), ...(to && { to }), ...(status && { status }) };
}

export function list(_req: Request, res: Response) {
  res.json({ data: reports.listReports() });
}

export async function preview(req: Request<{ key: string }>, res: Response) {
  const report = reports.reportDefinition(req.params.key);
  res.json({ data: await reports.previewReport(report.key, parseFilters(req, report)) });
}

export async function exportCsv(req: Request<{ key: string }>, res: Response) {
  const report = reports.reportDefinition(req.params.key);
  const file = await reports.exportReport(report.key, parseFilters(req, report), staffPrincipal(req));
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
