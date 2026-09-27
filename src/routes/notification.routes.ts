import { Router } from "express";
import * as notifications from "../controllers/notification.controller.ts";

export const notificationRouter = Router();

notificationRouter.get("/", notifications.list);
notificationRouter.get("/unread-count", notifications.unreadCount);
notificationRouter.post("/read-all", notifications.markAllRead);
notificationRouter.post("/:notificationId/read", notifications.markRead);
