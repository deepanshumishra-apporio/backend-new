// Keeps `investor_journey_snapshots` — the admin portal's read model — in step
// with the investor journey.
//
// Every tick:
//   1. take the lease (one row in `projection_checkpoints`), so of several API
//      instances exactly one does the work;
//   2. find the users whose rows changed since the watermark, across every
//      table `investorFacts` reads, and re-derive just those;
//   3. once a day, or when there is no watermark yet, re-derive everyone in
//      keyset batches, which also removes rows for deleted users.
//
// Re-deriving is an upsert of `investorFacts`, so it is idempotent: running a
// batch twice, or two instances overlapping after a lease expires, changes
// nothing. The watermark is read back with an overlap, because `updatedAt` is
// stamped by the app's clock and the watermark by the database's.
//
// Its own loop, apart from the money sweeps in background-jobs.service.ts: a
// slow projection must never delay an SIP debit or an allotment.
import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { investorFacts } from "./investor-facts.service.ts";

const NAME = "investor_journey_snapshots";
const DEFAULT_INTERVAL_MS = 60_000;
const BATCH = 1_000;
const LEASE_MS = 5 * 60_000;
const OVERLAP = Prisma.sql`interval '2 minutes'`;
const FULL_REFRESH_EVERY_MS = 24 * 60 * 60_000;
const holder = `${process.pid}-${randomUUID().slice(0, 8)}`;

export interface ProjectionRun {
  mode: "incremental" | "full" | "skipped";
  refreshed: number;
  removed: number;
}

