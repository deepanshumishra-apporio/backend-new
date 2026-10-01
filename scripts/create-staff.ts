// Create or reset an admin-portal staff account:
//
//   STAFF_PASSWORD='…' bun run staff:create --email ops@example.com --name "Ops Lead" \
//     [--role SUPER_ADMIN] [--role SUPPORT] [--phone +91…] [--reset-mfa] [--no-mfa]
//
// The password comes from the environment, never argv, so it stays out of
// shell history and the process list. The owner must change it at first
// sign-in. Re-running for the same email resets the password, roles and
// lockout and signs out every session; --reset-mfa also removes the enrolled
// authenticator (a lost phone). --no-mfa is for service accounts only.
import { parseArgs } from "node:util";
import { disconnectDatabase } from "../src/db/client.ts";
import { upsertStaff } from "../src/services/staff-account.service.ts";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    phone: { type: "string" },
    role: { type: "string", multiple: true },
    "reset-mfa": { type: "boolean", default: false },
    "no-mfa": { type: "boolean", default: false },
  },
});

const password = process.env["STAFF_PASSWORD"];
const roleKeys = (values.role?.length ? values.role : ["SUPPORT"]).map((role) => role.toUpperCase());
if (!values.email || !values.name || !password) {
  console.error('Usage: STAFF_PASSWORD=… bun run staff:create --email <email> --name "<name>" [--role <ROLE>]… [--phone <phone>] [--reset-mfa] [--no-mfa]');
  process.exit(1);
}

let exitCode = 0;
try {
  const staff = await upsertStaff(
    {
      email: values.email.trim().toLowerCase(),
      fullName: values.name.trim(),
      ...(values.phone && { phone: values.phone.trim() }),
      password,
      roleKeys,
      mfaRequired: !values["no-mfa"],
    },
    { resetMfa: values["reset-mfa"] },
  );
  console.log(`${staff.created ? "Created" : "Reset"} staff ${staff.email} [${staff.roles.join(", ")}], id ${staff.id}`);
  console.log("They must change this password at first sign-in.");
} catch (error) {
  console.error(`Could not create staff: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
}
await disconnectDatabase();
process.exit(exitCode);
