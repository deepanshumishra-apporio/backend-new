// Which step of a POA KYC form the investor owes next.
//
// Pure, and kept out of `kyc.service.ts` so the ordering can be tested without
// a database or an FP token behind it.
import { KycFormStatus } from "../../generated/prisma/enums.ts";

/** Where to send the investor next, or null when it is the provider's turn. */
export type KycNextAction =
  | "FETCH_PROOF"
  | "UPLOAD_SIGNATURE"
  | "PROVIDE_DETAILS"
  | "ESIGN"
  | null;

/**
 * Requirements POA names in `fields_needed` that no form input can answer.
 *
 * `identity_proof` and `address` are both satisfied by the DigiLocker fetch and
 * `signature` by the upload endpoint, so counting them as outstanding *form*
 * fields would park the investor on the details screen with nothing to type.
 * Everything else — `geolocation` included — is the investor's to supply.
 */
export const ProviderSuppliedFields: readonly string[] = [
  "identity_proof",
  "address",
  "signature",
];

export interface KycStepState {
  status: string;
  /** POA's `requirements.fields_needed`, verbatim. */
  fieldsNeeded: readonly string[];
  /** Mirrors `proof_details.status`; SUCCESSFUL is POA's "fetched". */
  proofStatus: string | null;
  signatureProvided: boolean;
}

/** Anything left in `fields_needed` that a screen can actually ask for. */
export function outstandingInvestorFields(
  fieldsNeeded: readonly string[],
): string[] {
  return fieldsNeeded.filter((field) => !ProviderSuppliedFields.includes(field));
}

/**
 * The next step, in the order the POA docs prescribe:
 *
 *   created → answer `fields_needed` → DigiLocker → signature → esign
 *
 * Asking for the proof first is wrong and was the bug: `proofStatus` is PENDING
 * from the moment a form is created, so `PROVIDE_DETAILS` was unreachable until
 * after DigiLocker and a resumed investor was sent to DigiLocker before they
 * had answered a single question.
 */
export function kycNextAction(state: KycStepState): KycNextAction {
  if (state.status === KycFormStatus.AWAITING_ESIGN) return "ESIGN";
  if (state.status !== KycFormStatus.CREATED) return null;

  if (outstandingInvestorFields(state.fieldsNeeded).length > 0) return "PROVIDE_DETAILS";
  if (state.proofStatus !== "SUCCESSFUL") return "FETCH_PROOF";
  if (!state.signatureProvided) return "UPLOAD_SIGNATURE";
  return null;
}
