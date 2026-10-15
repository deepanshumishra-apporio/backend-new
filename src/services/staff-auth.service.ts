// Staff authentication for the admin portal: email and password, then a TOTP
// code. MFA is on unless STAFF_MFA_ENABLED=false, which production refuses;
// with it off the password step returns a full session straight away.
//
// With MFA on, a sign-in is two steps on one session:
//
//   POST /admin/sessions          password  → MFA-pending session (10 min)
//   POST /admin/sessions/mfa/*    TOTP code → full session (12 h, 30 min idle)
//
// A pending session can do nothing but finish MFA or sign out, so a stolen
// password alone reaches no data. Only the SHA-256 of a token is stored.
//
// Every failure a caller can see on the password step is the same 401 —
// unknown email, deactivated account and wrong password alike — so the
// endpoint cannot be used to discover staff emails. A lockout is the one
// exception: the real owner needs to know to wait. Each attempt, good or bad,
// is written to `staff_login_events`.
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { open, seal } from "../utils/secret-box.ts";
import { newSessionToken, sessionTokenHash } from "../utils/session-token.ts";
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from "../utils/totp.ts";
import type { StaffLoginOutcome } from "../../generated/prisma/enums.ts";
import {
  PERMISSIONS,
  type MfaSetupDto,
  type MfaState,
  type Permission,
  type StaffLoginInput,
  type StaffMeDto,
  type StaffPrincipal,
  type StaffSessionDto,
  type StaffSessionStateDto,
} from "../types/staff.types.ts";

const MINUTE = 60 * 1000;
const PENDING_TTL_MS = 10 * MINUTE;
const SESSION_TTL_MS = 12 * 60 * MINUTE;
const IDLE_TIMEOUT_MS = 30 * MINUTE;
/** lastSeenAt is written at most this often, not on every request. */
const TOUCH_INTERVAL_MS = MINUTE;
const MAX_FAILED_PASSWORDS = 5;
const LOCKOUT_MS = 15 * MINUTE;
/** Wrong codes allowed on one sign-in session. */
const MAX_FAILED_MFA = 5;
/** Wrong codes allowed across all of one account's sessions per LOCKOUT_MS. */
const MAX_FAILED_MFA_PER_ACCOUNT = 10;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

const invalidCredentials = () => new HttpError(401, "INVALID_CREDENTIALS", "Invalid email or password");
const invalidCode = () => new HttpError(401, "INVALID_MFA_CODE", "That code is not valid. Try the current one.");

const isPermission = (key: string): key is Permission => (PERMISSIONS as readonly string[]).includes(key);

/**
 * The 32-byte key MFA secrets are sealed with. Read lazily: only the admin
 * portal needs it, so a missing key must not stop the investor API booting.
 */
function mfaKey(): Buffer {
  const raw = process.env["STAFF_MFA_ENCRYPTION_KEY"];
  const key = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) {
    console.error("[staff-auth] STAFF_MFA_ENCRYPTION_KEY is missing or not 32 base64-encoded bytes");
    throw HttpError.serviceUnavailable("Staff sign-in is not configured");
  }
  return key;
}

const mfaIssuer = () => process.env["STAFF_MFA_ISSUER"]?.trim() || "RiSips Admin";

/**
 * Whether sign-in asks for an authenticator code after the password.
 *
 * On unless STAFF_MFA_ENABLED=false, and that opt-out is refused in production
 * (see `assertStaffMfaConfig`): a password alone must never reach every
 * investor's PAN, bank and contact details. The per-account `mfaRequired` flag
 * still exempts audited service accounts created with `--no-mfa`.
 */
export const staffMfaEnabled = () => process.env["STAFF_MFA_ENABLED"]?.trim().toLowerCase() !== "false";

