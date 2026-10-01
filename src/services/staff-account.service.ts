// Provisioning staff accounts. Used by `scripts/create-staff.ts`; there is
// deliberately no HTTP route that mints staff yet — the first one has to come
// from someone with database access, and an invite flow is its own feature.
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { passwordProblem } from "./staff-auth.service.ts";
import type { CreateStaffInput } from "../types/staff.types.ts";

export interface StaffAccountDto {
  id: string;
  email: string;
  roles: string[];
  created: boolean;
}

/**
 * Create a staff account, or reset an existing one's password, roles and
 * lockout. `mustChange` is set so whoever typed the password on the command
 * line is not the only person who knows the one the owner keeps using.
 */
export async function upsertStaff(input: CreateStaffInput, options: { resetMfa: boolean }): Promise<StaffAccountDto> {
  const problem = passwordProblem(input.password, input.email);
  if (problem) throw HttpError.badRequest(problem);

  const roles = await db.role.findMany({ where: { key: { in: input.roleKeys } }, select: { key: true } });
  const unknown = input.roleKeys.filter((key) => !roles.some((role) => role.key === key));
  if (unknown.length) throw HttpError.badRequest(`Unknown role: ${unknown.join(", ")}`);

  const passwordHash = await Bun.password.hash(input.password, "argon2id");
  const existing = await db.staffUser.findUnique({ where: { email: input.email }, select: { id: true } });

  const staff = await db.$transaction(async (tx) => {
    const row = await tx.staffUser.upsert({
      where: { email: input.email },
      create: {
        email: input.email, fullName: input.fullName, phone: input.phone ?? null,
        mfaRequired: input.mfaRequired, status: "ACTIVE",
      },
      update: { fullName: input.fullName, phone: input.phone ?? null, mfaRequired: input.mfaRequired, status: "ACTIVE" },
      select: { id: true, email: true },
    });
    await tx.staffCredential.upsert({
      where: { staffUserId: row.id },
      create: { staffUserId: row.id, passwordHash, mustChange: true },
      update: { passwordHash, mustChange: true, failedAttempts: 0, lockedUntil: null, passwordChangedAt: new Date() },
    });
    await tx.staffUserRole.deleteMany({ where: { staffUserId: row.id, roleKey: { notIn: input.roleKeys } } });
    await tx.staffUserRole.createMany({
      data: input.roleKeys.map((roleKey) => ({ staffUserId: row.id, roleKey })),
      skipDuplicates: true,
    });
    // A reset password must not leave the old sessions alive.
    await tx.staffSession.updateMany({
      where: { staffUserId: row.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "PASSWORD_CHANGED" },
    });
    if (options.resetMfa) await tx.staffMfaFactor.deleteMany({ where: { staffUserId: row.id } });
    return row;
  });

  return { id: staff.id, email: staff.email, roles: input.roleKeys, created: !existing };
}
