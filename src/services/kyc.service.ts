// KYC: is this investor allowed to transact, and if not, how do they become so?
//
// There are two routes, and which one a deployment has depends on provisioning:
//
//   tenant realm  /api/kyc/check + /v2/kyc_requests   FP's own KYC
//   partner realm /poa/pre_verifications + /poa/kyc_forms  Cybrilla POA
//
// On the sandbox tenant we hold, the tenant realm answers 404 / "Couldn't find
// Tenant" and the partner realm works, so this service leads with the partner
// route and treats the tenant route as the fallback. Both are implemented;
// neither is assumed.
import { KycFormStatus, KycFormType } from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import {
  fpErrorToHttpError,
  fpKycForms,
  fpPreVerification,
  hasPreVerifyConfig,
} from "../integrations/fp/index.ts";
import { HttpError } from "../utils/http-error.ts";
import { asDate } from "../utils/money.ts";
import { syncKycForm } from "./fp-sync/index.ts";
import { syncPreVerification } from "./fp-sync/preverification.sync.ts";
import type {
  KycFormDto,
  KycReadinessDto,
  StartKycInput,
  UpdateKycFormInput,
} from "../types/kyc.types.ts";

/**
 * Check whether a PAN can transact, using pre-verification.
 *
 * `readiness.status` is the answer — the top-level `status` only acknowledges
 * that the request was accepted. The check runs asynchronously, so a fresh
 * request usually comes back with readiness still null; the caller polls, or
 * re-reads when the investor returns.
 */
