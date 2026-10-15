// Which environment this process runs in. Pure; no I/O.
//
// Every dev affordance in this codebase — the fixed OTP, emailed OTPs, CORS
// reflecting any origin, upstream error detail, sandbox simulation — is gated
// on `NODE_ENV !== "production"`. That check fails open: `prod`, `Production`
// or an unset variable all read as "not production" and switch them on against
// real investors. Refusing to boot on anything but the three known values makes
// every one of those checks mean what it says.

export const RUNTIME_ENVS = ["production", "development", "test"] as const;
export type RuntimeEnv = (typeof RUNTIME_ENVS)[number];

export function runtimeEnv(env: Record<string, string | undefined> = process.env): RuntimeEnv {
  const value = env["NODE_ENV"];
  if (!RUNTIME_ENVS.includes(value as RuntimeEnv)) {
    throw new Error(
      `NODE_ENV must be exactly one of ${RUNTIME_ENVS.join(", ")} (got ${value === undefined ? "nothing" : `"${value}"`}). ` +
        "Anything else would leave development-only shortcuts enabled.",
    );
  }
  return value as RuntimeEnv;
}
