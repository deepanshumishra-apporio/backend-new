import { db } from "../../db/client.ts";
import type { FpPreVerification } from "../../integrations/fp/resources/preverification.ts";
import { fpDate, fpDateTime, fpFlatText, bankAccountFingerprint } from "../../utils/fp-mapping.ts";

/** Persist all results atomically; an older poll must not undo a completed check. */
export async function syncPreVerification(result: FpPreVerification, links: { userId?: string; investorProfileId?: string } = {}) {
  const updatedAt = fpDateTime(result.updated_at);
  if (!updatedAt || !result.id || !result.readiness || !["accepted", "completed"].includes(result.status)) {
    throw new Error("Invalid pre-verification response");
  }
  const fields = {
    status: result.status, investorIdentifier: result.investor_identifier,
    readinessStatus: result.readiness.status, readinessCode: result.readiness.code,
    readinessReason: result.readiness.reason,
    // Not always a string: FP returns a {status, requested_at} object here on
    // some records, which a bare assignment turns into a 500 on every poll.
    readinessModification: fpFlatText(result.readiness.modification, 120),
    pan: result.pan?.value ?? null, panStatus: result.pan?.status ?? null,
    panCode: result.pan?.code ?? null, panReason: result.pan?.reason ?? null,
    name: result.name?.value ?? null, nameStatus: result.name?.status ?? null,
    nameCode: result.name?.code ?? null, nameReason: result.name?.reason ?? null,
    dateOfBirth: fpDate(result.date_of_birth?.value), dateOfBirthStatus: result.date_of_birth?.status ?? null,
    dateOfBirthCode: result.date_of_birth?.code ?? null, dateOfBirthReason: result.date_of_birth?.reason ?? null,
    fpCreatedAt: fpDateTime(result.created_at), fpUpdatedAt: updatedAt,
    completedAt: fpDateTime(result.completed_at), syncedAt: new Date(), ...links,
  };
  return db.$transaction(async tx => {
    const row = await tx.preVerification.upsert({ where: { fpId: result.id }, update: {}, create: { fpId: result.id, ...fields } });
    if (links.userId && row.userId && row.userId !== links.userId) throw new Error("Verification ownership conflict");
    const saved = await tx.preVerification.updateMany({
      where: { id: row.id, OR: [{ fpUpdatedAt: null }, { fpUpdatedAt: { lte: updatedAt } }] }, data: fields,
    });
    if (saved.count) {
      await tx.preVerificationBankResult.deleteMany({ where: { preVerificationId: row.id } });
      if (result.bank_accounts?.length) await tx.preVerificationBankResult.createMany({
        data: await Promise.all(result.bank_accounts.map(async (bank, position) => ({
          preVerificationId: row.id, position, status: bank.status, code: bank.code, reason: bank.reason,
          accountNumber: bank.value.account_number, ifscCode: bank.value.ifsc_code,
          accountNumberFingerprint: await bankAccountFingerprint(bank.value.account_number, bank.value.ifsc_code),
          accountType: bank.value.account_type, bankAccountProofFpId: bank.value.bank_account_proof,
        }))),
      });
    }
    return { id: row.id };
  });
}