/** Boot check: production may not switch staff MFA off. */
export function assertStaffMfaConfig(env: Record<string, string | undefined> = process.env): void {
  if (env["NODE_ENV"] === "production" && env["STAFF_MFA_ENABLED"]?.trim().toLowerCase() === "false") {
    throw new Error("STAFF_MFA_ENABLED=false is not allowed in production — staff sign-in must use MFA");
  }
}

// Verifying against a throwaway hash when there is no credential keeps the
// response time of an unknown email equal to a wrong password's.
let decoyHash: Promise<string> | undefined;
const timingDecoy = () => (decoyHash ??= Bun.password.hash("timing-decoy-not-a-password", "argon2id"));

export function passwordProblem(password: string, email: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (password.toLowerCase().includes(email.split("@")[0]!.toLowerCase())) return "Password must not contain your email name";
  return null;
}

async function recordLogin(
  outcome: StaffLoginOutcome,
  email: string,
  staffUserId: string | null,
  input: { ipAddress?: string | undefined; userAgent?: string | undefined },
): Promise<void> {
  await db.staffLoginEvent.create({
    data: {
      outcome, email, staffUserId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    },
  });
}

async function audit(staffId: string, action: string, metadata?: Record<string, string>): Promise<void> {
  await db.auditLog.create({
    data: { actorStaffId: staffId, action, entityType: "staff_user", entityId: staffId, ...(metadata && { metadata }) },
  });
}

/**
 * Count one wrong password; true when this one locked the account.
 *
 * The increment is atomic. Reading the count, adding one and writing it back
 * let a burst of concurrent guesses all read 0 and all write 1, so the lock
 * never tripped however many were sent.
 */
async function recordPasswordFailure(staffUserId: string, now: Date): Promise<boolean> {
  const { failedAttempts } = await db.staffCredential.update({
    where: { staffUserId },
    data: { failedAttempts: { increment: 1 } },
    select: { failedAttempts: true },
  });
  if (failedAttempts < MAX_FAILED_PASSWORDS) return false;
  await db.staffCredential.update({
    where: { staffUserId },
    data: { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) },
  });
  return true;
}

/** Lock the password step and end every session still waiting on MFA. */
async function lockForMfaFailures(principal: StaffPrincipal, now: Date): Promise<void> {
  await db.$transaction([
    db.staffCredential.updateMany({
      where: { staffUserId: principal.staffId },
      data: { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) },
    }),
    db.staffSession.updateMany({
      where: { staffUserId: principal.staffId, revokedAt: null, mfaVerifiedAt: null },
      data: { revokedAt: now, revokedReason: "MFA_FAILED" },
    }),
  ]);
  await audit(principal.staffId, "STAFF_LOCKED_MFA_FAILURES");
}

function lockedError(lockedUntil: Date, now: Date): HttpError {
  return new HttpError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.", {
    retryAfterSeconds: Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000),
  });
}

// --- password step ------------------------------------------------------------

