// Build the investor account from what the investor has already told us.
//
// Everything an MF investment account needs is either in the KYC form or is one
// of three things the form never carries — source of wealth, a residential
// address and a nomination. Those three are collected once in the identity
// journey and arrive here; everything else is read back from FP. Nothing is
// asked for twice, and there is no separate "set up your investor account"
// form.
//
// **Idempotent, and safe to call after every step.** Each stage checks what
// already exists before creating anything, so the app can call this as each
// answer lands — profile after the details, address after the address screen,
// nomination after the nominee screen, payout bank when a bank is linked — and
// a retry after a failure resumes rather than duplicates.
//
// **FP first, and one stage at a time.** A stage that cannot run yet is
// reported in `missing` rather than guessed at: FP freezes `name`, `pan`,
// `date_of_birth`, `tax_status`, `occupation`, `gender`, `country_of_birth` and
// `place_of_birth` on the profile the moment it exists, so a stage that
// invented a value would make it permanent.
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import {
  addAddress,
  addEmail,
  addNominee,
  addPhone,
  createInvestmentAccount,
  createInvestorProfile,
  setFolioDefaults,
} from "./investor.service.ts";
import { kycProfilePrefill } from "./kyc-prefill.service.ts";
import { investmentReadiness } from "./investor-readiness.service.ts";
import type {
  KycProfilePrefillDto,
  ProvisionInput,
  ProvisionResult,
} from "../types/investor.types.ts";

/**
 * The profile fields FP refuses an investment account without.
 *
 * From FP's own required-information list for an individual. Checked before the
 * create rather than after, because a profile created without them is frozen
 * incomplete and the investor can never be onboarded on that PAN again.
 */
const REQUIRED_FOR_PROFILE = [
  "gender",
  "occupation",
  "incomeSlab",
  "pepDetails",
  "placeOfBirth",
] as const;

/** India, lower case — the casing `/v2/investor_profiles` documents. */
const INDIA = "in";

/**
 * Only the nominee's own PAN is offered as proof.
 *
 * FP wants `nomineeN_identity_proof_type` to name something the related party
 * actually carries, and answers "proof type should exists for the given
 * nominee" otherwise — so an unnamed nominee PAN means no proof type at all.
 */
const NOMINEE_PROOF_TYPE = "pan";

interface Stage {
  investorProfileId: string | null;
  addressId: string | null;
  phoneNumberId: string | null;
  emailAddressId: string | null;
  relatedPartyId: string | null;
  /** The nominee's own PAN, if they gave one. Decides the proof type FP wants. */
  relatedPartyPan: string | null;
  mfInvestmentAccountId: string | null;
  payoutBankAccountId: string | null;
  nominationRecorded: boolean;
  /** The investor declined to nominate on an earlier call. Sticky. */
  nominationDeclined: boolean;
  /** What the folio defaults already point at, so a no-op patch is skipped. */
  defaults: {
    addressId: string | null;
    phoneNumberId: string | null;
    emailAddressId: string | null;
  };
}

/** What this investor already has. One read, so the stages agree with each other. */
async function readStage(userId: string): Promise<Stage> {
  const link = await db.userInvestorProfile.findFirst({
    where: { userId, relationship: "SELF" },
    orderBy: { isPrimary: "desc" },
    select: { investorProfileId: true },
  });
  const empty = { addressId: null, phoneNumberId: null, emailAddressId: null };
  if (!link) {
    return {
      ...empty, investorProfileId: null, relatedPartyId: null, relatedPartyPan: null,
      mfInvestmentAccountId: null, payoutBankAccountId: null,
      nominationRecorded: false, nominationDeclined: false, defaults: empty,
    };
  }
  const investorProfileId = link.investorProfileId;
  const [address, phone, email, party, account, onboarding] = await Promise.all([
    db.address.findFirst({ where: { investorProfileId }, select: { id: true }, orderBy: { createdAt: "asc" } }),
    db.phoneNumber.findFirst({ where: { investorProfileId }, select: { id: true }, orderBy: { createdAt: "asc" } }),
    db.emailAddress.findFirst({ where: { investorProfileId }, select: { id: true }, orderBy: { createdAt: "asc" } }),
    db.relatedParty.findFirst({ where: { investorProfileId }, select: { id: true, pan: true }, orderBy: { createdAt: "asc" } }),
    db.mfInvestmentAccount.findFirst({
      where: { primaryInvestorProfileId: investorProfileId },
      select: {
        id: true,
        folioDefaults: {
          select: {
            payoutBankAccountId: true,
            communicationAddressId: true,
            communicationPhoneNumberId: true,
            communicationEmailAddressId: true,
          },
        },
        // A nomination is recorded as a slot row, not a column on the defaults.
        nominees: { select: { id: true }, take: 1 },
      },
    }),
    db.investorOnboarding.findUnique({
      where: { investorProfileId },
      select: { nominationOptOutAt: true },
    }),
  ]);
  const defaults = account?.folioDefaults;
  return {
    investorProfileId,
    addressId: address?.id ?? null,
    phoneNumberId: phone?.id ?? null,
    emailAddressId: email?.id ?? null,
    relatedPartyId: party?.id ?? null,
    relatedPartyPan: party?.pan ?? null,
    mfInvestmentAccountId: account?.id ?? null,
    payoutBankAccountId: defaults?.payoutBankAccountId ?? null,
    nominationRecorded: (account?.nominees.length ?? 0) > 0,
    nominationDeclined: onboarding?.nominationOptOutAt !== null && onboarding?.nominationOptOutAt !== undefined,
    defaults: {
      addressId: defaults?.communicationAddressId ?? null,
      phoneNumberId: defaults?.communicationPhoneNumberId ?? null,
      emailAddressId: defaults?.communicationEmailAddressId ?? null,
    },
  };
}

