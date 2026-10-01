// Masking for identifiers shown to staff. Pure.
//
// Support needs enough to match a caller to a record, not the full identifier:
// the last four characters do that, and a screen or export that leaks shows
// nothing reusable.

/** ABCDE1234F → XXXXXX234F */
export function maskPan(pan: string | null | undefined): string | null {
  if (!pan) return null;
  return pan.length <= 4 ? pan : `${"X".repeat(pan.length - 4)}${pan.slice(-4)}`;
}

/** Last four digits only; we never store more. */
export function maskAccountNumber(last4: string): string {
  return `XXXXXX${last4}`;
}

/** asha.k@gmail.com → as***@gmail.com */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

/** Last four digits of a phone or account number, e.g. XXXXXX3210. */
export function maskTail(value: string | null | undefined, keep = 4): string | null {
  if (!value) return null;
  const digits = value.replace(/\s+/g, "");
  return digits.length <= keep ? digits : `${"X".repeat(Math.min(6, digits.length - keep))}${digits.slice(-keep)}`;
}
