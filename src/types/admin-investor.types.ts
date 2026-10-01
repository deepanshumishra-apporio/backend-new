import type { KycNextAction } from "../utils/kyc-steps.ts";

/**
 * Where an investor's identity check stands.
 *
 * - NOT_STARTED       no PAN check and no KYC form yet
 * - PAN_CHECK_FAILED  the PAN check came back without a pass (usually: not KRA
 *                     compliant, so a digital KYC form is owed) and no form opened
 * - IN_PROGRESS       a KYC form is open (see `kycNextStep` for whose turn it is)
 * - FAILED / EXPIRED  the latest form cannot advance; a new one is owed
 * - COMPLETED         PAN, name and DOB verified at the KRA, or a form submitted
 */
export const KYC_STATUSES = ["NOT_STARTED", "PAN_CHECK_FAILED", "IN_PROGRESS", "FAILED", "EXPIRED", "COMPLETED"] as const;
export type AdminKycStatus = (typeof KYC_STATUSES)[number];

/** How a COMPLETED KYC was reached: already on record at the KRA, or via our digital form. */
export type KycCompletedVia = "KRA" | "KYC_FORM";

/**
 * The furthest point of the journey an investor has reached, in order.
 * Derived from the rows that exist, never from `InvestorOnboarding.stage`,
 * whose cursor skips several steps.
 */
export const JOURNEY_STAGES = [
  "SIGNED_UP",
  "KYC",
  "KYC_COMPLETED",
  "PROFILE",
  "ACCOUNT_SETUP",
  "READY_TO_INVEST",
  "INVESTED",
] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

/** Next step inside an open KYC form; WAITING_ON_PROVIDER when it is FP's turn. */
export type KycNextStep = Exclude<KycNextAction, null> | "WAITING_ON_PROVIDER";

export interface CountByKey<K extends string = string> {
  key: K;
  label: string;
  count: number;
}

export interface DashboardSummaryDto {
  generatedAt: string;
  /**
   * When the investor read model was last brought up to date; investor counts
   * are as of this moment. Null until the first projection run completes.
   */
  dataAsOf: string | null;
  signups: { total: number; today: number; last7Days: number; last30Days: number };
  usersByStatus: CountByKey[];
  kyc: {
    byStatus: CountByKey<AdminKycStatus>[];
    completed: number;
    completedVia: { kra: number; kycForm: number };
    /** Open forms, split by whose move it is. */
    inProgressByStep: CountByKey<KycNextStep>[];
  };
  journey: { byStage: CountByKey<JourneyStage>[] };
  /** Independent milestone counts, in journey order. */
  funnel: CountByKey[];
  attention: {
    /** An open KYC form with no progress for over 48 hours. */
    kycStalled: number;
    kycFailedOrExpired: number;
    panCheckFailed: number;
    /** Investment account exists but the investor still cannot transact. */
    accountNotReady: number;
  };
  investments: {
    investedInvestors: number;
    successfulPurchases: number;
    /** Sum of successful purchase amounts. Rupees, as a string. */
    purchasedAmount: string;
    /** From the last holdings sync, not derived from orders. */
    currentValue: string;
    activeSips: number;
    activeSipMonthlyAmount: string;
    mandatesByStatus: CountByKey[];
  };
}

export type SignupBucket = "day" | "week" | "month";

export interface SignupSeriesDto {
  bucket: SignupBucket;
  from: string;
  to: string;
  /** India time; one point per bucket, zero-filled. */
  points: { date: string; signups: number; kycCompleted: number }[];
}

export interface InvestorListQuery {
  search?: string;
  stage?: JourneyStage[];
  kycStatus?: AdminKycStatus[];
  status?: string[];
  kycStalled?: boolean;
  /** Only investors with an active SIP instalment due within this many days. */
  sipDueDays?: number;
  cursor?: { createdAt: Date; id: string };
  limit: number;
}

export interface InvestorListItemDto {
  id: string;
  name: string | null;
  email: string | null;
  phone: string;
  status: string;
  pan: string | null;
  stage: JourneyStage;
  kycStatus: AdminKycStatus;
  kycCompletedVia: KycCompletedVia | null;
  kycNextStep: KycNextStep | null;
  investedAmount: string;
  /** From the last holdings sync. */
  currentValue: string;
  activeSips: number;
  sipMonthlyAmount: string;
  nextSipDate: string | null;
  signedUpAt: string;
  lastLoginAt: string | null;
  lastActivityAt: string;
}

