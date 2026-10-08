// Role Manager: defining roles and the permissions each grants (`roles.manage`).
//
// Rules every action obeys:
//
//   - Super admin and Role Manager access are fixed: admins always hold
//     everything, and Role Manager access is the one permission it carries.
//   - Sub-admin's operations can be switched, except the two that make it a
//     level: Manage staff stays on, and Role Manager is given per sub-admin.
//   - Other built-in roles (Operations, Support, Read only) keep their name and
//     can't be deleted, but their permissions can be switched on and off.
//   - No escalation. You can only put a permission into a role — or take one
//     out — if you hold it yourself. Otherwise `roles.manage` would be a way to
//     mint access you were never given.
//   - Custom roles are operator roles. Managing staff or roles comes with a
//     level (admin, sub-admin), never with a role you build here.
//   - Not your own role. Editing a role you hold is how you lock yourself out
//     (or widen your own access); another admin does that.
//   - A role in use can't be deleted. Reassign its staff first — deactivated
//     accounts included, since they keep their roles for the audit trail.
//
// Staff permissions are read from the database on every request, so a change
// here takes effect on each holder's next click.
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { roleKeyFrom } from "../utils/role-key.ts";
import { ADMIN_ROLE, LEVEL_PERMISSIONS, ROLE_MANAGER_ROLE, SUB_ADMIN_ROLE } from "../utils/staff-hierarchy.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { listRoles } from "./staff-admin.service.ts";
import {
  PERMISSIONS,
  type CreateRoleInput,
  type Permission,
  type PermissionDto,
  type RoleDto,
  type StaffPrincipal,
  type UpdateRoleInput,
} from "../types/staff.types.ts";

const isPermission = (key: string): key is Permission => (PERMISSIONS as readonly string[]).includes(key);

async function audit(actor: StaffPrincipal, action: string, roleKey: string, metadata?: Prisma.InputJsonObject): Promise<void> {
  await db.auditLog.create({
    data: { actorStaffId: actor.staffId, action, entityType: "role", entityId: roleKey, ...(metadata && { metadata }) },
  });
}

function assertOperatorAccess(permissions: Permission[]): void {
  const reserved = permissions.filter((permission) => LEVEL_PERMISSIONS.includes(permission));
  if (reserved.length) {
    throw HttpError.badRequest(`Custom roles are for operators and can't include ${reserved.join(" or ")}`);
  }
}

function assertHeld(actor: StaffPrincipal, permissions: Permission[]): void {
  const beyond = permissions.filter((permission) => !actor.permissions.includes(permission));
  if (beyond.length) {
    throw new HttpError(403, "ROLE_ESCALATION", `You can't grant or remove access you don't have yourself: ${beyond.join(", ")}`);
  }
}

async function loadEditable(actor: StaffPrincipal, key: string) {
  const role = await db.role.findUnique({
    where: { key },
    select: { key: true, name: true, description: true, isSystem: true, permissions: { select: { permissionKey: true } } },
  });
  if (!role) throw HttpError.notFound("No role with that key");
  if (role.key === ADMIN_ROLE) throw HttpError.conflict("Admins always have every permission.");
  if (role.key === ROLE_MANAGER_ROLE) throw HttpError.conflict("Role Manager access is switched on each sub-admin's staff page.");
  const holds = await db.staffUserRole.count({ where: { staffUserId: actor.staffId, roleKey: key } });
  if (holds) throw new HttpError(403, "SELF_MANAGEMENT", "You hold this role, so another admin has to change it.");
  return { ...role, permissions: role.permissions.map((p) => p.permissionKey).filter(isPermission) };
}

async function roleDto(key: string): Promise<RoleDto> {
  const role = (await listRoles()).find((entry) => entry.key === key);
  if (!role) throw HttpError.notFound("No role with that key");
  return role;
}

// --- reads -----------------------------------------------------------------------

