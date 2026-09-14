// Mirror KYC checks and digital KYC requests.
import { db } from "../../db/client.ts";
import {
  DocumentFetchStatus,
  EsignStatus,
  Gender,
  IdentityProofType,
  IncomeSlab,
  KycFormStatus,
  KycFormType,
  KycOccupationType,
  KycRequestStatus,
  MaritalStatus,
  PepDetails,
  ResidentialStatus,
} from "../../../generated/prisma/enums.ts";
import {
  fpBool,
  fpDate,
  fpDateTime,
  fpDecimal,
  fpEnum,
  fpEnumOr,
  fpJson,
  fpStringArray,
  fpText,
  lastFour,
} from "../../utils/fp-mapping.ts";
import type { FpKycCheck, FpKycRequest } from "../../integrations/fp/fp.types.ts";
import type { FpKycForm } from "../../integrations/fp/resources/kyc-forms.ts";

function unknownValue(field: string) {
  return (value: string) => console.warn(`[fp-sync] unmapped ${field}: "${value}"`);
}

export interface KycCheckLinks {
  userId?: string | null;
  investorProfileId?: string | null;
}

/**
 * Mirror a KYC check.
 *
 * Kept as history rather than overwritten per PAN: a PAN can move from
 * non-compliant to compliant, and the old row is what explains why we sent that
 * investor down the digital-KYC path.
 */
export async function syncKycCheck(
  check: FpKycCheck,
  links: KycCheckLinks = {},
): Promise<{ id: string }> {
  const data = {
    pan: check.pan,
    isCompliant: check.status === true,
    action: fpText(check.action, 60),
    reason: fpText(check.reason, 120),
    sourceRefId: fpText(check.source_ref_id, 120),
    // Json: the shape varies by KRA and by call variant, and nothing queries
    // inside it — it only ever prefills a form.
    entityDetails: fpJson(check.entity_details),
    constraints: fpJson(check.constraints),
    sources: fpJson(check.sources),
    fpCreatedAt: fpDateTime(check.created_at),
    fpUpdatedAt: fpDateTime(check.updated_at),
    userId: links.userId ?? null,
    investorProfileId: links.investorProfileId ?? null,
    syncedAt: new Date(),
  };

  return db.kycCheck.upsert({
    where: { fpId: check.id },
    update: data,
    create: { fpId: check.id, ...data },
    select: { id: true },
  });
}

export async function syncKycRequest(
  request: FpKycRequest,
  links: KycCheckLinks = {},
): Promise<{ id: string }> {
  const data = {
    status: fpEnumOr(
      KycRequestStatus,
      request.status,
      KycRequestStatus.PENDING,
      unknownValue("kyc status"),
    ),
    name: fpText(request.name, 70) ?? request.name,
    pan: request.pan,
    dateOfBirth: fpDate(request.date_of_birth) ?? new Date(0),
    aadhaarLast4: lastFour(request.aadhaar_number),
    fatherName: fpText(request.father_name, 70),
    motherName: fpText(request.mother_name, 70),
    spouseName: fpText(request.spouse_name, 70),
    gender: fpEnum(Gender, request.gender, unknownValue("gender")),
    maritalStatus: fpEnum(MaritalStatus, request.marital_status, unknownValue("marital_status")),
    residentialStatus: fpEnum(
      ResidentialStatus,
      request.residential_status,
      unknownValue("residential_status"),
    ),
    // Note: kyc_request uses a DIFFERENT occupation vocabulary from
    // investor_profile. Mapping through KycOccupationType is deliberate.
    occupationType: fpEnum(
      KycOccupationType,
      request.occupation_type,
      unknownValue("occupation_type"),
    ),
    email: request.email,
    mobileIsd: request.mobile?.isd ?? "",
    mobileNumber: request.mobile?.number ?? "",
    citizenshipCountries: fpStringArray(request.citizenship_countries),
    nationalityCountry: fpText(request.nationality_country, 2),
    countryOfBirth: fpText(request.country_of_birth, 2),
    placeOfBirth: fpText(request.place_of_birth, 120),
    incomeSlab: fpEnum(IncomeSlab, request.income_slab, unknownValue("income_slab")),
    pepDetails: fpEnum(PepDetails, request.pep_details, unknownValue("pep_details")),
    taxResidencyOtherThanIndia: fpBool(request.tax_residency_other_than_india),
    addressProofType: fpEnum(
      IdentityProofType,
      request.address?.proof_type,
      unknownValue("address proof_type"),
    ),
    geoLatitude: fpDecimal(request.geolocation?.latitude, 6),
    geoLongitude: fpDecimal(request.geolocation?.longitude, 6),
    // Drive the form off this, not off a hardcoded list of fields.
    fieldsNeeded: fpStringArray(request.requirements?.fields_needed),
    verificationStatus: fpEnum(
      KycRequestStatus,
      request.verification?.status,
      unknownValue("verification status"),
    ),
    verificationDetails: fpJson(request.verification?.details_verbose),
    expiresAt: fpDateTime(request.expires_at) ?? new Date(Date.now() + 5 * 86_400_000),
    esignRequiredAt: fpDateTime(request.esign_required_at),
    submittedAt: fpDateTime(request.submitted_at),
    successfulAt: fpDateTime(request.successful_at),
    rejectedAt: fpDateTime(request.rejected_at),
    fpCreatedAt: fpDateTime(request.created_at),
    fpUpdatedAt: fpDateTime(request.updated_at),
    userId: links.userId ?? null,
    investorProfileId: links.investorProfileId ?? null,
    syncedAt: new Date(),
  };

  const row = await db.kycRequest.upsert({
    where: { fpId: request.id },
    update: data,
    create: { fpId: request.id, ...data },
    select: { id: true },
  });

  const residencies = [
    request.non_indian_tax_residency_1,
    request.non_indian_tax_residency_2,
    request.non_indian_tax_residency_3,
  ];
  for (const [index, residency] of residencies.entries()) {
    const slot = index + 1;
    if (!residency?.country || !residency.taxid_number) {
      await db.kycRequestTaxResidency.deleteMany({ where: { kycRequestId: row.id, slot } });
      continue;
    }
    await db.kycRequestTaxResidency.upsert({
      where: { kycRequestId_slot: { kycRequestId: row.id, slot } },
      update: { country: residency.country, taxIdNumber: residency.taxid_number },
      create: {
        kycRequestId: row.id,
        slot,
        country: residency.country,
        taxIdNumber: residency.taxid_number,
      },
    });
  }

  return row;
}