export interface InvestorListDto {
  items: InvestorListItemDto[];
  total: number;
  nextCursor: string | null;
}

export interface InvestorDetailDto {
  summary: InvestorListItemDto;
  user: {
    emailVerifiedAt: string | null;
    phoneVerifiedAt: string | null;
    createdAt: string;
  };
  kyc: {
    panCheck: {
      at: string;
      readinessStatus: string | null;
      readinessCode: string | null;
      readinessReason: string | null;
      pan: { status: string | null; code: string | null };
      name: { status: string | null; code: string | null };
      dateOfBirth: { status: string | null; code: string | null };
    } | null;
    forms: {
      id: string;
      type: string;
      status: string;
      reason: string | null;
      nextStep: KycNextStep | null;
      proofStatus: string | null;
      esignStatus: string | null;
      signatureProvided: boolean;
      outstandingFields: string[];
      createdAt: string;
      submittedAt: string | null;
      failedAt: string | null;
      expiresAt: string | null;
    }[];
  };
  profile: {
    id: string;
    name: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    occupation: string | null;
    taxStatus: string | null;
    incomeSlab: string | null;
    addresses: { city: string | null; state: string | null; postalCode: string; country: string }[];
  } | null;
  bankAccounts: {
    id: string;
    bankName: string | null;
    accountNumber: string;
    ifscCode: string;
    type: string;
    isPayout: boolean;
    verificationStatus: string | null;
    verificationConfidence: string | null;
    verifiedAt: string | null;
  }[];
  nomination: {
    optedOut: boolean;
    nominees: { name: string; relationship: string; allocationPercentage: string }[];
  };
  mandates: { id: string; type: string; status: string; limit: string; approvedAt: string | null; createdAt: string }[];
  investments: InvestorInvestmentsDto;
  timeline: { at: string; event: string }[];
}

// --- an investor's money: holdings, plans, orders, payments ---------------------

export type PlanKind = "SIP" | "SWP" | "STP";
export type OrderKind = "PURCHASE" | "REDEMPTION" | "SWITCH";
/** Where an order came from: placed by hand, or an instalment of a plan. */
export type OrderSource = "ONE_TIME" | PlanKind;

export interface HoldingDto {
  id: string;
  scheme: string;
  isin: string;
  folioNumber: string;
  units: string;
  redeemableUnits: string | null;
  nav: string | null;
  navAsOn: string | null;
  currentValue: string | null;
  investedValue: string | null;
  /** currentValue − investedValue, when both are known. */
  gain: string | null;
}

export interface PlanDto {
  id: string;
  kind: PlanKind;
  scheme: string;
  /** STP only: the scheme units move into. */
  toScheme: string | null;
  amount: string | null;
  units: string | null;
  frequency: string;
  installmentDay: number | null;
  state: string;
  startDate: string | null;
  endDate: string | null;
  nextInstallmentDate: string | null;
  previousInstallmentDate: string | null;
  totalInstallments: number;
  remainingInstallments: number | null;
  /** Instalment orders placed so far, and how many of them succeeded. */
  installmentsPlaced: number;
  installmentsSucceeded: number;
  /** SIP only. */
  pause: { state: string | null; from: string | null; to: string | null } | null;
  mandate: { type: string; status: string } | null;
  folioNumber: string | null;
  createdAt: string;
  cancelledAt: string | null;
  reason: string | null;
}

export interface UpcomingInstallmentDto {
  planId: string;
  kind: PlanKind;
  scheme: string;
  toScheme: string | null;
  date: string;
  amount: string | null;
  units: string | null;
  /** SIP only: whether the mandate that will be debited is approved. */
  mandateReady: boolean | null;
  paused: boolean;
}

export interface OrderDto {
  id: string;
  kind: OrderKind;
  source: OrderSource;
  scheme: string;
  toScheme: string | null;
  /** Requested amount; for a redemption or switch by units, null. */
  amount: string | null;
  units: string | null;
  /** What actually happened: allotted / redeemed / switched. */
  processedAmount: string | null;
  processedUnits: string | null;
  price: string | null;
  folioNumber: string | null;
  state: string;
  failureReason: string | null;
  placedAt: string;
  completedAt: string | null;
}