export async function login(input: StaffLoginInput): Promise<StaffSessionDto> {
  const now = new Date();
  const staff = await db.staffUser.findUnique({
    where: { email: input.email },
    select: {
      id: true, status: true, mfaRequired: true,
      credential: { select: { passwordHash: true, lockedUntil: true } },
      mfaFactors: { where: { confirmedAt: { not: null } }, select: { id: true }, take: 1 },
    },
  });

  if (!staff?.credential) {
    await Bun.password.verify(input.password, await timingDecoy());
    await recordLogin("UNKNOWN_EMAIL", input.email, null, input);
    throw invalidCredentials();
  }

  const { credential } = staff;
  if (credential.lockedUntil && credential.lockedUntil > now) {
    await recordLogin("LOCKED", input.email, staff.id, input);
    throw lockedError(credential.lockedUntil, now);
  }

  const passwordOk = await Bun.password.verify(input.password, credential.passwordHash);
  if (!passwordOk) {
    const locked = await recordPasswordFailure(staff.id, now);
    await recordLogin(locked ? "LOCKED" : "BAD_PASSWORD", input.email, staff.id, input);
    throw invalidCredentials();
  }

  // Checked only after the password, so a suspended account's existence is
  // not revealed to someone who does not know its password.
  if (staff.status !== "ACTIVE") {
    await recordLogin("INACTIVE", input.email, staff.id, input);
    throw invalidCredentials();
  }

  const mfa: MfaState = !staffMfaEnabled() || !staff.mfaRequired
    ? "VERIFIED"
    : staff.mfaFactors.length ? "VERIFY_REQUIRED" : "SETUP_REQUIRED";
  const accessToken = newSessionToken();
  const expiresAt = new Date(now.getTime() + (mfa === "VERIFIED" ? SESSION_TTL_MS : PENDING_TTL_MS));

  await db.$transaction([
    db.staffCredential.update({ where: { staffUserId: staff.id }, data: { failedAttempts: 0, lockedUntil: null } }),
    db.staffSession.create({
      data: {
        staffUserId: staff.id,
        tokenHash: sessionTokenHash(accessToken),
        expiresAt,
        mfaVerifiedAt: mfa === "VERIFIED" ? now : null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
    }),
    ...(mfa === "VERIFIED" ? [db.staffUser.update({ where: { id: staff.id }, data: { lastLoginAt: now } })] : []),
  ]);
  await recordLogin("SUCCESS", input.email, staff.id, input);
  if (mfa === "VERIFIED") await audit(staff.id, "STAFF_SIGNED_IN", { mfa: staffMfaEnabled() ? "not_required" : "disabled" });

  return { accessToken, tokenType: "Bearer", expiresAt: expiresAt.toISOString(), mfa };
}

// --- resolving a token --------------------------------------------------------

/**
 * A bearer token → the staff member and what they may do, or null.
 *
 * Status, roles and permissions are re-read on every request, so suspending
 * someone or removing a role takes effect on their very next click.
 */
export async function authenticate(token: string): Promise<StaffPrincipal | null> {
  const now = new Date();
  const session = await db.staffSession.findUnique({
    where: { tokenHash: sessionTokenHash(token) },
    select: {
      id: true, expiresAt: true, revokedAt: true, lastSeenAt: true, mfaVerifiedAt: true,
      staffUser: {
        select: {
          id: true, email: true, status: true,
          credential: { select: { mustChange: true } },
          mfaFactors: { where: { confirmedAt: { not: null } }, select: { id: true }, take: 1 },
          roles: { select: { role: { select: { permissions: { select: { permissionKey: true } } } } } },
        },
      },
    },
  });
  if (!session || session.revokedAt || session.expiresAt <= now) return null;
  const staff = session.staffUser;
  if (staff.status !== "ACTIVE") return null;

  if (session.mfaVerifiedAt && now.getTime() - session.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) {
    await db.staffSession.update({ where: { id: session.id }, data: { revokedAt: now, revokedReason: "IDLE_TIMEOUT" } });
    return null;
  }
  if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.staffSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  }

  const permissions = [
    ...new Set(staff.roles.flatMap((r) => r.role.permissions.map((p) => p.permissionKey)).filter(isPermission)),
  ];
  return {
    staffId: staff.id,
    sessionId: session.id,
    email: staff.email,
    permissions,
    mfa: session.mfaVerifiedAt ? "VERIFIED" : staff.mfaFactors.length ? "VERIFY_REQUIRED" : "SETUP_REQUIRED",
    mustChangePassword: staff.credential?.mustChange ?? false,
  };
}

export async function sessionState(principal: StaffPrincipal): Promise<StaffSessionStateDto> {
  const session = await db.staffSession.findUniqueOrThrow({
    where: { id: principal.sessionId },
    select: { expiresAt: true },
  });
  return { expiresAt: session.expiresAt.toISOString(), mfa: principal.mfa, mustChangePassword: principal.mustChangePassword };
}

// --- MFA step -------------------------------------------------------------------

