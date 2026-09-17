// Receiving and applying FP webhooks.
//
// The contract with FP is: acknowledge fast, process later. A handler that does
// its work inline will eventually exceed FP's delivery timeout, FP will redeliver,
// and the same event gets applied twice under load — exactly when you least want
// it. So `receive` does nothing but write the raw event and return; `process`
// applies it afterwards.
//
// Idempotency comes from `FpWebhookEvent.fpEventId` being unique. A redelivery
// collides on insert instead of applying twice, and the event body is retained
// because it is the only evidence of what FP told us and when — which is what a
// reconciliation dispute actually turns on.
import { WebhookProcessingStatus } from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import {
  fpErrorToHttpError,
  fpEvents,
  fpOrders,
  fpPayments,
  fpPlans,
} from "../integrations/fp/index.ts";
import { HttpError } from "../utils/http-error.ts";
import { fpDateTime, fpJson, splitEventType } from "../utils/fp-mapping.ts";
import {
  syncKycRequest,
  syncMandate,
  syncPayment,
  syncPurchase,
  syncPurchasePlan,
  syncRedemption,
  syncRedemptionPlan,
  syncSwitch,
  syncSwitchPlan,
} from "./fp-sync/index.ts";

/** Give up after this many attempts and leave the row for an operator. */
const MAX_PROCESSING_ATTEMPTS = 5;

export interface ReceivedEvent {
  eventId: string;
  type: string;
  duplicate: boolean;
}

interface RawEvent {
  id?: unknown;
  type?: unknown;
  time?: unknown;
  data?: { object?: Record<string, unknown> } | null;
}

/**
 * Record a delivery. Cheap, and safe to call twice.
 *
 * Returns `duplicate: true` for a redelivery so the caller can still answer
 * 200 — FP must not be told to retry an event we already hold.
 */
export async function receive(payload: unknown): Promise<ReceivedEvent> {
  const incoming = payload as RawEvent;
  const eventId = typeof incoming?.id === "string" ? incoming.id : null;
  if (!eventId || !/^evt_[A-Za-z0-9]{16,64}$/.test(eventId)) throw HttpError.badRequest("Invalid FP event identifier");
  // The notification is only a hint. Authenticate the event through our tenant
  // before allowing its id to occupy the durable deduplication key.
  const event = await fpEvents.fetchEvent(eventId).catch(fpErrorToHttpError);
  if (event.id !== eventId || typeof event.type !== "string") throw HttpError.badGateway("Invalid event response");
  const type = event.type;

  const { objectType } = splitEventType(type);
  const objectFpId =
    typeof event.data?.object?.["id"] === "string" ? event.data.object["id"] : null;

  // createMany + skipDuplicates rather than create-and-catch-P2002: a
  // redelivery is a normal, expected event, and catching it as an exception
  // means Prisma logs a unique-constraint error for something that is not a
  // problem. `count` tells us which case it was.
  const { count } = await db.fpWebhookEvent.createMany({
    data: [
      {
        fpEventId: eventId,
        type,
        objectType,
        objectFpId,
        payload: fpJson(event) ?? {},
        occurredAt: fpDateTime(event.time),
      },
    ],
    skipDuplicates: true,
  });

  return { eventId, type, duplicate: count === 0 };
}

/**
 * Apply pending events, oldest first.
 *
 * Re-fetching the object from FP rather than trusting the event body is
 * deliberate. Deliveries arrive out of order — a `successful` can land before
 * the `submitted` that preceded it — and applying a stale body would walk the
 * mirror backwards. One extra GET buys us the current truth.
 */
