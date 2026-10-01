import { Router } from "express";
import * as announcements from "../controllers/announcement.controller.ts";
import * as notifications from "../controllers/notification.controller.ts";

export const notificationRouter = Router();

notificationRouter.get("/", notifications.list);
notificationRouter.get("/unread-count", notifications.unreadCount);
// Whether the investor receives offers and promotions. Transactional notifications ignore it.
notificationRouter.get("/preferences", announcements.getPreferences);
notificationRouter.put("/preferences", announcements.setPreferences);
notificationRouter.post("/read-all", notifications.markAllRead);
notificationRouter.post("/:notificationId/read", notifications.markRead);
