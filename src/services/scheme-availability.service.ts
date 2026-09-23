// Whether a scheme can be transacted in *right now*, according to FP.
//
// The catalogue in our database is a mirror: seeded from a snapshot and, until
// this module, never refreshed. A fund the AMC closes stays "active,
// purchasable" here indefinitely. The app then lists it, the investor fills in
// an amount, and only the order call finds out — the sandbox's
// "ICICI Prudential FMCG Fund – IDCW Payout" is exactly that: FP reports every
// flag false, our copy said open, and it sorted first in the fund list.
//
// So every live read is also written back. That is within the mirror rule: the
// flags change only because FP said so, in an API response.
//
// A `true` from FP is a hint, not a promise (see CLAUDE.md — a scheme can say
// `sip_allowed` and still be refused), so this only ever *refuses* on what FP
// reports as closed. It never approves something the thresholds refuse.
import { db } from "../db/client.ts";
import { fpCatalogue, fpErrorToHttpError } from "../integrations/fp/index.ts";
import type { FpFundScheme } from "../integrations/fp/resources/catalogue.ts";
import { HttpError } from "../utils/http-error.ts";

/** A capability FP publishes per scheme, in our vocabulary. */
export type SchemeCapability = "purchase" | "sip" | "redemption" | "switch_out" | "switch_in";

const CAPABILITY_FIELD: Record<SchemeCapability, keyof FpFundScheme> = {
  purchase: "purchase_allowed",
  sip: "sip_allowed",
  redemption: "redemption_allowed",
  switch_out: "switch_out_allowed",
  switch_in: "switch_in_allowed",
};

const CAPABILITY_REFUSAL: Record<SchemeCapability, string> = {
  purchase: "is not open for purchases at the fund house right now",
  sip: "is not accepting new SIPs at the fund house right now",
  redemption: "is not open for redemptions at the fund house right now",
  switch_out: "does not allow switching out at the fund house right now",
  switch_in: "does not accept switch-ins at the fund house right now",
};

/** Write FP's current flags onto our row. Unknown ISINs are ignored. */
export async function applyLiveFlags(isin: string, live: FpFundScheme): Promise<void> {
  await db.mfScheme.updateMany({
    where: { isin },
    data: {
      isActive: live.active,
      purchaseAllowed: live.purchase_allowed,
      redemptionAllowed: live.redemption_allowed,
      sipAllowed: live.sip_allowed,
      switchInAllowed: live.switch_in_allowed,
      switchOutAllowed: live.switch_out_allowed,
      swpAllowed: live.swp_allowed,
      stpInAllowed: live.stp_in_allowed,
      stpOutAllowed: live.stp_out_allowed,
      merged: live.merged,
      mergedToIsin: live.merged_to_isin || null,
      syncedAt: new Date(),
    },
  });
}

/**
 * Refuse, in the investor's words, a scheme FP reports as closed for this.
 *
 * Asks FP (not the mirror) and records the answer, so the fund list stops
 * offering a closed fund the moment anyone tries it. An FP outage is an
 * upstream error, never a silent pass: placing an order on a fund we could not
 * check is how the investor ended up at FP's refusal in the first place.
 */
export async function assertLiveCapability(
  isin: string,
  capability: SchemeCapability,
): Promise<void> {
  let live: FpFundScheme;
  try {
    live = await fpCatalogue.fetchFundScheme(isin);
  } catch (error) {
    fpErrorToHttpError(error);
  }
  await applyLiveFlags(isin, live);

  const name = live.name || isin;
  if (live.merged) {
    throw HttpError.badRequest(
      `${name} has merged into ${live.merged_to_isin || "another scheme"}. Choose that scheme instead.`,
      { isin, mergedToIsin: live.merged_to_isin || null, schemeUnavailable: true },
    );
  }
  if (!live.active) {
    throw HttpError.badRequest(
      `${name} is no longer available at the fund house. Choose another scheme.`,
      { isin, schemeUnavailable: true },
    );
  }
  if (!live[CAPABILITY_FIELD[capability]]) {
    throw HttpError.badRequest(`${name} ${CAPABILITY_REFUSAL[capability]}. Choose another scheme.`, {
      isin,
      capability,
      schemeUnavailable: true,
    });
  }
}

/** How old a scheme's flags may be before a detail read re-checks them. */
const DETAIL_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Re-read a scheme's flags when the investor opens it and ours are stale.
 *
 * The fund screen is where the investor decides to invest, so it is where the
 * flags must be right. Best-effort: on any FP failure the mirror is served, and
 * the order-time check (`assertLiveCapability`) remains the gate.
 */
export async function refreshIfStale(isin: string, syncedAt: Date): Promise<boolean> {
  if (Date.now() - syncedAt.getTime() < DETAIL_MAX_AGE_MS) return false;
  try {
    await applyLiveFlags(isin, await fpCatalogue.fetchFundScheme(isin));
    return true;
  } catch (error) {
    console.warn(
      `[schemes] could not refresh ${isin}; serving the stored flags:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** A full catalogue pass is spread over ticks; each scheme is re-read this often. */
const CATALOGUE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Keep the whole catalogue's flags current, a few schemes per tick.
 *
 * Covers the schemes nobody has opened: the fund list filters on `isActive`
 * and `merged`, so a fund closed at the AMC must drop out of it even if no
 * investor ever tries it. Least recently checked first, bounded per call so
 * the background loop stays inside FP's rate limit. Inactive schemes are
 * included: a fund can reopen.
 */
export async function refreshCatalogueFlags(limit = 10): Promise<{ checked: number; failed: number }> {
  const rows = await db.mfScheme.findMany({
    where: { syncedAt: { lt: new Date(Date.now() - CATALOGUE_MAX_AGE_MS) } },
    orderBy: { syncedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 50),
    select: { isin: true },
  });
  const result = { checked: 0, failed: 0 };
  for (const row of rows) {
    result.checked++;
    try {
      await applyLiveFlags(row.isin, await fpCatalogue.fetchFundScheme(row.isin));
    } catch (error) {
      result.failed++;
      // Pushed to the back of the queue so one bad ISIN cannot stall the pass.
      await db.mfScheme.updateMany({ where: { isin: row.isin }, data: { syncedAt: new Date() } });
      console.warn(`[schemes] ${row.isin} could not be refreshed:`, error instanceof Error ? error.message : error);
    }
  }
  return result;
}
