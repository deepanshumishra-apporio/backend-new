// Events and webhook subscriptions.
//
// Webhooks are how the mirror stays fresh without polling. Events are the
// backstop: if a delivery is missed, the event list is replayable.
import { fpList, fpRequest } from "../fp.http.ts";
import type { FpEvent, FpNotificationWebhook } from "../fp.types.ts";

/** Capped at 100, newest first. */
export async function listEvents(
  query: { type?: string },
  requestId?: string,
): Promise<FpEvent[]> {
  return fpList<FpEvent>("/v2/events", query, requestId);
}

export async function fetchEvent(id: string, requestId?: string): Promise<FpEvent> {
  return fpRequest<FpEvent>({
    method: "GET",
    path: `/v2/events/${id}`,
    ...(requestId && { requestId }),
  });
}

/**
 * Subscribe a URL to one event type.
 *
 * One webhook per event type — there is no wildcard, so a full subscription is
 * a loop over FP_WEBHOOK_EVENTS.
 */
export async function createNotificationWebhook(
  payload: { event: string; url: string; status: "enabled" | "disabled" },
  requestId?: string,
): Promise<FpNotificationWebhook> {
  return fpRequest<FpNotificationWebhook>({
    method: "POST",
    path: "/v2/notification_webhooks",
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function listNotificationWebhooks(
  query: { event?: string },
  requestId?: string,
): Promise<FpNotificationWebhook[]> {
  return fpList<FpNotificationWebhook>("/v2/notification_webhooks", query, requestId);
}

export async function updateNotificationWebhook(
  id: string,
  payload: { url: string; status: "enabled" | "disabled" },
  requestId?: string,
): Promise<FpNotificationWebhook> {
  return fpRequest<FpNotificationWebhook>({
    method: "PUT",
    path: `/v2/notification_webhooks/${id}`,
    body: payload,
    retry: false,
    ...(requestId && { requestId }),
  });
}

/**
 * Every event type this platform cares about.
 *
 * Order matters only for readability. Subscribing to an event we do not handle
 * is harmless — the receiver records it as IGNORED — but NOT subscribing to one
 * we depend on leaves the mirror silently stale.
 */
export const FP_WEBHOOK_EVENTS = [
  "kyc_request.esign_required",
  "kyc_request.submitted",
  "kyc_request.successful",
  "kyc_request.rejected",
  "kyc_request.expired",

  "mf_purchase.created",
  "mf_purchase.confirmed",
  "mf_purchase.submitted",
  "mf_purchase.successful",
  "mf_purchase.failed",
  "mf_purchase.cancelled",
  "mf_purchase.reversed",

  "mf_redemption.created",
  "mf_redemption.confirmed",
  "mf_redemption.submitted",
  "mf_redemption.successful",
  "mf_redemption.failed",
  "mf_redemption.cancelled",
  "mf_redemption.reversed",

  "mf_switch.created",
  "mf_switch.confirmed",
  "mf_switch.submitted",
  "mf_switch.successful",
  "mf_switch.failed",
  "mf_switch.cancelled",
  "mf_switch.reversed",

  "mf_purchase_plan.created",
  "mf_purchase_plan.activated",
  "mf_purchase_plan.cancelled",
  "mf_purchase_plan.failed",
  "mf_purchase_plan.completed",

  "mf_redemption_plan.created",
  "mf_redemption_plan.activated",
  "mf_redemption_plan.cancelled",
  "mf_redemption_plan.failed",
  "mf_redemption_plan.completed",

  "mf_switch_plan.created",
  "mf_switch_plan.activated",
  "mf_switch_plan.cancelled",
  "mf_switch_plan.failed",
  "mf_switch_plan.completed",

  "mandate.created",
  "mandate.received",
  "mandate.submitted",
  "mandate.approved",
  "mandate.rejected",
  "mandate.cancelled",

  "payment.pending",
  "payment.initiated",
  "payment.submitted",
  "payment.approved",
  "payment.rejected",
  "payment.success",
  "payment.failed",
] as const;

export type FpWebhookEventType = (typeof FP_WEBHOOK_EVENTS)[number];