/** Every permission a role can grant, in the order the code lists them. */
export async function listPermissions(): Promise<PermissionDto[]> {
  const rows = await db.permission.findMany({ select: { key: true, description: true } });
  return PERMISSIONS.flatMap((key) => {
    const row = rows.find((entry) => entry.key === key);
    return row ? [{ key, description: row.description }] : [];
  });
}

// --- writes ----------------------------------------------------------------------

export async function createRole(actor: StaffPrincipal, input: CreateRoleInput): Promise<RoleDto> {
  const key = roleKeyFrom(input.name);
  if (key.length < 2) throw HttpError.badRequest("Give the role a name with at least two letters");
  if (input.permissions.length === 0) throw HttpError.badRequest("Choose at least one permission");
  assertOperatorAccess(input.permissions);
  assertHeld(actor, input.permissions);
  const clash = await db.role.findFirst({
    where: { OR: [{ key }, { name: { equals: input.name, mode: "insensitive" } }] },
    select: { key: true },
  });
  if (clash) throw HttpError.conflict("A role with this name already exists");

  await db.role.create({
    data: {
      key,
      name: input.name,
      description: input.description,
      isSystem: false,
      permissions: { create: input.permissions.map((permissionKey) => ({ permissionKey })) },
    },
  });
  await audit(actor, "ROLE_CREATED", key, { name: input.name, permissions: input.permissions });
  return roleDto(key);
}

export async function updateRole(actor: StaffPrincipal, key: string, input: UpdateRoleInput): Promise<RoleDto> {
  const role = await loadEditable(actor, key);
  if (role.isSystem) {
    const renamed = input.name !== undefined && input.name !== role.name;
    const redescribed = input.description !== undefined && input.description !== role.description;
    if (renamed || redescribed) throw HttpError.badRequest("Built-in roles keep their name and description; only their permissions change.");
  }
  const next = input.permissions ? [...new Set(input.permissions)] : undefined;
  const added = next?.filter((permission) => !role.permissions.includes(permission)) ?? [];
  const removed = next ? role.permissions.filter((permission) => !next.includes(permission)) : [];

  if (next) {
    if (next.length === 0) throw HttpError.badRequest("Choose at least one permission");
    if (key === SUB_ADMIN_ROLE) {
      if ([...added, ...removed].some((permission) => LEVEL_PERMISSIONS.includes(permission))) {
        throw HttpError.badRequest("Sub-admins always manage staff, and Role Manager is given per sub-admin.");
      }
    } else {
      assertOperatorAccess(added);
    }
    assertHeld(actor, [...added, ...removed]);
  }
  if (input.name !== undefined && input.name.toLowerCase() !== role.name.toLowerCase()) {
    const clash = await db.role.findFirst({
      where: { key: { not: key }, name: { equals: input.name, mode: "insensitive" } },
      select: { key: true },
    });
    if (clash) throw HttpError.conflict("A role with this name already exists");
  }

  await db.$transaction(async (tx) => {
    await tx.role.update({
      where: { key },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
      },
    });
    if (removed.length) await tx.rolePermission.deleteMany({ where: { roleKey: key, permissionKey: { in: removed } } });
    if (added.length) {
      await tx.rolePermission.createMany({ data: added.map((permissionKey) => ({ roleKey: key, permissionKey })), skipDuplicates: true });
    }
  });

  await audit(actor, "ROLE_UPDATED", key, {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.description !== undefined && { descriptionChanged: true }),
    ...(added.length && { permissionsAdded: added }),
    ...(removed.length && { permissionsRemoved: removed }),
  });
  return roleDto(key);
}

export async function deleteRole(actor: StaffPrincipal, key: string): Promise<void> {
  const role = await loadEditable(actor, key);
  if (role.isSystem) throw HttpError.conflict("Built-in roles can't be deleted.");
  const holders = await db.staffUserRole.count({ where: { roleKey: key } });
  if (holders) {
    throw HttpError.conflict(
      `${holders} staff ${holders === 1 ? "account still has" : "accounts still have"} this role. Give them another role first.`,
    );
  }
  await db.role.delete({ where: { key } });
  await audit(actor, "ROLE_DELETED", key, { name: role.name, permissions: role.permissions });
}
