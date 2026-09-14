import type { MfOrderState, MfPurchaseType, OrderGateway } from "../../generated/prisma/enums.ts";

/** Where the request came from. Reported to the RTA, so it is audit data. */
export interface OrderOrigin {
  /** The investor's device IP, IPv4. FP rejects anything else. */
  userIp: string;
  serverIp?: string;
  initiatedVia?: string;
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
  folioNumber: string | null;
  /** Money and units are strings; see utils/money.ts. */
  amount: string | null;
  units: string | null;
  allottedUnits: string | null;
  allottedPrice: string | null;
  settledAmount: string | null;
  purchaseType?: MfPurchaseType | null;
  scheduledOn: string | null;
  tradedOn: string | null;
  failureCode: string | null;
  consentRecorded: boolean;
  createdAt: string;
  confirmedAt: string | null;
  succeededAt: string | null;
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}
