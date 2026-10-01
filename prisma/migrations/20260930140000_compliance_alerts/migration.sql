-- CreateEnum
CREATE TYPE "ComplianceAlertKind" AS ENUM ('KYC_STALLED', 'KYC_FAILED', 'SIP_FAILURES', 'MANDATE_REJECTED', 'MANDATE_PENDING', 'PAID_NOT_ALLOTTED', 'ORDER_STUCK', 'NOMINEE_MISSING');

-- CreateEnum
CREATE TYPE "ComplianceSeverity" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ComplianceAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "compliance_alerts" (
    "id" UUID NOT NULL,
    "kind" "ComplianceAlertKind" NOT NULL,
    "severity" "ComplianceSeverity" NOT NULL,
    "status" "ComplianceAlertStatus" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" VARCHAR(160) NOT NULL,
    "userId" UUID,
    "entityType" VARCHAR(20),
    "entityId" UUID,
    "title" VARCHAR(160) NOT NULL,
    "detail" VARCHAR(500) NOT NULL,
    "firstDetectedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastDetectedAt" TIMESTAMPTZ(3) NOT NULL,
    "assignedStaffId" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedByStaffId" UUID,
    "resolution" VARCHAR(500),
    "autoResolved" BOOLEAN NOT NULL DEFAULT false,
    "lastRemindedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "compliance_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_alert_events" (
    "id" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "actorStaffId" UUID,
    "note" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compliance_alerts_dedupeKey_key" ON "compliance_alerts"("dedupeKey");

-- CreateIndex
CREATE INDEX "compliance_alerts_status_severity_firstDetectedAt_idx" ON "compliance_alerts"("status", "severity", "firstDetectedAt");

-- CreateIndex
CREATE INDEX "compliance_alerts_kind_status_idx" ON "compliance_alerts"("kind", "status");

-- CreateIndex
CREATE INDEX "compliance_alerts_userId_idx" ON "compliance_alerts"("userId");

-- CreateIndex
CREATE INDEX "compliance_alerts_assignedStaffId_status_idx" ON "compliance_alerts"("assignedStaffId", "status");

-- CreateIndex
CREATE INDEX "compliance_alert_events_alertId_createdAt_idx" ON "compliance_alert_events"("alertId", "createdAt");

-- AddForeignKey
ALTER TABLE "compliance_alerts" ADD CONSTRAINT "compliance_alerts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_alerts" ADD CONSTRAINT "compliance_alerts_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_alerts" ADD CONSTRAINT "compliance_alerts_resolvedByStaffId_fkey" FOREIGN KEY ("resolvedByStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_alert_events" ADD CONSTRAINT "compliance_alert_events_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "compliance_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_alert_events" ADD CONSTRAINT "compliance_alert_events_actorStaffId_fkey" FOREIGN KEY ("actorStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


INSERT INTO "permissions" ("key", "description") VALUES
  ('compliance.manage', 'Work the compliance queue: acknowledge, assign, resolve or dismiss alerts, remind investors, run the checks');
INSERT INTO "role_permissions" ("roleKey", "permissionKey") VALUES
  ('SUPER_ADMIN', 'compliance.manage'),
  ('OPERATIONS', 'compliance.manage');
