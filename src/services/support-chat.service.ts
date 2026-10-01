// The in-app chat: Ri answers, and a person can take over at any time.
//
// A conversation has a handler. While it is BOT, the app answers the
// investor's message with Ri's rules and records both turns in one call. Once
// it is HUMAN — the investor tapped "Talk to a person", or a staff member
// stepped in — the bot is silent and staff reply from the admin portal; staff
// can hand it back to the bot or turn it into a ticket.
//
// The handler is read under a row lock when a bot turn is recorded, so a
// takeover that lands while the app is composing an answer always wins: the
// answer is dropped rather than appearing after the person has joined.
//
// Ri's answers are worked out on the device, from data the investor's app has
// already loaded, so a bot turn is investor-supplied text. It is only ever
// shown back to that investor and to staff, marked as the bot's.
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { maskEmail, maskPan, maskTail } from "../utils/mask.ts";
import { createTicketFromChat, reference } from "./support-ticket.service.ts";
import type {
  BotReplyInput,
  ChatDetailDto,
  ChatListDto,
  ChatListItemDto,
  ChatMessageDto,
  ChatView,
  EscalateChatInput,
  InvestorChatDto,
  TicketInvestorDto,
} from "../types/support.types.ts";
import type { StaffPrincipal } from "../types/staff.types.ts";

/** A bot-only chat idle this long is over; the investor's next message starts a new one. */
const BOT_IDLE_MS = 12 * 60 * 60 * 1000;
/** A closed chat stays on the investor's screen this long, so they see how it ended. */
const RECENTLY_CLOSED_MS = 24 * 60 * 60 * 1000;
const MESSAGE_LIMIT = 200;

const firstName = (fullName: string) => fullName.trim().split(/\s+/)[0] ?? fullName;

const SYSTEM = {
  handover: "Connecting you to a person from the RiSips team. Keep typing if you like — they will see everything above.",
  joined: (name: string) => `${name} from RiSips has joined the chat.`,
  handBack: "You're chatting with Ri again. Tap “Talk to a person” any time.",
  closed: "This chat has been closed. Send a message any time to start a new one.",
  ticket: (ref: string) => `We've raised request ${ref} for this. You can follow it in Support → My requests.`,
};

// --- shapes ----------------------------------------------------------------------

const messageSelect = {
  id: true, sender: true, body: true, intent: true, createdAt: true, staff: { select: { fullName: true } },
} as const satisfies Prisma.ChatMessageSelect;

type MessageRow = Prisma.ChatMessageGetPayload<{ select: typeof messageSelect }>;

const toMessage = (row: MessageRow, staffName: (full: string) => string): ChatMessageDto => ({
  id: row.id,
  sender: row.sender,
  staffName: row.staff ? staffName(row.staff.fullName) : null,
  body: row.body,
  intent: row.intent,
  createdAt: row.createdAt.toISOString(),
});

/** The newest messages, oldest first. */
const recentMessages = {
  orderBy: { createdAt: "desc" },
  take: MESSAGE_LIMIT,
  select: messageSelect,
} as const satisfies Prisma.ChatConversation$messagesArgs;

// --- the investor's side ------------------------------------------------------------

const investorChatSelect = {
  id: true, handler: true, status: true, closedAt: true,
  assignedStaff: { select: { fullName: true } },
  ticket: { select: { id: true, number: true } },
  messages: recentMessages,
} as const satisfies Prisma.ChatConversationSelect;

type InvestorChatRow = Prisma.ChatConversationGetPayload<{ select: typeof investorChatSelect }>;

const toInvestorChat = (row: InvestorChatRow): InvestorChatDto => ({
  id: row.id,
  handler: row.handler,
  status: row.status,
  agentName: row.handler === "HUMAN" && row.assignedStaff ? firstName(row.assignedStaff.fullName) : null,
  ticket: row.ticket ? { id: row.ticket.id, reference: reference(row.ticket.number) } : null,
  messages: [...row.messages].reverse().map((message) => toMessage(message, firstName)),
});

