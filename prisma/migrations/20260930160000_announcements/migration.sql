-- CreateEnum
CREATE TYPE "AnnouncementCategory" AS ENUM ('PROMOTIONAL', 'INFORMATIONAL');

-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL_INVESTORS', 'KYC_PENDING', 'READY_NOT_INVESTED', 'INVESTED', 'ACTIVE_SIP', 'NO_SIP');

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE 'ANNOUNCEMENT';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "promoOptOutAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" "AnnouncementCategory" NOT NULL,
    "audience" "AnnouncementAudience" NOT NULL,
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "title" VARCHAR(80) NOT NULL,
    "body" VARCHAR(240) NOT NULL,
    "sendNotification" BOOLEAN NOT NULL DEFAULT true,
    "showBanner" BOOLEAN NOT NULL DEFAULT false,
    "tag" VARCHAR(30),
    "bannerTitle" VARCHAR(60),
    "bannerBody" VARCHAR(120),
    "highlight" VARCHAR(80),
    "ctaLabel" VARCHAR(30),
    "ctaAction" VARCHAR(20),
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3),
    "createdByStaffId" UUID,
    "submittedAt" TIMESTAMPTZ(3),
    "approvedByStaffId" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "rejectionReason" VARCHAR(300),
    "cancelledAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "targetedCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "optedOutCount" INTEGER NOT NULL DEFAULT 0,
    "cappedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_views" (
    "id" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clickedAt" TIMESTAMPTZ(3),

    CONSTRAINT "announcement_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_status_startsAt_idx" ON "announcements"("status", "startsAt");

-- CreateIndex
CREATE INDEX "announcements_createdAt_idx" ON "announcements"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "announcement_views_userId_idx" ON "announcement_views"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_views_announcementId_userId_key" ON "announcement_views"("announcementId", "userId");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_approvedByStaffId_fkey" FOREIGN KEY ("approvedByStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_views" ADD CONSTRAINT "announcement_views_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_views" ADD CONSTRAINT "announcement_views_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


INSERT INTO "permissions" ("key", "description") VALUES
  ('announcements.manage', 'Compose announcements to investors, and approve ones a colleague composed');
INSERT INTO "role_permissions" ("roleKey", "permissionKey") VALUES
  ('SUPER_ADMIN', 'announcements.manage'),
  ('OPERATIONS', 'announcements.manage');
