// Every order — purchase, redemption, switch, one-time or plan installment — as
// one row shape, for the admin views that look across all of them (transaction
// monitoring and the transactions report). One definition, so the two can
// never disagree about what an order's amount or state is.
//
// Amounts and units prefer what was actually allotted or redeemed over what
// was asked for; `state` is FP's wire value (`successful`).
import { Prisma } from "../../generated/prisma/client.ts";
import type { OrderType } from "../types/admin-transaction.types.ts";

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  PURCHASE: "Purchase",
  SIP_INSTALLMENT: "SIP installment",
  REDEMPTION: "Redemption",
  SWP_INSTALLMENT: "SWP installment",
  SWITCH: "Switch",
  STP_INSTALLMENT: "STP installment",
};

/**
 * Columns: id, kind (purchase | redemption | switch), type (an `OrderType`),
 * account_id, scheme_isin, scheme, to_scheme, folio, amount, units, state,
 * gateway, placed_at, updated_at, confirmed_at, submitted_at, completed_at,
 * failure_code, failure_reason.
 */
export const orderUnionSql = Prisma.sql`
  SELECT p.id, 'purchase' AS kind,
         CASE WHEN p."planId" IS NULL THEN 'PURCHASE' ELSE 'SIP_INSTALLMENT' END AS type,
         p."mfInvestmentAccountId" AS account_id, p."schemeIsin" AS scheme_isin, s.name AS scheme,
         NULL::text AS to_scheme, p."folioNumber" AS folio,
         COALESCE(p."purchasedAmount", p.amount) AS amount, p."allottedUnits" AS units,
         p.state::text AS state, p.gateway::text AS gateway,
         COALESCE(p."fpCreatedAt", p."createdAt") AS placed_at, p."updatedAt" AS updated_at,
         p."confirmedAt" AS confirmed_at, p."submittedAt" AS submitted_at, p."succeededAt" AS completed_at,
         p."failureCode" AS failure_code, p."failureReason" AS failure_reason
  FROM mf_purchases p JOIN mf_schemes s ON s.isin = p."schemeIsin"
  UNION ALL
  SELECT r.id, 'redemption',
         CASE WHEN r."planId" IS NULL THEN 'REDEMPTION' ELSE 'SWP_INSTALLMENT' END,
         r."mfInvestmentAccountId", r."schemeIsin", s.name, NULL::text, r."folioNumber",
         COALESCE(r."redeemedAmount", r.amount), COALESCE(r."redeemedUnits", r.units),
         r.state::text, r.gateway::text,
         COALESCE(r."fpCreatedAt", r."createdAt"), r."updatedAt",
         r."confirmedAt", r."submittedAt", r."succeededAt", r."failureCode", r."failureReason"
  FROM mf_redemptions r JOIN mf_schemes s ON s.isin = r."schemeIsin"
  UNION ALL
  SELECT w.id, 'switch',
         CASE WHEN w."planId" IS NULL THEN 'SWITCH' ELSE 'STP_INSTALLMENT' END,
         w."mfInvestmentAccountId", w."switchOutSchemeIsin", so.name, si.name, w."folioNumber",
         COALESCE(w."switchedOutAmount", w.amount), COALESCE(w."switchedOutUnits", w.units),
         w.state::text, w.gateway::text,
         COALESCE(w."fpCreatedAt", w."createdAt"), w."updatedAt",
         w."confirmedAt", w."submittedAt", w."succeededAt", w."failureCode", w."failureReason"
  FROM mf_switches w
  JOIN mf_schemes so ON so.isin = w."switchOutSchemeIsin"
  JOIN mf_schemes si ON si.isin = w."switchInSchemeIsin"`;
