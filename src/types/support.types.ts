// Contracts for support: tickets and the in-app chat, as staff and investors
// see them. Investors never receive internal notes, ticket history or staff
// surnames.

export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_ON_INVESTOR", "RESOLVED", "CLOSED"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = ["KYC", "SIP_MANDATE", "ORDER", "REDEMPTION", "PAYMENT", "STATEMENT", "ACCOUNT", "OTHER"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** Staff raise tickets from these; the app and chat channels are the investor's own. */
export const STAFF_CHANNELS = ["PHONE", "EMAIL"] as const;
export type TicketChannel = "APP" | "CHAT" | "PHONE" | "EMAIL";

export const RELATED_TYPES = ["order", "plan", "payment"] as const;
export type TicketRelatedType = (typeof RELATED_TYPES)[number];

export interface StaffRefDto {
  id: string;
  name: string;
}

export interface TicketInvestorDto {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  pan: string | null;
}

export interface TicketListItemDto {
  id: string;
  reference: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  channel: TicketChannel;
  investor: TicketInvestorDto;
  assignee: StaffRefDto | null;
  slaDueAt: string;
  /** Past its SLA and not yet resolved. */
  overdue: boolean;
  awaitingStaff: boolean;
  lastMessageAt: string;
  createdAt: string;
}

export interface TicketMessageDto {
  id: string;
  author: "INVESTOR" | "STAFF" | "SYSTEM";
  /** Full name for staff screens; first name only for the investor. */
  staffName: string | null;
  body: string;
  internal: boolean;
  createdAt: string;
}

export interface TicketEventDto {
  id: string;
  type: string;
  actor: "INVESTOR" | "STAFF" | "SYSTEM";
  staffName: string | null;
  from: string | null;
  to: string | null;
  createdAt: string;
}

export interface TicketDetailDto extends TicketListItemDto {
  related: { type: TicketRelatedType; id: string } | null;
  chatConversationId: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  openedBy: StaffRefDto | null;
  messages: TicketMessageDto[];
  events: TicketEventDto[];
}

export interface TicketSummaryDto {
  open: number;
  unassigned: number;
  overdue: number;
  awaitingStaff: number;
  waitingOnInvestor: number;
  mine: number;
}

export interface TicketListDto {
  items: TicketListItemDto[];
  total: number;
  nextCursor: string | null;
  summary: TicketSummaryDto;
}

export interface TicketListQuery {
  limit: number;
  status?: TicketStatus[];
  priority?: TicketPriority[];
  category?: TicketCategory[];
  /** A staff id, or "unassigned". */
  assignee?: string;
  overdue?: boolean;
  search?: string;
  cursor?: { at: Date; id: string };
}

export interface CreateStaffTicketInput {
  userId: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  channel: (typeof STAFF_CHANNELS)[number];
  body: string;
  related?: { type: TicketRelatedType; id: string };
}

export interface UpdateTicketInput {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  /** null unassigns. */
  assigneeId?: string | null;
}

export interface StaffReplyInput {
  body: string;
  internal: boolean;
  /** Where the ticket goes with this reply; defaults to waiting on the investor for a public reply. */
  status?: TicketStatus;
}

// --- the investor's view ----------------------------------------------------------

export interface InvestorTicketDto {
  id: string;
  reference: string;
  subject: string;
  category: TicketCategory;
  /** Collapsed for the investor: "Open", "Awaiting your reply", "Resolved", "Closed". */
  status: TicketStatus;
  /** Where it was raised: the app's form, the chat, or by staff (phone, email). */
  channel: TicketChannel;
  unread: boolean;
  /** The newest public message, for the list. */
  lastMessage: { author: TicketMessageDto["author"]; body: string } | null;
  lastMessageAt: string;
  createdAt: string;
}

export interface InvestorTicketDetailDto extends InvestorTicketDto {
  related: { type: TicketRelatedType; id: string } | null;
  canReply: boolean;
  resolvedAt: string | null;
  messages: TicketMessageDto[];
  /** The chat it was raised from, so the investor can read it back. Null for other channels. */
  chat: { startedAt: string; messages: ChatMessageDto[] } | null;
}

export interface CreateInvestorTicketInput {
  subject: string;
  category: TicketCategory;
  body: string;
  related?: { type: TicketRelatedType; id: string };
}

// --- chat -----------------------------------------------------------------------

export type ChatHandler = "BOT" | "HUMAN";
export type ChatStatus = "OPEN" | "WAITING_FOR_AGENT" | "CLOSED";
export type ChatSender = "INVESTOR" | "BOT" | "STAFF" | "SYSTEM";

export interface ChatMessageDto {
  id: string;
  sender: ChatSender;
  staffName: string | null;
  body: string;
  intent: string | null;
  createdAt: string;
}

export interface InvestorChatDto {
  id: string;
  handler: ChatHandler;
  status: ChatStatus;
  /** First name of the person answering, once one has joined. */
  agentName: string | null;
  ticket: { id: string; reference: string } | null;
  messages: ChatMessageDto[];
}

export interface BotReplyInput {
  body: string;
  intent?: string;
}

export interface ChatListItemDto {
  id: string;
  investor: TicketInvestorDto;
  handler: ChatHandler;
  status: ChatStatus;
  assignee: StaffRefDto | null;
  lastIntent: string | null;
  lastMessage: { sender: ChatSender; body: string; at: string } | null;
  unreadByStaff: boolean;
  handoverRequestedAt: string | null;
  messageCount: number;
  ticket: { id: string; reference: string } | null;
  createdAt: string;
}

export interface ChatDetailDto extends ChatListItemDto {
  messages: ChatMessageDto[];
  closedAt: string | null;
}

export const CHAT_VIEWS = ["live", "waiting", "mine", "bot", "closed"] as const;
export type ChatView = (typeof CHAT_VIEWS)[number];

export interface ChatSummaryDto {
  live: number;
  waiting: number;
  mine: number;
  bot: number;
}

export interface ChatListDto {
  items: ChatListItemDto[];
  summary: ChatSummaryDto;
}

export interface EscalateChatInput {
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
}
