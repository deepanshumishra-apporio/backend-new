// Carry a sandbox order all the way to an allotment.
//
// The ONDC route cannot reach one: FP refuses `/api/oms/simulate/orders/:id`
// for it ("ONDC gateway orders can't be simulated") and the sandbox RTA batch
// rejects whatever is waiting, so no folio is ever issued and redemption and
// switch stay untestable. On the RTA route the same orders settle on demand.
//
// The sequences below are FP's, and the differences between them are the whole
// point — each was established by making FP reject the alternative:
//
//   purchase     create -> PATCH consent ALONE -> settlement -> PATCH state ALONE
//   redemption   create -> PATCH {state, consent} TOGETHER
//   switch       create -> PATCH {state, consent} TOGETHER
//
// A purchase needs money behind it, which off-FP means a settlement detail. A
// redemption and a switch move units the investor already holds, so there is
// nothing to settle and consent travels with the confirm.
//
// Everything here refuses to run outside the sandbox, by a computed fact rather
// than a flag: forging an allotment in production would be inventing money.
import { MfOrderState } from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import {
  fpConfig,
  fpErrorToHttpError,
  fpOrders,
  fpProfiles,
  fpSettlements,
  fpSimulation,
} from "../integrations/fp/index.ts";
import { HttpError } from "../utils/http-error.ts";
import { syncPurchase, syncRedemption, syncSwitch } from "./fp-sync/index.ts";
import { pullRedemptionPayout, resolveConsentContact, sendConsent } from "./order.service.ts";
import type { OrderDto } from "../types/order.types.ts";

/** FP needs a moment between transitions; these are not arbitrary. */
const SETTLE_PAUSE_MS = 1_200;

const pause = () => new Promise((resolve) => setTimeout(resolve, SETTLE_PAUSE_MS));

function assertSandbox(): void {
  if (!fpConfig().simulationEnabled) {
    throw HttpError.conflict(
      "Settling an order by simulation is a sandbox-only facility and must never run in production",
    );
  }
}

/**
 * Drive an order through the registrar, from whatever state it is in.
 *
 * `SUBMITTED` then `SUCCESSFUL`, in that order — FP rejects a jump straight to
 * successful from `pending`, because the registrar it is standing in for could
 * not have done that either.
 */
async function simulateToSuccess(oldId: number, state?: string): Promise<void> {
  const statuses = state === MfOrderState.SUBMITTED
    ? ["SUCCESSFUL"] as const
    : ["SUBMITTED", "SUCCESSFUL"] as const;
  for (const status of statuses) {
    await fpSimulation.simulateOrder(oldId, status);
    await pause();
  }
}

/**
 * Settle a purchase: consent alone, then the money, then the state alone.
 *
 * The two PATCHes cannot be merged. FP rejects a body carrying `state` and
 * `consent` together on a purchase, and refuses to confirm one with no money
 * behind it — so the settlement has to land between them.
 */
