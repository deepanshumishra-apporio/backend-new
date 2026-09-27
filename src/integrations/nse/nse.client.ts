// NSE's published trading-holiday list — the calendar mutual fund NAVs follow.
//
// SEBI ties MF business days to the exchanges, and NSE publishes a dedicated
// "MF" segment in its holiday master. The API refuses a request that has not
// first loaded an NSE page (it sets the session cookies the API checks), so a
// fetch is two calls. It is an unofficial endpoint behind a website, which is
// why a committed snapshot (`prisma/seed-data/market-holidays.json`) is the
// fallback and this only refreshes it.

const PAGE_URL = "https://www.nseindia.com/resources/exchange-communication-holidays";
const API_URL = "https://www.nseindia.com/api/holiday-master?type=trading";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 30_000;

export interface NseHoliday {
  /** YYYY-MM-DD. */
  date: string;
  name: string;
}

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/** The MF segment of NSE's holiday master; rows it cannot read are dropped. */
export function parseHolidays(payload: unknown): NseHoliday[] {
  const segment = (payload as { MF?: unknown })?.MF;
  if (!Array.isArray(segment)) return [];
  return segment.flatMap((row) => {
    const raw = (row as { tradingDate?: unknown; description?: unknown }) ?? {};
    const match = typeof raw.tradingDate === "string" ? /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(raw.tradingDate) : null;
    const month = match && MONTHS[match[2]!];
    if (!match || !month || typeof raw.description !== "string") return [];
    // NSE marks some names with an asterisk (a Muhurat session note).
    return [{ date: `${match[3]}-${month}-${match[1]}`, name: raw.description.replace(/\*+$/, "").trim().slice(0, 120) }];
  });
}

export async function fetchMfHolidays(): Promise<NseHoliday[]> {
  const page = await fetch(PAGE_URL, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const cookies = page.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const response = await fetch(API_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", Referer: PAGE_URL, Cookie: cookies },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`NSE answered ${response.status}`);
  const holidays = parseHolidays(await response.json());
  if (holidays.length === 0) throw new Error("NSE returned no MF holidays");
  return holidays;
}
