// The server's recurring work.
//
// Seven jobs, one loop:
//   - apply pending FP webhook deliveries, which `receive` only records;
//   - collect SIP installments: mirror each live plan's installments and debit
//     its mandate for every unpaid one (FP never debits them itself);
//   - reconcile paid, in-flight purchases, so an allotment (and its folio) is
//     mirrored even when nobody is looking at the order — including one that
//     allots a day or more later;
//   - reconcile in-flight redemptions and switches, and pull redemption payouts;
//   - mirror SWP and STP installments, which FP announces only by webhook;
//   - re-read payments FP has not settled, so a funded order never shows its
//     payment as pending after it has been allotted;
//   - keep the catalogue's capability flags current, so a fund the AMC has
//     closed drops out of the fund list instead of failing at order time;
//   - twice a day, top up the last ten days of NAVs from AMFI;
//   - keep the market holiday calendar, and announce a holiday the day before.
//
// One tick at a time: a tick that outlives the interval makes the next one
// wait instead of overlapping it, so a slow FP never piles up concurrent sweeps.
import {
  collectExitPlanInstallments,
  collectSipInstallments,
  reconcileExits,
  reconcileInFlightPurchases,
  reconcileOpenPayments,
} from "./order-reconciler.service.ts";
import { processPending } from "./fp-webhook.service.ts";
import { refreshCatalogueFlags } from "./scheme-availability.service.ts";
import { refreshRecentNavs } from "./nav-import.service.ts";
import { runMarketCalendarJobs } from "./market.service.ts";

const DEFAULT_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | undefined;
let stopped = true;

/** `ORDER_RECONCILE_INTERVAL_MS`; 0 turns the loop off (tests, one-off scripts). */
function intervalMs(): number {
  const raw = process.env["ORDER_RECONCILE_INTERVAL_MS"]?.trim();
  if (!raw) return DEFAULT_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ORDER_RECONCILE_INTERVAL_MS must be a non-negative integer (got "${raw}")`);
  }
  return value;
}

async function tick(): Promise<void> {
  try {
    // Webhooks first: they are the cheapest signal and may already carry the
    // allotment the sweeps below would otherwise have to fetch.
    const webhooks = await processPending(50);
    const sips = await collectSipInstallments();
    const orders = await reconcileInFlightPurchases();
    const exitPlans = await collectExitPlanInstallments();
    const exits = await reconcileExits();
    const payments = await reconcileOpenPayments();
    const catalogue = await refreshCatalogueFlags();
    // AMFI being slow or down must never hold up the money sweeps above.
    const navs = await refreshRecentNavs().catch((error: unknown) => {
      console.warn("[jobs] NAV refresh failed:", error instanceof Error ? error.message : error);
      return null;
    });
    if (navs) console.log(`[jobs] NAVs refreshed: ${navs.matched}/${navs.schemes} schemes, ${navs.points} points`);
    const market = await runMarketCalendarJobs().catch((error: unknown) => {
      console.warn("[jobs] market calendar failed:", error instanceof Error ? error.message : error);
      return null;
    });
    if (market?.notified) console.log(`[jobs] market holiday announced to ${market.notified} investors`);
    if (orders.checked > 0 || exits.checked > 0 || sips.plans > 0 || exitPlans.plans > 0 || payments.checked > 0 || catalogue.checked > 0 || webhooks.processed > 0 || webhooks.failed > 0) {
      console.log(
        `[jobs] webhooks processed=${webhooks.processed} failed=${webhooks.failed}; ` +
          `sips=${sips.plans} installments=${sips.installmentsSeen} debited=${sips.debited} failed=${sips.failed}; ` +
          `swps/stps=${exitPlans.plans} installments=${exitPlans.installmentsSeen} failed=${exitPlans.failed}; ` +
          `purchases checked=${orders.checked} settled=${orders.settled} failed=${orders.failed}; ` +
          `redemptions/switches checked=${exits.checked} settled=${exits.settled} failed=${exits.failed}; ` +
          `payments checked=${payments.checked} settled=${payments.settled} failed=${payments.failed}; ` +
          `schemes checked=${catalogue.checked} failed=${catalogue.failed}`,
      );
    }
  } catch (error) {
    // The loop must survive a database or FP outage and try again next tick.
    console.error("[jobs] tick failed:", error instanceof Error ? error.message : error);
  }
}

function schedule(delay: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    running = tick().finally(() => {
      running = undefined;
      schedule(delay);
    });
  }, delay);
}

/** Start the loop. Returns false when it is disabled by configuration. */
export function startBackgroundJobs(): boolean {
  const delay = intervalMs();
  if (delay === 0 || !stopped) return false;
  stopped = false;
  schedule(delay);
  return true;
}

/** Stop scheduling and wait for a tick already in progress to finish. */
export async function stopBackgroundJobs(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
  await running;
}
