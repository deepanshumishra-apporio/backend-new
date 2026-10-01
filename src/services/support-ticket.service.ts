// Support tickets: tracked requests with an owner, a status and an SLA.
//
// Staff and investors share one table but not one view. Staff see every
// message, internal notes and the full history; the investor sees only the
// public thread and a first name for whoever answered. Every status, owner,
// priority and category change is written to `support_ticket_events`, so a
// ticket can always say who moved it where and when.
//
// The SLA is a resolution deadline from the ticket's priority, in calendar
// hours from when it was raised. "Overdue" is judged at read time against
// now(), because time passing changes no row.
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { maskEmail, maskPan, maskTail } from "../utils/mask.ts";
import { notify } from "./notification.service.ts";
import type {
  CreateInvestorTicketInput,
  CreateStaffTicketInput,
  InvestorTicketDetailDto,
  InvestorTicketDto,
  StaffRefDto,
  StaffReplyInput,
  TicketDetailDto,
  TicketInvestorDto,
  TicketListDto,
  TicketListItemDto,
  TicketListQuery,
  TicketMessageDto,
  TicketPriority,
  TicketRelatedType,
  TicketStatus,
  TicketSummaryDto,
  UpdateTicketInput,
} from "../types/support.types.ts";
import type { StaffPrincipal } from "../types/staff.types.ts";

const HOUR_MS = 60 * 60 * 1000;

/** Resolution deadline per priority, in hours. */
export const SLA_HOURS: Record<TicketPriority, number> = { URGENT: 4, HIGH: 24, NORMAL: 48, LOW: 72 };

const slaFrom = (createdAt: Date, priority: TicketPriority) => new Date(createdAt.getTime() + SLA_HOURS[priority] * HOUR_MS);

const DONE: TicketStatus[] = ["RESOLVED", "CLOSED"];
const LIVE: TicketStatus[] = ["OPEN", "IN_PROGRESS", "WAITING_ON_INVESTOR"];

export const reference = (number: number) => `RS-${number}`;

/** "RS-100001", "rs100001" or "100001" → 100001. */
function referenceNumber(search: string): number | null {
  const match = /^(?:rs-?)?(\d{4,9})$/i.exec(search.trim());
  return match?.[1] ? Number(match[1]) : null;
}

const firstName = (fullName: string) => fullName.trim().split(/\s+/)[0] ?? fullName;

// --- reading ---------------------------------------------------------------------

const ticketSelect = {
  id: true, number: true, subject: true, category: true, priority: true, status: true, channel: true,
  userId: true, slaDueAt: true, awaitingStaff: true, lastMessageAt: true, createdAt: true,
  assignedStaff: { select: { id: true, fullName: true } },
} as const satisfies Prisma.SupportTicketSelect;

type TicketRow = Prisma.SupportTicketGetPayload<{ select: typeof ticketSelect }>;

const staffRef = (staff: { id: string; fullName: string } | null): StaffRefDto | null =>
  staff ? { id: staff.id, name: staff.fullName } : null;

/** Investor identity for staff screens, from the admin read model and masked as everywhere else. */
async function investorsById(userIds: string[]): Promise<Map<string, TicketInvestorDto>> {
  const rows = await db.investorJourneySnapshot.findMany({
    where: { userId: { in: [...new Set(userIds)] } },
    select: { userId: true, name: true, phone: true, email: true, pan: true },
  });
  return new Map(rows.map((row) => [row.userId, {
    id: row.userId, name: row.name, phone: maskTail(row.phone), email: maskEmail(row.email), pan: maskPan(row.pan),
  }]));
}

const unknownInvestor = (userId: string): TicketInvestorDto => ({ id: userId, name: null, phone: null, email: null, pan: null });