export async function settlePurchase(id: string): Promise<OrderDto> {
  assertSandbox();
  const { getOrder, refreshOrder } = await import("./order.service.ts");
  const order = await db.mfPurchase.findUnique({
    where: { id },
    select: {
      fpId: true,
      fpOldId: true,
      state: true,
      amount: true,
      consentAt: true,
      folioNumber: true,
      mfInvestmentAccountId: true,
    },
  });
  if (!order) throw HttpError.notFound("No such order");
  if (!order.fpOldId) throw HttpError.conflict("This order has no numeric id to simulate against");
  if (order.state === MfOrderState.SUCCESSFUL) return getOrder(id);

  try {
    if (!order.consentAt && order.state === MfOrderState.PENDING) {
      const contact = await resolveConsentContact(order.mfInvestmentAccountId, order.folioNumber);
      await sendConsent(contact, (consent) => fpOrders.updatePurchase({ id: order.fpId, consent }));
      await db.mfPurchase.update({
        where: { id },
        data: {
          consentEmail: contact.email,
          consentIsdCode: contact.isdCode,
          consentMobile: contact.mobile,
          consentAt: new Date(),
        },
      });
      await pause();
    }

    if (order.state === MfOrderState.PENDING) {
      const account = await db.mfInvestmentAccount.findUniqueOrThrow({
        where: { id: order.mfInvestmentAccountId }, select: { primaryInvestorProfileId: true },
      });
      const bank = await db.bankAccount.findFirst({
        where: { investorProfileId: account.primaryInvestorProfileId },
        select: { fpId: true }, orderBy: { createdAt: "asc" },
      });
      if (!bank) throw HttpError.conflict("Add a bank account before settling this purchase");
      const sourceBank = await fpProfiles.fetchBankAccount(bank.fpId);
      await fpSettlements.createSettlementDetail({
        mf_purchase: order.fpId,
        // Synthetic transfer details for sandbox simulation only (guarded above).
        payment_type: "netbanking",
        bank_account_number: sourceBank.account_number,
        bank_ifsc: sourceBank.ifsc_code,
        beneficiary_account_number: "1233453",
        beneficiary_account_title: "Sandbox MF Collection A/c",
        beneficiary_bank_name: "Sandbox Bank",
        utr_number: `SBX${order.fpOldId}`,
      });
      await pause();
      await fpOrders.updatePurchase({ id: order.fpId, state: "confirmed" });
      await pause();
    }

    await simulateToSuccess(order.fpOldId, order.state);
    await syncPurchase(await fpOrders.fetchPurchase(order.fpId), order.mfInvestmentAccountId);
    return refreshOrder(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Settle a redemption: one PATCH carrying state and consent together.
 *
 * There is no settlement step — the money flows towards the investor — so the
 * two-PATCH dance a purchase needs does not apply, and FP accepts the combined
 * body here that it rejects on a purchase.
 */
export async function settleRedemption(id: string): Promise<OrderDto> {
  assertSandbox();
  const { getOrder, refreshOrder } = await import("./order.service.ts");
  const order = await db.mfRedemption.findUnique({
    where: { id },
    select: {
      fpId: true,
      fpOldId: true,
      state: true,
      consentAt: true,
      folioNumber: true,
      mfInvestmentAccountId: true,
    },
  });
  if (!order) throw HttpError.notFound("No such order");
  if (!order.fpOldId) throw HttpError.conflict("This order has no numeric id to simulate against");
  if (order.state === MfOrderState.SUCCESSFUL) return getOrder(id);

  try {
    if (order.state === MfOrderState.PENDING) {
      const contact = await resolveConsentContact(order.mfInvestmentAccountId, order.folioNumber);
      await sendConsent(contact, (consent) =>
        fpOrders.updateRedemption({ id: order.fpId, state: "confirmed", consent }),
      );
      await db.mfRedemption.update({
        where: { id },
        data: {
          consentEmail: contact.email,
          consentIsdCode: contact.isdCode,
          consentMobile: contact.mobile,
          consentAt: new Date(),
        },
      });
      await pause();
    }

    await simulateToSuccess(order.fpOldId);
    const row = await syncRedemption(
      await fpOrders.fetchRedemption(order.fpId),
      order.mfInvestmentAccountId,
    );
    // The proceeds are the point of a redemption; nothing announces them.
    await pullRedemptionPayout(row.id, order.fpId);
    return refreshOrder(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** A switch settles exactly like a redemption: one combined PATCH, then simulate. */
export async function settleSwitch(id: string): Promise<OrderDto> {
  assertSandbox();
  const { getOrder, refreshOrder } = await import("./order.service.ts");
  const order = await db.mfSwitch.findUnique({
    where: { id },
    select: {
      fpId: true,
      fpOldId: true,
      state: true,
      consentAt: true,
      folioNumber: true,
      mfInvestmentAccountId: true,
    },
  });
  if (!order) throw HttpError.notFound("No such order");
  if (!order.fpOldId) throw HttpError.conflict("This order has no numeric id to simulate against");
  if (order.state === MfOrderState.SUCCESSFUL) return getOrder(id);

  try {
    if (order.state === MfOrderState.PENDING) {
      const contact = await resolveConsentContact(order.mfInvestmentAccountId, order.folioNumber);
      await sendConsent(contact, (consent) =>
        fpOrders.updateSwitch({ id: order.fpId, state: "confirmed", consent }),
      );
      await db.mfSwitch.update({
        where: { id },
        data: {
          consentEmail: contact.email,
          consentIsdCode: contact.isdCode,
          consentMobile: contact.mobile,
          consentAt: new Date(),
        },
      });
      await pause();
    }

    await simulateToSuccess(order.fpOldId);
    await syncSwitch(await fpOrders.fetchSwitch(order.fpId), order.mfInvestmentAccountId);
    return refreshOrder(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}
