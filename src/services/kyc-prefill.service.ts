// What the investor already told the KYC form, shaped for an investor profile.
//
// The two objects ask for the same facts in two different vocabularies, and FP
// makes most profile fields write-once — so a mistyped re-entry is permanent.
// Everything the KYC form already holds is therefore read back and translated
// here, in one place, rather than asked for a second time.
//
// Read live from FP rather than from our mirror: `kyc_forms` stores only the
// identity columns (pan, name, date of birth, email, phone), so the answers
// themselves exist nowhere else on this side.
//
// This is a prefill, never an auto-create. FP freezes `name`, `pan`,
// `date_of_birth`, `tax_status`, `occupation`, `gender`, `country_of_birth` and
// `place_of_birth` the moment a profile is created, so the investor has to see
// and accept them first.
import { db } from "../db/client.ts";
import { fpErrorToHttpError, fpKycForms } from "../integrations/fp/index.ts";
import type { FpKycForm } from "../integrations/fp/resources/kyc-forms.ts";
import type { KycProfilePrefillDto } from "../types/investor.types.ts";

/**
 * KYC occupations that are spelled differently on `investor_profile`.
 *
 * Only the exceptions are listed — every other value is identical in both
 * vocabularies, and a full table would rot the moment FP adds one.
 */
const OCCUPATION_TO_PROFILE: Record<string, string> = {
  housewife: "house_wife",
  private_sector: "private_sector_service",
  public_sector: "public_sector_service",
  government_sector: "government_service",
};

/** `kyc_form.pep_details` -> `investor_profile.pep_details`. Nothing overlaps. */
const PEP_TO_PROFILE: Record<string, string> = {
  no_exposure: "not_applicable",
  pep: "pep_exposed",
  related_pep: "pep_related",
};

/** The KYC form says `unmarried`; the profile accepts only `single`. */
const MARITAL_TO_PROFILE: Record<string, string> = { unmarried: "single" };

const PROFILE_OCCUPATIONS = new Set([
  "business", "professional", "retired", "house_wife", "student",
  "public_sector_service", "private_sector_service", "government_service",
  "agriculture", "doctor", "forex_dealer", "service", "others",
]);
const PROFILE_MARITAL = new Set(["married", "single", "others"]);
const PROFILE_PEP = new Set(["pep_exposed", "pep_related", "not_applicable"]);
const PROFILE_GENDERS = new Set(["male", "female", "transgender"]);
const PROFILE_INCOME_SLABS = new Set([
  "upto_1lakh", "above_1lakh_upto_5lakh", "above_5lakh_upto_10lakh",
  "above_10lakh_upto_25lakh", "above_25lakh_upto_1cr", "above_1cr",
]);

/**
 * Translate one value, dropping it unless the result is a value the profile
 * endpoint accepts.
 *
 * Dropping beats passing it through: FP rejects the whole create on one
 * unmapped spelling, which would fail the profile over a field the investor
 * could just as well have picked themselves.
 */
function toProfileValue(
  value: string | null,
  aliases: Record<string, string>,
  allowed: Set<string>,
): string | undefined {
  if (!value) return undefined;
  const mapped = aliases[value] ?? value;
  return allowed.has(mapped) ? mapped : undefined;
}

/** Two letters, lower case — the casing `/v2/investor_profiles` documents. */
function countryCode(value: string | null): string | undefined {
  return value && /^[A-Za-z]{2}$/.test(value) ? value.toLowerCase() : undefined;
}

/** `{ key: value }`, or nothing at all when there is no value to carry. */
function carry<K extends string, V extends string | string[]>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined || value.length === 0
    ? {}
    : ({ [key]: value } as Record<K, V>);
}

/**
 * One KYC form's answers, in the investor profile's vocabulary.
 *
 * Pure, and separate from the fetch below so the translation can be tested
 * without an FP token behind it — the same reason `kyc-steps.ts` is its own
 * module.
 */
export function kycFormToProfileFields(
  kyc: FpKycForm,
): Omit<KycProfilePrefillDto, "source"> {
  const citizenships = (kyc.citizenship_countries ?? [])
    .map(countryCode)
    .filter((value): value is string => value !== undefined);

  return {
    pan: kyc.pan,
    name: kyc.name,
    dateOfBirth: kyc.date_of_birth.slice(0, 10),
    // The only status this KYC form supports, and the only one the rest of the
    // journey is built for.
    taxStatus: "resident_individual",
    ...carry("email", kyc.email_address ?? undefined),
    ...carry("mobile", kyc.phone_number?.number ?? undefined),
    ...carry("gender", toProfileValue(kyc.gender, {}, PROFILE_GENDERS)),
    ...carry(
      "maritalStatus",
      toProfileValue(kyc.marital_status, MARITAL_TO_PROFILE, PROFILE_MARITAL),
    ),
    // Only one of these is ever set, decided by marital status; the profile has
    // no spouse field, so a married investor still types their father's name.
    ...carry("fatherName", kyc.father_name ?? undefined),
    ...carry(
      "occupation",
      toProfileValue(kyc.occupation_type, OCCUPATION_TO_PROFILE, PROFILE_OCCUPATIONS),
    ),
    ...carry("incomeSlab", toProfileValue(kyc.income_slab, {}, PROFILE_INCOME_SLABS)),
    ...carry("pepDetails", toProfileValue(kyc.pep_details, PEP_TO_PROFILE, PROFILE_PEP)),
    ...carry("placeOfBirth", kyc.place_of_birth ?? undefined),
    ...carry("countryOfBirth", countryCode(kyc.country_of_birth)),
    ...carry("nationalityCountry", countryCode(kyc.nationality_country)),
    ...carry("citizenshipCountries", citizenships),
    ...carry("aadhaarLast4", kyc.aadhaar_number ?? undefined),
    // Deliberately absent: the residential address. DigiLocker hands it to FP
    // but `/poa/kyc_forms` returns only `address.proof_type`, so there is
    // nothing to carry over and the address card still has to ask.
  };
}

/**
 * The investor's own answers, ready to be shown back to them.
 *
 * Returns the identity alone when there is no KYC form — a PAN already
 * registered at the KRA never opens one, and its name and date of birth are
 * still worth carrying over from the pre-verification rather than retyped.
 *
 * `null` only when this user has neither.
 */
export async function kycProfilePrefill(
  userId: string,
): Promise<KycProfilePrefillDto | null> {
  const form = await db.kycForm.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { fpId: true },
  });

  if (!form) {
    const check = await db.preVerification.findFirst({
      where: { userId, panStatus: "verified" },
      orderBy: { fpCreatedAt: "desc" },
      select: { pan: true, name: true, dateOfBirth: true },
    });
    if (!check?.pan) return null;
    return {
      source: "pre_verification",
      pan: check.pan,
      ...carry("name", check.name ?? undefined),
      ...carry("dateOfBirth", check.dateOfBirth?.toISOString().slice(0, 10)),
      taxStatus: "resident_individual",
    };
  }

  try {
    const kyc = await fpKycForms.fetchKycForm(form.fpId);
    return { source: "kyc_form", ...kycFormToProfileFields(kyc) };
  } catch (error) {
    fpErrorToHttpError(error);
  }
}
