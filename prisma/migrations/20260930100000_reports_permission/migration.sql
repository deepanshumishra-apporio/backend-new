-- Reports: previews and CSV exports of investors, KYC, transactions, plans,
-- payments and AUM. Identifiers are masked in every report, but an export
-- leaves the system, so it goes to the roles that already run operations and
-- not to Support or Read only.
INSERT INTO "permissions" ("key", "description") VALUES
  ('reports.read', 'Run reports and export them as CSV, with identifiers masked');
INSERT INTO "role_permissions" ("roleKey", "permissionKey") VALUES
  ('SUPER_ADMIN', 'reports.read'),
  ('OPERATIONS', 'reports.read');
