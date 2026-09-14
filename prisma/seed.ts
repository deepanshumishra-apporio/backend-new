// Idempotent seed. Safe to run repeatedly — every write is an upsert keyed on a
// natural unique column, so re-running updates rather than duplicating.
//
// Runs offline. The scheme catalogue comes from
// seed-data/fp-sandbox-catalogue.json, a committed snapshot of the real FP
// sandbox records for the seven test ISINs (regenerate with
// `bun run db:seed:refresh`). Real ids and real thresholds matter here: FP
// rejects an order whose amount misses a multiple, so a seeded scheme with
// invented limits could not be used against the sandbox at all.
//
// NAV is the one invented thing — FP's sandbox serves no NAV history, so the
// series is a deterministic walk that exists purely to make charts render.
//
// What is deliberately NOT seeded: investor profiles, investment accounts,
// folios and orders. Those exist only once FP creates them, and a locally
// invented `fpId` would poison the first sync that tried to reconcile it.
// Create them through the onboarding flow against the sandbox instead.
//
// Run with: bun run db:seed
import { db, disconnectDatabase } from "../src/db/client.ts";
import type { CatalogueSnapshot, SeedScheme } from "./seed-data/catalogue.types.ts";

/** Invented NAV anchors, by ISIN. Only used to give the walk a plausible base. */
const NAV_ANCHORS: Record<string, number> = {
  INF109K01423: 412.8317,
  INF109KC1TY0: 17.4126,
  INF109KC1TV6: 21.0884,
  INF109KC1TU8: 27.6431,
  INF109K01605: 288.1975,
  INF109KC11U2: 14.6208,
  INF109KC19T7: 15.9042,
};

const NAV_DAYS = 60;

/** Deterministic NAV walk, so repeated seeds produce identical history. */
function navSeries(base: number, days: number): { navDate: Date; nav: string }[] {
  const series: { navDate: Date; nav: string }[] = [];
  const today = new Date();
  const midnightUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset--) {
    const date = new Date(midnightUtc - dayOffset * 86_400_000);
    // Skip weekends — NAV is only published on business days.
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    // Smooth deterministic drift, no Math.random so the series is stable.
    const drift = Math.sin(dayOffset / 7) * 0.035 + (days - dayOffset) * 0.0009;
    series.push({ navDate: date, nav: (base * (1 + drift)).toFixed(4) });
  }
  return series;
}

/** Dev accounts. Phone is the credential; email is optional on User. */
const USERS = [
  {
    phone: "+919876543210",
    email: "investor@mutualfund.local",
    fullName: "Asha Investor",
    role: "INVESTOR",
  },
  {
    phone: "+919876500001",
    email: "admin@mutualfund.local",
    fullName: "Platform Admin",
    role: "ADMIN",
  },
] as const;

async function loadSnapshot(): Promise<CatalogueSnapshot> {
  const path = `${import.meta.dir}/seed-data/fp-sandbox-catalogue.json`;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Catalogue snapshot missing at ${path}. Run: bun run db:seed:refresh`);
  }
  return (await file.json()) as CatalogueSnapshot;
}

/**
 * The MfScheme columns that are the same whether we insert or update.
 *
 * Drops the three snapshot fields that are not columns on MfScheme: `isin` is
 * the upsert key, `fpAmcId` resolves to our own `amcId`, and `thresholds` are
 * their own rows. The `void`s keep `noUnusedLocals` quiet about the names that
 * exist only to be excluded from the rest spread.
 */
function schemeColumns(scheme: SeedScheme) {
  const { isin, fpAmcId, thresholds, ...columns } = scheme;
  void isin;
  void fpAmcId;
  void thresholds;
  return columns;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    // Seed data includes fictional investor accounts and invented NAVs.
    // Loading it into production would put fake data in a financial system.
    throw new Error("Refusing to seed with NODE_ENV=production");
  }

  const snapshot = await loadSnapshot();
  console.log(`[seed] catalogue snapshot from ${snapshot.source}, captured ${snapshot.capturedAt}`);

  // --- AMCs ----------------------------------------------------------------
  const amcIdByFpId = new Map<number, string>();
  for (const amc of snapshot.amcs) {
    const row = await db.mfAmc.upsert({
      where: { fpAmcId: amc.fpAmcId },
      update: { name: amc.name, code: amc.code, isActive: amc.isActive, syncedAt: new Date() },
      create: {
        fpAmcId: amc.fpAmcId,
        name: amc.name,
        code: amc.code,
        isActive: amc.isActive,
      },
      select: { id: true },
    });
    amcIdByFpId.set(amc.fpAmcId, row.id);
  }
  console.log(`[seed] amcs ready: ${snapshot.amcs.length}`);

  // --- Schemes, thresholds and NAV history ---------------------------------
  let thresholdCount = 0;

  for (const scheme of snapshot.schemes) {
    const amcId = scheme.fpAmcId === null ? undefined : amcIdByFpId.get(scheme.fpAmcId);
    if (!amcId) throw new Error(`${scheme.isin}: no seeded AMC for fpAmcId ${scheme.fpAmcId}`);

    const anchor = NAV_ANCHORS[scheme.isin];
    const series = anchor === undefined ? [] : navSeries(anchor, NAV_DAYS);
    const latest = series.at(-1);

    const columns = {
      ...schemeColumns(scheme),
      ...(latest && { latestNav: latest.nav, latestNavDate: latest.navDate }),
      syncedAt: new Date(),
    };

    const row = await db.mfScheme.upsert({
      where: { isin: scheme.isin },
      update: columns,
      create: { isin: scheme.isin, amcId, ...columns },
      select: { id: true },
    });

    for (const threshold of scheme.thresholds) {
      const { type, frequency, ...limits } = threshold;
      await db.mfSchemeThreshold.upsert({
        // (scheme, type, frequency) is the natural key. It is upsertable only
        // because frequency is NOT NULL — see SchemeThresholdFrequency.
        where: { schemeId_type_frequency: { schemeId: row.id, type, frequency } },
        update: { ...limits, syncedAt: new Date() },
        create: { schemeId: row.id, type, frequency, ...limits },
      });
      thresholdCount++;
    }

    // createMany + skipDuplicates leans on @@unique([schemeId, navDate]) so a
    // re-run inserts only the dates that are missing.
    if (series.length > 0) {
      await db.navHistory.createMany({
        data: series.map((point) => ({
          schemeId: row.id,
          navDate: point.navDate,
          nav: point.nav,
        })),
        skipDuplicates: true,
      });
    }
  }
  console.log(
    `[seed] schemes ready: ${snapshot.schemes.length} (${thresholdCount} thresholds, ` +
      `nav history for ${Object.keys(NAV_ANCHORS).length})`,
  );

  // --- Users ---------------------------------------------------------------
  // Argon2id via Bun's built-in password hashing. Never store plaintext, and
  // never seed a shared password into anything but a local database.
  const passwordHash = await Bun.password.hash("DevPassword123!");

  for (const user of USERS) {
    const row = await db.user.upsert({
      where: { phone: user.phone },
      update: { role: user.role, status: "ACTIVE" },
      create: {
        phone: user.phone,
        email: user.email,
        fullName: user.fullName,
        passwordHash,
        role: user.role,
        status: "ACTIVE",
        phoneVerifiedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    console.log(`[seed] user ${user.role.padEnd(8)} ${row.id}  ${user.phone}`);
  }

  console.log("[seed] complete");
}

try {
  await main();
} catch (error) {
  console.error("[seed] failed:", error);
  await disconnectDatabase();
  process.exit(1);
}

await disconnectDatabase();