/** Upsert the snapshot rows for these users (or, with no ids, for one keyset batch after `afterId`). */
function upsertSql(userWhere: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO investor_journey_snapshots (
      "userId", name, email, phone, pan, "userStatus", stage, "kycStatus", "kycVia",
      "kycFormStatus", "kycProofStatus", "kycSignatureProvided", "kycFieldsNeeded", "kycMovedAt", "kycCompletedAt",
      "hasProfile", "hasAccount", purchases, "investedAmount", "currentValue", "activeSips", "sipMonthlyAmount", "nextSipDate",
      "signedUpAt", "lastLoginAt", "lastActivityAt", "refreshedAt"
    )
    SELECT
      f.id, COALESCE(f.profile_name, f."fullName"), f.email, f.phone, upper(f.pan), f.status, f.stage, f.kyc_status, f.kyc_via,
      f.kf_status, f.kf_proof_status, f.kf_signature, COALESCE(f.kf_fields_needed, '{}'), f.kf_moved_at, f.kyc_completed_at,
      f.profile_id IS NOT NULL, f.account_id IS NOT NULL, f.purchases::int, f.purchased_amount,
      f.current_value, f.active_sips::int, round(f.sip_monthly, 2), f.next_sip_date,
      f."createdAt", f."lastLoginAt", f.last_activity_at, now()
    FROM (${investorFacts(userWhere)}) f
    ON CONFLICT ("userId") DO UPDATE SET
      name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone, pan = EXCLUDED.pan,
      "userStatus" = EXCLUDED."userStatus", stage = EXCLUDED.stage, "kycStatus" = EXCLUDED."kycStatus",
      "kycVia" = EXCLUDED."kycVia", "kycFormStatus" = EXCLUDED."kycFormStatus",
      "kycProofStatus" = EXCLUDED."kycProofStatus", "kycSignatureProvided" = EXCLUDED."kycSignatureProvided",
      "kycFieldsNeeded" = EXCLUDED."kycFieldsNeeded", "kycMovedAt" = EXCLUDED."kycMovedAt",
      "kycCompletedAt" = EXCLUDED."kycCompletedAt", "hasProfile" = EXCLUDED."hasProfile",
      "hasAccount" = EXCLUDED."hasAccount", purchases = EXCLUDED.purchases,
      "investedAmount" = EXCLUDED."investedAmount", "currentValue" = EXCLUDED."currentValue",
      "activeSips" = EXCLUDED."activeSips", "sipMonthlyAmount" = EXCLUDED."sipMonthlyAmount",
      "nextSipDate" = EXCLUDED."nextSipDate", "signedUpAt" = EXCLUDED."signedUpAt",
      "lastLoginAt" = EXCLUDED."lastLoginAt", "lastActivityAt" = EXCLUDED."lastActivityAt",
      "refreshedAt" = EXCLUDED."refreshedAt"`;
}

/** Re-derive these users, and drop the rows of any that are no longer live investors. */
export async function refreshInvestors(userIds: string[]): Promise<{ refreshed: number; removed: number }> {
  let refreshed = 0;
  let removed = 0;
  for (let i = 0; i < userIds.length; i += BATCH) {
    const ids = userIds.slice(i, i + BATCH);
    refreshed += await db.$executeRaw(upsertSql(Prisma.sql`AND u.id = ANY(${ids}::uuid[])`));
    removed += await db.$executeRaw`
      DELETE FROM investor_journey_snapshots s
      WHERE s."userId" = ANY(${ids}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s."userId" AND u.role = 'INVESTOR' AND u."deletedAt" IS NULL)`;
  }
  return { refreshed, removed };
}

/** Every user touched since `since`, through any table the stage depends on. */
async function changedUserIds(since: Date): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH w AS (SELECT ${since}::timestamptz - ${OVERLAP} AS t),
    link AS (SELECT "userId", "investorProfileId" FROM user_investor_profiles),
    accounts AS (SELECT a.id, l."userId" FROM mf_investment_accounts a JOIN link l ON l."investorProfileId" = a."primaryInvestorProfileId")
    SELECT id FROM users, w WHERE "updatedAt" > w.t
    UNION SELECT "userId" FROM kyc_forms, w WHERE "updatedAt" > w.t AND "userId" IS NOT NULL
    UNION SELECT "userId" FROM pre_verifications, w WHERE "updatedAt" > w.t AND "userId" IS NOT NULL
    UNION SELECT l."userId" FROM pre_verifications p JOIN link l ON l."investorProfileId" = p."investorProfileId", w WHERE p."updatedAt" > w.t
    UNION SELECT "userId" FROM user_investor_profiles, w WHERE "updatedAt" > w.t
    UNION SELECT l."userId" FROM investor_onboardings o JOIN link l ON l."investorProfileId" = o."investorProfileId", w WHERE o."updatedAt" > w.t
    UNION SELECT l."userId" FROM investor_profiles ip JOIN link l ON l."investorProfileId" = ip.id, w WHERE ip."updatedAt" > w.t
    UNION SELECT l."userId" FROM mf_investment_accounts a JOIN link l ON l."investorProfileId" = a."primaryInvestorProfileId", w WHERE a."updatedAt" > w.t
    UNION SELECT l."userId" FROM bank_accounts b JOIN link l ON l."investorProfileId" = b."investorProfileId", w WHERE b."updatedAt" > w.t
    UNION SELECT ac."userId" FROM mf_folio_defaults fd JOIN accounts ac ON ac.id = fd."mfInvestmentAccountId", w WHERE fd."updatedAt" > w.t
    UNION SELECT ac."userId" FROM mf_purchases m JOIN accounts ac ON ac.id = m."mfInvestmentAccountId", w WHERE m."updatedAt" > w.t
    UNION SELECT ac."userId" FROM mf_purchase_plans p JOIN accounts ac ON ac.id = p."mfInvestmentAccountId", w WHERE p."updatedAt" > w.t
    UNION SELECT ac."userId" FROM mf_holdings h JOIN accounts ac ON ac.id = h."mfInvestmentAccountId", w WHERE h."updatedAt" > w.t`;
  return rows.map((row) => row.id);
}

