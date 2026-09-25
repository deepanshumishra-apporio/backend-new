import type { PaymentDto } from "./payment.types.ts";

export type CartItemType = "LUMPSUM" | "SIP";

export interface CartItemDto {
  id: string;
  isin: string;
  type: CartItemType;
  /** The one-time amount, or the monthly instalment. */
  amount: string;
  schemeName: string;
  category: string | null;
  subCategory: string | null;
  amcName: string | null;
  latestNav: string | null;
  createdAt: string;
}

export interface CartDto {
  items: CartItemDto[];
  /** Sum of the monthly SIP instalments. */
  sipMonthly: string;
  /** Sum of the one-time amounts. */
  lumpsum: string;
}

export interface PutCartItemInput {
  userId: string;
  isin: string;
  type: CartItemType;
  amount: string;
}

export interface CreateCheckoutInput {
  userId: string;
  mfInvestmentAccountId: string;
  /** Required when the cart holds a SIP. */
  mandateId?: string;
  /** Day of the month the SIPs debit on; required with a SIP. */
  installmentDay?: number;
  userIp: string;
  initiatedVia?: string;
}

export interface PayCheckoutInput {
  method?: string;
  bankAccountId?: string;
}

/**
 * Where a checkout stands, derived from its orders and plans:
 *
 * - `reviewing`: FP is still reviewing at least one line.
 * - `ready`: every live line passed review; one OTP confirms them all.
 * - `consented`: the OTP is spent and every line carries its consent.
 * - `failed`: nothing in the checkout can go ahead.
 */
export type CheckoutStage = "reviewing" | "ready" | "consented" | "failed";

export interface CheckoutLineDto {
  id: string;
  isin: string;
  schemeName: string | null;
  type: CartItemType;
  amount: string;
  /** Why FP refused this line, when it did. */
  error: string | null;
  order: { id: string; state: string; failureCode: string | null; folioNumber: string | null } | null;
  plan: { id: string; state: string; reason: string | null; nextInstallmentDate: string | null } | null;
}

export interface CheckoutDto {
  id: string;
  stage: CheckoutStage;
  mandateId: string | null;
  installmentDay: number | null;
  consentedAt: string | null;
  createdAt: string;
  lines: CheckoutLineDto[];
  /** Sum of the live one-time lines — what the payment page collects. */
  payableNow: string;
  /** Sum of the live SIP instalments, debited by AutoPay. */
  sipMonthly: string;
  /** The one payment covering every one-time line, once created. */
  payment: PaymentDto | null;
}
