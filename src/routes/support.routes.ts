import { Router } from "express";
import * as support from "../controllers/support.controller.ts";

/** The investor's side of support: their requests and the in-app chat. */
export const supportRouter = Router();

supportRouter.get("/tickets", support.listTickets);
supportRouter.post("/tickets", support.createTicket);
supportRouter.get("/tickets/:ticketId", support.getTicket);
supportRouter.post("/tickets/:ticketId/messages", support.replyToTicket);

supportRouter.get("/chat", support.getChat);
supportRouter.post("/chat/messages", support.sendChatMessage);
supportRouter.post("/chat/handover", support.requestHuman);
supportRouter.post("/chat/end", support.endChat);
