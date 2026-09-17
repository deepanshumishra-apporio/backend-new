// RTA transactions, and the file operations that produce them.
//
// A transaction is what the registrar reports back after it has processed an
// order: the trade that actually happened, with the NAV it happened at. It is
// the source of holdings — an order says what was asked for, a transaction says
// what the RTA did — which is why an ONDC order can sit at `submitted` for ever
// with no units behind it.
//
// `transaction_simulation` is the sandbox-only half. Nothing on the ONDC route
// can force an allotment (`/api/oms/simulate/orders/:id` answers "ONDC gateway
// orders can't be simulated"), so uploading a reverse-feed CSV is the only way
// to put units on a folio and make a redemption or a switch testable at all.
import { fpList, fpRequest } from "../fp.http.ts";
import { fpConfig } from "../fp.config.ts";

export interface FpTransactionSource {
  days_held: number | null;
  units: number | null;
  purchased_on: string | null;
  purchased_at: number | null;
  gain: number | null;
}

export interface FpTransaction {
  object: "transaction";
  folio_number: string;
  isin: string;
  /** purchase, redemption, switch_in, switch_out, transfer_in/out, dividend_*. */
  type: string;
  amount: number | null;
  units: number | null;
  traded_on: string | null;
  /** The NAV the trade happened at. */
  traded_at: number | null;
  /** Null when the trade did not originate from an FP order. */
  order: string | null;
  corporate_action: string | null;
  related_transaction_id: string | null;
  rta_order_reference: string | null;
  rta_product_code: string | null;
  rta_investment_option: string | null;
  rta_scheme_name: string | null;
  /** Only on a sell leg: the FIFO purchases the units came from. */
  sources: FpTransactionSource[] | null;
}

/**
 * List the trades the registrar has reported.
 *
 * `folios` is mandatory and is a comma-separated set — FP answers
 * `parameter_missing: required request parameter 'folios' ... is not present`
 * without it. There is no by-investment-account form: transactions belong to
 * folios, not to accounts.
 */
export async function listTransactions(
  query: { folios: string[]; isin?: string; from?: string; to?: string },
  requestId?: string,
): Promise<FpTransaction[]> {
  const { folios, ...rest } = query;
  if (folios.length === 0) throw new Error("listTransactions needs at least one folio");
  return fpList<FpTransaction>("/transactions", { ...rest, folios: folios.join(",") }, requestId);
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

export type FpFileOperationType = "transaction_processing" | "transaction_simulation";

export interface FpFileOperation {
  object: "file_operation";
  id: string;
  file: string;
  type: string;
  /** pending, processed or failed. Processing happens in the background. */
  status: string;
  processed: number | null;
  failed: number | null;
  succeeded: number | null;
}

export async function createFileOperation(
  payload: { type: FpFileOperationType; file: string },
  requestId?: string,
): Promise<FpFileOperation> {
  return fpRequest<FpFileOperation>({
    method: "POST",
    path: "/file_operations",
    body: payload,
    // Re-posting would replay every row in the file.
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function fetchFileOperation(
  id: string,
  requestId?: string,
): Promise<FpFileOperation> {
  return fpRequest<FpFileOperation>({
    method: "GET",
    path: `/file_operations/${id}`,
    ...(requestId && { requestId }),
  });
}

// ---------------------------------------------------------------------------
// Transaction simulation (sandbox only)
// ---------------------------------------------------------------------------

/** One row of the simulation CSV. The column order below is FP's. */
export interface SimulatedTransaction {
  folio_number: string;
  isin: string;
  /**
   * Idempotency key, per folio. FP updates the existing transaction when
   * (reference_no, folio_number) repeats, so re-running a file corrects rows
   * rather than duplicating the holding.
   */
  reference_no: string;
  license_code?: string;
  amount: number;
  units: number;
  bucket:
    | "PURCHASE"
    | "REDEMPTION"
    | "TRANSFER_IN"
    | "TRANSFER_OUT"
    | "SWITCH_IN"
    | "SWITCH_OUT"
    | "DIVIDEND_REINVESTMENT"
    | "DIVIDEND_PAYOUT";
  /** yyyy-MM-dd, the date the RTA processed the trade. */
  trade_date: string;
  mf_investment_account: string;
}

const CSV_COLUMNS = [
  "folio_number",
  "isin",
  "reference_no",
  "license_code",
  "amount",
  "units",
  "bucket",
  "trade_date",
  "mf_investment_account",
] as const;

/** Render rows in FP's exact column order. */
export function toSimulationCsv(rows: SimulatedTransaction[]): string {
  const cell = (value: string | number | undefined): string => {
    const text = value === undefined ? "" : String(value);
    // A scheme name or reason could carry a comma; quote defensively.
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => cell(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function assertSandbox(): void {
  if (!fpConfig().simulationEnabled) {
    throw new Error(
      "simulateTransactions is a sandbox-only facility and must never run in production",
    );
  }
}

/**
 * Put transactions on a folio as though the RTA had reported them.
 *
 * Upload, then create the operation, then poll — FP processes the file in the
 * background and a create always answers `pending`. Returns the terminal
 * operation so the caller can see how many rows FP actually accepted;
 * `succeeded` is the only number that means anything, because a malformed row
 * is counted in `failed` and the operation still reports `processed`.
 */
export async function simulateTransactions(
  rows: SimulatedTransaction[],
  uploadFile: (file: Blob, filename: string) => Promise<{ id: string }>,
  requestId?: string,
): Promise<FpFileOperation> {
  assertSandbox();
  if (rows.length === 0) throw new Error("simulateTransactions needs at least one row");

  const csv = toSimulationCsv(rows);
  const uploaded = await uploadFile(
    new Blob([csv], { type: "text/csv" }),
    `transactions-${Date.now()}.csv`,
  );

  let operation = await createFileOperation(
    { type: "transaction_simulation", file: uploaded.id },
    requestId,
  );

  for (let attempt = 0; attempt < 15 && operation.status === "pending"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 800 : 1500));
    operation = await fetchFileOperation(operation.id, requestId);
  }
  return operation;
}
