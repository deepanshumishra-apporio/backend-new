// The market calendar: which NAV date an order placed at a given moment gets.
// Offline: the holiday table is a stub holding real 2026 NSE MF holidays.
import { describe, expect, mock, test } from "bun:test";

const holidays: Record<string, string> = {
  "2026-09-14": "Ganesh Chaturthi",
  "2026-10-02": "Mahatma Gandhi Jayanti",
  "2026-11-10": "Diwali-Balipratipada",
};
const raised: { userId: string; dedupeKey: string; title: string }[] = [];

mock.module("../src/db/client.ts", () => ({ db: {
  marketHoliday: {
    findMany: async () => Object.entries(holidays).map(([date, name]) => ({ date: new Date(`${date}T00:00:00Z`), name })),
  },
  userInvestorProfile: { findMany: async () => [{ userId: "u1" }, { userId: "u2" }] },
} }));
mock.module("../src/services/notification.service.ts", () => ({
  notify: async (input: { userId: string; dedupeKey: string; title: string }) => {
    raised.push(input);
  },
}));

const { announceHoliday, getMarketStatus } = await import("../src/services/market.service.ts");
/** An instant in India time. */
const ist = (local: string) => new Date(`${local}+05:30`);

describe("which NAV an order placed now gets", () => {
  test("on a holiday: closed, and the next business day's NAV", async () => {
    const s = await getMarketStatus(ist("2026-09-14T10:00:00"));
    expect(s).toMatchObject({ open: false, reason: "holiday", navDate: "2026-09-15" });
    expect(s.holiday?.name).toBe("Ganesh Chaturthi");
  });
  test("a Friday holiday rolls over the weekend to Monday", async () => {
    expect((await getMarketStatus(ist("2026-10-02T11:00:00"))).navDate).toBe("2026-10-05");
  });
  test("a weekend is closed but is not a holiday", async () => {
    const s = await getMarketStatus(ist("2026-09-27T12:00:00"));
    expect(s).toMatchObject({ open: false, reason: "weekend", holiday: null, navDate: "2026-09-28" });
  });
  test("the 3 PM cut-off moves a business day's order to the next NAV — past any holiday", async () => {
    expect((await getMarketStatus(ist("2026-09-29T14:59:00"))).navDate).toBe("2026-09-29");
    expect((await getMarketStatus(ist("2026-09-29T15:00:00"))).navDate).toBe("2026-09-30");
    expect((await getMarketStatus(ist("2026-11-09T16:00:00"))).navDate).toBe("2026-11-11");
  });
});

describe("holiday announcements", () => {
  test("the day before, every investor hears it once per holiday", async () => {
    raised.length = 0;
    expect(await announceHoliday(ist("2026-09-13T09:00:00"))).toBe(2);
    expect(raised.map((r) => r.dedupeKey)).toEqual(["market:2026-09-14", "market:2026-09-14"]);
    expect(raised[0]!.title).toBe("Market holiday: Ganesh Chaturthi");
  });
  test("an ordinary day announces nothing", async () => {
    raised.length = 0;
    expect(await announceHoliday(ist("2026-09-22T09:00:00"))).toBe(0);
  });
});
