// AMFI's NAV history text: section lines set the fund house and SEBI category
// for the rows under them; malformed rows are skipped, never guessed at.
import { describe, expect, test } from "bun:test";
import { amfiDate, parseHistory } from "../src/integrations/amfi/amfi.client.ts";

const sample = [
  "Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date",
  "",
  "Open Ended Schemes ( Equity Scheme - Large Cap Fund )",
  "",
  "ICICI Prudential Mutual Fund",
  "152366;ICICI Prudential Nifty50 Value 20 Index Fund - Growth;Regular Plan;Growth;INF109KC19T7;;9.6167;25-Sep-2026",
  "152364;ICICI Prudential Nifty50 Value 20 Index Fund - IDCW;Regular Plan;IDCW;INF109KC10U4;INF109KC11U2;9.6166;25-Sep-2026",
  "152367;Broken row;Regular Plan;Growth;INF109KC19T8;;N.A.;25-Sep-2026",
].join("\n");

describe("AMFI NAV history", () => {
  const rows = parseHistory(sample);
  test("reads each row with its ISINs, NAV and ISO date", () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ schemeCode: "152366", isins: ["INF109KC19T7"], nav: "9.6167", date: "2026-09-25" });
    expect(rows[1]!.isins).toEqual(["INF109KC10U4", "INF109KC11U2"]);
  });
  test("carries the fund house and SEBI category down from the section lines", () => {
    expect(rows[0]!.fundHouse).toBe("ICICI Prudential Mutual Fund");
    expect(rows[0]!.category).toBe("Large Cap Fund");
  });
  test("skips a row whose NAV is not a number", () => {
    expect(rows.some((row) => row.isins.includes("INF109KC19T8"))).toBe(false);
  });
  test("writes dates the way AMFI's query takes them", () => {
    expect(amfiDate(new Date("2026-09-05T00:00:00Z"))).toBe("05-Sep-2026");
  });
});
