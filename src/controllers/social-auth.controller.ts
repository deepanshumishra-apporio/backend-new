import type { Request, Response } from "express";
import * as socialAuth from "../services/social-auth.service.ts";
import { SOCIAL_PROVIDERS, type SocialProvider } from "../types/social-auth.types.ts";
import { asBody, oneOf, optionalString, requiredString } from "../utils/validate.ts";

/** Which provider buttons the app may enable. */
export function providers(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: socialAuth.availableProviders() });
}

export async function start(req: Request, res: Response) {
  const body = asBody(req.body);
  const provider = oneOf(body, "provider", SOCIAL_PROVIDERS) as SocialProvider;
  // A JWT of a few kilobytes at most; anything longer is not a provider token.
  const idToken = requiredString(body, "idToken", { maxLength: 8192 });
  const nonce = optionalString(body, "nonce", { maxLength: 128 });
  const data = await socialAuth.startSocialSignIn({ provider, idToken, ...(nonce !== undefined && { nonce }) });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ data });
}