/**
 * Start (or restart) enrolment. Replaces any unconfirmed factor; refuses once
 * one is confirmed — losing an authenticator is a reset done by an operator
 * (`bun run staff:create --reset-mfa`), never self-service from a session
 * that has only proved the password.
 */
export async function beginMfaSetup(principal: StaffPrincipal): Promise<MfaSetupDto> {
  if (principal.mfa !== "SETUP_REQUIRED") {
    throw new HttpError(409, "MFA_ALREADY_ENROLLED", "An authenticator is already set up for this account");
  }
  const key = mfaKey();
  const secret = newTotpSecret();
  await db.$transaction([
    db.staffMfaFactor.deleteMany({ where: { staffUserId: principal.staffId, confirmedAt: null } }),
    db.staffMfaFactor.create({
      data: { staffUserId: principal.staffId, type: "TOTP", secretEncrypted: new Uint8Array(seal(secret, key)) },
    }),
  ]);
  return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, principal.email, mfaIssuer()) };
}

/** Check a TOTP code; on success the session becomes a full one. */
export async function verifyMfa(
  principal: StaffPrincipal,
  code: string,
  context: { ipAddress?: string; userAgent?: string },
): Promise<StaffSessionStateDto> {
  const now = new Date();
  // During enrolment the pending factor is checked; afterwards the confirmed one.
  const factor = await db.staffMfaFactor.findFirst({
    where: {
      staffUserId: principal.staffId,
      ...(principal.mfa === "SETUP_REQUIRED" ? { confirmedAt: null } : { confirmedAt: { not: null } }),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, secretEncrypted: true, lastUsedStep: true, confirmedAt: true },
  });
  if (!factor) throw new HttpError(409, "MFA_NOT_SET_UP", "Set up an authenticator first");

  // Account-wide cap. The per-session counter alone was reset by every fresh
  // password sign-in, so anyone holding the password could keep guessing codes.
  const recentFailures = await db.staffLoginEvent.count({
    where: { staffUserId: principal.staffId, outcome: "MFA_FAILED", createdAt: { gt: new Date(now.getTime() - LOCKOUT_MS) } },
  });
  if (recentFailures >= MAX_FAILED_MFA_PER_ACCOUNT) {
    await lockForMfaFailures(principal, now);
    throw lockedError(new Date(now.getTime() + LOCKOUT_MS), now);
  }

  // Spend an attempt BEFORE checking the code. Counting only after a failure let
  // a burst of concurrent guesses on one session all be checked before the
  // first increment landed.
  const reserved = await db.staffSession.updateMany({
    where: { id: principal.sessionId, revokedAt: null, mfaFailedAttempts: { lt: MAX_FAILED_MFA } },
    data: { mfaFailedAttempts: { increment: 1 } },
  });
  if (reserved.count === 0) {
    await db.staffSession.update({ where: { id: principal.sessionId }, data: { revokedAt: now, revokedReason: "MFA_FAILED" } });
    throw invalidCode();
  }

  const step = verifyTotp(open(factor.secretEncrypted, mfaKey()), code, now, factor.lastUsedStep);
  // The conditional update is the replay guard under concurrency: two requests
  // with the same code race, and only one can move lastUsedStep past it.
  const claimed = step === null ? 0 : (await db.staffMfaFactor.updateMany({
    where: { id: factor.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
    data: { lastUsedStep: step, lastUsedAt: now, ...(factor.confirmedAt ? {} : { confirmedAt: now }) },
  })).count;

  if (claimed === 0) {
    // The attempt is already counted; end the session once it used its last one.
    await db.staffSession.updateMany({
      where: { id: principal.sessionId, mfaFailedAttempts: { gte: MAX_FAILED_MFA } },
      data: { revokedAt: now, revokedReason: "MFA_FAILED" },
    });
    await recordLogin("MFA_FAILED", principal.email, principal.staffId, context);
    throw invalidCode();
  }

  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.$transaction([
    db.staffSession.update({
      where: { id: principal.sessionId },
      data: { mfaVerifiedAt: now, expiresAt, lastSeenAt: now, mfaFailedAttempts: 0 },
    }),
    db.staffUser.update({ where: { id: principal.staffId }, data: { lastLoginAt: now } }),
  ]);
  await recordLogin("MFA_SUCCESS", principal.email, principal.staffId, context);
  if (!factor.confirmedAt) await audit(principal.staffId, "STAFF_MFA_ENROLLED");
  await audit(principal.staffId, "STAFF_SIGNED_IN");

  return { expiresAt: expiresAt.toISOString(), mfa: "VERIFIED", mustChangePassword: principal.mustChangePassword };
}

// --- account -----------------------------------------------------------------

export async function me(principal: StaffPrincipal): Promise<StaffMeDto> {
  const staff = await db.staffUser.findUniqueOrThrow({
    where: { id: principal.staffId },
    select: {
      id: true, email: true, fullName: true, lastLoginAt: true,
      roles: { orderBy: { roleKey: "asc" }, select: { role: { select: { key: true, name: true } } } },
    },
  });
  return {
    id: staff.id,
    email: staff.email,
    fullName: staff.fullName,
    roles: staff.roles.map((r) => r.role),
    permissions: principal.permissions,
    mustChangePassword: principal.mustChangePassword,
    lastLoginAt: staff.lastLoginAt?.toISOString() ?? null,
  };
}

/** Change one's own password; every other session of theirs is signed out. */
export async function changePassword(principal: StaffPrincipal, current: string, next: string): Promise<void> {
  const credential = await db.staffCredential.findUnique({
    where: { staffUserId: principal.staffId },
    select: { passwordHash: true, lockedUntil: true },
  });
  if (!credential) throw HttpError.conflict("This account has no password");
  const started = new Date();
  // Honour the lockout here too. It used to be set by this endpoint but never
  // read by it, so a hijacked session could keep guessing the password.
  if (credential.lockedUntil && credential.lockedUntil > started) throw lockedError(credential.lockedUntil, started);

  if (!(await Bun.password.verify(current, credential.passwordHash))) {
    // A wrong current password counts toward the same lockout as sign-in, or
    // this endpoint would be an unthrottled password oracle for a hijacked session.
    if (await recordPasswordFailure(principal.staffId, started)) {
      // Whoever is guessing is holding this session: end it.
      await db.staffSession.update({
        where: { id: principal.sessionId },
        data: { revokedAt: started, revokedReason: "PASSWORD_LOCKOUT" },
      });
    }
    throw new HttpError(401, "INVALID_CREDENTIALS", "Current password is incorrect");
  }
  const problem = passwordProblem(next, principal.email);
  if (problem) throw HttpError.badRequest(problem);
  if (await Bun.password.verify(next, credential.passwordHash)) {
    throw HttpError.badRequest("Choose a password different from the current one");
  }

  const now = new Date();
  await db.$transaction([
    db.staffCredential.update({
      where: { staffUserId: principal.staffId },
      data: {
        passwordHash: await Bun.password.hash(next, "argon2id"),
        passwordChangedAt: now, mustChange: false, failedAttempts: 0, lockedUntil: null,
      },
    }),
    db.staffSession.updateMany({
      where: { staffUserId: principal.staffId, revokedAt: null, id: { not: principal.sessionId } },
      data: { revokedAt: now, revokedReason: "PASSWORD_CHANGED" },
    }),
  ]);
  await audit(principal.staffId, "STAFF_PASSWORD_CHANGED");
}

export async function logout(principal: StaffPrincipal): Promise<void> {
  await db.staffSession.update({
    where: { id: principal.sessionId },
    data: { revokedAt: new Date(), revokedReason: "LOGOUT" },
  });
  await audit(principal.staffId, "STAFF_SIGNED_OUT");
}