function toListItem(row: TicketRow, investors: Map<string, TicketInvestorDto>, now = Date.now()): TicketListItemDto {
  return {
    id: row.id,
    reference: reference(row.number),
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    channel: row.channel,
    investor: investors.get(row.userId) ?? unknownInvestor(row.userId),
    assignee: staffRef(row.assignedStaff),
    slaDueAt: row.slaDueAt.toISOString(),
    overdue: !DONE.includes(row.status) && row.slaDueAt.getTime() < now,
    awaitingStaff: row.awaitingStaff,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export const encodeTicketCursor = (row: { lastMessageAt: string; id: string }) =>
  Buffer.from(`${row.lastMessageAt}|${row.id}`).toString("base64url");

async function summary(staffId: string): Promise<TicketSummaryDto> {
  const live = { status: { in: LIVE } } satisfies Prisma.SupportTicketWhereInput;
  const [open, unassigned, overdue, awaitingStaff, waitingOnInvestor, mine] = await Promise.all([
    db.supportTicket.count({ where: live }),
    db.supportTicket.count({ where: { ...live, assignedStaffId: null } }),
    db.supportTicket.count({ where: { ...live, slaDueAt: { lt: new Date() } } }),
    db.supportTicket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] }, awaitingStaff: true } }),
    db.supportTicket.count({ where: { status: "WAITING_ON_INVESTOR" } }),
    db.supportTicket.count({ where: { ...live, assignedStaffId: staffId } }),
  ]);
  return { open, unassigned, overdue, awaitingStaff, waitingOnInvestor, mine };
}

export async function listTickets(query: TicketListQuery, viewer: StaffPrincipal): Promise<TicketListDto> {
  const and: Prisma.SupportTicketWhereInput[] = [];
  if (query.status) and.push({ status: { in: query.status } });
  if (query.priority) and.push({ priority: { in: query.priority } });
  if (query.category) and.push({ category: { in: query.category } });
  if (query.assignee === "unassigned") and.push({ assignedStaffId: null });
  else if (query.assignee) and.push({ assignedStaffId: query.assignee });
  if (query.overdue) and.push({ status: { in: LIVE }, slaDueAt: { lt: new Date() } });
  if (query.search) {
    const number = referenceNumber(query.search);
    const matches = await db.investorJourneySnapshot.findMany({
      where: { name: { contains: query.search, mode: "insensitive" } },
      select: { userId: true },
      take: 200,
    });
    and.push({
      OR: [
        ...(number !== null ? [{ number }] : []),
        { subject: { contains: query.search, mode: "insensitive" } },
        ...(matches.length ? [{ userId: { in: matches.map((m) => m.userId) } }] : []),
      ],
    });
  }
  const where: Prisma.SupportTicketWhereInput = and.length ? { AND: and } : {};
  const page: Prisma.SupportTicketWhereInput = query.cursor
    ? {
        AND: [where, {
          OR: [
            { lastMessageAt: { lt: query.cursor.at } },
            { lastMessageAt: query.cursor.at, id: { lt: query.cursor.id } },
          ],
        }],
      }
    : where;

  const [rows, total, counts] = await Promise.all([
    db.supportTicket.findMany({
      where: page,
      select: ticketSelect,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    }),
    db.supportTicket.count({ where }),
    summary(viewer.staffId),
  ]);
  const shown = rows.slice(0, query.limit);
  const investors = await investorsById(shown.map((row) => row.userId));
  const items = shown.map((row) => toListItem(row, investors));
  const last = items.at(-1);
  return {
    items,
    total,
    nextCursor: rows.length > query.limit && last ? encodeTicketCursor(last) : null,
    summary: counts,
  };
}

const detailSelect = {
  ...ticketSelect,
  relatedType: true, relatedId: true, chatConversationId: true, firstResponseAt: true, resolvedAt: true, closedAt: true,
  openedByStaff: { select: { id: true, fullName: true } },
  messages: {
    orderBy: { createdAt: "asc" },
    select: { id: true, author: true, body: true, internal: true, createdAt: true, staff: { select: { fullName: true } } },
  },
  events: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true, type: true, actor: true, fromValue: true, toValue: true, createdAt: true,
      actorStaff: { select: { fullName: true } },
    },
  },
} as const satisfies Prisma.SupportTicketSelect;

