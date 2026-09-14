import type {
  SchemeCategory,
  SchemeInvestmentOption,
  SchemePlanType,
} from "../../generated/prisma/enums.ts";

export interface ListSchemesQuery {
  search?: string;
  category?: SchemeCategory;
  planType?: SchemePlanType;
  investmentOption?: SchemeInvestmentOption;
  /** Only schemes an SIP can be registered against. */
  sipOnly?: boolean;
  limit: number;
  cursor?: string;
}

/**
 * Catalogue row. ISIN is the public identifier, not our uuid: it is what FP's
 * order APIs take, so the client that lists schemes can place an order without
 * a second lookup.
 */
export interface SchemeDto {
  isin: string;
  name: string;
  amcName: string;
  schemeCode: string | null;
  category: SchemeCategory;
  planType: SchemePlanType;
  investmentOption: SchemeInvestmentOption;
  latestNav: string | null;
  latestNavDate: string | null;
  /** Money as strings — see utils/money.ts. */
  minInitialInvestment: string | null;
  minAdditionalInvestment: string | null;
  purchaseAllowed: boolean;
  redemptionAllowed: boolean;
  sipAllowed: boolean;
}

/** Per-frequency limits FP enforces; validate against these before ordering. */
export interface SchemeThresholdDto {
  type: string;
  /** "not_applicable" for the one-off types. */
  frequency: string;
  amountMin: string | null;
  amountMax: string | null;
  amountMultiples: string | null;
  unitsMin: string | null;
  unitsMax: string | null;
  installmentsMin: number | null;
  allowedDates: number[];
}

export interface SchemeDetailDto extends SchemeDto {
  subCategory: string | null;
  lockIn: boolean;
  lockInPeriodDays: number | null;
  exitLoadPct: string | null;
  expenseRatio: string | null;
  switchInAllowed: boolean;
  switchOutAllowed: boolean;
  swpAllowed: boolean;
  stpInAllowed: boolean;
  stpOutAllowed: boolean;
  thresholds: SchemeThresholdDto[];
}

export interface NavPointDto {
  date: string;
  nav: string | null;
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}
