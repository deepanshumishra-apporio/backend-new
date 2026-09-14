// Refreshes the committed FP sandbox catalogue snapshot that prisma/seed.ts
// loads.
//
// Why a snapshot at all: the seed must run offline and produce identical rows
// every time, but the scheme limits it seeds have to be the REAL ones — FP
// rejects an order whose amount misses a multiple by a paisa, so invented
// thresholds would make every seeded scheme untestable. So we capture them
// once, normalise them into this schema's vocabulary, and commit the result.
//
// Run with: bun run db:seed:refresh
//
// Requires FP_BASE_URL, FP_TENANT_ID, FP_CLIENT_ID and FP_CLIENT_SECRET.
// Credentials are never written into the snapshot.
import {
  SchemeCategory,
  SchemeDeliveryMode,
  SchemeInvestmentOption,
  SchemePlanType,
  SchemeThresholdFrequency,
  SchemeThresholdType,
} from "../../generated/prisma/enums.ts";
import type { CatalogueSnapshot, SeedScheme, SeedThreshold } from "./catalogue.types.ts";

/// The ISINs FP gave us for sandbox testing.
const TEST_ISINS = [
  "INF109K01423",
  "INF109KC1TY0",
  "INF109KC1TV6",
  "INF109KC1TU8",
  "INF109K01605",
  "INF109KC11U2",
  "INF109KC19T7",
] as const;

const SNAPSHOT_PATH = `${import.meta.dir}/fp-sandbox-catalogue.json`;

/// FP rate-limits per-tenant, and the sandbox limit is low enough that seven
/// back-to-back scheme fetches trip it. Pace the calls and back off on a 429.
const REQUEST_SPACING_MS = 1_200;
const MAX_RETRIES = 4;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with spacing and 429 backoff. Honours Retry-After when FP sends it,
 * otherwise doubles a fixed delay.
 */
async function fetchJson(url: string, headers: Record<string, string>, label: string) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers });
    if (response.ok) return (await response.json()) as unknown;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt > MAX_RETRIES) {
      throw new Error(`${label}: FP returned ${response.status}`);
    }

    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : REQUEST_SPACING_MS * 2 ** attempt;
    console.log(`[refresh] ${label}: ${response.status}, retrying in ${waitMs}ms`);
    await sleep(waitMs);
  }
}

/** Look an FP wire value up in one of our enums, or fail loudly. */
function toEnum<T extends Record<string, string>>(
  values: T,
  raw: unknown,
  field: string,
): T[keyof T] {
  if (typeof raw !== "string") throw new Error(`${field}: expected a string, got ${typeof raw}`);
  // The v1 catalogue shouts its enums ("EQUITY"); our TS names are the same
  // shape, so upper-casing is the whole normalisation.
  const key = raw.toUpperCase();
  const match = (values as Record<string, string>)[key];
  if (match === undefined) {
    throw new Error(`${field}: FP sent "${raw}", which is not in ${Object.keys(values).join("|")}`);
  }
  return match as T[keyof T];
}

function toEnumOrNull<T extends Record<string, string>>(values: T, raw: unknown, field: string) {
  return raw === null || raw === undefined ? null : toEnum(values, raw, field);
}

/** FP sends numbers; Decimal columns take strings. Keep 4dp — multiples go to 0.001. */
function decimal(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return raw.toFixed(4);
}

function integer(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
}

