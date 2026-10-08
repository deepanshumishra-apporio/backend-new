-- Three levels of staff: Admin (SUPER_ADMIN) > Sub-admin > Operator (every
-- other role). Admins create sub-admins; admins and sub-admins create
-- operators. Role Manager is an admin's, and a sub-admin's only when an admin
-- switches it on for that person — so it moves off the Sub-admin role onto a
-- grant of its own, ROLE_MANAGER, held alongside SUB_ADMIN.

DELETE FROM "role_permissions" WHERE "roleKey" = 'SUB_ADMIN' AND "permissionKey" = 'roles.manage';

UPDATE "roles"
   SET "description" = 'Runs the portal and creates operators; Role Manager only if an admin allows it'
 WHERE "key" = 'SUB_ADMIN';

INSERT INTO "roles" ("key", "name", "description", "isSystem") VALUES
  ('ROLE_MANAGER', 'Role Manager access', 'Given to a sub-admin by an admin: create and edit operator roles', true);
INSERT INTO "role_permissions" ("roleKey", "permissionKey") VALUES
  ('ROLE_MANAGER', 'roles.manage');

-- Custom roles are operator roles: managing staff or roles is never part of one.
DELETE FROM "role_permissions"
 WHERE "permissionKey" IN ('staff.manage', 'roles.manage')
   AND "roleKey" IN (SELECT "key" FROM "roles" WHERE NOT "isSystem");
