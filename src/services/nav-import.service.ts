// Real NAV history from AMFI, into `nav_history` and each scheme's latest NAV.
//
// The catalogue shipped with a seeded NAV series — synthetic, two months long
// — which made every return and chart a fiction. This replaces it with AMFI's
// official daily NAVs: a backfill once (`bun run nav:import`), then the
// background loop keeps the last few days current.
//
// AMFI's history download is per fund house, keyed by AMFI's own fund-house
// number, which nothing we mirror carries. It is found by asking AMFI for one
// recent day per number and matching the ISINs we hold — robust to AMFI's
// fund-house names never matching FP's ("ICICI Prudential Mutual Fund" vs
// "ICICI PRUDENTIAL ASSET MANAGEMENT COMPANY LTD").
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { fetchHistory, type AmfiNavRow } from "../integrations/amfi/amfi.client.ts";

/** AMFI's fund-house numbers run well under this. */
const FUND_HOUSE_SWEEP = 80;
const DAY_MS = 86_400_000;

export interface NavImportResult {
  schemes: number;
  matched: number;
  points: number;
  fundHouses: number[];
}

/** Fund-house numbers found in this process, by the AMC id they belong to. */
const knownFundHouse = new Map<string, number>();

/** Find AMFI's fund-house number for each AMC we list, by the ISINs it reports. */
async function resolveFundHouses(schemes: { isin: string; amcId: string }[]): Promise<Map<string, number>> {
  const wanted = new Map<string, Set<string>>();
  for (const scheme of schemes) {
    if (knownFundHouse.has(scheme.amcId)) continue;
    wanted.set(scheme.amcId, (wanted.get(scheme.amcId) ?? new Set()).add(scheme.isin));
  }
  if (wanted.size > 0) {
    // A recent week, so a holiday or a slow AMC still reports something.
    const to = new Date();
    const from = new Date(to.getTime() - 7 * DAY_MS);
    for (let code = 1; code <= FUND_HOUSE_SWEEP && wanted.size > 0; code++) {
      const rows = await fetchHistory(code, from, to).catch(() => [] as AmfiNavRow[]);
      if (rows.length === 0) continue;
      const reported = new Set(rows.flatMap((row) => row.isins));
      for (const [amcId, isins] of wanted) {
        if ([...isins].some((isin) => reported.has(isin))) {
          knownFundHouse.set(amcId, code);
          wanted.delete(amcId);
        }
      }
    }
  }
  return knownFundHouse;
}

/**
 * Import the last `days` of NAVs for every active scheme.
 *
 * Idempotent: a date already stored is overwritten with AMFI's value, so a
 * re-run corrects rather than duplicates. Within the imported window, a date
 * AMFI does not report is removed — that is how the seeded synthetic points go.
 */
export async function importNavHistory(days: number): Promise<NavImportResult> {
  const schemes = await db.mfScheme.findMany({
    where: { isActive: true },
    select: { id: true, isin: true, amcId: true },
  });
  const houses = await resolveFundHouses(schemes);
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);
  const result: NavImportResult = { schemes: schemes.length, matched: 0, points: 0, fundHouses: [] };

  const byHouse = new Map<number, typeof schemes>();
  for (const scheme of schemes) {
    const code = houses.get(scheme.amcId);
    if (code === undefined) continue;
    byHouse.set(code, [...(byHouse.get(code) ?? []), scheme]);
  }

  for (const [code, group] of byHouse) {
    result.fundHouses.push(code);
    const rows = await fetchHistory(code, from, to);
    for (const scheme of group) {
      const series = rows.filter((row) => row.isins.includes(scheme.isin)).sort((a, b) => a.date.localeCompare(b.date));
      if (series.length === 0) continue;
      result.matched += 1;
      result.points += series.length;
      const first = new Date(`${series[0]!.date}T00:00:00Z`);
      const last = series[series.length - 1]!;
      await db.$transaction([
        // The window AMFI answered for is AMFI's now; nothing else survives in it.
        db.navHistory.deleteMany({ where: { schemeId: scheme.id, navDate: { gte: first } } }),
        db.navHistory.createMany({
          data: series.map((row) => ({
            schemeId: scheme.id,
            navDate: new Date(`${row.date}T00:00:00Z`),
            nav: new Prisma.Decimal(row.nav),
          })),
          skipDuplicates: true,
        }),
        db.mfScheme.update({
          where: { id: scheme.id },
          data: { latestNav: new Prisma.Decimal(last.nav), latestNavDate: new Date(`${last.date}T00:00:00Z`) },
        }),
      ]);
    }
  }
  return result;
}

let lastRun = 0;

/**
 * The background loop's daily top-up: the last ten days, at most once every
 * twelve hours. Ten, not one, so a missed day or a late AMFI file heals itself.
 */
export async function refreshRecentNavs(now = Date.now()): Promise<NavImportResult | null> {
  if (now - lastRun < 12 * 60 * 60 * 1000) return null;
  lastRun = now;
  return importNavHistory(10);
}
