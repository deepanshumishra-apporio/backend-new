// Shape of fp-sandbox-catalogue.json, shared by the refresh script that writes
// it and the seed that reads it. Decimal-backed values are strings so no money
// or multiple ever passes through a JS double.
import type {
  SchemeCategory,
  SchemeDeliveryMode,
  SchemeInvestmentOption,
  SchemePlanType,
  SchemeThresholdFrequency,
  SchemeThresholdType,
} from "../../generated/prisma/enums.ts";

export interface SeedAmc {
  fpAmcId: number;
  name: string;
  code: string | null;
  isActive: boolean;
}

export interface SeedThreshold {
  type: SchemeThresholdType;
  /** NOT_APPLICABLE for the one-off types (lumpsum, withdrawal, switch). */
  frequency: SchemeThresholdFrequency;
  amountMin: string | null;
  amountMax: string | null;
  amountMultiples: string | null;
  unitsMin: string | null;
  unitsMax: string | null;
  unitsMultiples: string | null;
  installmentsMin: number | null;
  allowedDates: number[];
}

export interface SeedScheme {
  isin: string;
  fpSchemeId: number | null;
  name: string;
  schemeCode: string | null;
  amfiCode: string | null;
  fpAmcId: number | null;
  fpRtaId: number | null;

  category: SchemeCategory;
  planType: SchemePlanType;
  investmentOption: SchemeInvestmentOption;
  deliveryMode: SchemeDeliveryMode | null;
  subCategory: string | null;

  isActive: boolean;
  closeEnded: boolean;
  lockIn: boolean;
  lockInPeriodDays: number | null;
  longTermPeriodDays: number | null;

  purchaseAllowed: boolean;
  redemptionAllowed: boolean;
  instantRedemptionAllowed: boolean;
  switchInAllowed: boolean;
  switchOutAllowed: boolean;
  sipAllowed: boolean;
  swpAllowed: boolean;
  stpInAllowed: boolean;
  stpOutAllowed: boolean;

  minInitialInvestment: string | null;
  maxInitialInvestment: string | null;
  initialInvestmentMultiples: string | null;
  minAdditionalInvestment: string | null;
  maxAdditionalInvestment: string | null;
  additionalInvestmentMultiples: string | null;

  minWithdrawalAmount: string | null;
  maxWithdrawalAmount: string | null;
  withdrawalMultiples: string | null;
  minWithdrawalUnits: string | null;
  maxWithdrawalUnits: string | null;
  withdrawalUnitMultiples: string | null;
  minInstantWithdrawalAmount: string | null;
  instantWithdrawalMultiples: string | null;

  minSwitchInAmount: string | null;
  maxSwitchInAmount: string | null;
  switchInAmountMultiples: string | null;
  minSwitchOutAmount: string | null;
  maxSwitchOutAmount: string | null;
  switchOutAmountMultiples: string | null;
  minSwitchOutUnits: string | null;
  maxSwitchOutUnits: string | null;
  switchOutUnitMultiples: string | null;

  merged: boolean;
  mergedToIsin: string | null;

  thresholds: SeedThreshold[];
}

export interface CatalogueSnapshot {
  capturedAt: string;
  /** Which FP environment and tenant this came from. Never credentials. */
  source: string;
  amcs: SeedAmc[];
  schemes: SeedScheme[];
}
