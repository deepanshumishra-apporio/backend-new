import type { Request, Response } from "express";
import { staffPrincipal } from "../middleware/staff-auth.ts";
import * as chats from "../services/support-chat.service.ts";
import * as tickets from "../services/support-ticket.service.ts";
import {
  CHAT_VIEWS,
  STAFF_CHANNELS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type ChatView,
  type UpdateTicketInput,
} from "../types/support.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { isUuid, queryBoolean, queryCursor, queryLimit, queryList, queryString } from "../utils/query.ts";
import { parseRelated } from "../utils/support-input.ts";
import { asBody, oneOf, requiredString } from "../utils/validate.ts";

type TicketParams = { ticketId: string };
type ChatParams = { chatId: string };

function ticketId(req: Request<TicketParams>): string {
  if (!isUuid(req.params.ticketId)) throw HttpError.notFound("No ticket with that id");
  return req.params.ticketId;
}

function chatId(req: Request<ChatParams>): string {
  if (!isUuid(req.params.chatId)) throw HttpError.notFound("No chat with that id");
  return req.params.chatId;
}

// --- tickets --------------------------------------------------------------------

export async function listTickets(req: Request, res: Response) {
  const viewer = staffPrincipal(req);
  const assigneeRaw = queryString(req.query, "assignee");
  const assignee = assigneeRaw === "me" ? viewer.staffId : assigneeRaw;
  if (assignee && assignee !== "unassigned" && !isUuid(assignee)) {
    throw HttpError.badRequest("assignee must be me, unassigned or a staff id");
  }
  const status = queryList(req.query, "status", TICKET_STATUSES);
  const priority = queryList(req.query, "priority", TICKET_PRIORITIES);
  const category = queryList(req.query, "category", TICKET_CATEGORIES);
  const overdue = queryBoolean(req.query, "overdue");
  const search = queryString(req.query, "search");
  const cursor = queryCursor(req.query);
  res.json({
    data: await tickets.listTickets({
      limit: queryLimit(req.query, 25, 100),
      ...(status && { status }),
      ...(priority && { priority }),
      ...(category && { category }),
      ...(assignee && { assignee }),
      ...(overdue && { overdue }),
      ...(search && { search }),
      ...(cursor && { cursor }),
    }, viewer),
  });
}

export async function getTicket(req: Request<TicketParams>, res: Response) {
  res.json({ data: await tickets.getTicket(ticketId(req)) });
}

export async function createTicket(req: Request, res: Response) {
  const body = asBody(req.body);
  const userId = requiredString(body, "userId");
  if (!isUuid(userId)) throw HttpError.badRequest("userId must be an investor id");
  const related = parseRelated(body);
  const ticket = await tickets.createStaffTicket({
    userId,
    subject: requiredString(body, "subject", { maxLength: 160 }),
    category: oneOf(body, "category", TICKET_CATEGORIES)!,
    priority: oneOf(body, "priority", TICKET_PRIORITIES, false) ?? "NORMAL",
    channel: oneOf(body, "channel", STAFF_CHANNELS)!,
    body: requiredString(body, "body", { maxLength: 4000 }),
    ...(related && { related }),
  }, staffPrincipal(req));
  res.status(201).json({ data: ticket });
}

export async function updateTicket(req: Request<TicketParams>, res: Response) {
  const body = asBody(req.body);
  const input: UpdateTicketInput = {};
  const status = oneOf(body, "status", TICKET_STATUSES, false);
  const priority = oneOf(body, "priority", TICKET_PRIORITIES, false);
  const category = oneOf(body, "category", TICKET_CATEGORIES, false);
  if (status) input.status = status;
  if (priority) input.priority = priority;
  if (category) input.category = category;
  if ("assigneeId" in body) {
    const raw = body["assigneeId"];
    if (raw !== null && (typeof raw !== "string" || !isUuid(raw))) throw HttpError.badRequest("assigneeId must be a staff id or null");
    input.assigneeId = raw;
  }
  if (!Object.keys(input).length) throw HttpError.badRequest("Nothing to change");
  res.json({ data: await tickets.updateTicket(ticketId(req), input, staffPrincipal(req)) });
}

export async function replyToTicket(req: Request<TicketParams>, res: Response) {
  const body = asBody(req.body);
  const internal = body["internal"] ?? false;
  if (typeof internal !== "boolean") throw HttpError.badRequest("internal must be true or false");
  const status = oneOf(body, "status", TICKET_STATUSES, false);
  res.status(201).json({
    data: await tickets.staffReply(ticketId(req), {
      body: requiredString(body, "body", { maxLength: 4000 }),
      internal,
      ...(status && { status }),
    }, staffPrincipal(req)),
  });
}

export async function agents(_req: Request, res: Response) {
  res.json({ data: await tickets.listAgents() });
}

// --- chats ----------------------------------------------------------------------

export async function listChats(req: Request, res: Response) {
  const view = (queryString(req.query, "view") ?? "live") as ChatView;
  if (!CHAT_VIEWS.includes(view)) throw HttpError.badRequest(`view must be one of: ${CHAT_VIEWS.join(", ")}`);
  res.json({ data: await chats.listChats(view, staffPrincipal(req)) });
}

export async function getChat(req: Request<ChatParams>, res: Response) {
  res.json({ data: await chats.getChat(chatId(req)) });
}

export async function takeOver(req: Request<ChatParams>, res: Response) {
  res.json({ data: await chats.takeOver(chatId(req), staffPrincipal(req)) });
}

export async function handBack(req: Request<ChatParams>, res: Response) {
  res.json({ data: await chats.handBack(chatId(req), staffPrincipal(req)) });
}

export async function sendChatMessage(req: Request<ChatParams>, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await chats.sendStaffMessage(chatId(req), requiredString(body, "body", { maxLength: 2000 }), staffPrincipal(req)),
  });
}

export async function closeChat(req: Request<ChatParams>, res: Response) {
  res.json({ data: await chats.closeChat(chatId(req), staffPrincipal(req)) });
}

export async function escalateChat(req: Request<ChatParams>, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await chats.escalate(chatId(req), {
      subject: requiredString(body, "subject", { maxLength: 160 }),
      category: oneOf(body, "category", TICKET_CATEGORIES)!,
      priority: oneOf(body, "priority", TICKET_PRIORITIES, false) ?? "NORMAL",
    }, staffPrincipal(req)),
  });
}
