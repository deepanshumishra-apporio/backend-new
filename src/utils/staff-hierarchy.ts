// The three levels of portal staff, read off the roles they hold:
//
//   Admin      SUPER_ADMIN — everything, Role Manager included
//   Sub-admin  SUB_ADMIN   — everything but Role Manager, unless an admin has
//                            also given them ROLE_MANAGER
//   Operator   any other role (Operations, Support, Read only, custom roles)
//
// Admins create and manage anyone but themselves; sub-admins create and manage
// operators only. Roles that set a level are an admin's alone to hand out.

export type StaffLevel = "ADMIN" | "SUB_ADMIN" | "OPERATOR";

export const ADMIN_ROLE = "SUPER_ADMIN";
export const SUB_ADMIN_ROLE = "SUB_ADMIN";
export const ROLE_MANAGER_ROLE = "ROLE_MANAGER";

/** Only an admin may grant or remove these. */
export const ADMIN_ONLY_ROLES: readonly string[] = [ADMIN_ROLE, SUB_ADMIN_ROLE, ROLE_MANAGER_ROLE];

/** Permissions that belong to a level, never to an operator role. */
export const LEVEL_PERMISSIONS: readonly string[] = ["staff.manage", "roles.manage"];

export function levelOf(roleKeys: readonly string[]): StaffLevel {
  if (roleKeys.includes(ADMIN_ROLE)) return "ADMIN";
  if (roleKeys.includes(SUB_ADMIN_ROLE)) return "SUB_ADMIN";
  return "OPERATOR";
}

/** Admins manage anyone; sub-admins manage operators; operators manage no one. */
export function canManage(actor: StaffLevel, target: StaffLevel): boolean {
  if (actor === "ADMIN") return true;
  if (actor === "SUB_ADMIN") return target === "OPERATOR";
  return false;
}

/** Why a set of roles can't be held together, or null if it can. */
export function roleSetProblem(roleKeys: readonly string[]): string | null {
  if (roleKeys.includes(ADMIN_ROLE) && roleKeys.includes(SUB_ADMIN_ROLE)) {
    return "Someone is either an admin or a sub-admin, not both";
  }
  if (roleKeys.includes(ROLE_MANAGER_ROLE) && !roleKeys.includes(SUB_ADMIN_ROLE)) {
    return "Role Manager access is given to sub-admins only";
  }
  return null;
}
