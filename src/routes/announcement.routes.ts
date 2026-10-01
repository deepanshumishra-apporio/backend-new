import { Router } from "express";
import * as announcements from "../controllers/announcement.controller.ts";

/** The investor's side of announcements: the home banner, and marking it seen or tapped. */
export const announcementRouter = Router();

announcementRouter.get("/active", announcements.activeBanner);
announcementRouter.post("/:announcementId/seen", announcements.seen);
announcementRouter.post("/:announcementId/clicked", announcements.clicked);