export interface PaymentDto {
  id: string;
  type: string;
  method: string | null;
  status: string;
  amount: string;
  failureReason: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface InvestorInvestmentsDto {
  portfolio: {
    currentValue: string;
    investedValue: string;
    gain: string;
    /** Absolute return, percent, to 2 dp; null when nothing is invested. */
    gainPercent: string | null;
    /** The oldest valuation date among the holdings. */
    asOf: string | null;
    holdings: HoldingDto[];
  };
  folios: { number: string; amcCode: string | null; holdingPattern: string | null; schemes: number }[];
  plans: { sips: PlanDto[]; swps: PlanDto[]; stps: PlanDto[] };
  summary: {
    activeSips: number;
    /** Active SIPs, normalised to a monthly amount. */
    sipMonthlyAmount: string;
    activeSwps: number;
    activeStps: number;
    nextSip: { date: string; amount: string; count: number } | null;
  };
  upcoming: UpcomingInstallmentDto[];
  orders: OrderDto[];
  orderTotals: {
    purchased: string;
    redeemed: string;
    switched: string;
    inFlight: number;
    failed: number;
  };
  payments: PaymentDto[];
}

// --- one item, for the side panel ------------------------------------------------

export type InvestorItemType = "holding" | "sip" | "swp" | "stp" | "purchase" | "redemption" | "switch" | "payment";

/** The item's life so far, in order; each step is when FP says it happened. */
export interface ItemEvent {
  at: string;
  label: string;
}

export interface SchemeFactsDto {
  isin: string;
  name: string;
  amc: string;
  category: string;
  subCategory: string | null;
  planType: string;
  option: string;
  latestNav: string | null;
  latestNavDate: string | null;
  expenseRatio: string | null;
  exitLoadPercent: string | null;
  lockInDays: number | null;
}

export interface OrderDetailDto extends OrderDto {
  fpId: string;
  sourceRefId: string | null;
  gateway: string | null;
  /** Purchase: LUMPSUM / SIP instalment; redemption: NORMAL / INSTANT. */
  subtype: string | null;
  failureCode: string | null;
  navDate: string | null;
  scheduledOn: string | null;
  tradedOn: string | null;
  initiatedBy: string | null;
  initiatedVia: string | null;
  consent: { at: string; email: string | null; mobile: string | null } | null;
  /** Redemption payout account, masked. */
  payoutAccount: { accountNumber: string; ifsc: string | null } | null;
  plan: { id: string; kind: PlanKind; scheme: string } | null;
  payments: PaymentDto[];
  events: ItemEvent[];
  scheme: string;
  schemeFacts: SchemeFactsDto;
}

export interface PlanDetailDto extends PlanDto {
  fpId: string;
  gateway: string | null;
  requestedActivationDate: string | null;
  activatedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  autoCancelled: boolean | null;
  cancellationCode: string | null;
  cancellationScheduledOn: string | null;
  consentAt: string | null;
  /** SIP only. */
  paymentMethod: string | null;
  purpose: string | null;
  /** Every instalment order this plan has placed, newest first. */
  installments: OrderDto[];
  events: ItemEvent[];
  schemeFacts: SchemeFactsDto;
}

export interface HoldingDetailDto extends HoldingDto {
  unitsAsOn: string | null;
  currentValueAsOn: string | null;
  investedValueAsOn: string | null;
  payoutAmount: string | null;
  /** Null when the scheme is not in our catalogue (a holding the RTA reported that we never sold). */
  schemeFacts: SchemeFactsDto | null;
  folio: { number: string; amcCode: string | null; holdingPattern: string | null } | null;
  /** Orders on this scheme in this folio, newest first. */
  orders: OrderDto[];
  /** Live and past plans on this scheme. */
  plans: { id: string; kind: PlanKind; state: string; amount: string | null; frequency: string; nextInstallmentDate: string | null }[];
}

export interface PaymentDetailDto extends PaymentDto {
  fpId: number;
  provider: string | null;
  debitDate: string | null;
  failureCode: string | null;
  lateAuth: boolean | null;
  refund: { status: string | null; reference: string | null; reason: string | null; at: string | null } | null;
  mandate: { type: string; status: string; umrn: string | null } | null;
  bankAccount: { bankName: string | null; accountNumber: string } | null;
  purchases: OrderDto[];
  events: ItemEvent[];
}

export type InvestorItemDto =
  | { type: "holding"; holding: HoldingDetailDto }
  | { type: "plan"; plan: PlanDetailDto }
  | { type: "order"; order: OrderDetailDto }
  | { type: "payment"; payment: PaymentDetailDto };