function text(raw: unknown): string | null {
  // FP uses "" for "no sub category"; treat it as absent.
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

interface FrequencyBlock {
  dates?: unknown;
  min_installment_amount?: unknown;
  max_installment_amount?: unknown;
  amount_multiples?: unknown;
  min_installments?: unknown;
}

/** One threshold row per (plan type, frequency) FP reports for the scheme. */
function planThresholds(
  type: SchemeThresholdType,
  block: unknown,
  isin: string,
): SeedThreshold[] {
  if (block === null || typeof block !== "object") return [];

  return Object.entries(block as Record<string, FrequencyBlock>).map(([frequency, limits]) => ({
    type,
    frequency: toEnum(SchemeThresholdFrequency, frequency, `${isin}.${type}.frequency`),
    amountMin: decimal(limits.min_installment_amount),
    amountMax: decimal(limits.max_installment_amount),
    amountMultiples: decimal(limits.amount_multiples),
    unitsMin: null,
    unitsMax: null,
    unitsMultiples: null,
    installmentsMin: integer(limits.min_installments),
    allowedDates: Array.isArray(limits.dates) ? limits.dates.filter(Number.isInteger) : [],
  }));
}

function oneOffThreshold(
  type: SchemeThresholdType,
  limits: Pick<
    SeedThreshold,
    "amountMin" | "amountMax" | "amountMultiples" | "unitsMin" | "unitsMax" | "unitsMultiples"
  >,
): SeedThreshold {
  return {
    type,
    frequency: SchemeThresholdFrequency.NOT_APPLICABLE,
    installmentsMin: null,
    allowedDates: [],
    ...limits,
  };
}

function toSeedScheme(s: Record<string, unknown>): SeedScheme {
  const isin = String(s["isin"]);

  return {
    isin,
    fpSchemeId: integer(s["fund_scheme_id"]),
    name: String(s["name"]),
    schemeCode: text(s["scheme_code"]),
    amfiCode: text(s["amfi_code"]),
    fpAmcId: integer(s["amc_id"]),
    fpRtaId: integer(s["rta_id"]),

    category: toEnum(SchemeCategory, s["fund_category"], `${isin}.fund_category`),
    planType: toEnum(SchemePlanType, s["plan_type"], `${isin}.plan_type`),
    investmentOption: toEnum(
      SchemeInvestmentOption,
      s["investment_option"],
      `${isin}.investment_option`,
    ),
    deliveryMode: toEnumOrNull(SchemeDeliveryMode, s["delivery_mode"], `${isin}.delivery_mode`),
    subCategory: text(s["sub_category"]),

    isActive: s["active"] === true,
    closeEnded: s["close_ended"] === true,
    lockIn: s["lock_in"] === true,
    lockInPeriodDays: integer(s["lock_in_period"]),
    longTermPeriodDays: integer(s["long_term_period"]),

    purchaseAllowed: s["purchase_allowed"] === true,
    redemptionAllowed: s["redemption_allowed"] === true,
    // FP spells this one "insta", not "instant".
    instantRedemptionAllowed: s["insta_redemption_allowed"] === true,
    switchInAllowed: s["switch_in_allowed"] === true,
    switchOutAllowed: s["switch_out_allowed"] === true,
    sipAllowed: s["sip_allowed"] === true,
    swpAllowed: s["swp_allowed"] === true,
    stpInAllowed: s["stp_in_allowed"] === true,
    stpOutAllowed: s["stp_out_allowed"] === true,

    minInitialInvestment: decimal(s["min_initial_investment"]),
    maxInitialInvestment: decimal(s["max_initial_investment"]),
    initialInvestmentMultiples: decimal(s["initial_investment_multiples"]),
    minAdditionalInvestment: decimal(s["min_additional_investment"]),
    maxAdditionalInvestment: decimal(s["max_additional_investment"]),
    additionalInvestmentMultiples: decimal(s["additional_investment_multiples"]),

    minWithdrawalAmount: decimal(s["min_withdrawal_amount"]),
    maxWithdrawalAmount: decimal(s["max_withdrawal_amount"]),
    withdrawalMultiples: decimal(s["withdrawal_multiples"]),
    minWithdrawalUnits: decimal(s["min_withdrawal_units"]),
    maxWithdrawalUnits: decimal(s["max_withdrawal_units"]),
    withdrawalUnitMultiples: decimal(s["withdrawal_multiples_units"]),
    minInstantWithdrawalAmount: decimal(s["min_instant_withdrawal_amount"]),
    instantWithdrawalMultiples: decimal(s["instant_withdrawal_multiples"]),

    minSwitchInAmount: decimal(s["min_switch_in_amount"]),
    maxSwitchInAmount: decimal(s["max_switch_in_amount"]),
    switchInAmountMultiples: decimal(s["switch_in_amount_multiples"]),
    minSwitchOutAmount: decimal(s["min_switch_out_amount"]),
    maxSwitchOutAmount: decimal(s["max_switch_out_amount"]),
    switchOutAmountMultiples: decimal(s["switch_out_amount_multiples"]),
    minSwitchOutUnits: decimal(s["min_switch_out_units"]),
    maxSwitchOutUnits: decimal(s["max_switch_out_units"]),
    switchOutUnitMultiples: decimal(s["switch_out_unit_multiples"]),

    merged: s["merged"] === true,
    mergedToIsin: text(s["merged_to_isin"]),

    thresholds: [
      oneOffThreshold(SchemeThresholdType.LUMPSUM, {
        amountMin: decimal(s["min_initial_investment"]),
        amountMax: decimal(s["max_initial_investment"]),
        amountMultiples: decimal(s["initial_investment_multiples"]),
        unitsMin: null,
        unitsMax: null,
        unitsMultiples: null,
      }),
      oneOffThreshold(SchemeThresholdType.ADDITIONAL, {
        amountMin: decimal(s["min_additional_investment"]),
        amountMax: decimal(s["max_additional_investment"]),
        amountMultiples: decimal(s["additional_investment_multiples"]),
        unitsMin: null,
        unitsMax: null,
        unitsMultiples: null,
      }),
      oneOffThreshold(SchemeThresholdType.WITHDRAWAL, {
        amountMin: decimal(s["min_withdrawal_amount"]),
        amountMax: decimal(s["max_withdrawal_amount"]),
        amountMultiples: decimal(s["withdrawal_multiples"]),
        unitsMin: decimal(s["min_withdrawal_units"]),
        unitsMax: decimal(s["max_withdrawal_units"]),
        unitsMultiples: decimal(s["withdrawal_multiples_units"]),
      }),
      oneOffThreshold(SchemeThresholdType.SWITCH_IN, {
        amountMin: decimal(s["min_switch_in_amount"]),
        amountMax: decimal(s["max_switch_in_amount"]),
        amountMultiples: decimal(s["switch_in_amount_multiples"]),
        unitsMin: null,
        unitsMax: null,
        unitsMultiples: null,
      }),
      oneOffThreshold(SchemeThresholdType.SWITCH_OUT, {
        amountMin: decimal(s["min_switch_out_amount"]),
        amountMax: decimal(s["max_switch_out_amount"]),
        amountMultiples: decimal(s["switch_out_amount_multiples"]),
        unitsMin: decimal(s["min_switch_out_units"]),
        unitsMax: decimal(s["max_switch_out_units"]),
        unitsMultiples: decimal(s["switch_out_unit_multiples"]),
      }),
      ...planThresholds(SchemeThresholdType.SIP, s["sip_frequency_specific_data"], isin),
      ...planThresholds(SchemeThresholdType.SWP, s["swp_frequency_specific_data"], isin),
      ...planThresholds(SchemeThresholdType.STP, s["stp_frequency_specific_data"], isin),
    ],
  };
}

async function main() {
  const baseUrl = required("FP_BASE_URL").replace(/\/+$/, "");
  const tenantId = required("FP_TENANT_ID");

  const tokenResponse = await fetch(`${baseUrl}/v2/auth/${tenantId}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: required("FP_CLIENT_ID"),
      client_secret: required("FP_CLIENT_SECRET"),
      grant_type: "client_credentials",
    }),
  });
  if (!tokenResponse.ok) {
    // Never echo the body — it can repeat the client_id back at us.
    throw new Error(`FP token request failed with ${tokenResponse.status}`);
  }
  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: string };
  if (!accessToken) throw new Error("FP token response carried no access_token");

  const headers = {
    authorization: `Bearer ${accessToken}`,
    "x-tenant-id": tenantId,
    accept: "application/json",
  };

  const schemes: SeedScheme[] = [];
  for (const [index, isin] of TEST_ISINS.entries()) {
    if (index > 0) await sleep(REQUEST_SPACING_MS);
    const payload = await fetchJson(`${baseUrl}/api/oms/fund_schemes/${isin}`, headers, isin);
    schemes.push(toSeedScheme(payload as Record<string, unknown>));
    console.log(`[refresh] ${isin} ok`);
  }

  // Only the AMCs the seeded schemes actually belong to.
  const wantedAmcIds = new Set(schemes.map((s) => s.fpAmcId));
  await sleep(REQUEST_SPACING_MS);
  // GET /api/oms/amcs returns `amc_id`, not `id` as the reference implies.
  const { amcs } = (await fetchJson(`${baseUrl}/api/oms/amcs`, headers, "amcs")) as {
    amcs: { amc_id: number; name: string; amc_code: string | null; active: boolean }[];
  };

  const snapshot: CatalogueSnapshot = {
    capturedAt: new Date().toISOString(),
    source: `${baseUrl} (tenant ${tenantId})`,
    amcs: amcs
      .filter((a) => wantedAmcIds.has(a.amc_id))
      .map((a) => ({
        fpAmcId: a.amc_id,
        name: a.name,
        code: a.amc_code,
        isActive: a.active,
      })),
    schemes,
  };

  await Bun.write(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `[refresh] wrote ${snapshot.amcs.length} amc(s) and ${snapshot.schemes.length} scheme(s) ` +
      `(${snapshot.schemes.reduce((n, s) => n + s.thresholds.length, 0)} thresholds)`,
  );
}

await main();