export async function checkReadiness(input: {
  userId: string;
  investorProfileId?: string;
  pan: string;
  name: string;
  dateOfBirth: string;
  bankAccount?: { accountNumber: string; ifscCode: string; accountType: string };
}): Promise<KycReadinessDto> {
  if (!hasPreVerifyConfig()) {
    throw HttpError.serviceUnavailable("Pre-verification is not configured");
  }

  try {
    const result = await fpPreVerification.createPreVerification({
      investor_identifier: input.pan,
      pan: { value: input.pan },
      name: { value: input.name },
      date_of_birth: { value: input.dateOfBirth },
      ...(input.bankAccount && {
        bank_accounts: [
          {
            value: {
              account_number: input.bankAccount.accountNumber,
              ifsc_code: input.bankAccount.ifscCode,
              account_type: input.bankAccount.accountType,
            },
            verify_manually_if_required: false,
          },
        ],
      }),
    });
    await syncPreVerification(result, { userId: input.userId, ...(input.investorProfileId && { investorProfileId: input.investorProfileId }) });
    return toReadinessDto(result);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function getReadiness(preVerificationId: string): Promise<KycReadinessDto> {
  try {
    const result = await fpPreVerification.fetchPreVerification(preVerificationId);
    await syncPreVerification(result);
    return toReadinessDto(result);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

function toReadinessDto(result: fpPreVerification.FpPreVerification): KycReadinessDto {
  const bank = result.bank_accounts?.[0];
  return {
    id: result.id,
    pan: result.pan?.value ?? result.investor_identifier ?? null,
    // null while the checks are still running.
    ready: result.readiness.status === "verified",
    readinessStatus: result.readiness.status,
    readinessCode: result.readiness.code,
    checks: {
      pan: { status: result.pan?.status ?? null, code: result.pan?.code ?? null },
      name: { status: result.name?.status ?? null, code: result.name?.code ?? null },
      dateOfBirth: {
        status: result.date_of_birth?.status ?? null,
        code: result.date_of_birth?.code ?? null,
      },
      ...(bank && { bankAccount: { status: bank.status, code: bank.code } }),
    },
    completedAt: result.completed_at,
  };
}

// ---------------------------------------------------------------------------
// KYC forms
// ---------------------------------------------------------------------------

const formSelect = {
  id: true,
  fpId: true,
  type: true,
  status: true,
  reason: true,
  pan: true,
  name: true,
  dateOfBirth: true,
  proofFetchUrl: true,
  proofStatus: true,
  esignUrl: true,
  esignStatus: true,
  signatureProvided: true,
  fieldsNeeded: true,
  expiresAt: true,
  submittedAt: true,
  failedAt: true,
  createdAt: true,
  fpCreatedAt: true,
} as const;

interface FormRow {
  id: string;
  fpId: string;
  type: string;
  status: string;
  reason: string | null;
  pan: string;
  name: string;
  dateOfBirth: Date;
  proofFetchUrl: string | null;
  proofStatus: string | null;
  esignUrl: string | null;
  esignStatus: string | null;
  signatureProvided: boolean;
  fieldsNeeded: string[];
  expiresAt: Date | null;
  submittedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  fpCreatedAt: Date | null;
}

/** What the investor has to do next, so the app can route them straight there. */
function nextAction(row: FormRow): KycFormDto["nextAction"] {
  if (row.status === KycFormStatus.CREATED) {
    if (row.proofStatus !== "SUCCESSFUL") return "FETCH_PROOF";
    if (!row.signatureProvided) return "UPLOAD_SIGNATURE";
    if (row.fieldsNeeded.length > 0) return "PROVIDE_DETAILS";
    return null;
  }
  if (row.status === KycFormStatus.AWAITING_ESIGN) return "ESIGN";
  return null;
}

function toFormDto(row: FormRow): KycFormDto {
  return {
    id: row.id,
    fpId: row.fpId,
    type: row.type,
    status: row.status,
    reason: row.reason,
    pan: row.pan,
    name: row.name,
    dateOfBirth: asDate(row.dateOfBirth),
    fieldsNeeded: row.fieldsNeeded,
    signatureProvided: row.signatureProvided,
    // Both are short-lived and belong to the investor's browser, not to us.
    proofFetchUrl: row.proofFetchUrl,
    proofStatus: row.proofStatus,
    esignUrl: row.esignUrl,
    esignStatus: row.esignStatus,
    nextAction: nextAction(row),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    createdAt: (row.fpCreatedAt ?? row.createdAt).toISOString(),
  };
}

/**
 * Start a KYC form.
 *
 * `type` is not a free choice: FRESH needs a PAN with no KYC, MODIFY needs one
 * already registered, and the wrong pick settles to FAILED with
 * `ineligible_for_fresh_kyc` / `ineligible_for_kyc_modification` a moment
 * later. Run `checkReadiness` first and pick accordingly.
 *
 * Returns while still UNDER_REVIEW — eligibility is decided asynchronously, so
 * poll `refreshForm` before showing the investor a form to fill in.
 */
export async function startKycForm(input: StartKycInput): Promise<KycFormDto> {
  if (!hasPreVerifyConfig()) {
    throw HttpError.serviceUnavailable("KYC forms are not configured");
  }

  // One live form per PAN: FP rejects a second with "An ongoing KYC Form
  // already exists for this PAN", and failing here is clearer than failing
  // asynchronously.
  const existing = await db.kycForm.findFirst({
    where: {
      pan: input.pan.toUpperCase(),
      status: {
        in: [
          KycFormStatus.UNDER_REVIEW,
          KycFormStatus.CREATED,
          KycFormStatus.AWAITING_ESIGN,
          KycFormStatus.AWAITING_SUBMISSION,
        ],
      },
    },
    select: { id: true },
  });
  if (existing) {
    throw HttpError.conflict("A KYC form is already in progress for this PAN", {
      kycFormId: existing.id,
    });
  }

  try {
    const created = await fpKycForms.createKycForm({
      type: input.type === KycFormType.MODIFY ? "modify" : "fresh",
      pan: input.pan.toUpperCase(),
      name: input.name,
      date_of_birth: input.dateOfBirth,
      proof_details_callback_url: input.proofCallbackUrl,
      esign_callback_url: input.esignCallbackUrl,
    });
    const row = await syncKycForm(created, {
      userId: input.userId ?? null,
      investorProfileId: input.investorProfileId ?? null,
    });
    return getForm(row.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** Fill in the fields FP named in `fieldsNeeded`. */
export async function updateKycForm(
  id: string,
  input: UpdateKycFormInput,
): Promise<KycFormDto> {
  const form = await db.kycForm.findUnique({
    where: { id },
    select: { fpId: true, status: true, userId: true, investorProfileId: true },
  });
  if (!form) throw HttpError.notFound("No such KYC form");
  if (form.status !== KycFormStatus.CREATED) {
    throw HttpError.conflict("This form is not open for changes", { status: form.status });
  }

  try {
    const updated = await fpKycForms.updateKycForm({
      id: form.fpId,
      ...(input.email && { email_address: input.email }),
      ...(input.mobile && { phone_number: { isd: input.mobile.isd, number: input.mobile.number } }),
      ...(input.residentialStatus && { residential_status: input.residentialStatus }),
      ...(input.gender && { gender: input.gender }),
      ...(input.maritalStatus && { marital_status: input.maritalStatus }),
      // FP asks for exactly one of these, decided by marital status.
      ...(input.fatherName && { father_name: input.fatherName }),
      ...(input.spouseName && { spouse_name: input.spouseName }),
      ...(input.occupationType && { occupation_type: input.occupationType }),
      ...(input.aadhaarLast4 && { aadhaar_number: input.aadhaarLast4 }),
      ...(input.countryOfBirth && { country_of_birth: input.countryOfBirth }),
      ...(input.placeOfBirth && { place_of_birth: input.placeOfBirth }),
      ...(input.incomeSlab && { income_slab: input.incomeSlab }),
      ...(input.pepDetails && { pep_details: input.pepDetails }),
      ...(input.citizenshipCountries?.length && {
        citizenship_countries: input.citizenshipCountries,
      }),
      ...(input.nationalityCountry && { nationality_country: input.nationalityCountry }),
      ...(input.taxResidencyOtherThanIndia !== undefined && {
        tax_residency_other_than_india: input.taxResidencyOtherThanIndia,
      }),
      ...(input.geolocation && { geo_location: input.geolocation }),
    });
    await syncKycForm(updated, {
      userId: form.userId,
      investorProfileId: form.investorProfileId,
    });
    return getForm(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** png, jpg, jpeg or pdf, up to 5MB. */
export async function uploadSignature(
  id: string,
  file: Blob,
  filename: string,
): Promise<KycFormDto> {
  const form = await db.kycForm.findUnique({
    where: { id },
    select: { fpId: true, userId: true, investorProfileId: true },
  });
  if (!form) throw HttpError.notFound("No such KYC form");

  try {
    const updated = await fpKycForms.uploadSignature(form.fpId, file, filename);
    await syncKycForm(updated, {
      userId: form.userId,
      investorProfileId: form.investorProfileId,
    });
    return getForm(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** Issue a new DigiLocker link after a failed fetch. */
export async function retryProofFetch(id: string): Promise<KycFormDto> {
  const form = await db.kycForm.findUnique({
    where: { id },
    select: { fpId: true, proofStatus: true, userId: true, investorProfileId: true },
  });
  if (!form) throw HttpError.notFound("No such KYC form");
  if (form.proofStatus !== "FAILED") {
    throw HttpError.conflict("A new proof link can only be issued after a failed fetch", {
      proofStatus: form.proofStatus,
    });
  }

  try {
    const updated = await fpKycForms.retryProofDetailsFetch(form.fpId);
    await syncKycForm(updated, {
      userId: form.userId,
      investorProfileId: form.investorProfileId,
    });
    return getForm(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Re-read the form from FP.
 *
 * Needed more than elsewhere in this integration: eligibility, the DigiLocker
 * fetch and the esign all complete out of band, and there are no webhooks for
 * KYC forms on this realm.
 */
export async function refreshForm(id: string): Promise<KycFormDto> {
  const form = await db.kycForm.findUnique({
    where: { id },
    select: { fpId: true, userId: true, investorProfileId: true },
  });
  if (!form) throw HttpError.notFound("No such KYC form");

  try {
    const fresh = await fpKycForms.fetchKycForm(form.fpId);
    await syncKycForm(fresh, {
      userId: form.userId,
      investorProfileId: form.investorProfileId,
    });
    return getForm(id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function getForm(id: string): Promise<KycFormDto> {
  const row = await db.kycForm.findUnique({ where: { id }, select: formSelect });
  if (!row) throw HttpError.notFound("No such KYC form");
  return toFormDto(row);
}

export async function listForms(userId: string): Promise<KycFormDto[]> {
  const rows = await db.kycForm.findMany({
    where: { userId },
    select: formSelect,
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map(toFormDto);
}
