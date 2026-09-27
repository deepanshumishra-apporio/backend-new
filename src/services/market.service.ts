// When orders are processed: the market calendar, and what it means for an
// order placed right now.
//
// A mutual fund business day is a weekday that is not an exchange holiday
// (NSE's MF segment list, in `market_holidays`). On any other day the market
// is shut, NAVs do not move, and an order waits for the next business day's
// NAV. The 3 PM cut-off does the same on a business day: after it, the order
// gets the next business day's NAV. (Liquid and overnight funds cut off at
// 1:30 PM; the screens say "usually", not a promise.)
import { db } from "../db/client.ts";
import { fetchMfHolidays } from "../integrations/nse/nse.client.ts";
import { notify } from "./notification.service.ts";
import type { MarketStatusDto } from "../types/market.types.ts";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
/** The usual cut-off for an order to get the same day's NAV, IST. */
const CUTOFF_MINUTES = 15 * 60;

/** Today's date and minute of day in India, whatever the server's timezone. */
function istNow(now: Date) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return { date: shifted.toISOString().slice(0, 10), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

const addDays = (iso: string, days: number) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const isWeekend = (iso: string) => [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());

/** Holidays from `from` for the next few weeks, by date. */
async function holidaysFrom(from: string): Promise<Map<string, string>> {
  const rows = await db.marketHoliday.findMany({
    where: { date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${addDays(from, 60)}T00:00:00Z`) } },
    select: { date: true, name: true },
    orderBy: { date: "asc" },
  });
  return new Map(rows.map((row) => [row.date.toISOString().slice(0, 10), row.name]));
}

/** The first business day strictly after `iso`. */
export function nextBusinessDay(iso: string, holidays: Map<string, string>): string {
  let day = addDays(iso, 1);
  for (let guard = 0; guard < 30 && (isWeekend(day) || holidays.has(day)); guard++) day = addDays(day, 1);
  return day;
}

/**
 * Is the market open today, and at which date's NAV would an order placed now
 * be processed?
 */
export async function getMarketStatus(now = new Date()): Promise<MarketStatusDto> {
  const { date: today, minutes } = istNow(now);
  const holidays = await holidaysFrom(today);
  const holidayName = holidays.get(today) ?? null;
  const weekend = isWeekend(today);
  const open = !weekend && holidayName === null;
  const next = nextBusinessDay(today, holidays);
  const afterCutoff = open && minutes >= CUTOFF_MINUTES;
  const upcoming = [...holidays.entries()].find(([date]) => date > today && !isWeekend(date));
  return {
    today,
    open,
    reason: holidayName ? "holiday" : weekend ? "weekend" : null,
    holiday: holidayName ? { date: today, name: holidayName } : null,
    afterCutoff,
    navDate: open && !afterCutoff ? today : next,
    nextBusinessDay: next,
    upcomingHoliday: upcoming ? { date: upcoming[0], name: upcoming[1] } : null,
  };
}

// ---------------------------------------------------------------------------
// Keeping the calendar
// ---------------------------------------------------------------------------

/** Write holidays in, idempotently. A name NSE changes is updated. */
export async function saveHolidays(holidays: { date: string; name: string }[]): Promise<number> {
  for (const holiday of holidays) {
    const date = new Date(`${holiday.date}T00:00:00Z`);
    await db.marketHoliday.upsert({ where: { date }, create: { date, name: holiday.name }, update: { name: holiday.name } });
  }
  return holidays.length;
}

/** Refresh from NSE. The committed snapshot covers us if NSE is unreachable. */
export async function importHolidaysFromNse(): Promise<number> {
  return saveHolidays(await fetchMfHolidays());
}

let lastCalendarRun = 0;
let lastNoticeRun = 0;

/**
 * The background loop's part: refresh the calendar weekly (NSE publishes next
 * year's list in December), and on the day before and the day of a holiday
 * tell every investor, once per holiday.
 */
export async function runMarketCalendarJobs(now = new Date()): Promise<{ refreshed: number | null; notified: number }> {
  let refreshed: number | null = null;
  if (now.getTime() - lastCalendarRun > 7 * DAY_MS) {
    lastCalendarRun = now.getTime();
    refreshed = await importHolidaysFromNse().catch((error: unknown) => {
      console.warn("[market] NSE holiday refresh failed:", error instanceof Error ? error.message : error);
      return null;
    });
  }
  let notified = 0;
  if (now.getTime() - lastNoticeRun > 60 * 60 * 1000) {
    lastNoticeRun = now.getTime();
    notified = await announceHoliday(now);
  }
  return { refreshed, notified };
}

/** "Market closed today/tomorrow" for every investor, once per holiday. */
export async function announceHoliday(now = new Date()): Promise<number> {
  const { date: today } = istNow(now);
  const tomorrow = addDays(today, 1);
  const holidays = await holidaysFrom(today);
  const date = holidays.has(today) ? today : holidays.has(tomorrow) ? tomorrow : null;
  if (!date || isWeekend(date)) return 0;
  const name = holidays.get(date)!;
  const navDate = nextBusinessDay(date, holidays);
  const when = date === today ? "today" : "tomorrow";
  const pretty = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const users = await db.userInvestorProfile.findMany({
    where: { relationship: "SELF", user: { status: "ACTIVE", deletedAt: null } },
    select: { userId: true },
    distinct: ["userId"],
  });
  for (const { userId } of users) {
    await notify({
      userId,
      category: "MARKET",
      dedupeKey: `market:${date}`,
      title: `Market holiday: ${name}`,
      body: `Markets are closed ${when} (${pretty(date)}). Orders placed then get the ${pretty(navDate)} NAV.`,
    });
  }
  return users.length;
}
