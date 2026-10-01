CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_ON_INVESTOR', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportTicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SupportTicketCategory" AS ENUM ('KYC', 'SIP_MANDATE', 'ORDER', 'REDEMPTION', 'PAYMENT', 'STATEMENT', 'ACCOUNT', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportChannel" AS ENUM ('APP', 'CHAT', 'PHONE', 'EMAIL');

-- CreateEnum
CREATE TYPE "SupportAuthor" AS ENUM ('INVESTOR', 'STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ChatHandler" AS ENUM ('BOT', 'HUMAN');

-- CreateEnum
CREATE TYPE "ChatStatus" AS ENUM ('OPEN', 'WAITING_FOR_AGENT', 'CLOSED');

-- CreateEnum
CREATE TYPE "ChatSender" AS ENUM ('INVESTOR', 'BOT', 'STAFF', 'SYSTEM');

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "userId" UUID NOT NULL,
    "subject" VARCHAR(160) NOT NULL,
    "category" "SupportTicketCategory" NOT NULL,
    "priority" "SupportTicketPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "channel" "SupportChannel" NOT NULL,
    "assignedStaffId" UUID,
    "openedByStaffId" UUID,
    "chatConversationId" UUID,
    "relatedType" VARCHAR(20),
    "relatedId" UUID,
    "slaDueAt" TIMESTAMPTZ(3) NOT NULL,
    "firstResponseAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "lastMessageAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "awaitingStaff" BOOLEAN NOT NULL DEFAULT true,
    "unreadByInvestor" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_messages" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "author" "SupportAuthor" NOT NULL,
    "staffId" UUID,
    "body" VARCHAR(4000) NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_events" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "actor" "SupportAuthor" NOT NULL,
    "actorStaffId" UUID,
    "type" VARCHAR(30) NOT NULL,
    "fromValue" VARCHAR(80),
    "toValue" VARCHAR(80),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "handler" "ChatHandler" NOT NULL DEFAULT 'BOT',
    "status" "ChatStatus" NOT NULL DEFAULT 'OPEN',
    "assignedStaffId" UUID,
    "lastIntent" VARCHAR(60),
    "handoverRequestedAt" TIMESTAMPTZ(3),
    "lastMessageAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unreadByStaff" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "sender" "ChatSender" NOT NULL,
    "staffId" UUID,
    "body" VARCHAR(2000) NOT NULL,
    "intent" VARCHAR(60),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_number_key" ON "support_tickets"("number");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_chatConversationId_key" ON "support_tickets"("chatConversationId");

-- CreateIndex
CREATE INDEX "support_tickets_status_slaDueAt_idx" ON "support_tickets"("status", "slaDueAt");

-- CreateIndex
CREATE INDEX "support_tickets_assignedStaffId_status_idx" ON "support_tickets"("assignedStaffId", "status");

-- CreateIndex
CREATE INDEX "support_tickets_userId_createdAt_idx" ON "support_tickets"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "support_tickets_lastMessageAt_idx" ON "support_tickets"("lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "support_ticket_messages_ticketId_createdAt_idx" ON "support_ticket_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "support_ticket_events_ticketId_createdAt_idx" ON "support_ticket_events"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_conversations_status_lastMessageAt_idx" ON "chat_conversations"("status", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "chat_conversations_userId_createdAt_idx" ON "chat_conversations"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "chat_messages_conversationId_createdAt_idx" ON "chat_messages"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_openedByStaffId_fkey" FOREIGN KEY ("openedByStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_chatConversationId_fkey" FOREIGN KEY ("chatConversationId") REFERENCES "chat_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_actorStaffId_fkey" FOREIGN KEY ("actorStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one live conversation per investor, so the app and the queue can
-- never disagree about which one is "the" chat. Prisma cannot express a
-- partial unique index; it lives here.
CREATE UNIQUE INDEX "chat_conversations_one_open_per_user" ON "chat_conversations"("userId") WHERE "status" <> 'CLOSED';

-- Ticket numbers start at a round figure so RS-100001 reads as a reference, not a count.
ALTER SEQUENCE "support_tickets_number_seq" RESTART WITH 100001;

INSERT INTO "permissions" ("key", "description") VALUES
  ('transactions.read', 'Monitor orders and payments across investors, and refresh one from FP'),
  ('support.manage', 'Work support tickets and live chats: reply, assign, take over from the bot');
INSERT INTO "role_permissions" ("roleKey", "permissionKey") VALUES
  ('SUPER_ADMIN', 'transactions.read'), ('SUPER_ADMIN', 'support.manage'),
  ('OPERATIONS', 'transactions.read'), ('OPERATIONS', 'support.manage'),
  ('SUPPORT', 'transactions.read'), ('SUPPORT', 'support.manage');
