// Contracts for the admin portal's reports: a fixed catalogue of tabular
// extracts, each previewable on screen and exportable as CSV.

export const REPORT_KEYS = ["investors", "kyc", "transactions", "plans", "payments", "aum", "compliance"] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/** How a column's values are typed, so a screen and a spreadsheet format them alike. */
export type ReportColumnKind = "text" | "money" | "units" | "count" | "date" | "datetime";

export interface ReportColumnDto {
  key: string;
  label: string;
  kind: ReportColumnKind;
}

/** Money and units leave as decimal strings, dates as ISO strings. */
export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;

export interface ReportOptionDto {
  value: string;
  label: string;
}

export interface ReportDefinitionDto {
  key: ReportKey;
  name: string;
  description: string;
  /** What the date range filters on, e.g. "Signed up"; null when the report is a point-in-time view. */
  dateField: string | null;
  /** Label of the report's one status-like filter; null when it has none. */
  statusLabel: string | null;
  statuses: ReportOptionDto[];
  columns: ReportColumnDto[];
}

/** Validated by the controller: India-local dates (inclusive) and a status from the report's own list. */
export interface ReportFilters {
  from?: string;
  to?: string;
  status?: string;
}

export interface ReportResultDto {
  report: ReportKey;
  name: string;
  columns: ReportColumnDto[];
  rows: ReportRow[];
  /** Every row the filters match, not only those returned. */
  total: number;
  limit: number;
  truncated: boolean;
  filters: ReportFilters;
  generatedAt: string;
}
