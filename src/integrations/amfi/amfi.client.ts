// AMFI's public NAV files — the official daily NAV of every scheme in India.
//
// FP publishes no NAV history (its scheme master carries no NAV at all), so
// returns and charts are built from AMFI's. Two files:
//
//   NAVAll.txt                        today's NAV for every scheme
//   DownloadNAVHistoryReport_Po.aspx  history for one fund house, any range
//
// Both are semicolon-separated text with section lines between the rows:
// the fund house ("ICICI Prudential Mutual Fund") and the SEBI category
// ("Open Ended Schemes ( Equity Scheme - Large Cap Fund )").

const HISTORY_URL = "https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx";
const TIMEOUT_MS = 120_000;

export interface AmfiNavRow {
  /** AMFI's scheme code. */
  schemeCode: string;
  /** Every ISIN the row names — growth / payout, and reinvestment. */
  isins: string[];
  nav: string;
  /** YYYY-MM-DD. */
  date: string;
  /** The SEBI category the row sits under, e.g. "Large Cap Fund". */
  category: string | null;
  /** The fund house the row sits under, e.g. "ICICI Prudential Mutual Fund". */
  fundHouse: string | null;
}

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/** "25-Sep-2026" → "2026-09-25"; null for anything else. */
function isoDate(value: string): string | null {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  const month = match && MONTHS[match[2]!];
  return match && month ? `${match[3]}-${month}-${match[1]}` : null;
}

/** 2026-09-25 → "25-Sep-2026", the form AMFI's query takes. */
export function amfiDate(date: Date): string {
  const month = Object.keys(MONTHS)[date.getUTCMonth()]!;
  return `${String(date.getUTCDate()).padStart(2, "0")}-${month}-${date.getUTCFullYear()}`;
}

/**
 * Parse the history report. Columns: scheme code; name; plan; option; ISIN
 * (growth or payout); ISIN (reinvestment); NAV; date.
 */
export function parseHistory(text: string): AmfiNavRow[] {
  const rows: AmfiNavRow[] = [];
  let category: string | null = null;
  let fundHouse: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.includes(";")) {
      const section = /\(\s*([^)]*?)\s*\)\s*$/.exec(line);
      if (section) category = section[1]!.split(/\s+-\s+/).pop() ?? section[1]!;
      else fundHouse = line;
      continue;
    }
    const cells = line.split(";");
    if (cells.length < 8 || cells[0] === "Scheme Code") continue;
    const date = isoDate(cells[7]!);
    const nav = cells[6]!.trim();
    if (!date || !/^\d+(\.\d+)?$/.test(nav) || Number(nav) <= 0) continue;
    const isins = [cells[4], cells[5]].map((cell) => cell?.trim() ?? "").filter((cell) => /^INF[A-Z0-9]{9}$/.test(cell));
    rows.push({ schemeCode: cells[0]!.trim(), isins, nav, date, category, fundHouse });
  }
  return rows;
}

/** Every NAV one fund house reported between two dates, inclusive. */
export async function fetchHistory(fundHouseCode: number, from: Date, to: Date): Promise<AmfiNavRow[]> {
  const url = `${HISTORY_URL}?mf=${fundHouseCode}&tp=1&frmdt=${amfiDate(from)}&todt=${amfiDate(to)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`AMFI answered ${response.status} for fund house ${fundHouseCode}`);
  return parseHistory(await response.text());
}
