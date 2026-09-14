export interface CreateMandateInput {
  bankAccountId: string;
  /** E_MANDATE for NACH, UPI for UPI autopay. */
  mandateType: string;
  /** Per-debit ceiling, as a decimal string. */
  mandateLimit: string;
  /**
   * RAZORPAY, BILLDESK or CYBRILLAPOA. Effectively required: without it FP
   * falls back to the tenant default, which fails outright when that default
   * is ONDC. It must also match the gateway the orders will use.
   */
  providerName?: string;
  validFrom?: string;
  validTo?: string;
}

export interface MandateDto {
  id: string;
  fpId: number;
  type: string;
  status: string;
  limit: string | null;
  umrn: string | null;
  validFrom: string | null;
  validTo: string | null;
  provider: string | null;
  rejectedReason: string | null;
  bankAccount: {
    id: string;
    bankName: string | null;
    accountNumberLast4: string;
    ifscCode: string;
  };
  /** Only an APPROVED mandate can fund a plan or a payment. */
  usableForPlans: boolean;
  approvedAt: string | null;
  createdAt: string;
}

export interface MandateAuthDto {
  mandateId: string;
  /** FP's payment id for the zero-value authorisation debit. */
  paymentId: number;
  /** Send the investor here. Short-lived — request a new one if it expires. */
  authorizationUrl: string;
}

export interface PayOrdersInput {
  /** Our purchase ids. At most ten, all on one investment account. */
  orderIds: string[];
  /** NETBANKING or UPI. */
  method?: string;
  postbackUrl?: string;
  /** Enables third-party verification of the paying account. */
  bankAccountId?: string;
  providerName?: string;
}

export interface PaymentDto {
  id: string;
  fpId: number;
  type: string;
  method: string | null;
  status: string;
  amount: string | null;
  debitDate: string | null;
  provider: string | null;
  failureCode: string | null;
  failureReason: string | null;
  /** Where to send the investor, for a redirect-based payment. */
  paymentUrl: string | null;
  orderIds: string[];
  createdAt: string;
  settledAt: string | null;
}
