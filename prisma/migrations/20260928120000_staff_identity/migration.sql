-- Staff identity: admins leave `users` for their own tables.
--
-- Customers and staff now share nothing: staff get staff_users, credentials,
-- MFA factors, sessions, a login-event log and permission-based roles. The two
-- ADMIN rows that lived in `users` move across with their ids and password
-- hashes, the audit entries they wrote follow them to actorStaffId, and
-- UserRole shrinks to the customer-facing roles.
--
-- One transaction: a half-applied identity migration is worse than none.
BEGIN;

-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "StaffMfaType" AS ENUM ('TOTP');

-- CreateEnum
CREATE TYPE "StaffLoginOutcome" AS ENUM ('SUCCESS', 'BAD_PASSWORD', 'UNKNOWN_EMAIL', 'INACTIVE', 'LOCKED', 'MFA_SUCCESS', 'MFA_FAILED');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actorStaffId" UUID;

-- CreateTable
CREATE TABLE "staff_users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "fullName" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(20),
    "status" "StaffStatus" NOT NULL DEFAULT 'ACTIVE',
    "mfaRequired" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deactivatedAt" TIMESTAMPTZ(3),

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_credentials" (
    "staffUserId" UUID NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "passwordChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mustChange" BOOLEAN NOT NULL DEFAULT false,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_credentials_pkey" PRIMARY KEY ("staffUserId")
);

