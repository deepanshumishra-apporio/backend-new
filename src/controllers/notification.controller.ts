import type { Request, Response } from "express";
import { investorId } from "../middleware/investor-auth.ts";
import * as notificationService from "../services/notification.service.ts";
import { HttpError } from "../utils/http-error.ts";

type NotificationParams = { notificationId: string };

export async function list(req: Request, res: Response) {
  const cursor = req.query["cursor"];
  if (cursor !== undefined && (typeof cursor !== "string" || !/^[0-9a-f-]{36}$/i.test(cursor))) {
    throw HttpError.badRequest("cursor must be a notification id");
  }
  const unread = req.query["unread"];
  if (unread !== undefined && unread !== "true" && unread !== "false") {
    throw HttpError.badRequest("unread must be true or false");
  }
  res.json({
    data: await notificationService.listNotifications(investorId(req), {
      ...(typeof cursor === "string" && { cursor }),
      unreadOnly: unread === "true",
    }),
  });
}

export async function unreadCount(req: Request, res: Response) {
  res.json({ data: { unreadCount: await notificationService.unreadCount(investorId(req)) } });
}

export async function markRead(req: Request<NotificationParams>, res: Response) {
  res.json({ data: await notificationService.markRead(investorId(req), req.params.notificationId) });
}

export async function markAllRead(req: Request, res: Response) {
  res.json({ data: await notificationService.markAllRead(investorId(req)) });
}
