// Managing staff accounts from the portal (the `staff.manage` permission).
//
// Rules every action obeys:
//
//   - No acting on yourself. Suspending, re-roling or resetting your own
//     account from here is how an admin locks themselves out; your own
//     password changes through /me/password instead.
//   - No escalation. You can only grant or remove a role — or reset the
//     credentials of someone holding one — if you already hold every
//     permission that role carries. Otherwise `staff.manage` would be a way
//     to mint a super admin.
//   - Never zero super admins. Any change that would leave no ACTIVE staff
//     member with SUPER_ADMIN is refused; there would be no one left who
//     could manage staff at all.
//   - Deactivation is final. The account stays for the audit trail and its
//     email stays taken.
//
// Anything that takes access away (suspend, deactivate, reset password or MFA)
// revokes the person's sessions, so it takes effect on their next click.
// Issued passwords are returned once and must be changed at first sign-in.
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { temporaryPassword } from "../utils/temp-password.ts";
import { passwordProblem } from "./staff-auth.service.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import {
  PERMISSIONS,
  type CreateStaffByAdminInput,
  type Permission,
  type RoleDto,
  type StaffDetailDto,
  type StaffListItemDto,
  type StaffPrincipal,
  type StaffStatusValue,
  type TemporaryPasswordDto,
  type UpdateStaffInput,
} from "../types/staff.types.ts";

const SUPER_ADMIN = "SUPER_ADMIN";

const isPermission = (key: string): key is Permission => (PERMISSIONS as readonly string[]).includes(key);

const staffSelect = {
  id: true, email: true, fullName: true, phone: true, status: true, lastLoginAt: true, createdAt: true,
  roles: { orderBy: { roleKey: "asc" }, select: { role: { select: { key: true, name: true } } } },
  credential: { select: { mustChange: true, lockedUntil: true } },
  mfaFactors: { where: { confirmedAt: { not: null } }, select: { id: true }, take: 1 },
} as const satisfies Prisma.StaffUserSelect;

type StaffRow = Prisma.StaffUserGetPayload<{ select: typeof staffSelect }>;

function toItem(row: StaffRow): StaffListItemDto {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    phone: row.phone,
    status: row.status,
    roles: row.roles.map((r) => r.role),
    mfaEnrolled: row.mfaFactors.length > 0,
    locked: Boolean(row.credential?.lockedUntil && row.credential.lockedUntil > new Date()),
    mustChangePassword: row.credential?.mustChange ?? false,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function audit(actor: StaffPrincipal, action: string, targetId: string, metadata?: Prisma.InputJsonObject): Promise<void> {
  await db.auditLog.create({
    data: { actorStaffId: actor.staffId, action, entityType: "staff_user", entityId: targetId, ...(metadata && { metadata }) },
  });
}

function notSelf(actor: StaffPrincipal, targetId: string): void {
  if (actor.staffId === targetId) {
    throw new HttpError(403, "SELF_MANAGEMENT", "You can't do this to your own account. Ask another admin.");
  }
}

/** The actor must already hold every permission of each of these roles. */
async function assertCanHandle(actor: StaffPrincipal, roleKeys: string[]): Promise<void> {
  if (roleKeys.length === 0) return;
  const grants = await db.rolePermission.findMany({
    where: { roleKey: { in: roleKeys } },
    select: { roleKey: true, permissionKey: true },
  });
  const beyond = grants.filter((g) => !isPermission(g.permissionKey) || !actor.permissions.includes(g.permissionKey));
  if (beyond.length) {
    const roles = [...new Set(beyond.map((g) => g.roleKey))].join(", ");
    throw new HttpError(403, "ROLE_ESCALATION", `Your own access doesn't cover the ${roles} role, so you can't manage it`);
  }
}

async function assertRolesExist(roleKeys: string[]): Promise<void> {
  const found = await db.role.findMany({ where: { key: { in: roleKeys } }, select: { key: true } });
  const missing = roleKeys.filter((key) => !found.some((role) => role.key === key));
  if (missing.length) throw HttpError.badRequest(`Unknown role: ${missing.join(", ")}`);
}

/** Refuse a change that leaves no active super admin besides `targetId`. */
async function assertAnotherSuperAdmin(tx: Prisma.TransactionClient, targetId: string): Promise<void> {
  const others = await tx.staffUser.count({
    where: { id: { not: targetId }, status: "ACTIVE", roles: { some: { roleKey: SUPER_ADMIN } } },
  });
  if (others === 0) {
    throw HttpError.conflict("This is the last active super admin. Make someone else a super admin first.");
  }
}

async function loadTarget(id: string) {
  const target = await db.staffUser.findUnique({
    where: { id },
    select: { id: true, email: true, status: true, roles: { select: { roleKey: true } } },
  });
  if (!target) throw HttpError.notFound("No staff member with that id");
  return { ...target, roleKeys: target.roles.map((r) => r.roleKey) };
}

function issuePassword(email: string): string {
  // A random password essentially never contains the email name; loop anyway
  // so the policy holds without exception.
  for (;;) {
    const password = temporaryPassword();
    if (!passwordProblem(password, email)) return password;
  }
}

// --- reads -----------------------------------------------------------------------

export async function listRoles(): Promise<RoleDto[]> {
  const roles = await db.role.findMany({
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    select: {
      key: true, name: true, description: true, isSystem: true,
      permissions: { select: { permissionKey: true } },
      _count: { select: { staff: { where: { staffUser: { status: { not: "DEACTIVATED" } } } } } },
    },
  });
  return roles.map((role) => ({
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: role.permissions.map((p) => p.permissionKey).filter(isPermission),
    staffCount: role._count.staff,
  }));
}

export async function listStaff(): Promise<StaffListItemDto[]> {
  const rows = await db.staffUser.findMany({
    orderBy: [{ status: "asc" }, { fullName: "asc" }],
    take: 1000,
    select: staffSelect,
  });
  return rows.map(toItem);
}

export async function getStaff(id: string): Promise<StaffDetailDto> {
  const row = await db.staffUser.findUnique({
    where: { id },
    select: {
      ...staffSelect,
      deactivatedAt: true,
      createdBy: { select: { id: true, fullName: true } },
      _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } },
      loginEvents: {
        orderBy: { createdAt: "desc" },
        take: 15,
        select: { outcome: true, ipAddress: true, userAgent: true, createdAt: true },
      },
    },
  });
  if (!row) throw HttpError.notFound("No staff member with that id");
  return {
    ...toItem(row),
    createdBy: row.createdBy,
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
    activeSessions: row._count.sessions,
    recentLogins: row.loginEvents.map((event) => ({
      outcome: event.outcome,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      at: event.createdAt.toISOString(),
    })),
  };
}