-- CreateTable
CREATE TABLE "staff_mfa_factors" (
    "id" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "type" "StaffMfaType" NOT NULL,
    "secretEncrypted" BYTEA NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "lastUsedStep" INTEGER,
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_sessions" (
    "id" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "mfaVerifiedAt" TIMESTAMPTZ(3),
    "mfaFailedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" VARCHAR(40),
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_login_events" (
    "id" UUID NOT NULL,
    "staffUserId" UUID,
    "email" VARCHAR(255) NOT NULL,
    "outcome" "StaffLoginOutcome" NOT NULL,
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_login_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" VARCHAR(60) NOT NULL,
    "description" VARCHAR(200) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "roles" (
    "key" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(200),
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleKey" VARCHAR(40) NOT NULL,
    "permissionKey" VARCHAR(60) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleKey","permissionKey")
);

-- CreateTable
CREATE TABLE "staff_user_roles" (
    "staffUserId" UUID NOT NULL,
    "roleKey" VARCHAR(40) NOT NULL,
    "grantedById" UUID,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_user_roles_pkey" PRIMARY KEY ("staffUserId","roleKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_email_key" ON "staff_users"("email");

-- CreateIndex
CREATE INDEX "staff_users_status_idx" ON "staff_users"("status");

-- CreateIndex
CREATE INDEX "staff_mfa_factors_staffUserId_idx" ON "staff_mfa_factors"("staffUserId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_sessions_tokenHash_key" ON "staff_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "staff_sessions_staffUserId_expiresAt_idx" ON "staff_sessions"("staffUserId", "expiresAt");

-- CreateIndex
CREATE INDEX "staff_login_events_staffUserId_createdAt_idx" ON "staff_login_events"("staffUserId", "createdAt");

-- CreateIndex
CREATE INDEX "staff_login_events_email_createdAt_idx" ON "staff_login_events"("email", "createdAt");

-- CreateIndex
CREATE INDEX "staff_login_events_ipAddress_createdAt_idx" ON "staff_login_events"("ipAddress", "createdAt");

-- CreateIndex
CREATE INDEX "staff_user_roles_roleKey_idx" ON "staff_user_roles"("roleKey");

-- CreateIndex
CREATE INDEX "audit_logs_actorStaffId_createdAt_idx" ON "audit_logs"("actorStaffId", "createdAt");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorStaffId_fkey" FOREIGN KEY ("actorStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_mfa_factors" ADD CONSTRAINT "staff_mfa_factors_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_login_events" ADD CONSTRAINT "staff_login_events_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleKey_fkey" FOREIGN KEY ("roleKey") REFERENCES "roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "permissions"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_user_roles" ADD CONSTRAINT "staff_user_roles_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_user_roles" ADD CONSTRAINT "staff_user_roles_roleKey_fkey" FOREIGN KEY ("roleKey") REFERENCES "roles"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_user_roles" ADD CONSTRAINT "staff_user_roles_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Enforced here rather than in Prisma, which cannot express CHECKs.
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_email_lowercase" CHECK ("email" = lower("email"));

-- Permissions are the code's vocabulary (src/types/staff.types.ts); a new one
-- arrives with the migration of the feature that checks it.
INSERT INTO "permissions" ("key", "description") VALUES
  ('dashboard.read', 'View aggregate dashboard metrics'),
  ('investors.read', 'List and view investors, with identifiers masked');

INSERT INTO "roles" ("key", "name", "description", "isSystem") VALUES
  ('SUPER_ADMIN', 'Super admin', 'Every permission', true),
  ('OPERATIONS',  'Operations',  'Dashboard and investor records', true),
  ('SUPPORT',     'Support',     'Investor records, to answer investor queries', true),
  ('READ_ONLY',   'Read only',   'Dashboard metrics only', true);

INSERT INTO "role_permissions" ("roleKey", "permissionKey")
  SELECT 'SUPER_ADMIN', "key" FROM "permissions";
INSERT INTO "role_permissions" ("roleKey", "permissionKey") VALUES
  ('OPERATIONS', 'dashboard.read'), ('OPERATIONS', 'investors.read'),
  ('SUPPORT', 'investors.read'),
  ('READ_ONLY', 'dashboard.read');

-- Move existing staff across, keeping their ids so history still resolves.
INSERT INTO "staff_users" ("id", "email", "fullName", "phone", "status", "lastLoginAt", "createdAt", "updatedAt")
  SELECT u."id", lower(u."email"), COALESCE(u."fullName", u."email"), u."phone",
         CASE u."status" WHEN 'SUSPENDED' THEN 'SUSPENDED'::"StaffStatus"
                         WHEN 'CLOSED' THEN 'DEACTIVATED'::"StaffStatus"
                         ELSE 'ACTIVE'::"StaffStatus" END,
         u."lastLoginAt", u."createdAt", CURRENT_TIMESTAMP
  FROM "users" u
  WHERE u."role" IN ('ADMIN', 'SUPPORT') AND u."email" IS NOT NULL AND u."deletedAt" IS NULL;

INSERT INTO "staff_credentials" ("staffUserId", "passwordHash", "updatedAt")
  SELECT u."id", u."passwordHash", CURRENT_TIMESTAMP
  FROM "users" u JOIN "staff_users" s ON s."id" = u."id"
  WHERE u."passwordHash" IS NOT NULL;

INSERT INTO "staff_user_roles" ("staffUserId", "roleKey")
  SELECT u."id", CASE u."role" WHEN 'ADMIN' THEN 'SUPER_ADMIN' ELSE 'SUPPORT' END
  FROM "users" u JOIN "staff_users" s ON s."id" = u."id";

UPDATE "audit_logs"
  SET "actorStaffId" = "actorId", "actorId" = NULL, "actorRole" = NULL
  WHERE "actorId" IN (SELECT "id" FROM "staff_users");
UPDATE "audit_logs" SET "actorRole" = NULL WHERE "actorRole" IN ('ADMIN', 'SUPPORT');

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_single_actor"
  CHECK ("actorId" IS NULL OR "actorStaffId" IS NULL);

-- Staff rows are gone from `users`; only then can the enum lose its values.
DELETE FROM "users" WHERE "role" IN ('ADMIN', 'SUPPORT');

-- DropForeignKey
ALTER TABLE "admin_sessions" DROP CONSTRAINT "admin_sessions_userId_fkey";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "failedLoginAttempts",
DROP COLUMN "lockedUntil";

-- DropTable
DROP TABLE "admin_sessions";

-- UserRole: customer-facing roles only.
CREATE TYPE "UserRole_new" AS ENUM ('INVESTOR', 'DISTRIBUTOR');
ALTER TABLE "public"."users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole_new" USING ("role"::text::"UserRole_new");
ALTER TABLE "audit_logs" ALTER COLUMN "actorRole" TYPE "UserRole_new" USING ("actorRole"::text::"UserRole_new");
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
DROP TYPE "public"."UserRole_old";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'INVESTOR';

COMMIT;
