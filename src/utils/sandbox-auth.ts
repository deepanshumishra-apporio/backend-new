import { HttpError } from "./http-error.ts";

/** Explicit opt-in; a production process can never accept demonstration OTPs. */
export function assertSandboxAuth(env: Record<string, string | undefined> = process.env): void {
  if (!['development', 'test'].includes(env.NODE_ENV ?? '') ||
      env.SANDBOX_AUTH_ENABLED !== 'true' || env.FP_BASE_URL !== 'https://s.finprim.com') {
    throw HttpError.notFound('Route not found');
  }
}
