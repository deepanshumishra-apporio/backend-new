// Mirror mandates and payments.
//
// These come from FP's /api/pg gateway, which identifies everything by integer
// and shouts its enum values. `fpId` here is therefore an Int, not a String.
import { db } from "../../db/client.ts";
import {
  MandateStatus,
  MandateType,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  PaymentType,
  RefundStatus,
} from "../../../generated/prisma/enums.ts";
import { fpAmount, fpDate, fpDateTime, fpEnum, fpEnumOr, fpText } from "../../utils/fp-mapping.ts";
import type { FpMandate, FpPayment } from "../../integrations/fp/fp.types.ts";

function unknownValue(field: string) {
  return (value: string) => console.warn(`[fp-sync] unmapped ${field}: "${value}"`);
}

export async function syncMandate(mandate: FpMandate): Promise<{ id: string }> {
  // Mandates are addressed by the bank account's numeric id, so that is what
  // we resolve back to our row.
  const bankAccount = await db.bankAccount.findUnique({
    where: { fpOldId: mandate.bank_account_id },
    select: { id: true },
  });
  if (!bankAccount) {
    throw new Error(`Mandate ${mandate.id} references unmirrored bank account ${mandate.bank_account_id}`);
  }

  const data = {
    bankAccountId: bankAccount.id,
    mandateType: fpEnumOr(
      MandateType,
      mandate.mandate_type,
      MandateType.E_MANDATE,
      unknownValue("mandate_type"),
    ),
    mandateStatus: fpEnumOr(
      MandateStatus,
      mandate.mandate_status,
      MandateStatus.CREATED,
      unknownValue("mandate_status"),
    ),
    mandateLimit: fpAmount(mandate.mandate_limit) ?? "0.00",
    mandateRef: fpText(mandate.mandate_ref, 64),
    mandateToken: fpText(mandate.mandate_token, 120),
    umrn: fpText(mandate.umrn, 40),
    validFrom: fpDate(mandate.valid_from),
    validTo: fpDate(mandate.valid_to),
    providerName: fpEnum(PaymentProvider, mandate.provider_name, unknownValue("provider_name")),
    providerId: mandate.provider_id ?? null,
    rejectedReason: fpText(mandate.rejected_reason, 500),
    fpCreatedAt: fpDateTime(mandate.created_at),
    receivedAt: fpDateTime(mandate.received_at),
    submittedAt: fpDateTime(mandate.submitted_at),
    approvedAt: fpDateTime(mandate.approved_at),
    rejectedAt: fpDateTime(mandate.rejected_at),
    cancelledAt: fpDateTime(mandate.cancelled_at),
    syncedAt: new Date(),
  };

  return db.mandate.upsert({
    where: { fpId: mandate.id },
    update: data,
    create: { fpId: mandate.id, ...data },
    select: { id: true },
  });
}

/**
 * Mirror a payment and the purchases it covers.
 *
 * `amc_order_ids` is a list, so the links are rebuilt each time: an order can
 * drop out of a payment, and leaving a stale link would make a failed order
 * look paid.
 */
export async function syncPayment(payment: FpPayment): Promise<{ id: string }> {
  const mandate = payment.mandate_id
    ? await db.mandate.findUnique({ where: { fpId: payment.mandate_id }, select: { id: true } })
    : null;
  const bankAccount = payment.from_bank_account_id
    ? await db.bankAccount.findUnique({
        where: { fpOldId: payment.from_bank_account_id },
        select: { id: true },
      })
    : null;

  const data = {
    paymentType: fpEnumOr(
      PaymentType,
      payment.payment_type,
      PaymentType.NETBANKING,
      unknownValue("payment_type"),
    ),
    method: fpEnum(PaymentMethod, payment.method, unknownValue("payment method")),
    status: fpEnumOr(
      PaymentStatus,
      payment.status,
      PaymentStatus.INITIATED,
      unknownValue("payment status"),
    ),
    amount: fpAmount(payment.amount) ?? "0.00",
    mandateId: mandate?.id ?? null,
    fromBankAccountId: bankAccount?.id ?? null,
    provider: fpEnum(PaymentProvider, payment.provider_name, unknownValue("provider_name")),
    debitDate: fpDate(payment.debit_date),
    failureCode: fpText(payment.failure_code, 60),
    failedReason: fpText(payment.failed_reason, 500),
    lateAuth: payment.late_auth ?? null,
    refundReference: fpText(payment.refund_reference, 120),
    refundReason: fpText(payment.refund_reason, 200),
    refundStatus: fpEnum(RefundStatus, payment.refund_status, unknownValue("refund_status")),
    refundCreatedAt: fpDateTime(payment.refund_created_at),
    fpCreatedAt: fpDateTime(payment.created_at),
    submittedAt: fpDateTime(payment.submitted_at),
    debitConfirmedAt: fpDateTime(payment.debit_confirmed_at),
    transferInitiatedAt: fpDateTime(payment.transfer_initiated_at),
    settledAt: fpDateTime(payment.settled_at),
    failedAt: fpDateTime(payment.failed_at),
    rejectedAt: fpDateTime(payment.rejected_at),
    syncedAt: new Date(),
  };

  const row = await db.payment.upsert({
    where: { fpId: payment.id },
    update: data,
    create: { fpId: payment.id, ...data },
    select: { id: true },
  });

  const orderIds = payment.amc_order_ids ?? [];
  const purchases =
    orderIds.length === 0
      ? []
      : await db.mfPurchase.findMany({
          where: { fpOldId: { in: orderIds } },
          select: { id: true },
        });

  await db.$transaction([
    db.paymentPurchase.deleteMany({
      where: { paymentId: row.id, mfPurchaseId: { notIn: purchases.map((p) => p.id) } },
    }),
    db.paymentPurchase.createMany({
      data: purchases.map((purchase) => ({ paymentId: row.id, mfPurchaseId: purchase.id })),
      skipDuplicates: true,
    }),
  ]);

  return row;
}
