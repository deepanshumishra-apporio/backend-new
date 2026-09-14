/**
 * Common to every plan create: who asked, and from where.
 *
 * No 2FA proof here. On the ONDC route a plan is created, reviewed, and only
 * then confirmed — and the confirm is where consent is collected and spent, by
 * `confirmPlan`. Creating a plan authorises nothing on its own.
 */
interface PlanOrigin {
  mfInvestmentAccountId: string;
  /** Installment cadence, e.g. MONTHLY. Must be one the scheme publishes. */
  frequency: string;
  /** 1-5 for weekly cadences, 1-28 for monthly and longer. Omit for daily. */
  installmentDay?: number;
  numberOfInstallments: number;
  folioNumber?: string;
  userIp: string;
  serverIp?: string;
  initiatedVia?: string;
  euin?: string;
  sourceRefId?: string;
}

export interface CreateSipInput extends PlanOrigin {
  isin: string;
  /** Per-installment amount, as a decimal string. */
  amount: string;
  /** Our mandate id. The mandate must be APPROVED. */
  mandateId?: string;
  purpose?: string;
}

export interface CreateSwpInput extends PlanOrigin {
  isin: string;
  folioNumber: string;
  amount?: string;
  units?: string;
}

export interface CreateStpInput extends PlanOrigin {
  switchOutIsin: string;
  switchInIsin: string;
  folioNumber: string;
  amount?: string;
  units?: string;
}

export interface PlanDto {
  id: string;
  fpId: string;
  type: "SIP" | "SWP" | "STP";
  state: string;
  isin: string;
  switchInIsin?: string;
  schemeName: string | null;
  /** false means FP generates ordinary lumpsum orders on a schedule instead. */
  systematic: boolean;
  frequency: string;
  installmentDay: number | null;
  amount: string | null;
  units: string | null;
  numberOfInstallments: number;
  remainingInstallments: number | null;
  startDate: string | null;
  endDate: string | null;
  nextInstallmentDate: string | null;
  previousInstallmentDate: string | null;
  folioNumber: string | null;
  cancellationCode: string | null;
  reason: string | null;
  createdAt: string;
  activatedAt: string | null;
  cancelledAt: string | null;
}