export async function getTicket(id: string): Promise<TicketDetailDto> {
  const row = await db.supportTicket.findUnique({ where: { id }, select: detailSelect });
  if (!row) throw HttpError.notFound("No ticket with that id");
  const investors = await investorsById([row.userId]);
  return {
    ...toListItem(row, investors),
    related: row.relatedType && row.relatedId ? { type: row.relatedType as TicketRelatedType, id: row.relatedId } : null,
    chatConversationId: row.chatConversationId,
    firstResponseAt: row.firstResponseAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    openedBy: staffRef(row.openedByStaff),
    messages: row.messages.map((message) => ({
      id: message.id,
      author: message.author,
      staffName: message.staff?.fullName ?? null,
      body: message.body,
      internal: message.internal,
      createdAt: message.createdAt.toISOString(),
    })),
    events: row.events.map((event) => ({
      id: event.id,
      type: event.type,
      actor: event.actor,
      staffName: event.actorStaff?.fullName ?? null,
      from: event.fromValue,
      to: event.toValue,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

/** Active staff who can work tickets, for the assignee picker. */
export async function listAgents(): Promise<StaffRefDto[]> {
  const rows = await db.staffUser.findMany({
    where: agentWhere(),
    select: { id: true, fullName: true },
    orderBy: { fullName: "asc" },
  });
  return rows.map((row) => ({ id: row.id, name: row.fullName }));
}

const agentWhere = (): Prisma.StaffUserWhereInput => ({
  status: "ACTIVE",
  roles: { some: { role: { permissions: { some: { permissionKey: "support.manage" } } } } },
});

async function assertAgent(staffId: string): Promise<void> {
  const agent = await db.staffUser.findFirst({ where: { id: staffId, ...agentWhere() }, select: { id: true } });
  if (!agent) throw HttpError.badRequest("That staff member cannot be assigned tickets");
}

// --- related records ---------------------------------------------------------------

/** The related order, plan or payment must be this investor's, or the link would leak someone else's record. */
async function assertRelated(userId: string, related: { type: TicketRelatedType; id: string }): Promise<void> {
  const account = { primaryInvestorProfile: { userLinks: { some: { userId, relationship: "SELF" as const } } } };
  let found: unknown;
  if (related.type === "order") {
    const where = { id: related.id, mfInvestmentAccount: account };
    found = (await db.mfPurchase.findFirst({ where, select: { id: true } }))
      ?? (await db.mfRedemption.findFirst({ where, select: { id: true } }))
      ?? (await db.mfSwitch.findFirst({ where, select: { id: true } }));
  } else if (related.type === "plan") {
    const where = { id: related.id, mfInvestmentAccount: account };
    found = (await db.mfPurchasePlan.findFirst({ where, select: { id: true } }))
      ?? (await db.mfRedemptionPlan.findFirst({ where, select: { id: true } }))
      ?? (await db.mfSwitchPlan.findFirst({ where, select: { id: true } }));
  } else {
    found = await db.payment.findFirst({
      where: { id: related.id, purchases: { some: { mfPurchase: { mfInvestmentAccount: account } } } },
      select: { id: true },
    });
  }
  if (!found) throw HttpError.badRequest(`No ${related.type} with that id for this investor`);
}

// --- writing ---------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

function event(tx: Tx, ticketId: string, staffId: string | null, type: string, from?: string | null, to?: string | null) {
  return tx.supportTicketEvent.create({
    data: {
      ticketId, type, actor: staffId ? "STAFF" : "INVESTOR", actorStaffId: staffId,
      fromValue: from ?? null, toValue: to ?? null,
    },
  });
}

/** Timestamps that follow a status: resolving stamps, reopening clears. */
function statusStamps(status: TicketStatus, now: Date): Prisma.SupportTicketUpdateInput {
  if (status === "RESOLVED") return { status, resolvedAt: now, closedAt: null };
  if (status === "CLOSED") return { status, closedAt: now };
  return { status, resolvedAt: null, closedAt: null };
}

/** Tell the investor a person replied. Never throws; a notification is never worth a failed reply. */
async function notifyReply(ticket: { id: string; number: number; userId: string; subject: string }, messageId: string) {
  await notify({
    userId: ticket.userId,
    category: "ACCOUNT",
    title: `Support replied on ${reference(ticket.number)}`,
    body: ticket.subject,
    dedupeKey: `ticket:${ticket.id}:message:${messageId}`,
    targetType: "ticket",
    targetId: ticket.id,
  });
}

/** Staff raising a ticket for an investor — a phone call or an email. */
export async function createStaffTicket(input: CreateStaffTicketInput, viewer: StaffPrincipal): Promise<TicketDetailDto> {
  const user = await db.user.findFirst({ where: { id: input.userId, role: "INVESTOR", deletedAt: null }, select: { id: true } });
  if (!user) throw HttpError.badRequest("No investor with that id");
  if (input.related) await assertRelated(input.userId, input.related);
  const now = new Date();
  const id = await db.$transaction(async (tx) => {
    const ticket = await tx.supportTicket.create({
      data: {
        userId: input.userId, subject: input.subject, category: input.category, priority: input.priority,
        channel: input.channel, openedByStaffId: viewer.staffId, assignedStaffId: viewer.staffId,
        slaDueAt: slaFrom(now, input.priority), status: "IN_PROGRESS", awaitingStaff: false,
        ...(input.related && { relatedType: input.related.type, relatedId: input.related.id }),
      },
      select: { id: true },
    });
    // What the investor asked, in staff's words: an internal note, since the
    // investor never wrote it.
    await tx.supportTicketMessage.create({
      data: { ticketId: ticket.id, author: "STAFF", staffId: viewer.staffId, body: input.body, internal: true },
    });
    await event(tx, ticket.id, viewer.staffId, "CREATED", null, input.channel);
    return ticket.id;
  });
  return getTicket(id);
}

export async function updateTicket(id: string, input: UpdateTicketInput, viewer: StaffPrincipal): Promise<TicketDetailDto> {
  const current = await db.supportTicket.findUnique({
    where: { id },
    select: { status: true, priority: true, category: true, assignedStaffId: true, createdAt: true },
  });
  if (!current) throw HttpError.notFound("No ticket with that id");
  if (input.assigneeId) await assertAgent(input.assigneeId);

  const now = new Date();
  await db.$transaction(async (tx) => {
    const data: Prisma.SupportTicketUpdateInput = {};
    if (input.status && input.status !== current.status) {
      Object.assign(data, statusStamps(input.status, now));
      await event(tx, id, viewer.staffId, "STATUS", current.status, input.status);
    }
    if (input.priority && input.priority !== current.priority) {
      data.priority = input.priority;
      data.slaDueAt = slaFrom(current.createdAt, input.priority);
      await event(tx, id, viewer.staffId, "PRIORITY", current.priority, input.priority);
    }
    if (input.category && input.category !== current.category) {
      data.category = input.category;
      await event(tx, id, viewer.staffId, "CATEGORY", current.category, input.category);
    }
    if (input.assigneeId !== undefined && input.assigneeId !== current.assignedStaffId) {
      data.assignedStaff = input.assigneeId ? { connect: { id: input.assigneeId } } : { disconnect: true };
      const names = await tx.staffUser.findMany({
        where: { id: { in: [current.assignedStaffId, input.assigneeId].filter((v): v is string => Boolean(v)) } },
        select: { id: true, fullName: true },
      });
      const name = (staffId: string | null) => names.find((n) => n.id === staffId)?.fullName ?? null;
      await event(tx, id, viewer.staffId, "ASSIGNED", name(current.assignedStaffId), name(input.assigneeId));
    }
    if (Object.keys(data).length) await tx.supportTicket.update({ where: { id }, data });
  });
  return getTicket(id);
}

export async function staffReply(id: string, input: StaffReplyInput, viewer: StaffPrincipal): Promise<TicketDetailDto> {
  const ticket = await db.supportTicket.findUnique({
    where: { id },
    select: { id: true, number: true, userId: true, subject: true, status: true, assignedStaffId: true, firstResponseAt: true },
  });
  if (!ticket) throw HttpError.notFound("No ticket with that id");
  if (ticket.status === "CLOSED" && !input.internal) {
    throw HttpError.conflict("This ticket is closed. Reopen it before replying to the investor.");
  }

  const now = new Date();
  const messageId = await db.$transaction(async (tx) => {
    const message = await tx.supportTicketMessage.create({
      data: { ticketId: id, author: "STAFF", staffId: viewer.staffId, body: input.body, internal: input.internal },
      select: { id: true },
    });
    const data: Prisma.SupportTicketUpdateInput = {};
    if (!input.internal) {
      Object.assign(data, { lastMessageAt: now, awaitingStaff: false, unreadByInvestor: true });
      if (!ticket.firstResponseAt) data.firstResponseAt = now;
    }
    // Replying claims an unowned ticket, so nobody else picks it up at the same time.
    if (!ticket.assignedStaffId) {
      data.assignedStaff = { connect: { id: viewer.staffId } };
      await event(tx, id, viewer.staffId, "ASSIGNED", null, (await tx.staffUser.findUnique({
        where: { id: viewer.staffId }, select: { fullName: true },
      }))?.fullName ?? null);
    }
    const next = input.status ?? (input.internal ? undefined : "WAITING_ON_INVESTOR");
    if (next && next !== ticket.status) {
      Object.assign(data, statusStamps(next, now));
      await event(tx, id, viewer.staffId, "STATUS", ticket.status, next);
    }
    if (Object.keys(data).length) await tx.supportTicket.update({ where: { id }, data });
    return message.id;
  });
  if (!input.internal) await notifyReply(ticket, messageId);
  return getTicket(id);
}

// --- the investor's side ---------------------------------------------------------------

const investorSelect = {
  id: true, number: true, subject: true, category: true, status: true, unreadByInvestor: true,
  lastMessageAt: true, createdAt: true,
} as const satisfies Prisma.SupportTicketSelect;

type InvestorRow = Prisma.SupportTicketGetPayload<{ select: typeof investorSelect }>;

const toInvestorTicket = (row: InvestorRow): InvestorTicketDto => ({
  id: row.id,
  reference: reference(row.number),
  subject: row.subject,
  category: row.category,
  status: row.status,
  unread: row.unreadByInvestor,
  lastMessageAt: row.lastMessageAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

export async function listMyTickets(userId: string): Promise<InvestorTicketDto[]> {
  const rows = await db.supportTicket.findMany({
    where: { userId },
    select: investorSelect,
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  return rows.map(toInvestorTicket);
}

/** Opening a ticket marks it read. Internal notes never leave this function. */
export async function getMyTicket(userId: string, id: string): Promise<InvestorTicketDetailDto> {
  const row = await db.supportTicket.findFirst({
    where: { id, userId },
    select: {
      ...investorSelect, relatedType: true, relatedId: true,
      messages: {
        where: { internal: false },
        orderBy: { createdAt: "asc" },
        select: { id: true, author: true, body: true, createdAt: true, staff: { select: { fullName: true } } },
      },
    },
  });
  if (!row) throw HttpError.notFound("No ticket with that id");
  if (row.unreadByInvestor) await db.supportTicket.update({ where: { id }, data: { unreadByInvestor: false } });
  return {
    ...toInvestorTicket({ ...row, unreadByInvestor: false }),
    related: row.relatedType && row.relatedId ? { type: row.relatedType as TicketRelatedType, id: row.relatedId } : null,
    canReply: row.status !== "CLOSED",
    messages: row.messages.map((message): TicketMessageDto => ({
      id: message.id,
      author: message.author,
      staffName: message.staff ? firstName(message.staff.fullName) : null,
      body: message.body,
      internal: false,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

export async function createMyTicket(userId: string, input: CreateInvestorTicketInput): Promise<InvestorTicketDetailDto> {
  if (input.related) await assertRelated(userId, input.related);
  const open = await db.supportTicket.count({ where: { userId, status: { in: LIVE } } });
  // A backstop against a stuck button or a script, not a policy on real use.
  if (open >= 10) throw HttpError.conflict("You already have 10 open requests. Reply on one of those, or wait for them to be resolved.");
  const now = new Date();
  const id = await db.$transaction(async (tx) => {
    const ticket = await tx.supportTicket.create({
      data: {
        userId, subject: input.subject, category: input.category, channel: "APP",
        slaDueAt: slaFrom(now, "NORMAL"),
        ...(input.related && { relatedType: input.related.type, relatedId: input.related.id }),
      },
      select: { id: true },
    });
    await tx.supportTicketMessage.create({ data: { ticketId: ticket.id, author: "INVESTOR", body: input.body } });
    await event(tx, ticket.id, null, "CREATED", null, "APP");
    return ticket.id;
  });
  return getMyTicket(userId, id);
}

/** An investor reply reopens a ticket that was waiting on them or resolved. */
export async function replyToMyTicket(userId: string, id: string, body: string): Promise<InvestorTicketDetailDto> {
  const ticket = await db.supportTicket.findFirst({ where: { id, userId }, select: { status: true } });
  if (!ticket) throw HttpError.notFound("No ticket with that id");
  if (ticket.status === "CLOSED") throw HttpError.conflict("This request is closed. Raise a new one if you still need help.");
  await db.$transaction(async (tx) => {
    await tx.supportTicketMessage.create({ data: { ticketId: id, author: "INVESTOR", body } });
    const reopen = ticket.status === "WAITING_ON_INVESTOR" || ticket.status === "RESOLVED";
    await tx.supportTicket.update({
      where: { id },
      data: { lastMessageAt: new Date(), awaitingStaff: true, ...(reopen && statusStamps("OPEN", new Date())) },
    });
    if (reopen) await event(tx, id, null, "STATUS", ticket.status, "OPEN");
  });
  return getMyTicket(userId, id);
}

// --- from a chat -----------------------------------------------------------------

/**
 * A ticket for a chat that needs follow-up. The transcript is attached as an
 * internal note, so whoever picks it up has the context without the investor
 * repeating themselves.
 */
export async function createTicketFromChat(
  tx: Tx,
  input: {
    userId: string; conversationId: string; subject: string; category: CreateStaffTicketInput["category"];
    priority: TicketPriority; transcript: string;
  },
  viewer: StaffPrincipal,
): Promise<{ id: string; number: number }> {
  const now = new Date();
  const ticket = await tx.supportTicket.create({
    data: {
      userId: input.userId, subject: input.subject, category: input.category, priority: input.priority,
      channel: "CHAT", chatConversationId: input.conversationId, openedByStaffId: viewer.staffId,
      assignedStaffId: viewer.staffId, status: "IN_PROGRESS", awaitingStaff: false,
      slaDueAt: slaFrom(now, input.priority),
    },
    select: { id: true, number: true },
  });
  await tx.supportTicketMessage.create({
    data: { ticketId: ticket.id, author: "SYSTEM", body: input.transcript.slice(0, 4000), internal: true },
  });
  await event(tx, ticket.id, viewer.staffId, "CREATED", null, "CHAT");
  return ticket;
}
