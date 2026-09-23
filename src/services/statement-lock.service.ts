// Password-protecting a generated statement PDF.
//
// The client renders the statement (it owns the layout template) and sends the
// unencrypted PDF here to be locked. Encryption happens on this side for one
// reason: the password is the investor's full PAN, which the client never holds
// — the workspace only ever exposes a masked PAN. Doing it here keeps the full
// PAN server-side and makes the lock authoritative rather than client-supplied.
import { PDFDocument } from "@cantoo/pdf-lib";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";

/**
 * The PAN that opens the account's statements — the primary holder's.
 *
 * Prefers the linked profile's PAN and falls back to the PAN captured on the
 * account before a profile existed. Uppercased, because that is how a PAN is
 * printed and how the investor will type it.
 */
async function accountPan(mfInvestmentAccountId: string): Promise<string> {
  const account = await db.mfInvestmentAccount.findUnique({
    where: { id: mfInvestmentAccountId },
    select: {
      primaryInvestorPan: true,
      primaryInvestorProfile: { select: { pan: true } },
    },
  });
  if (!account) throw HttpError.notFound("No such investment account");

  const pan = account.primaryInvestorProfile?.pan ?? account.primaryInvestorPan;
  if (!pan) {
    // Without a PAN there is no password to set, and a silently-unlocked
    // statement would be worse than a clear failure.
    throw HttpError.conflict("This account has no PAN on record to lock the statement with");
  }
  return pan.toUpperCase();
}

/**
 * Encrypt a statement PDF with the account holder's PAN.
 *
 * Both the user (open) and owner (permissions) passwords are the PAN: there is
 * no separate owner who should be able to bypass it, and a null owner password
 * would let a reader strip the protection.
 */
export async function lockStatementPdf(
  mfInvestmentAccountId: string,
  pdf: Uint8Array,
): Promise<Uint8Array> {
  if (pdf.byteLength === 0) throw HttpError.badRequest("No PDF was uploaded");

  const password = await accountPan(mfInvestmentAccountId);

  let document: PDFDocument;
  try {
    document = await PDFDocument.load(pdf);
  } catch {
    throw HttpError.badRequest("The uploaded file is not a readable PDF");
  }

  await document.encrypt({ userPassword: password, ownerPassword: password });
  return document.save();
}