/**
 * Mirror a Cybrilla POA KYC form.
 *
 * Separate from `syncKycRequest`: the two are different objects on different
 * realms, and a deployment may use either. Upserts on `fpId` like everything
 * else, so polling the same form repeatedly converges rather than duplicating.
 */
export async function syncKycForm(
  form: FpKycForm,
  links: KycCheckLinks = {},
): Promise<{ id: string }> {
  const data = {
    type: fpEnumOr(KycFormType, form.type, KycFormType.FRESH, unknownValue("kyc form type")),
    status: fpEnumOr(
      KycFormStatus,
      form.status,
      KycFormStatus.UNDER_REVIEW,
      unknownValue("kyc form status"),
    ),
    reason: fpText(form.reason, 120),
    pan: form.pan,
    name: fpText(form.name, 70) ?? form.name,
    dateOfBirth: fpDate(form.date_of_birth) ?? new Date(0),
    email: fpText(form.email_address, 255),
    mobileIsd: fpText(form.phone_number?.isd, 4),
    mobileNumber: fpText(form.phone_number?.number, 20),
    proofFetchUrl: fpText(form.proof_details?.fetch_url, 1000),
    proofStatus: fpEnum(DocumentFetchStatus, form.proof_details?.status, unknownValue("proof")),
    proofCallbackUrl: fpText(form.proof_details_callback_url, 1000),
    esignCallbackUrl: fpText(form.esign_callback_url, 1000),
    esignUrl: fpText(form.esign_details?.esign_url, 1000),
    esignStatus: fpEnum(EsignStatus, form.esign_details?.status, unknownValue("esign")),
    signatureProvided: form.signature_provided === true,
    fieldsNeeded: fpStringArray(form.requirements?.fields_needed),
    fpCreatedAt: fpDateTime(form.created_at),
    fpUpdatedAt: fpDateTime(form.updated_at),
    reviewCompletedAt: fpDateTime(form.review_completed_at),
    awaitingEsignAt: fpDateTime(form.awaiting_esign_at),
    awaitingSubmissionAt: fpDateTime(form.awaiting_submission_at),
    submittedAt: fpDateTime(form.submitted_at),
    failedAt: fpDateTime(form.failed_at),
    expiresAt: fpDateTime(form.expires_at),
    userId: links.userId ?? null,
    investorProfileId: links.investorProfileId ?? null,
    syncedAt: new Date(),
  };

  return db.kycForm.upsert({
    where: { fpId: form.id },
    update: data,
    create: { fpId: form.id, ...data },
    select: { id: true },
  });
}
