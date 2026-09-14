import type { Request, Response } from "express";
import * as webhookService from "../services/fp-webhook.service.ts";
import { HttpError } from "../utils/http-error.ts";

/**
 * Receive an FP webhook delivery.
 *
 * Answers 200 as fast as it can: the only work done inline is writing the raw
 * event. Anything heavier risks exceeding FP's delivery timeout, which makes FP
 * redeliver and multiplies the load exactly when the system is already
 * struggling.
 *
 * A redelivery also answers 200 — telling FP to retry an event we already hold
 * would be a lie, and `fpEventId` being unique means it cannot be applied twice.
 */
export async function receive(req: Request, res: Response) {
  const received = await webhookService.receive(req.body);
  res.status(200).json({ data: { received: true, duplicate: received.duplicate } });
}

/**
 * Apply pending events.
 *
 * Exposed as an endpoint so a scheduler (or an operator) can drive it. It is
 * deliberately not called from `receive`: the write and the work are separate
 * so a slow FP read can never delay an acknowledgement.
 */
export async function processPending(req: Request, res: Response) {
  const rawLimit = req.query["limit"];
  const limit = typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : 50;
  res.json({ data: await webhookService.processPending(limit) });
}

/** Operational health: is the mirror keeping up? */
export async function backlog(_req: Request, res: Response) {
  res.json({ data: await webhookService.webhookBacklog() });
}

/** Guard the process/backlog endpoints with a shared secret from the env. */
export function requireWebhookAdminSecret(req: Request): void {
  const expected = process.env["FP_WEBHOOK_ADMIN_SECRET"]?.trim();
  if (!expected) {
    throw HttpError.serviceUnavailable("Webhook administration is not configured");
  }
  const provided = req.headers["x-admin-secret"];
  if (typeof provided !== "string" || provided !== expected) {
    throw new HttpError(403, "FORBIDDEN", "Not allowed");
  }
}