// --- writes ----------------------------------------------------------------------

export async function createStaff(actor: StaffPrincipal, input: CreateStaffByAdminInput): Promise<TemporaryPasswordDto> {
  if (input.roleKeys.length === 0) throw HttpError.badRequest("Give them at least one role");
  await assertRolesExist(input.roleKeys);
  await assertCanHandle(actor, input.roleKeys);
  if (await db.staffUser.findUnique({ where: { email: input.email }, select: { id: true } })) {
    throw HttpError.conflict("A staff account with this email already exists");
  }

  const password = issuePassword(input.email);
  const passwordHash = await Bun.password.hash(password, "argon2id");
  const row = await db.staffUser.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      phone: input.phone ?? null,
      createdById: actor.staffId,
      credential: { create: { passwordHash, mustChange: true } },
      roles: { create: input.roleKeys.map((roleKey) => ({ roleKey, grantedById: actor.staffId })) },
    },
    select: staffSelect,
  });
  await audit(actor, "STAFF_CREATED", row.id, { email: row.email, roles: input.roleKeys });
  return { staff: toItem(row), temporaryPassword: password };
}

export async function updateStaff(actor: StaffPrincipal, id: string, input: UpdateStaffInput): Promise<StaffDetailDto> {
  const target = await loadTarget(id);
  if (target.status === "DEACTIVATED") throw HttpError.conflict("A deactivated account can't be changed");

  const roleKeys = input.roleKeys ? [...new Set(input.roleKeys)] : undefined;
  const added = roleKeys?.filter((key) => !target.roleKeys.includes(key)) ?? [];
  const removed = roleKeys ? target.roleKeys.filter((key) => !roleKeys.includes(key)) : [];

  if (roleKeys) {
    notSelf(actor, id);
    if (roleKeys.length === 0) throw HttpError.badRequest("Give them at least one role");
    await assertRolesExist(roleKeys);
    await assertCanHandle(actor, [...added, ...removed]);
  }

  await db.$transaction(async (tx) => {
    if (removed.includes(SUPER_ADMIN) && target.status === "ACTIVE") await assertAnotherSuperAdmin(tx, id);
    await tx.staffUser.update({
      where: { id },
      data: {
        ...(input.fullName !== undefined && { fullName: input.fullName }),
        ...(input.phone !== undefined && { phone: input.phone }),
      },
    });
    if (removed.length) await tx.staffUserRole.deleteMany({ where: { staffUserId: id, roleKey: { in: removed } } });
    if (added.length) {
      await tx.staffUserRole.createMany({
        data: added.map((roleKey) => ({ staffUserId: id, roleKey, grantedById: actor.staffId })),
        skipDuplicates: true,
      });
    }
  });

  await audit(actor, "STAFF_UPDATED", id, {
    ...(input.fullName !== undefined && { fullName: input.fullName }),
    ...(input.phone !== undefined && { phoneChanged: true }),
    ...(added.length && { rolesAdded: added }),
    ...(removed.length && { rolesRemoved: removed }),
  });
  return getStaff(id);
}

