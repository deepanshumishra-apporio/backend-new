import { db } from "../db/client.ts";
import { refreshIfStale } from "./scheme-availability.service.ts";
import { HttpError } from "../utils/http-error.ts";
import { asAmount, asDate, asNav, asPercent, asUnits } from "../utils/money.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import type {
  ListSchemesQuery,
  NavPointDto,
  Paginated,
  SchemeDetailDto,
  SchemeDto,
  SchemeThresholdDto,
} from "../types/scheme.types.ts";

// `satisfies` (not `as const`) keeps the object a literal while checking it
// against the generated select type — this is what replaces Prisma.validator().
const listSelect = {
  isin: true,
  name: true,
  schemeCode: true,
  category: true,
  planType: true,
  investmentOption: true,
  latestNav: true,
  latestNavDate: true,
  minInitialInvestment: true,
  minAdditionalInvestment: true,
  purchaseAllowed: true,
  redemptionAllowed: true,
  sipAllowed: true,
  amc: { select: { name: true } },
} satisfies Prisma.MfSchemeSelect;

const detailSelect = {
  ...listSelect,
  subCategory: true,
  lockIn: true,
  lockInPeriodDays: true,
  exitLoadPct: true,
  expenseRatio: true,
  switchInAllowed: true,
  switchOutAllowed: true,
  swpAllowed: true,
  stpInAllowed: true,
  stpOutAllowed: true,
  thresholds: {
    select: {
      type: true,
      frequency: true,
      amountMin: true,
      amountMax: true,
      amountMultiples: true,
      unitsMin: true,
      unitsMax: true,
      installmentsMin: true,
      allowedDates: true,
    },
    orderBy: [{ type: "asc" }, { frequency: "asc" }],
  },
} satisfies Prisma.MfSchemeSelect;

/** Exact row types derived from the selects above — no `any`, no drift. */
type ListRow = Prisma.MfSchemeGetPayload<{ select: typeof listSelect }>;
type DetailRow = Prisma.MfSchemeGetPayload<{ select: typeof detailSelect }>;
type ThresholdRow = DetailRow["thresholds"][number];

const toDto = (s: ListRow): SchemeDto => ({
  isin: s.isin,
  name: s.name,
  amcName: s.amc.name,
  schemeCode: s.schemeCode,
  category: s.category,
  planType: s.planType,
  investmentOption: s.investmentOption,
  latestNav: asNav(s.latestNav),
  latestNavDate: asDate(s.latestNavDate),
  minInitialInvestment: asAmount(s.minInitialInvestment),
  minAdditionalInvestment: asAmount(s.minAdditionalInvestment),
  purchaseAllowed: s.purchaseAllowed,
  redemptionAllowed: s.redemptionAllowed,
  sipAllowed: s.sipAllowed,
});

const toThresholdDto = (t: ThresholdRow): SchemeThresholdDto => ({
  type: t.type,
  frequency: t.frequency,
  amountMin: asAmount(t.amountMin),
  amountMax: asAmount(t.amountMax),
  amountMultiples: asAmount(t.amountMultiples),
  unitsMin: asUnits(t.unitsMin),
  unitsMax: asUnits(t.unitsMax),
  installmentsMin: t.installmentsMin,
  allowedDates: t.allowedDates,
});

const toDetailDto = (s: DetailRow): SchemeDetailDto => ({
  ...toDto(s),
  subCategory: s.subCategory,
  lockIn: s.lockIn,
  lockInPeriodDays: s.lockInPeriodDays,
  exitLoadPct: asPercent(s.exitLoadPct),
  expenseRatio: asPercent(s.expenseRatio),
  switchInAllowed: s.switchInAllowed,
  switchOutAllowed: s.switchOutAllowed,
  swpAllowed: s.swpAllowed,
  stpInAllowed: s.stpInAllowed,
  stpOutAllowed: s.stpOutAllowed,
  thresholds: s.thresholds.map(toThresholdDto),
});

/**
 * Cursor pagination on ISIN — `skip` gets linearly slower on deep pages, and
 * ISIN is unique so it is a stable cursor.
 */
export async function listSchemes(q: ListSchemesQuery): Promise<Paginated<SchemeDto>> {
  const rows = await db.mfScheme.findMany({
    where: {
      isActive: true,
      ...(q.search && { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { isin: { startsWith: q.search.toUpperCase() } }] }),
      // A merged scheme still exists but cannot be bought; hide it from the
      // catalogue rather than letting FP reject the order later.
      merged: false,
      ...(q.category && { category: q.category }),
      ...(q.planType && { planType: q.planType }),
      ...(q.investmentOption && { investmentOption: q.investmentOption }),
      ...(q.sipOnly && { sipAllowed: true }),
      ...(q.switchInOnly && { switchInAllowed: true }),
      ...(q.sameAmcAs && { amc: { schemes: { some: { isin: q.sameAmcAs } } } }),
    },
    select: listSelect,
    orderBy: { isin: "asc" },
    take: q.limit + 1, // one extra row tells us if another page exists
    ...(q.cursor && { cursor: { isin: q.cursor }, skip: 1 }),
  });

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;

  return {
    data: page.map(toDto),
    nextCursor: hasMore ? (page.at(-1)?.isin ?? null) : null,
  };
}

/**
 * One scheme, with its capability flags re-checked at FP when they are stale.
 *
 * This is the read behind the fund screen, where the investor decides to
 * invest — so a fund the AMC has closed must show as closed here, not only
 * when the order is refused. See scheme-availability.service.ts.
 */
export async function getScheme(isin: string): Promise<SchemeDetailDto> {
  const stamp = await db.mfScheme.findUnique({ where: { isin }, select: { syncedAt: true } });
  if (!stamp) throw HttpError.notFound(`No scheme with ISIN ${isin}`);
  await refreshIfStale(isin, stamp.syncedAt);
  const scheme = await db.mfScheme.findUnique({ where: { isin }, select: detailSelect });
  if (!scheme) throw HttpError.notFound(`No scheme with ISIN ${isin}`);
  return toDetailDto(scheme);
}

export async function getNavHistory(isin: string, days: number): Promise<NavPointDto[]> {
  const scheme = await db.mfScheme.findUnique({ where: { isin }, select: { id: true } });
  if (!scheme) throw HttpError.notFound(`No scheme with ISIN ${isin}`);

  const history = await db.navHistory.findMany({
    where: { schemeId: scheme.id },
    orderBy: { navDate: "desc" }, // served by @@unique([schemeId, navDate])
    take: Math.min(Math.max(days, 1), 365),
    select: { navDate: true, nav: true },
  });

  return history.map((p) => ({
    date: p.navDate.toISOString().slice(0, 10),
    nav: asNav(p.nav),
  }));
}
