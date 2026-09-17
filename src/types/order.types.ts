import type { MfOrderState, MfPurchaseType, OrderGateway } from "../../generated/prisma/enums.ts";

/** Where the request came from. Reported to the RTA, so it is audit data. */
export interface OrderOrigin {
  /** The investor's device IP, IPv4. FP rejects anything else. */
  userIp: string;
  serverIp?: string;
  initiatedVia?: string;
  /**
   * The order gateway. Defaults to the configured ONDC route.
   *
   * `rta` is accepted only in the sandbox, and only because ONDC cannot be
   * driven to an allotment there — see the transport's note. Never reachable
   * from an HTTP request: the controllers do not read it.
   */
  gateway?: string;
}

export interface CreatePurchaseInput extends OrderOrigin {
  mfInvestmentAccountId: string;
  isin: string;
  /** Rupees, as a decimal string — never a float. */
  amount: string;
  /** Omit for a fresh purchase: the AMC opens the folio. */
  folioNumber?: string;
  /**
   * Caller-supplied idempotency key. Reused across a retry of the SAME
   * intended order; a new order needs a new one. Generated if absent.
   */
  sourceRefId?: string;
  euin?: string;
}

export interface CreateRedemptionInput extends OrderOrigin {
  mfInvestmentAccountId: string;
  isin: string;
  folioNumber: string;
  /** Amount, or units, or neither — neither redeems the whole holding. */
  amount?: string;
  units?: string;
  sourceRefId?: string;
  euin?: string;
}

export interface CreateSwitchInput extends OrderOrigin {
  mfInvestmentAccountId: string;
  switchOutIsin: string;
  switchInIsin: string;
  folioNumber: string;
  amount?: string;
  units?: string;
  sourceRefId?: string;
  euin?: string;
}

/**
 * Proof that the investor authorised this order.
 *
 * SEBI requires 2FA before an order reaches the RTA. The service resolves the
 * contact to notify from the folio's registered details — FP rejects a consent
 * whose email does not match — so the caller only supplies the proof that the
 * OTP was actually verified.
 */
export interface OrderConsentInput {
  /** A verified PhoneVerification token, not the OTP itself. */
  verificationToken: string;
}

/**
 * Where a redemption's proceeds actually went.
 *
 * Filed by the registrar after the units are gone, so it is null for the whole
 * life of the order and for a working day or two after it succeeds. The UTR is
 * what the investor's bank statement will show, and is the only reference that
 * links the two sides.
 */
export interface OrderPayoutDto {
  amount: string | null;
  utrNumber: string | null;
  bankName: string | null;
  /** Masked at source by the registrar; we never hold the full number. */
  bankAccountNumberMasked: string | null;
  bankIfsc: string | null;
  paidAt: string | null;
}

export interface OrderDto {
  id: string;
  fpId: string;
  type: "PURCHASE" | "REDEMPTION" | "SWITCH";
  state: MfOrderState;
  gateway: OrderGateway;
  isin: string | null;
  switchOutIsin?: string | null;
  switchInIsin?: string | null;
  schemeName: string | null;
  /** The scheme a switch bought into. Only a switch carries one. */
  switchInSchemeName?: string | null;
  folioNumber: string | null;
  /** Money and units are strings; see utils/money.ts. */
  amount: string | null;
  units: string | null;
  allottedUnits: string | null;
  allottedPrice: string | null;
  settledAmount: string | null;
  /**
   * The far side of a switch: what landed in the target scheme.
   *
   * Separate from `allottedUnits`, which reports the switch-OUT leg. The two
   * legs price on different NAVs and can settle a day apart, so collapsing
   * them loses the only numbers that say what the investor now owns.
   */
  switchedInUnits?: string | null;
  switchedInAmount?: string | null;
  switchedInPrice?: string | null;
  /** `normal` on this gateway; `instant` is an RTA-route option. */
  redemptionMode?: string | null;
  /** Null until the registrar files the payout. Redemptions only. */
  payout?: OrderPayoutDto | null;
  purchaseType?: MfPurchaseType | null;
  /** Set when this order is an installment FP generated from a plan. */
  planId?: string | null;
  scheduledOn: string | null;
  tradedOn: string | null;
  /** The NAV date the units were allotted at, which need not be `tradedOn`. */
  allottedNavDate?: string | null;
  failureCode: string | null;
  consentRecorded: boolean;
  createdAt: string;
  confirmedAt: string | null;
  /** When FP handed the order to the registrar. */
  submittedAt: string | null;
  succeededAt: string | null;
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}
