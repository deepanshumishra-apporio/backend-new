// Contracts for compliance alerts: conditions the scan raised, and what staff did about them.
import type { TicketInvestorDto, StaffRefDto } from "./support.types.ts";

export const ALERT_KINDS = [
  "KYC_STALLED", "KYC_FAILED", "SIP_FAILURES", "MANDATE_REJECTED", "MANDATE_PENDING",
  "PAID_NOT_ALLOTTED", "ORDER_STUCK", "NOMINEE_MISSING",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ["HIGH", "MEDIUM", "LOW"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export type AlertEntityType = "order" | "plan" | "mandate" | "account";

/** One condition a detector found in this scan. */
export interface Detection {
  kind: AlertKind;
  severity: AlertSeverity;
  dedupeKey: string;
  userId: string | null;
  entityType: AlertEntityType | null;
  entityId: string | null;
  title: string;
  detail: string;
}

export interface AlertListItemDto {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  detail: string;
  investor: TicketInvestorDto | null;
  entity: { type: AlertEntityType; id: string } | null;
  assignee: StaffRefDto | null;
  firstDetectedAt: string;
  lastDetectedAt: string;
  ageDays: number;
  resolvedAt: string | null;
  autoResolved: boolean;
}

export interface AlertEventDto {
  id: string;
  type: string;
  staffName: string | null;
  note: string | null;
  createdAt: string;
}

export interface AlertDetailDto extends AlertListItemDto {
  resolution: string | null;
  resolvedBy: StaffRefDto | null;
  lastRemindedAt: string | null;
  /** Whether "Remind investor" has something to say for this kind of alert. */
  canRemind: boolean;
  events: AlertEventDto[];
}

export interface AlertSummaryDto {
  open: number;
  high: number;
  ageingOver7Days: number;
  unassigned: number;
  byKind: { key: AlertKind; label: string; count: number }[];
  resolvedLast30Days: number;
  /** Median hours from first detection to resolution, last 30 days; null with nothing resolved. */
  medianHoursToClose: number | null;
  lastScanAt: string | null;
}

export interface AlertListDto {
  items: AlertListItemDto[];
  nextCursor: string | null;
  summary: AlertSummaryDto;
}

export interface AlertListQuery {
  limit: number;
  status?: AlertStatus[];
  kind?: AlertKind[];
  severity?: AlertSeverity[];
  /** A staff id, or "unassigned". */
  assignee?: string;
  search?: string;
  cursor?: string;
}

export type AlertAction =
  | { type: "acknowledge" }
  | { type: "assign"; assigneeId: string | null }
  | { type: "resolve"; note: string }
  | { type: "dismiss"; note: string }
  | { type: "reopen"; note?: string }
  | { type: "note"; note: string }
  | { type: "remind" };

export interface ScanResultDto {
  mode: "ran" | "skipped";
  detected: number;
  raised: number;
  reopened: number;
  autoResolved: number;
  at: string;
}
