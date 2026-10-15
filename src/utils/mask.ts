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

/**
 * Strip identifiers out of free text from a third party before a client sees it:
 * PANs, emails, and any run of 9+ digits (bank accounts, phones, Aadhaar).
 * FP's error messages quote back the values they were sent and can name
 * another investor's PAN when a folio lookup collides.
 */
export function redactPii(text: string): string {
  return text
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gi, (pan) => maskPan(pan.toUpperCase()) ?? "")
    .replace(/[^\s@"']+@[^\s@"']+\.[^\s@"',;]+/g, (email) => maskEmail(email) ?? "")
    .replace(/\+?\d[\d -]{7,}\d/g, (run) => {
      const digits = run.replace(/\D/g, "");
      return digits.length >= 9 ? (maskTail(digits) ?? "") : run;
    });
}

/** Last four digits of a phone or account number, e.g. XXXXXX3210. */
export function maskTail(value: string | null | undefined, keep = 4): string | null {
  if (!value) return null;
  const digits = value.replace(/\s+/g, "");
  return digits.length <= keep ? digits : `${"X".repeat(Math.min(6, digits.length - keep))}${digits.slice(-keep)}`;
}
