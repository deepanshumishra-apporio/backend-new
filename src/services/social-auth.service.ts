// Sign in with Apple / Google.
//
// The phone stays the credential. A provider sign-in only proves who the
// investor is at Apple or Google; it is turned into a short-lived, single-use
// ticket, and the ticket counts for nothing until it is presented to
// POST /sessions together with a passed phone OTP. Only then is the provider
// account linked to the login — so a stolen Google account alone never opens a
// session, and an already linked one only opens the login it is linked to.
//
// Switched on per provider by its client ids (APPLE_CLIENT_IDS,
// GOOGLE_CLIENT_IDS). With none set the provider answers 404, as if absent.
import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import {
  IdTokenError,
  providerKeys,
  tokenKeyId,
  verifyIdToken,
  type ProviderConfig,
} from "../integrations/social/id-token.ts";
import { HttpError } from "../utils/http-error.ts";
import { maskTail } from "../utils/mask.ts";
import type {
  SocialProvider,
  SocialProvidersDto,
  SocialSignInDto,
  StartSocialSignInInput,
} from "../types/social-auth.types.ts";

type Tx = Prisma.TransactionClient;

/** Long enough to receive and type an SMS code, short enough to be useless if lifted. */
const TICKET_TTL_MS = 15 * 60 * 1000;

const ticketHash = (token: string) => createHash("sha256").update(token).digest("hex");

const list = (value: string | undefined) =>
  (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/**
 * A JWKS URL override exists only so the functional suite can sign its own
 * tokens; it is ignored outside NODE_ENV=test, so a deployment can never be
 * pointed at keys someone else holds.
 */
function jwksUrl(envName: string, fallback: string, env: Record<string, string | undefined>): string {
  return env.NODE_ENV === "test" && env[envName] ? env[envName] : fallback;
}

export function providerConfig(
  provider: SocialProvider,
  env: Record<string, string | undefined> = process.env,
): ProviderConfig | null {
  if (provider === "APPLE") {
    const audiences = list(env.APPLE_CLIENT_IDS);
    return audiences.length === 0 ? null : {
      issuers: ["https://appleid.apple.com"],
      jwksUrl: jwksUrl("APPLE_JWKS_URL", "https://appleid.apple.com/auth/keys", env),
      audiences,
    };
  }
  const audiences = list(env.GOOGLE_CLIENT_IDS);
  return audiences.length === 0 ? null : {
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    jwksUrl: jwksUrl("GOOGLE_JWKS_URL", "https://www.googleapis.com/oauth2/v3/certs", env),
    audiences,
  };
}

export function availableProviders(): SocialProvidersDto {
  return { apple: providerConfig("APPLE") !== null, google: providerConfig("GOOGLE") !== null };
}

export async function startSocialSignIn(input: StartSocialSignInInput): Promise<SocialSignInDto> {
  const config = providerConfig(input.provider);
  if (!config) throw HttpError.notFound("This sign-in option is not available");

  let keys;
  try {
    keys = await providerKeys(config.jwksUrl, tokenKeyId(input.idToken));
  } catch {
    throw HttpError.badGateway("Could not reach the sign-in provider. Try again.");
  }
  let verified;
  try {
    verified = verifyIdToken(input.idToken, keys, config, input.nonce === undefined ? {} : { nonce: input.nonce });
  } catch (error) {
    if (error instanceof IdTokenError) {
      throw new HttpError(401, "INVALID_ID_TOKEN", "That sign-in could not be verified. Try again.");
    }
    throw error;
  }

  const identity = await db.userIdentity.findUnique({
    where: { provider_subject: { provider: input.provider, subject: verified.subject } },
    select: { user: { select: { phone: true, status: true, deletedAt: true, role: true } } },
  });
  const user = identity?.user;
  if (user && (user.deletedAt || user.role !== "INVESTOR" || !["ACTIVE", "PENDING_VERIFICATION"].includes(user.status))) {
    throw user.status === "SUSPENDED"
      ? new HttpError(403, "ACCOUNT_FROZEN", "This account is frozen. Contact support to unfreeze it.")
      : new HttpError(403, "ACCOUNT_UNAVAILABLE", "This account cannot sign in. Contact support.");
  }

  const socialToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
  await db.socialSignIn.create({
    data: {
      tokenHash: ticketHash(socialToken),
      provider: input.provider,
      subject: verified.subject,
      email: verified.email,
      emailVerified: verified.emailVerified,
      expiresAt,
    },
    select: { id: true },
  });
  return {
    socialToken,
    expiresAt: expiresAt.toISOString(),
    linked: Boolean(user),
    phoneHint: user ? maskTail(user.phone) : null,
  };
}

/**
 * Spend a ticket inside the session transaction, after the phone OTP has
 * already been consumed for `userId`.
 *
 * - Provider account linked to this login: sign-in.
 * - Linked to another login: refused — the phone must be the one it belongs to.
 * - Not linked: linked now, unless this login already has a different account
 *   of the same provider. A verified provider email fills an empty email
 *   column, but never replaces one and never takes another login's address.
 */
export async function completeSocialSignIn(
  tx: Tx,
  socialToken: string,
  userId: string,
  now: Date,
): Promise<void> {
  const claimed = await tx.socialSignIn.updateMany({
    where: { tokenHash: ticketHash(socialToken), consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) {
    throw new HttpError(401, "SOCIAL_SIGN_IN_EXPIRED", "Your Apple or Google sign-in expired. Start again.");
  }
  const ticket = await tx.socialSignIn.findUniqueOrThrow({
    where: { tokenHash: ticketHash(socialToken) },
    select: { provider: true, subject: true, email: true, emailVerified: true },
  });
  const providerName = ticket.provider === "APPLE" ? "Apple ID" : "Google account";

  const existing = await tx.userIdentity.findUnique({
    where: { provider_subject: { provider: ticket.provider, subject: ticket.subject } },
    select: { id: true, userId: true, user: { select: { phone: true } } },
  });
  if (existing) {
    if (existing.userId !== userId) {
      throw HttpError.conflict(
        `This ${providerName} is linked to the mobile number ending ${existing.user.phone.slice(-4)}. Verify that number instead.`,
      );
    }
    await tx.userIdentity.update({ where: { id: existing.id }, data: { lastUsedAt: now }, select: { id: true } });
    return;
  }

  const sameProvider = await tx.userIdentity.findUnique({
    where: { userId_provider: { userId, provider: ticket.provider } },
    select: { id: true },
  });
  if (sameProvider) {
    throw HttpError.conflict(`This mobile number is already linked to a different ${providerName}.`);
  }
  await tx.userIdentity.create({
    data: { userId, provider: ticket.provider, subject: ticket.subject, email: ticket.email, lastUsedAt: now },
    select: { id: true },
  });

  if (ticket.email && ticket.emailVerified) {
    const [user, taken] = await Promise.all([
      tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
      tx.user.findUnique({ where: { email: ticket.email }, select: { id: true } }),
    ]);
    if (!user.email && !taken) {
      await tx.user.update({
        where: { id: userId },
        data: { email: ticket.email, emailVerifiedAt: now },
        select: { id: true },
      });
    }
  }
  await tx.auditLog.create({
    data: {
      actorId: userId,
      actorRole: "INVESTOR",
      action: "SOCIAL_IDENTITY_LINKED",
      entityType: "user",
      entityId: userId,
      metadata: { provider: ticket.provider },
    },
    select: { id: true },
  });
}
