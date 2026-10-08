-- Role Manager: staff who hold `roles.manage` define roles and what each may do.
-- Also gives the two advisory screens a permission of their own, so every page
-- in the portal is governed by a role.

INSERT INTO "permissions" ("key", "description") VALUES
  ('roles.manage',      'Create roles and choose the permissions each one grants'),
  ('portfolios.manage', 'Build and edit model portfolios'),
  ('meetings.manage',   'Schedule and run investor review meetings');

-- Super admins hold every permission.
INSERT INTO "role_permissions" ("roleKey", "permissionKey") VALUES
  ('SUPER_ADMIN', 'roles.manage'),
  ('SUPER_ADMIN', 'portfolios.manage'),
  ('SUPER_ADMIN', 'meetings.manage');

-- Operations kept the advisory screens, which were open to everyone until now.
INSERT INTO "role_permissions" ("roleKey", "permissionKey") VALUES
  ('OPERATIONS', 'portfolios.manage'),
  ('OPERATIONS', 'meetings.manage');

-- Sub-admins run the portal day to day: every permission, but only a super
-- admin may grant or remove the Super admin role (enforced in code).
INSERT INTO "roles" ("key", "name", "description", "isSystem") VALUES
  ('SUB_ADMIN', 'Sub-admin', 'Everything except managing super admins', true);
INSERT INTO "role_permissions" ("roleKey", "permissionKey")
  SELECT 'SUB_ADMIN', "key" FROM "permissions";