/** Which profile facts the KYC form never supplied. Named so the app can ask. */
function missingProfileFields(
  prefill: KycProfilePrefillDto | null,
  input: ProvisionInput,
): string[] {
  if (!prefill) return ["kycIdentity"];
  const profile = { ...prefill, ...input };
  const gaps: string[] = [];
  if (!profile.name) gaps.push("name");
  if (!profile.dateOfBirth) gaps.push("dateOfBirth");
  for (const field of REQUIRED_FOR_PROFILE) if (!profile[field]) gaps.push(field);
  // Never on a KYC form, so it can only come from the caller.
  if (!input.sourceOfWealth) gaps.push("sourceOfWealth");
  return gaps;
}

/**
 * Advance the investor account as far as the answers allow.
 *
 * Returns what is still outstanding rather than throwing on an incomplete
 * journey — the caller is walking the investor through those answers, and a
 * half-built account is the expected state between two screens.
 */
export async function provisionInvestor(input: ProvisionInput): Promise<ProvisionResult> {
  const { userId } = input;
  const created: string[] = [];
  let stage = await readStage(userId);

  // ---- Profile, and the contacts FP already holds on the KYC form ----------
  const prefill = stage.investorProfileId ? null : await kycProfilePrefill(userId);
  const profileGaps = stage.investorProfileId ? [] : missingProfileFields(prefill, input);

  if (!stage.investorProfileId && prefill && profileGaps.length === 0) {
    // A PAN that is already KYC-registered has no KYC form. In that case the
    // pre-verification supplies the identity and the app supplies the profile
    // answers it just collected. Prefer the form when it exists, and fill only
    // its gaps from the explicit answers.
    const profileData = { ...input, ...prefill };
    const profile = await createInvestorProfile({
      userId,
      name: profileData.name!,
      pan: profileData.pan,
      dateOfBirth: profileData.dateOfBirth!,
      taxStatus: profileData.taxStatus ?? "resident_individual",
      gender: profileData.gender!,
      occupation: profileData.occupation!,
      incomeSlab: profileData.incomeSlab!,
      pepDetails: profileData.pepDetails!,
      placeOfBirth: profileData.placeOfBirth!,
      sourceOfWealth: input.sourceOfWealth!,
      // The KYC form leaves country of birth null more often than not, and this
      // journey is resident individuals only.
      countryOfBirth: input.countryOfBirth ?? profileData.countryOfBirth ?? INDIA,
      nationalityCountry: profileData.nationalityCountry ?? INDIA,
      citizenshipCountries: profileData.citizenshipCountries ?? [INDIA],
      ...(profileData.maritalStatus && { maritalStatus: profileData.maritalStatus }),
      ...(profileData.fatherName && { fatherName: profileData.fatherName }),
      ...(prefill.aadhaarLast4 && { aadhaarLast4: prefill.aadhaarLast4 }),
      ...(input.ipAddress && { ipAddress: input.ipAddress }),
    });
    created.push("profile");
    stage = await readStage(userId);
  }

  if (!stage.investorProfileId) {
    return {
      investorProfileId: null,
      mfInvestmentAccountId: null,
      created,
      missing: [...profileGaps, "address", "nomination", "bankAccount"],
      canTransact: false,
    };
  }
  const investorProfileId = stage.investorProfileId;

  // Contact details. Both come off the KYC form, so neither is ever asked for.
  const contacts = prefill ?? (await kycProfilePrefill(userId));
  if (!stage.phoneNumberId && contacts?.mobile) {
    await addPhone(investorProfileId, { isd: "+91", number: contacts.mobile, belongsTo: "self" });
    created.push("phone");
  }
  if (!stage.emailAddressId && contacts?.email) {
    await addEmail(investorProfileId, { email: contacts.email, belongsTo: "self" });
    created.push("email");
  }

  // ---- Address ------------------------------------------------------------
  // DigiLocker hands it to FP, but `/poa/kyc_forms` returns only
  // `address.proof_type` and `/v2/identity_documents` is not provisioned on
  // this realm, so it is the one identity fact the investor has to type.
  if (!stage.addressId && input.address) {
    await addAddress(investorProfileId, {
      line1: input.address.line1,
      ...(input.address.line2 && { line2: input.address.line2 }),
      ...(input.address.city && { city: input.address.city }),
      ...(input.address.state && { state: input.address.state }),
      postalCode: input.address.postalCode,
      country: "IN",
      // Mandatory on ONDC.
      nature: "residential",
    });
    created.push("address");
  }

  // ---- Nomination ---------------------------------------------------------
  // Declining is a decision the investor made, and it leaves no row of its own
  // to prove it. Recorded before anything reads `missing`, or the next call
  // reports the nomination outstanding again and the journey loops back here.
  if (input.nominationOptOut && !stage.nominationDeclined) {
    await db.investorOnboarding.upsert({
      where: { investorProfileId },
      update: { nominationOptOutAt: new Date() },
      create: { investorProfileId, nominationOptOutAt: new Date() },
    });
    created.push("nominationOptOut");
  }

  if (!stage.relatedPartyId && input.nominee) {
    await addNominee(investorProfileId, {
      name: input.nominee.name,
      relationship: input.nominee.relationship,
      ...(input.nominee.dateOfBirth && { dateOfBirth: input.nominee.dateOfBirth }),
      ...(input.nominee.pan && { pan: input.nominee.pan }),
    });
    created.push("nominee");
    // Naming someone after declining reverses the declaration; the investor's
    // most recent answer is the one that stands.
    if (stage.nominationDeclined) {
      await db.investorOnboarding.update({
        where: { investorProfileId },
        data: { nominationOptOutAt: null },
      });
    }
  }

  stage = await readStage(userId);

  // ---- Investment account -------------------------------------------------
  if (!stage.mfInvestmentAccountId) {
    await createInvestmentAccount(investorProfileId);
    created.push("investmentAccount");
    stage = await readStage(userId);
  }
  const mfInvestmentAccountId = stage.mfInvestmentAccountId;
  if (!mfInvestmentAccountId) {
    throw HttpError.badGateway("The investment account was not created");
  }

  // ---- Folio defaults, patched as each answer lands -----------------------
  // FP merges what is sent, so this runs whenever something new can go in
  // rather than waiting for the whole set.
  // Only what the defaults do not already point at: FP merges, so re-sending
  // an unchanged set is an upstream call that achieves nothing.
  const bankAccountId =
    input.bankAccountId && input.bankAccountId !== stage.payoutBankAccountId
      ? input.bankAccountId
      : null;
  const nominating = Boolean(stage.relatedPartyId) && !stage.nominationDeclined;
  const patch = {
    ...(stage.emailAddressId !== stage.defaults.emailAddressId &&
      stage.emailAddressId && { emailAddressId: stage.emailAddressId }),
    ...(stage.phoneNumberId !== stage.defaults.phoneNumberId &&
      stage.phoneNumberId && { phoneNumberId: stage.phoneNumberId }),
    ...(stage.addressId !== stage.defaults.addressId &&
      stage.addressId && { addressId: stage.addressId }),
    ...(bankAccountId && { bankAccountId }),
    ...(nominating && !stage.nominationRecorded && {
      nominees: [
        {
          relatedPartyId: stage.relatedPartyId!,
          allocationPercentage: "100",
          // Read off the nominee FP already holds, never off this request's
          // body. The related party is created on one call and the folio
          // defaults can be patched on a later one that carries no nominee at
          // all — the bank step, or a retry — and a nominee whose PAN FP holds,
          // sent without the matching proof type, is answered "proof type
          // should exists for the given nominee" and the nomination is never
          // recorded.
          ...(stage.relatedPartyPan && { identityProofType: NOMINEE_PROOF_TYPE }),
        },
      ],
      nominationsInfoVisibility: "show_all_nominee_names",
    }),
  };
  if (Object.keys(patch).length > 0) {
    await setFolioDefaults(mfInvestmentAccountId, patch);
    created.push("folioDefaults");
    stage = await readStage(userId);
  }

  const missing: string[] = [];
  if (!stage.addressId) missing.push("address");
  if (!stage.nominationRecorded && !stage.nominationDeclined) missing.push("nomination");
  if (!stage.payoutBankAccountId) missing.push("bankAccount");

  const readiness = await investmentReadiness(mfInvestmentAccountId);
  return {
    investorProfileId,
    mfInvestmentAccountId,
    created,
    missing,
    canTransact: readiness.canTransact,
  };
}
