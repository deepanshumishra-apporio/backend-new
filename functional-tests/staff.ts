// Staff-account helpers shared by the admin test files.
//
// Accounts are created with the same service `bun run staff:create` uses;
// everything after that goes over HTTP.
import { Client, expectStatus } from "./lib.ts";

const { upsertStaff } = await import("../src/services/staff-account.service.ts");
const { base32Decode, timeStep, totpAt } = await import("../src/utils/totp.ts");

export const INITIAL = "Initial-Pass-For-Tests-01";
export const CHANGED = "Changed-Pass-For-Tests-02";
export { base32Decode, timeStep, totpAt };

export async function createStaff(role: string, mfaRequired = true): Promise<string> {
  const email = `ft-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  await upsertStaff({ email, fullName: `FT ${role}`, password: INITIAL, roleKeys: [role], mfaRequired }, { resetMfa: false });
  return email;
}

/** Password → MFA enrolment → password change: a fully usable staff session. */
export async function onboardStaff(role: string): Promise<Client & { email: string; secret: Uint8Array }> {
  const email = await createStaff(role);
  const client = new Client();
  const login = await client.post("/api/v1/admin/sessions", { email, password: INITIAL }, { idem: false });
  expectStatus(login, 201);
  client.token = login.body.data.accessToken;
  const setup = await client.post("/api/v1/admin/sessions/mfa/setup", {}, { idem: false });
  expectStatus(setup, 201);
  const secret = base32Decode(setup.body.data.secret);
  expectStatus(await client.post("/api/v1/admin/sessions/mfa/verify", { code: totpAt(secret, timeStep(new Date())) }, { idem: false }), 200);
  expectStatus(await client.post("/api/v1/admin/me/password", { currentPassword: INITIAL, newPassword: CHANGED }, { idem: false }), 204);
  return Object.assign(client, { email, secret });
}