export async function setStatus(actor: StaffPrincipal, id: string, status: StaffStatusValue): Promise<StaffDetailDto> {
  notSelf(actor, id);
  const target = await loadTarget(id);
  await assertCanHandle(actor, target.roleKeys);
  if (target.status === status) return getStaff(id);
  if (target.status === "DEACTIVATED") throw HttpError.conflict("A deactivated account can't be reactivated");

  const now = new Date();
  await db.$transaction(async (tx) => {
    if (status !== "ACTIVE" && target.roleKeys.includes(SUPER_ADMIN)) await assertAnotherSuperAdmin(tx, id);
    await tx.staffUser.update({
      where: { id },
      data: { status, ...(status === "DEACTIVATED" && { deactivatedAt: now }) },
    });
    if (status !== "ACTIVE") {
      await tx.staffSession.updateMany({
        where: { staffUserId: id, revokedAt: null },
        data: { revokedAt: now, revokedReason: status === "SUSPENDED" ? "STAFF_SUSPENDED" : "STAFF_DEACTIVATED" },
      });
    }
  });

  const action = { ACTIVE: "STAFF_REACTIVATED", SUSPENDED: "STAFF_SUSPENDED", DEACTIVATED: "STAFF_DEACTIVATED" }[status];
  await audit(actor, action, id);
  return getStaff(id);
}

export async function resetPassword(actor: StaffPrincipal, id: string): Promise<TemporaryPasswordDto> {
  notSelf(actor, id);
  const target = await loadTarget(id);
  if (target.status === "DEACTIVATED") throw HttpError.conflict("A deactivated account can't be changed");
  await assertCanHandle(actor, target.roleKeys);

  const password = issuePassword(target.email);
  const passwordHash = await Bun.password.hash(password, "argon2id");
  const now = new Date();
  await db.$transaction([
    db.staffCredential.upsert({
      where: { staffUserId: id },
      create: { staffUserId: id, passwordHash, mustChange: true },
      update: { passwordHash, mustChange: true, passwordChangedAt: now, failedAttempts: 0, lockedUntil: null },
    }),
    db.staffSession.updateMany({
      where: { staffUserId: id, revokedAt: null },
      data: { revokedAt: now, revokedReason: "PASSWORD_RESET" },
    }),
  ]);
  await audit(actor, "STAFF_PASSWORD_RESET", id);
  const row = await db.staffUser.findUniqueOrThrow({ where: { id }, select: staffSelect });
  return { staff: toItem(row), temporaryPassword: password };
}

/** For a lost phone: removes their authenticator, so their next sign-in enrols a new one. */
export async function resetMfa(actor: StaffPrincipal, id: string): Promise<StaffDetailDto> {
  notSelf(actor, id);
  const target = await loadTarget(id);
  if (target.status === "DEACTIVATED") throw HttpError.conflict("A deactivated account can't be changed");
  await assertCanHandle(actor, target.roleKeys);

  await db.$transaction([
    db.staffMfaFactor.deleteMany({ where: { staffUserId: id } }),
    db.staffSession.updateMany({
      where: { staffUserId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "MFA_RESET" },
    }),
  ]);
  await audit(actor, "STAFF_MFA_RESET", id);
  return getStaff(id);
}

export async function revokeSessions(actor: StaffPrincipal, id: string): Promise<StaffDetailDto> {
  notSelf(actor, id);
  const target = await loadTarget(id);
  await assertCanHandle(actor, target.roleKeys);
  const { count } = await db.staffSession.updateMany({
    where: { staffUserId: id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED" },
  });
  await audit(actor, "STAFF_SESSIONS_REVOKED", id, { sessions: count });
  return getStaff(id);
}
