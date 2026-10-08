import type { Request, Response } from "express";
import { investorId } from "../middleware/investor-auth.ts";
import * as chats from "../services/support-chat.service.ts";
import * as tickets from "../services/support-ticket.service.ts";
import { TICKET_CATEGORIES, type BotReplyInput } from "../types/support.types.ts";
import { parseRelated } from "../utils/support-input.ts";
import { asBody, oneOf, optionalString, requiredString } from "../utils/validate.ts";

type TicketParams = { ticketId: string };

// --- tickets ("My requests") ------------------------------------------------------------

export async function listTickets(req: Request, res: Response) {
  res.json({ data: await tickets.listMyTickets(investorId(req)) });
}

export async function getTicket(req: Request<TicketParams>, res: Response) {
  res.json({ data: await tickets.getMyTicket(investorId(req), req.params.ticketId) });
}

export async function createTicket(req: Request, res: Response) {
  const body = asBody(req.body);
  const related = parseRelated(body);
  res.status(201).json({
    data: await tickets.createMyTicket(investorId(req), {
      subject: requiredString(body, "subject", { maxLength: 160 }),
      category: oneOf(body, "category", TICKET_CATEGORIES)!,
      body: requiredString(body, "body", { maxLength: 4000 }),
      ...(related && { related }),
    }),
  });
}

export async function replyToTicket(req: Request<TicketParams>, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await tickets.replyToMyTicket(investorId(req), req.params.ticketId, requiredString(body, "body", { maxLength: 4000 })),
  });
}

// --- chat -------------------------------------------------------------------------

export async function getChat(req: Request, res: Response) {
  res.json({ data: await chats.getMyChat(investorId(req)) });
}

/** The investor's message, with Ri's answer when the app worked one out. */
export async function sendChatMessage(req: Request, res: Response) {
  const body = asBody(req.body);
  const text = requiredString(body, "body", { maxLength: 2000 });
  let botReply: BotReplyInput | undefined;
  if (body["botReply"] !== undefined && body["botReply"] !== null) {
    const reply = asBody(body["botReply"]);
    const intent = optionalString(reply, "intent", { maxLength: 60 });
    // Ri's answer is a record of what the app showed, not input to judge: a long
    // list of SIPs is kept, cut to the column, rather than failing the investor's message.
    const answer = requiredString(reply, "body", { maxLength: 20000 });
    botReply = { body: answer.length > 2000 ? `${answer.slice(0, 1999)}…` : answer, ...(intent && { intent }) };
  }
  res.status(201).json({ data: await chats.sendMyMessage(investorId(req), text, botReply) });
}

export async function requestHuman(req: Request, res: Response) {
  res.json({ data: await chats.requestHuman(investorId(req)) });
}

export async function endChat(req: Request, res: Response) {
  res.json({ data: await chats.endMyChat(investorId(req)) });
}
