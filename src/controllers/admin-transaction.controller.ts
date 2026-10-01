import type { Request, Response } from "express";
import { staffPrincipal } from "../middleware/staff-auth.ts";
import * as transactions from "../services/admin-transaction.service.ts";
import { ORDER_FLAGS, ORDER_STATES, ORDER_TYPES } from "../types/admin-transaction.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { isUuid, queryBoolean, queryCursor, queryDate, queryLimit, queryList, queryString } from "../utils/query.ts";

export async function summary(_req: Request, res: Response) {
  res.json({ data: await transactions.getSummary() });
}

export async function list(req: Request, res: Response) {
  const from = queryDate(req.query, "from");
  const to = queryDate(req.query, "to");
  if (from && to && from > to) throw HttpError.badRequest("from must be on or before to");
  const type = queryList(req.query, "type", ORDER_TYPES);
  const state = queryList(req.query, "state", ORDER_STATES);
  const flag = queryList(req.query, "flag", ORDER_FLAGS);
  const attention = queryBoolean(req.query, "attention");
  const search = queryString(req.query, "search");
  const cursor = queryCursor(req.query);
  res.json({
    data: await transactions.listTransactions({
      limit: queryLimit(req.query, 50, 100),
      ...(type && { type }),
      ...(state && { state }),
      ...(flag && { flag }),
      ...(attention && { attention }),
      ...(from && { from }),
      ...(to && { to }),
      ...(search && { search }),
      ...(cursor && { cursor }),
    }),
  });
}

export async function getOne(req: Request<{ orderId: string }>, res: Response) {
  if (!isUuid(req.params.orderId)) throw HttpError.notFound("No order with that id");
  res.json({ data: await transactions.getTransaction(req.params.orderId) });
}

export async function refresh(req: Request<{ orderId: string }>, res: Response) {
  if (!isUuid(req.params.orderId)) throw HttpError.notFound("No order with that id");
  res.json({ data: await transactions.refreshTransaction(req.params.orderId, staffPrincipal(req)) });
}