/** The investor's live conversation, after retiring a bot chat that has gone quiet. */
async function openConversation(userId: string): Promise<{ id: string; handler: "BOT" | "HUMAN" } | null> {
  const open = await db.chatConversation.findFirst({
    where: { userId, status: { not: "CLOSED" } },
    select: { id: true, handler: true, lastMessageAt: true },
  });
  if (!open) return null;
  if (open.handler === "BOT" && Date.now() - open.lastMessageAt.getTime() > BOT_IDLE_MS) {
    await db.chatConversation.updateMany({
      where: { id: open.id, handler: "BOT", status: { not: "CLOSED" } },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    return null;
  }
  return { id: open.id, handler: open.handler };
}

/** Open or start the investor's conversation. The partial unique index settles a race between two first messages. */
async function ensureConversation(userId: string): Promise<{ id: string; handler: "BOT" | "HUMAN" }> {
  const open = await openConversation(userId);
  if (open) return open;
  try {
    return await db.chatConversation.create({ data: { userId }, select: { id: true, handler: true } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await openConversation(userId);
      if (winner) return winner;
    }
    throw error;
  }
}

/** The open conversation, or one closed in the last day so the app can show how it ended; null for a fresh start. */
export async function getMyChat(userId: string): Promise<InvestorChatDto | null> {
  const open = await openConversation(userId);
  const row = open
    ? await db.chatConversation.findUnique({ where: { id: open.id }, select: investorChatSelect })
    : await db.chatConversation.findFirst({
        where: { userId, status: "CLOSED", closedAt: { gte: new Date(Date.now() - RECENTLY_CLOSED_MS) } },
        orderBy: { closedAt: "desc" },
        select: investorChatSelect,
      });
  return row ? toInvestorChat(row) : null;
}

async function loadMyChat(id: string): Promise<InvestorChatDto> {
  const row = await db.chatConversation.findUniqueOrThrow({ where: { id }, select: investorChatSelect });
  return toInvestorChat(row);
}

/**
 * The investor's message, and Ri's answer to it when the bot still has the
 * conversation. With a person on the chat the answer is dropped and staff are
 * flagged instead.
 */
export async function sendMyMessage(userId: string, body: string, botReply?: BotReplyInput): Promise<InvestorChatDto> {
  const conversation = await ensureConversation(userId);
  const now = new Date();
  await db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ handler: "BOT" | "HUMAN" }[]>`
      SELECT handler FROM chat_conversations WHERE id = ${conversation.id}::uuid FOR UPDATE`;
    await tx.chatMessage.create({ data: { conversationId: conversation.id, sender: "INVESTOR", body, createdAt: now } });
    const botAnswers = locked?.handler === "BOT" && botReply;
    if (botAnswers) {
      // A millisecond later, so ordering by time can never put the answer first.
      await tx.chatMessage.create({
        data: {
          conversationId: conversation.id, sender: "BOT", body: botReply.body,
          intent: botReply.intent ?? null, createdAt: new Date(now.getTime() + 1),
        },
      });
    }
    await tx.chatConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: now,
        ...(botAnswers && botReply.intent && { lastIntent: botReply.intent }),
        ...(locked?.handler === "HUMAN" && { unreadByStaff: true }),
      },
    });
  });
  return loadMyChat(conversation.id);
}

/** "Talk to a person": the bot steps aside and the chat joins the staff queue. */
export async function requestHuman(userId: string): Promise<InvestorChatDto> {
  const conversation = await ensureConversation(userId);
  await db.$transaction(async (tx) => {
    const current = await tx.chatConversation.findUniqueOrThrow({
      where: { id: conversation.id },
      select: { handler: true, assignedStaffId: true },
    });
    // Already with a person: asking again changes nothing.
    if (current.handler === "HUMAN") return;
    const now = new Date();
    await tx.chatMessage.create({ data: { conversationId: conversation.id, sender: "SYSTEM", body: SYSTEM.handover, createdAt: now } });
    await tx.chatConversation.update({
      where: { id: conversation.id },
      data: {
        handler: "HUMAN", status: "WAITING_FOR_AGENT", handoverRequestedAt: now,
        assignedStaffId: null, unreadByStaff: true, lastMessageAt: now,
      },
    });
  });
  return loadMyChat(conversation.id);
}

/** The investor ends the chat. */
export async function endMyChat(userId: string): Promise<InvestorChatDto | null> {
  const open = await openConversation(userId);
  if (!open) return getMyChat(userId);
  await db.chatConversation.update({ where: { id: open.id }, data: { status: "CLOSED", closedAt: new Date() } });
  return loadMyChat(open.id);
}

// --- the staff side ---------------------------------------------------------------

const staffChatSelect = {
  id: true, userId: true, handler: true, status: true, lastIntent: true, unreadByStaff: true,
  handoverRequestedAt: true, createdAt: true, closedAt: true,
  assignedStaff: { select: { id: true, fullName: true } },
  ticket: { select: { id: true, number: true } },
  _count: { select: { messages: true } },
  messages: { orderBy: { createdAt: "desc" }, take: 1, select: { sender: true, body: true, createdAt: true } },
} as const satisfies Prisma.ChatConversationSelect;