/** Everyone, in keyset batches so a large table never becomes one giant statement. */
async function refreshAll(): Promise<{ refreshed: number; removed: number }> {
  let refreshed = 0;
  let afterId: string | null = null;
  for (;;) {
    const page: { id: string }[] = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM users
      WHERE role = 'INVESTOR' AND "deletedAt" IS NULL ${afterId ? Prisma.sql`AND id > ${afterId}::uuid` : Prisma.empty}
      ORDER BY id LIMIT ${BATCH}`;
    if (page.length === 0) break;
    refreshed += (await refreshInvestors(page.map((row) => row.id))).refreshed;
    afterId = page[page.length - 1]!.id;
  }
  const removed = await db.$executeRaw`
    DELETE FROM investor_journey_snapshots s
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s."userId" AND u.role = 'INVESTOR' AND u."deletedAt" IS NULL)`;
  return { refreshed, removed };
}

/** Take the lease; returns the checkpoint when this instance now holds it. */
async function acquireLease(): Promise<{ watermark: Date | null; lastFullAt: Date | null } | null> {
  await db.$executeRaw`
    INSERT INTO projection_checkpoints (name, "updatedAt") VALUES (${NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  const rows = await db.$queryRaw<{ watermark: Date | null; lastFullAt: Date | null }[]>`
    UPDATE projection_checkpoints
    SET "leaseUntil" = now() + make_interval(secs => ${LEASE_MS / 1000}), "leaseHolder" = ${holder}, "updatedAt" = now()
    WHERE name = ${NAME} AND ("leaseUntil" IS NULL OR "leaseUntil" < now() OR "leaseHolder" = ${holder})
    RETURNING watermark, "lastFullAt"`;
  return rows[0] ?? null;
}

/** One pass. Exported for tests and for an operator to run by hand. */
export async function runProjection(options: { forceFull?: boolean } = {}): Promise<ProjectionRun> {
  const checkpoint = await acquireLease();
  if (!checkpoint) return { mode: "skipped", refreshed: 0, removed: 0 };

  // Taken before reading changes, so anything committed during the run is
  // after the new watermark and picked up next time.
  const [{ now }] = (await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`) as [{ now: Date }];
  const full =
    options.forceFull ||
    !checkpoint.watermark ||
    !checkpoint.lastFullAt ||
    now.getTime() - checkpoint.lastFullAt.getTime() > FULL_REFRESH_EVERY_MS;

  try {
    const result = full ? await refreshAll() : await refreshInvestors(await changedUserIds(checkpoint.watermark!));
    await db.$executeRaw`
      UPDATE projection_checkpoints
      SET watermark = ${now}, "lastFullAt" = ${full ? now : checkpoint.lastFullAt}, "leaseUntil" = NULL, "leaseHolder" = NULL, "updatedAt" = now()
      WHERE name = ${NAME} AND "leaseHolder" = ${holder}`;
    return { mode: full ? "full" : "incremental", ...result };
  } catch (error) {
    // Release without moving the watermark: the same changes are retried next tick.
    await db.$executeRaw`
      UPDATE projection_checkpoints SET "leaseUntil" = NULL, "leaseHolder" = NULL, "updatedAt" = now()
      WHERE name = ${NAME} AND "leaseHolder" = ${holder}`.catch(() => undefined);
    throw error;
  }
}

/** When the read model was last brought up to date, or null if it never has been. */
export async function projectionFreshness(): Promise<{ refreshedAt: Date | null; lastFullAt: Date | null }> {
  const row = await db.projectionCheckpoint.findUnique({
    where: { name: NAME },
    select: { watermark: true, lastFullAt: true },
  });
  return { refreshedAt: row?.watermark ?? null, lastFullAt: row?.lastFullAt ?? null };
}

// --- the loop -------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | undefined;
let stopped = true;

/** `ADMIN_PROJECTION_INTERVAL_MS`; 0 turns the loop off. */
function intervalMs(): number {
  const raw = process.env["ADMIN_PROJECTION_INTERVAL_MS"]?.trim();
  if (!raw) return DEFAULT_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ADMIN_PROJECTION_INTERVAL_MS must be a non-negative integer (got "${raw}")`);
  }
  return value;
}

async function tick(): Promise<void> {
  try {
    const run = await runProjection();
    if (run.mode === "full" || run.refreshed > 0 || run.removed > 0) {
      console.log(`[admin-projection] ${run.mode}: refreshed=${run.refreshed} removed=${run.removed}`);
    }
  } catch (error) {
    // Stale admin numbers are acceptable for a tick; a crashed loop is not.
    console.error("[admin-projection] tick failed:", error instanceof Error ? error.message : error);
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

/** Start the loop, running the first pass straight away. Returns false when disabled. */
export function startAdminProjection(): boolean {
  const delay = intervalMs();
  if (delay === 0 || !stopped) return false;
  stopped = false;
  running = tick().finally(() => {
    running = undefined;
    schedule(delay);
  });
  return true;
}

export async function stopAdminProjection(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
  await running;
}
