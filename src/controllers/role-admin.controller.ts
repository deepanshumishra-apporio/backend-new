import type { Request, Response } from "express";
import { staffPrincipal } from "../middleware/staff-auth.ts";
import * as roleAdmin from "../services/role-admin.service.ts";
import { PERMISSIONS, type Permission, type UpdateRoleInput } from "../types/staff.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { asBody, optionalString, optionalStringArray, requiredString } from "../utils/validate.ts";

type RoleParams = { roleKey: string };

function roleKey(req: Request<RoleParams>): string {
  if (!/^[A-Z_]{2,40}$/.test(req.params.roleKey)) throw HttpError.notFound("No role with that key");
  return req.params.roleKey;
}

function permissions(body: Record<string, unknown>): Permission[] | undefined {
  const raw = optionalStringArray(body, "permissions");
  if (raw === undefined) return undefined;
  const unknown = raw.filter((key) => !(PERMISSIONS as readonly string[]).includes(key));
  if (unknown.length) throw HttpError.badRequest(`Unknown permission: ${unknown.join(", ")}`);
  return [...new Set(raw as Permission[])];
}

/** An empty description clears it; a missing one leaves it alone. */
function description(body: Record<string, unknown>): string | null | undefined {
  if (body["description"] === null || body["description"] === "") return null;
  return optionalString(body, "description", { maxLength: 200 });
}

export async function permissionCatalogue(_req: Request, res: Response) {
  res.json({ data: await roleAdmin.listPermissions() });
}

export async function create(req: Request, res: Response) {
  const body = asBody(req.body);
  const granted = permissions(body);
  if (!granted?.length) throw HttpError.badRequest("Choose at least one permission");
  const role = await roleAdmin.createRole(staffPrincipal(req), {
    name: requiredString(body, "name", { maxLength: 80 }),
    description: description(body) ?? null,
    permissions: granted,
  });
  res.status(201).json({ data: role });
}

export async function update(req: Request<RoleParams>, res: Response) {
  const body = asBody(req.body);
  const input: UpdateRoleInput = {};
  const name = optionalString(body, "name", { maxLength: 80 });
  if (name !== undefined) input.name = name;
  const text = description(body);
  if (text !== undefined) input.description = text;
  const granted = permissions(body);
  if (granted !== undefined) input.permissions = granted;
  res.json({ data: await roleAdmin.updateRole(staffPrincipal(req), roleKey(req), input) });
}

export async function remove(req: Request<RoleParams>, res: Response) {
  await roleAdmin.deleteRole(staffPrincipal(req), roleKey(req));
  res.status(204).end();
}