type StaffChatRow = Prisma.ChatConversationGetPayload<{ select: typeof staffChatSelect }>;

async function investorsById(userIds: string[]): Promise<Map<string, TicketInvestorDto>> {
  const rows = await db.investorJourneySnapshot.findMany({
    where: { userId: { in: [...new Set(userIds)] } },
    select: { userId: true, name: true, phone: true, email: true, pan: true },
  });
  return new Map(rows.map((row) => [row.userId, {
    id: row.userId, name: row.name, phone: maskTail(row.phone), email: maskEmail(row.email), pan: maskPan(row.pan),
  }]));
}

function toListItem(row: StaffChatRow, investors: Map<string, TicketInvestorDto>): ChatListItemDto {
  const last = row.messages[0];
  return {
    id: row.id,
    investor: investors.get(row.userId) ?? { id: row.userId, name: null, phone: null, email: null, pan: null },
    handler: row.handler,
    status: row.status,
    assignee: row.assignedStaff ? { id: row.assignedStaff.id, name: row.assignedStaff.fullName } : null,
    lastIntent: row.lastIntent,
    lastMessage: last ? { sender: last.sender, body: last.body, at: last.createdAt.toISOString() } : null,
    unreadByStaff: row.unreadByStaff,
    handoverRequestedAt: row.handoverRequestedAt?.toISOString() ?? null,
    messageCount: row._count.messages,
    ticket: row.ticket ? { id: row.ticket.id, reference: reference(row.ticket.number) } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function viewWhere(view: ChatView, staffId: string): Prisma.ChatConversationWhereInput {
  const recent = { gte: new Date(Date.now() - BOT_IDLE_MS) };
  switch (view) {
    case "waiting":
      return { status: "WAITING_FOR_AGENT" };
    case "mine":
      return { status: "OPEN", handler: "HUMAN", assignedStaffId: staffId };
    case "bot":
      return { status: "OPEN", handler: "BOT", lastMessageAt: recent };
    case "closed":
      return { status: "CLOSED" };
    default:
      // A bot chat that went quiet is not live, though nobody closed it yet.
      return { status: { not: "CLOSED" }, OR: [{ handler: "HUMAN" }, { lastMessageAt: recent }] };
  }
}

export async function listChats(view: ChatView, viewer: StaffPrincipal): Promise<ChatListDto> {
  const [rows, live, waiting, mine, bot] = await Promise.all([
    db.chatConversation.findMany({
      where: viewWhere(view, viewer.staffId),
      select: staffChatSelect,
      // The queue is served oldest request first; everything else newest activity first.
      orderBy: view === "waiting" ? [{ handoverRequestedAt: "asc" }] : [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: 100,
    }),
    db.chatConversation.count({ where: viewWhere("live", viewer.staffId) }),
    db.chatConversation.count({ where: viewWhere("waiting", viewer.staffId) }),
    db.chatConversation.count({ where: viewWhere("mine", viewer.staffId) }),
    db.chatConversation.count({ where: viewWhere("bot", viewer.staffId) }),
  ]);
  const investors = await investorsById(rows.map((row) => row.userId));
  return { items: rows.map((row) => toListItem(row, investors)), summary: { live, waiting, mine, bot } };
}

/** One conversation in full. Opening it clears the unread flag. */
export async function getChat(id: string): Promise<ChatDetailDto> {
  const row = await db.chatConversation.findUnique({
    where: { id },
    select: { ...staffChatSelect, messages: recentMessages },
  });
  if (!row) throw HttpError.notFound("No chat with that id");
  if (row.unreadByStaff) await db.chatConversation.update({ where: { id }, data: { unreadByStaff: false } });
  const investors = await investorsById([row.userId]);
  const newest = row.messages[0];
  return {
    ...toListItem({ ...row, messages: newest ? [newest] : [] }, investors),
    unreadByStaff: false,
    closedAt: row.closedAt?.toISOString() ?? null,
    messages: [...row.messages].reverse().map((message) => toMessage(message, (full) => full)),
  };
}

type Tx = Prisma.TransactionClient;

async function openForStaff(tx: Tx, id: string) {
  const [row] = await tx.$queryRaw<{ id: string; status: string; handler: string; assignedStaffId: string | null; userId: string }[]>`
    SELECT id, status::text, handler::text, "assignedStaffId", "userId"
    FROM chat_conversations WHERE id = ${id}::uuid FOR UPDATE`;
  if (!row) throw HttpError.notFound("No chat with that id");
  if (row.status === "CLOSED") throw HttpError.conflict("This chat is closed");
  return row;
}

async function staffName(tx: Tx, staffId: string): Promise<string> {
  const staff = await tx.staffUser.findUniqueOrThrow({ where: { id: staffId }, select: { fullName: true } });
  return staff.fullName;
}

/** Put this staff member on the chat, silencing the bot. Idempotent for whoever already has it. */
async function claim(tx: Tx, id: string, viewer: StaffPrincipal): Promise<void> {
  const row = await openForStaff(tx, id);
  if (row.handler === "HUMAN" && row.assignedStaffId === viewer.staffId) return;
  const now = new Date();
  await tx.chatMessage.create({
    data: { conversationId: id, sender: "SYSTEM", body: SYSTEM.joined(firstName(await staffName(tx, viewer.staffId))), createdAt: now },
  });
  await tx.chatConversation.update({
    where: { id },
    data: { handler: "HUMAN", status: "OPEN", assignedStaffId: viewer.staffId, lastMessageAt: now },
  });
}

export async function takeOver(id: string, viewer: StaffPrincipal): Promise<ChatDetailDto> {
  await db.$transaction((tx) => claim(tx, id, viewer));
  return getChat(id);
}

/** A staff message. Writing into a chat the bot or a colleague has is itself a takeover. */
export async function sendStaffMessage(id: string, body: string, viewer: StaffPrincipal): Promise<ChatDetailDto> {
  await db.$transaction(async (tx) => {
    await claim(tx, id, viewer);
    const now = new Date();
    await tx.chatMessage.create({
      data: { conversationId: id, sender: "STAFF", staffId: viewer.staffId, body, createdAt: new Date(now.getTime() + 1) },
    });
    await tx.chatConversation.update({ where: { id }, data: { lastMessageAt: now, unreadByStaff: false } });
  });
  return getChat(id);
}

export async function handBack(id: string, _viewer: StaffPrincipal): Promise<ChatDetailDto> {
  await db.$transaction(async (tx) => {
    const row = await openForStaff(tx, id);
    if (row.handler === "BOT") return;
    const now = new Date();
    await tx.chatMessage.create({ data: { conversationId: id, sender: "SYSTEM", body: SYSTEM.handBack, createdAt: now } });
    await tx.chatConversation.update({
      where: { id },
      data: { handler: "BOT", status: "OPEN", assignedStaffId: null, handoverRequestedAt: null, lastMessageAt: now },
    });
  });
  return getChat(id);
}

export async function closeChat(id: string, _viewer: StaffPrincipal): Promise<ChatDetailDto> {
  await db.$transaction(async (tx) => {
    await openForStaff(tx, id);
    const now = new Date();
    await tx.chatMessage.create({ data: { conversationId: id, sender: "SYSTEM", body: SYSTEM.closed, createdAt: now } });
    await tx.chatConversation.update({ where: { id }, data: { status: "CLOSED", closedAt: now, lastMessageAt: now } });
  });
  return getChat(id);
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SENDER_LABEL = { INVESTOR: "Investor", BOT: "Ri (bot)", STAFF: "Staff", SYSTEM: "System" } as const;

/** Turn the chat into a ticket, with the transcript attached for whoever works it. */
export async function escalate(id: string, input: EscalateChatInput, viewer: StaffPrincipal): Promise<ChatDetailDto> {
  await db.$transaction(async (tx) => {
    const row = await openForStaff(tx, id);
    const existing = await tx.supportTicket.findUnique({ where: { chatConversationId: id }, select: { id: true } });
    if (existing) throw HttpError.conflict("This chat already has a ticket");
    const messages = await tx.chatMessage.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" },
      select: { sender: true, body: true, createdAt: true, staff: { select: { fullName: true } } },
    });
    const transcript = [
      "Chat transcript",
      ...messages.map((message) => {
        const at = new Date(message.createdAt.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
        return `[${at}] ${message.staff?.fullName ?? SENDER_LABEL[message.sender]}: ${message.body}`;
      }),
    ].join("\n");
    const ticket = await createTicketFromChat(tx, {
      userId: row.userId, conversationId: id, subject: input.subject, category: input.category,
      priority: input.priority, transcript,
    }, viewer);
    const now = new Date();
    await tx.chatMessage.create({
      data: { conversationId: id, sender: "SYSTEM", body: SYSTEM.ticket(reference(ticket.number)), createdAt: now },
    });
    await tx.chatConversation.update({ where: { id }, data: { lastMessageAt: now } });
  });
  return getChat(id);
}