export async function processPending(limit = 50): Promise<{ processed: number; failed: number }> {
  const pending = await db.fpWebhookEvent.findMany({
    where: {
      status: WebhookProcessingStatus.PENDING,
      attempts: { lt: MAX_PROCESSING_ATTEMPTS },
    },
    orderBy: { receivedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: { id: true, type: true, objectFpId: true, attempts: true },
  });

  let processed = 0;
  let failed = 0;

  for (const event of pending) {
    try {
      const outcome = await applyEvent(event.type, event.objectFpId);
      await db.fpWebhookEvent.update({
        where: { id: event.id },
        data: {
          status: outcome
            ? WebhookProcessingStatus.PROCESSED
            : WebhookProcessingStatus.IGNORED,
          processedAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      processed++;
    } catch (error) {
      const attempts = event.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      await db.fpWebhookEvent.update({
        where: { id: event.id },
        data: {
          attempts,
          lastError: message.slice(0, 1000),
          // Only give up once the retries are exhausted; until then leave it
          // PENDING so the next run picks it up.
          ...(attempts >= MAX_PROCESSING_ATTEMPTS && {
            status: WebhookProcessingStatus.FAILED,
          }),
        },
      });
      console.error(`[fp-webhook] ${event.type} failed (attempt ${attempts}): ${message}`);
      failed++;
    }
  }

  return { processed, failed };
}

/** Find the local investment account an FP object belongs to. */
async function accountIdByFpId(fpId: string | null): Promise<string | null> {
  if (!fpId) return null;
  const account = await db.mfInvestmentAccount.findUnique({
    where: { fpId },
    select: { id: true },
  });
  return account?.id ?? null;
}

/**
 * Apply one event. Returns false when the event is recognised but not acted
 * on, which is recorded as IGNORED rather than treated as a failure.
 */
async function applyEvent(type: string, objectFpId: string | null): Promise<boolean> {
  const { objectType } = splitEventType(type);
  if (!objectFpId) return false;

  try {
    switch (objectType) {
      case "mf_purchase": {
        const order = await fpOrders.fetchPurchase(objectFpId);
        const accountId = await accountIdByFpId(order.mf_investment_account);
        if (!accountId) return false;
        await syncPurchase(order, accountId);
        return true;
      }
      case "mf_redemption": {
        const order = await fpOrders.fetchRedemption(objectFpId);
        const accountId = await accountIdByFpId(order.mf_investment_account);
        if (!accountId) return false;
        const row = await syncRedemption(order, accountId);
        // Nothing announces a payout — there is no `mf_payout_detail` event —
        // so the redemption's own success event is the trigger for looking.
        if (order.state === "successful") {
          const { pullRedemptionPayout } = await import("./order.service.ts");
          await pullRedemptionPayout(row.id, order.id);
        }
        return true;
      }
      case "mf_switch": {
        const order = await fpOrders.fetchSwitch(objectFpId);
        const accountId = await accountIdByFpId(order.mf_investment_account);
        if (!accountId) return false;
        await syncSwitch(order, accountId);
        return true;
      }
      case "mf_purchase_plan": {
        const plan = await fpPlans.fetchPurchasePlan(objectFpId);
        const accountId = await accountIdByFpId(plan.mf_investment_account);
        if (!accountId) return false;
        await syncPurchasePlan(plan, accountId);
        return true;
      }
      case "mf_redemption_plan": {
        const plan = await fpPlans.fetchRedemptionPlan(objectFpId);
        const accountId = await accountIdByFpId(plan.mf_investment_account);
        if (!accountId) return false;
        await syncRedemptionPlan(plan, accountId);
        return true;
      }
      case "mf_switch_plan": {
        const plan = await fpPlans.fetchSwitchPlan(objectFpId);
        const accountId = await accountIdByFpId(plan.mf_investment_account);
        if (!accountId) return false;
        await syncSwitchPlan(plan, accountId);
        return true;
      }
      case "mandate": {
        // Mandate and payment ids are integers on this gateway.
        const numericId = Number(objectFpId);
        if (!Number.isInteger(numericId)) return false;
        await syncMandate(await fpPayments.fetchMandate(numericId));
        return true;
      }
      case "payment": {
        const numericId = Number(objectFpId);
        if (!Number.isInteger(numericId)) return false;
        await syncPayment(await fpPayments.fetchPayment(numericId));
        return true;
      }
      case "kyc_request": {
        const { fpIdentity } = await import("../integrations/fp/index.ts");
        await syncKycRequest(await fpIdentity.fetchKycRequest(objectFpId));
        return true;
      }
      default:
        // An event type we do not model. Recorded, not acted on — the row is
        // the evidence that we saw it, so adding support later is possible.
        console.warn(`[fp-webhook] no handler for ${type}`);
        return false;
    }
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** Operational view for the admin subdomain. */
export async function webhookBacklog(): Promise<{
  pending: number;
  failed: number;
  oldestPendingAt: string | null;
}> {
  const [pending, failed, oldest] = await Promise.all([
    db.fpWebhookEvent.count({ where: { status: WebhookProcessingStatus.PENDING } }),
    db.fpWebhookEvent.count({ where: { status: WebhookProcessingStatus.FAILED } }),
    db.fpWebhookEvent.findFirst({
      where: { status: WebhookProcessingStatus.PENDING },
      orderBy: { receivedAt: "asc" },
      select: { receivedAt: true },
    }),
  ]);

  return {
    pending,
    failed,
    oldestPendingAt: oldest?.receivedAt.toISOString() ?? null,
  };
}
