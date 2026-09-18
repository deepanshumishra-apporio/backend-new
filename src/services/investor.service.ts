// The investor onboarding journey.
//
// Each step does the same three things in the same order: call FP, mirror the
// response, advance the onboarding cursor. FP first, always — it owns the
// identifiers, and a local row written before FP accepted the object would be
// a row we can never reconcile.
//
// The cursor (`InvestorOnboarding.stage`) is a convenience for the app, never
// an authority. Anything that gates money reads the underlying rows.
import {
  BavConfidence,
  BavStatus,
  KycFormStatus,
  OnboardingStage,
  UserProfileRelationship,
} from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import { kycNextAction } from "../utils/kyc-steps.ts";
import {
  bankIsVerified,
  investmentReadiness,
  payoutVerificationRequired,
  userIdentityIsVerified,
} from "./investor-readiness.service.ts";
import {
  fpAccounts,
  fpBankVerification,
  fpConfig,
  fpErrorToHttpError,
  fpKycForms,
  fpProfiles,
} from "../integrations/fp/index.ts";
import { randomUUID } from "node:crypto";
import { HttpError } from "../utils/http-error.ts";
import { asAllocation, asDate } from "../utils/money.ts";
import { bankAccountFingerprint } from "../utils/fp-mapping.ts";
import {
  syncAddress,
  syncBankAccount,
  syncBankAccountVerification,
  syncEmailAddress,
  syncInvestmentAccount,
  syncInvestorProfile,
  syncPhoneNumber,
  syncRelatedParty,
} from "./fp-sync/index.ts";
import type {
  AddAddressInput,
  AddBankAccountInput,
  AddEmailInput,
  AddNomineeInput,
  AddPhoneInput,
  BankAccountDto,
  BankAccountLookupDto,
  ContactDto,
  CreateInvestorProfileInput,
  FolioDefaultsInput,
  InvestmentAccountDto,
  InvestorProfileDto,
  NomineeDto,
  OnboardingStatusDto,
} from "../types/investor.types.ts";

const BANK_LOOKUP_CONSENT =
  "I allow this investment platform to fetch my bank account details using my phone number via Cybrilla and its partners.";

function bankLookupStatus(status: string): BankAccountLookupDto["status"] {
  const value = status.toLowerCase();
  if (value === "success" || value === "successful") return "SUCCESSFUL";
  if (value === "failed") return "FAILED";
  return "PENDING";
}

async function requireOwnedProfile(userId: string, investorProfileId: string): Promise<void> {
  const link = await db.userInvestorProfile.findUnique({
    where: { userId_investorProfileId: { userId, investorProfileId } },
    select: { id: true },
  });
  if (!link) throw HttpError.notFound("No such investor profile");
}

/** "ABCDE1234F" -> "ABCXXXX34F". Enough to recognise, not enough to reuse. */
function maskPan(pan: string | null): string | null {
  if (!pan || pan.length !== 10) return pan;
  return `${pan.slice(0, 3)}XXXX${pan.slice(7)}`;
}

const profileSelect = {
  id: true,
  fpId: true,
  name: true,
  pan: true,
  dateOfBirth: true,
  taxStatus: true,
  gender: true,
  occupation: true,
  createdAt: true,
} as const;

function toProfileDto(row: {
  id: string;
  fpId: string;
  name: string | null;
  pan: string | null;
  dateOfBirth: Date | null;
  taxStatus: string | null;
  gender: string | null;
  occupation: string | null;
  createdAt: Date;
}): InvestorProfileDto {
  return {
    id: row.id,
    fpId: row.fpId,
    name: row.name,
    panMasked: maskPan(row.pan),
    dateOfBirth: asDate(row.dateOfBirth),
    taxStatus: row.taxStatus,
    gender: row.gender,
    occupation: row.occupation,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Move the cursor forward. Never backwards — a later step is still done. */
const STAGE_ORDER: OnboardingStage[] = [
  OnboardingStage.KYC_CHECK,
  OnboardingStage.KYC_REQUEST,
  OnboardingStage.PROFILE,
  OnboardingStage.CONTACT_DETAILS,
  OnboardingStage.BANK_ACCOUNT,
  OnboardingStage.NOMINEE,
  OnboardingStage.FATCA,
  OnboardingStage.INVESTMENT_ACCOUNT,
  OnboardingStage.MANDATE,
  OnboardingStage.COMPLETED,
];

async function advanceStage(investorProfileId: string, stage: OnboardingStage): Promise<void> {
  const current = await db.investorOnboarding.findUnique({
    where: { investorProfileId },
    select: { stage: true },
  });
  if (current && STAGE_ORDER.indexOf(current.stage) >= STAGE_ORDER.indexOf(stage)) return;

  await db.investorOnboarding.upsert({
    where: { investorProfileId },
    update: {
      stage,
      lastError: null,
      ...(stage === OnboardingStage.COMPLETED && { completedAt: new Date() }),
    },
    create: { investorProfileId, stage },
  });
}

async function requireProfile(investorProfileId: string) {
  const profile = await db.investorProfile.findUnique({
    where: { id: investorProfileId },
    select: { id: true, fpId: true, pan: true },
  });
  if (!profile) throw HttpError.notFound("No such investor profile");
  return profile;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Create the investor's profile at FP and link it to the app account.
 *
 * `use_default_tax_residences` asks FP to fill the first tax residency with
 * India + the PAN, which is what a resident individual needs to satisfy FATCA.
 * An NRI has to declare residencies explicitly, so that case must not take this
 * shortcut.
 */
export async function createInvestorProfile(
  input: CreateInvestorProfileInput,
): Promise<InvestorProfileDto> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true },
  });
  if (!user) throw HttpError.notFound("No such user");

  const isResidentIndividual = input.taxStatus === "resident_individual";

  try {
    const created = await fpProfiles.createInvestorProfile({
      type: "individual",
      tax_status: input.taxStatus,
      name: input.name,
      date_of_birth: input.dateOfBirth,
      pan: input.pan.toUpperCase(),
      ...(input.gender && { gender: input.gender }),
      ...(input.occupation && { occupation: input.occupation }),
      // Write-once at FP, so this is the only chance to record them.
      ...(input.maritalStatus && { marital_status: input.maritalStatus }),
      ...(input.fatherName && { father_name: input.fatherName }),
      ...(input.motherName && { mother_name: input.motherName }),
      ...(input.aadhaarLast4 && { aadhaar_number: input.aadhaarLast4 }),
      ...(input.citizenshipCountries?.length && {
        citizenship_countries: input.citizenshipCountries,
      }),
      ...(input.countryOfBirth && { country_of_birth: input.countryOfBirth }),
      ...(input.placeOfBirth && { place_of_birth: input.placeOfBirth }),
      ...(input.nationalityCountry && { nationality_country: input.nationalityCountry }),
      ...(input.sourceOfWealth && { source_of_wealth: input.sourceOfWealth }),
      ...(input.incomeSlab && { income_slab: input.incomeSlab }),
      ...(input.pepDetails && { pep_details: input.pepDetails }),
      ...(input.ipAddress && { ip_address: input.ipAddress }),
      use_default_tax_residences: isResidentIndividual,
    });

    const profile = await syncInvestorProfile(created);
    await db.preVerification.updateMany({ where: { userId: user.id, investorIdentifier: input.pan.toUpperCase(), investorProfileId: null }, data: { investorProfileId: profile.id } });

    // The link table is what makes minor and joint possible later: a second
    // row with a different relationship, rather than a schema change.
    await db.userInvestorProfile.upsert({
      where: {
        userId_investorProfileId: { userId: user.id, investorProfileId: profile.id },
      },
      update: {},
      create: {
        userId: user.id,
        investorProfileId: profile.id,
        relationship: UserProfileRelationship.SELF,
        isPrimary: true,
      },
    });

    await advanceStage(profile.id, OnboardingStage.PROFILE);
    if (isResidentIndividual) await advanceStage(profile.id, OnboardingStage.FATCA);

    const row = await db.investorProfile.findUniqueOrThrow({
      where: { id: profile.id },
      select: profileSelect,
    });
    return toProfileDto(row);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function getInvestorProfile(id: string): Promise<InvestorProfileDto> {
  const row = await db.investorProfile.findUnique({ where: { id }, select: profileSelect });
  if (!row) throw HttpError.notFound("No such investor profile");
  return toProfileDto(row);
}

/** Every profile an app account may act on. */
export async function listProfilesForUser(userId: string): Promise<InvestorProfileDto[]> {
  const links = await db.userInvestorProfile.findMany({
    where: { userId },
    select: { investorProfile: { select: profileSelect } },
    orderBy: { isPrimary: "desc" },
  });
  return links.map((link) => toProfileDto(link.investorProfile));
}

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

export async function addAddress(
  investorProfileId: string,
  input: AddAddressInput,
): Promise<ContactDto> {
  const profile = await requireProfile(investorProfileId);
  try {
    const created = await fpProfiles.createAddress({
      profile: profile.fpId,
      line1: input.line1,
      ...(input.line2 && { line2: input.line2 }),
      ...(input.line3 && { line3: input.line3 }),
      ...(input.city && { city: input.city }),
      ...(input.state && { state: input.state }),
      postal_code: input.postalCode,
      country: input.country.toUpperCase(),
      ...(input.nature && { nature: input.nature }),
    });
    const row = await syncAddress(created);
    await maybeAdvanceContactStage(investorProfileId);
    return {
      id: row.id,
      fpId: created.id,
      label: [created.line1, created.city, created.postal_code].filter(Boolean).join(", "),
      isDefault: false,
    };
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function addPhone(
  investorProfileId: string,
  input: AddPhoneInput,
): Promise<ContactDto> {
  const profile = await requireProfile(investorProfileId);
  try {
    const created = await fpProfiles.createPhoneNumber({
      profile: profile.fpId,
      isd: input.isd,
      number: input.number,
      belongs_to: input.belongsTo ?? "self",
    });
    const row = await syncPhoneNumber(created);
    await maybeAdvanceContactStage(investorProfileId);
    return {
      id: row.id,
      fpId: created.id,
      label: `+${created.isd.replace("+", "")} ${created.number}`,
      isDefault: false,
    };
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function addEmail(
  investorProfileId: string,
  input: AddEmailInput,
): Promise<ContactDto> {
  const profile = await requireProfile(investorProfileId);
  try {
    const created = await fpProfiles.createEmailAddress({
      profile: profile.fpId,
      email: input.email,
      belongs_to: input.belongsTo ?? "self",
    });
    const row = await syncEmailAddress(created);
    await maybeAdvanceContactStage(investorProfileId);
    return { id: row.id, fpId: created.id, label: created.email, isDefault: false };
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** Contact details count as done only once all three kinds exist. */
async function maybeAdvanceContactStage(investorProfileId: string): Promise<void> {
  const [addresses, phones, emails] = await Promise.all([
    db.address.count({ where: { investorProfileId } }),
    db.phoneNumber.count({ where: { investorProfileId } }),
    db.emailAddress.count({ where: { investorProfileId } }),
  ]);
  if (addresses > 0 && phones > 0 && emails > 0) {
    await advanceStage(investorProfileId, OnboardingStage.CONTACT_DETAILS);
  }
}

// ---------------------------------------------------------------------------
// Bank account and nominee
// ---------------------------------------------------------------------------

export async function addBankAccount(
  investorProfileId: string,
  input: AddBankAccountInput,
): Promise<BankAccountDto> {
  const profile = await requireProfile(investorProfileId);
  try {
    const created = await fpProfiles.createBankAccount({
      profile: profile.fpId,
      account_number: input.accountNumber,
      primary_account_holder_name: input.accountHolderName,
      type: input.type,
      ifsc_code: input.ifscCode.toUpperCase(),
    });
    const row = await syncBankAccount(created);
    await advanceStage(investorProfileId, OnboardingStage.BANK_ACCOUNT);
    return getBankAccount(row.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

type StoredBankLookup = {
  id: string;
  status: string;
  phoneLast4: string;
  bankAccountId: string | null;
};

type LookupBankData = {
  account_holder_name: string | null;
  account_number: string | null;
  ifsc_code: string | null;
  type: string | null;
} | null;

function bankLookupDto(row: StoredBankLookup, data: LookupBankData = null): BankAccountLookupDto {
  const number = data?.account_number?.replace(/\D/g, "") ?? "";
  return {
    id: row.id,
    status: bankLookupStatus(row.status),
    phoneLast4: row.phoneLast4,
    accountNumberLast4: number.length >= 4 ? number.slice(-4) : null,
    accountHolderName: data?.account_holder_name?.trim() || null,
    ifscCode: data?.ifsc_code?.trim().toUpperCase() || null,
    accountType: data?.type?.trim().toLowerCase() || null,
    bankAccountId: row.bankAccountId,
  };
}

/** Start consent-backed bank discovery using the login's verified phone. */
export async function createBankAccountLookup(input: {
  userId: string;
  investorProfileId: string;
  ipAddress: string;
}): Promise<BankAccountLookupDto> {
  await requireOwnedProfile(input.userId, input.investorProfileId);
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { phone: true },
  });
  if (!user) throw HttpError.notFound("No such investor account");
  const digits = user.phone.replace(/\D/g, "");
  const phone = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(phone)) {
    throw HttpError.conflict("A verified Indian mobile number is required for bank discovery");
  }

  const consentedAt = new Date();
  const sourceRefId = randomUUID();
  try {
    const lookup = await fpKycForms.createBankAccountLookup({
      phone_number: phone,
      source_ref_id: sourceRefId,
      consent: {
        collected_at: consentedAt.toISOString(),
        text: BANK_LOOKUP_CONSENT,
        mode: "checkbox",
        ip_address: input.ipAddress,
      },
    });
    const row = await db.bankAccountLookup.create({
      data: {
        fpId: lookup.id,
        userId: input.userId,
        investorProfileId: input.investorProfileId,
        sourceRefId,
        phoneLast4: phone.slice(-4),
        status: bankLookupStatus(lookup.status),
        consentedAt,
      },
      select: { id: true, status: true, phoneLast4: true, bankAccountId: true },
    });
    return bankLookupDto(row, lookup.data);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** Re-read a lookup. Full bank numbers are used only in-memory and never returned. */
export async function refreshBankAccountLookup(
  userId: string,
  lookupId: string,
): Promise<BankAccountLookupDto> {
  const existing = await db.bankAccountLookup.findFirst({
    where: { id: lookupId, userId },
    select: { id: true, fpId: true, status: true, phoneLast4: true, bankAccountId: true },
  });
  if (!existing) throw HttpError.notFound("No such bank lookup");
  if (existing.bankAccountId) return bankLookupDto(existing);
  try {
    const lookup = await fpKycForms.fetchBankAccountLookup(existing.fpId);
    const row = await db.bankAccountLookup.update({
      where: { id: existing.id },
      data: { status: bankLookupStatus(lookup.status), syncedAt: new Date() },
      select: { id: true, status: true, phoneLast4: true, bankAccountId: true },
    });
    return bankLookupDto(row, lookup.data);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/** Link the bank the investor just reviewed. The provider remains the source of the full number. */
export async function linkBankAccountLookup(
  userId: string,
  lookupId: string,
): Promise<BankAccountDto> {
  const existing = await db.bankAccountLookup.findFirst({
    where: { id: lookupId, userId },
    select: {
      id: true,
      fpId: true,
      investorProfileId: true,
      bankAccountId: true,
    },
  });
  if (!existing) throw HttpError.notFound("No such bank lookup");
  if (existing.bankAccountId) return getBankAccount(existing.bankAccountId);

  try {
    const lookup = await fpKycForms.fetchBankAccountLookup(existing.fpId);
    if (bankLookupStatus(lookup.status) !== "SUCCESSFUL") {
      throw HttpError.conflict(
        lookup.status === "failed"
          ? "No bank account could be found for this mobile number"
          : "The bank lookup is still in progress",
      );
    }
    const data = lookup.data;
    const accountNumber = data?.account_number?.replace(/\D/g, "") ?? "";
    const accountHolderName = data?.account_holder_name?.trim() ?? "";
    const ifscCode = data?.ifsc_code?.trim().toUpperCase() ?? "";
    const type = data?.type?.trim().toLowerCase() ?? "";
    if (!/^\d{9,18}$/.test(accountNumber) || accountHolderName === "" ||
        !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode) ||
        !["savings", "current", "nre", "nro"].includes(type)) {
      throw HttpError.badGateway("The bank lookup returned incomplete account details");
    }

    // A second lookup can find the same account. Reuse the local/provider
    // object instead of creating a duplicate at FP and then colliding with our
    // unique fingerprint constraint.
    const fingerprint = await bankAccountFingerprint(accountNumber, ifscCode);
    const alreadyLinked = await db.bankAccount.findUnique({
      where: {
        investorProfileId_accountNumberFingerprint: {
          investorProfileId: existing.investorProfileId,
          accountNumberFingerprint: fingerprint,
        },
      },
      select: { id: true },
    });
    if (alreadyLinked) {
      await db.bankAccountLookup.update({
        where: { id: existing.id },
        data: { status: "SUCCESSFUL", bankAccountId: alreadyLinked.id, syncedAt: new Date() },
      });
      return getBankAccount(alreadyLinked.id);
    }

    const bank = await addBankAccount(existing.investorProfileId, {
      accountNumber,
      accountHolderName,
      ifscCode,
      type,
    });
    await db.bankAccountLookup.update({
      where: { id: existing.id },
      data: { status: "SUCCESSFUL", bankAccountId: bank.id, syncedAt: new Date() },
    });
    return bank;
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Add a nominee.
 *
 * FP wants a PAN for an adult nominee and guardian details for a minor one,
 * and refuses a new folio unless at least one identity proof is on file.
 */
export async function addNominee(
  investorProfileId: string,
  input: AddNomineeInput,
): Promise<NomineeDto> {
  const profile = await requireProfile(investorProfileId);
  try {
    const created = await fpProfiles.createRelatedParty({
      profile: profile.fpId,
      name: input.name,
      relationship: input.relationship,
      ...(input.dateOfBirth && { date_of_birth: input.dateOfBirth }),
      ...(input.pan && { pan: input.pan.toUpperCase() }),
      ...(input.guardianName && { guardian_name: input.guardianName }),
      ...(input.guardianPan && { guardian_pan: input.guardianPan.toUpperCase() }),
    });
    const row = await syncRelatedParty(created);
    await advanceStage(investorProfileId, OnboardingStage.NOMINEE);
    return {
      id: row.id,
      fpId: created.id,
      name: created.name,
      relationship: created.relationship,
      dateOfBirth: created.date_of_birth,
      allocationPercentage: null,
      slot: null,
    };
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

// ---------------------------------------------------------------------------
// Investment account
// ---------------------------------------------------------------------------

/**
 * Create the investment account — the container every order hangs off.
 *
 * Folio defaults can be set here or later, but they MUST be set before the
 * first order: FP stamps them onto the folio the AMC opens, and the 2FA consent
 * on that order is validated against the email they name.
 */
export async function createInvestmentAccount(
  investorProfileId: string,
  defaults?: FolioDefaultsInput,
): Promise<InvestmentAccountDto> {
  const profile = await requireProfile(investorProfileId);

  const existing = await db.mfInvestmentAccount.findFirst({
    where: { primaryInvestorProfileId: profile.id },
    select: { id: true },
  });
  if (existing) {
    throw HttpError.conflict("This investor already has an investment account", {
      mfInvestmentAccountId: existing.id,
    });
  }

  try {
    const created = await fpAccounts.createInvestmentAccount({
      primary_investor: profile.fpId,
      holding_pattern: "single",
      ...(defaults && { folio_defaults: await buildFolioDefaults(profile.id, defaults) }),
    });
    const row = await syncInvestmentAccount(created);
    await advanceStage(investorProfileId, OnboardingStage.INVESTMENT_ACCOUNT);
    return getInvestmentAccount(row.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

export async function setFolioDefaults(
  mfInvestmentAccountId: string,
  defaults: FolioDefaultsInput,
): Promise<InvestmentAccountDto> {
  const account = await db.mfInvestmentAccount.findUnique({
    where: { id: mfInvestmentAccountId },
    select: { id: true, fpId: true, primaryInvestorProfileId: true },
  });
  if (!account) throw HttpError.notFound("No such investment account");

  try {
    const updated = await fpAccounts.updateInvestmentAccount({
      id: account.fpId,
      folio_defaults: await buildFolioDefaults(account.primaryInvestorProfileId, defaults),
    });
    await syncInvestmentAccount(updated);
    return getInvestmentAccount(account.id);
  } catch (error) {
    fpErrorToHttpError(error);
  }
}

/**
 * Translate our local ids into the FP ids the folio_defaults hash expects,
 * checking each one belongs to this investor on the way.
 */
async function buildFolioDefaults(investorProfileId: string, input: FolioDefaultsInput) {
  const resolve = async <T extends { fpId: string }>(
    finder: () => Promise<T | null>,
    id: string | undefined,
    label: string,
  ): Promise<string | undefined> => {
    if (!id) return undefined;
    const row = await finder();
    if (!row) throw HttpError.badRequest(`${label} does not belong to this investor`);
    return row.fpId;
  };

  const defaults: Record<string, unknown> = {};

  const email = await resolve(
    () =>
      db.emailAddress.findFirst({
        where: { id: input.emailAddressId, investorProfileId },
        select: { fpId: true },
      }),
    input.emailAddressId,
    "Email address",
  );
  if (email) defaults["communication_email_address"] = email;

  const phone = await resolve(
    () =>
      db.phoneNumber.findFirst({
        where: { id: input.phoneNumberId, investorProfileId },
        select: { fpId: true },
      }),
    input.phoneNumberId,
    "Phone number",
  );
  if (phone) defaults["communication_mobile_number"] = phone;

  const address = await resolve(
    () =>
      db.address.findFirst({
        where: { id: input.addressId, investorProfileId },
        select: { fpId: true },
      }),
    input.addressId,
    "Address",
  );
  if (address) defaults["communication_address"] = address;

  const bank = await resolve(
    () =>
      db.bankAccount.findFirst({
        where: { id: input.bankAccountId, investorProfileId },
        select: { fpId: true },
      }),
    input.bankAccountId,
    "Bank account",
  );
  if (bank) defaults["payout_bank_account"] = bank;

  const demat = await resolve(
    () =>
      db.dematAccount.findFirst({
        where: { id: input.dematAccountId, investorProfileId },
        select: { fpId: true },
      }),
    input.dematAccountId,
    "Demat account",
  );
  if (demat) defaults["demat_account"] = demat;

  const nominees = input.nominees ?? [];
  if (nominees.length > 3) throw HttpError.badRequest("At most three nominees are allowed");
  if (nominees.length > 0) {
    const total = nominees.reduce((sum, n) => sum + Number(n.allocationPercentage), 0);
    // The RTAs reject a nomination that does not allocate exactly 100%.
    if (Math.abs(total - 100) > 0.01) {
      throw HttpError.badRequest("Nominee allocations must add up to 100%", { total });
    }

    for (const [index, nominee] of nominees.entries()) {
      const party = await db.relatedParty.findFirst({
        where: { id: nominee.relatedPartyId, investorProfileId },
        select: { fpId: true },
      });
      if (!party) throw HttpError.badRequest("Nominee does not belong to this investor");
      const slot = index + 1;
      defaults[`nominee${slot}`] = party.fpId;
      defaults[`nominee${slot}_allocation_percentage`] = Number(nominee.allocationPercentage);
      if (nominee.identityProofType) {
        defaults[`nominee${slot}_identity_proof_type`] = nominee.identityProofType;
      }
    }

    // FP rejects the first order with "nomination_info_visibility should be set
    // in case of skip nomination is false" when a nominee exists without this,
    // and the failure surfaces at order time rather than here. Default it.
    defaults["nominations_info_visibility"] =
      input.nominationsInfoVisibility ?? "show_all_nominee_names";
  }

  return defaults;
}

export async function getInvestmentAccount(id: string): Promise<InvestmentAccountDto> {
  const account = await db.mfInvestmentAccount.findUnique({
    where: { id },
    select: {
      id: true,
      fpId: true,
      holdingPattern: true,
      primaryInvestorPan: true,
      fpCreatedAt: true,
      createdAt: true,
      folioDefaults: {
        select: {
          communicationEmailAddressId: true,
          communicationPhoneNumberId: true,
          communicationAddressId: true,
          payoutBankAccountId: true,
          nominationsInfoVisibility: true,
        },
      },
      nominees: {
        select: {
          slot: true,
          allocationPercentage: true,
          relatedParty: {
            select: { id: true, fpId: true, name: true, relationship: true, dateOfBirth: true },
          },
        },
        orderBy: { slot: "asc" },
      },
    },
  });
  if (!account) throw HttpError.notFound("No such investment account");

  const defaults = account.folioDefaults;
  const folioDefaultsComplete = Boolean(
    defaults?.communicationEmailAddressId &&
      defaults.communicationPhoneNumberId &&
      defaults.communicationAddressId &&
      defaults.payoutBankAccountId,
  );

  return {
    id: account.id,
    fpId: account.fpId,
    holdingPattern: account.holdingPattern,
    primaryInvestorPan: maskPan(account.primaryInvestorPan),
    folioDefaultsComplete,
    nominees: account.nominees.map((nominee) => ({
      id: nominee.relatedParty.id,
      fpId: nominee.relatedParty.fpId,
      name: nominee.relatedParty.name,
      relationship: nominee.relatedParty.relationship,
      dateOfBirth: asDate(nominee.relatedParty.dateOfBirth),
      allocationPercentage: asAllocation(nominee.allocationPercentage),
      slot: nominee.slot,
    })),
    createdAt: (account.fpCreatedAt ?? account.createdAt).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Onboarding status
// ---------------------------------------------------------------------------

/**
 * Everything the app needs to resume onboarding, in one read.
 *
 * `canTransact` is computed from the rows, not from the stage cursor, because
 * it gates money.
 */
/**
 * Whether the investor still owes the KYC form anything.
 *
 * The app routes off this: a finished or impossible form means the next step is
 * the investor profile, and sending them back into the KYC group instead is how
 * "continue setup" ended up bouncing off `/all-set` for ever. `null` when no
 * form was ever opened — a PAN already registered at the KRA never opens one.
 */
async function kycProgress(userId: string): Promise<OnboardingStatusDto["kyc"]> {
  const form = await db.kycForm.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, fieldsNeeded: true, proofStatus: true, signatureProvided: true },
  });
  if (!form) return null;
  return {
    formId: form.id,
    status: form.status,
    nextAction: kycNextAction(form),
    // FAILED and EXPIRED are outstanding too: neither can advance, so the
    // investor owes a brand new form before anything else matters.
    outstanding: form.status !== KycFormStatus.SUBMITTED,
  };
}

export async function getOnboardingStatus(userId: string): Promise<OnboardingStatusDto> {
  const [link, kyc] = await Promise.all([
    db.userInvestorProfile.findFirst({
      where: { userId },
      orderBy: { isPrimary: "desc" },
      select: { investorProfileId: true },
    }),
    kycProgress(userId),
  ]);

  if (!link) {
    const identityVerified = await userIdentityIsVerified(userId);
    return {
      investorProfileId: null,
      stage: null,
      completedAt: null,
      lastError: null,
      kyc,
      // Nothing exists yet, so everything after the identity journey is owed.
      accountMissing: ["address", "nomination", "bankAccount"],
      readiness: {
        hasProfile: false,
        hasAddress: false,
        hasPhone: false,
        hasEmail: false,
        hasBankAccount: false,
        hasNominee: false,
        hasInvestmentAccount: false,
        folioDefaultsComplete: false,
        identityVerified,
        payoutAccountVerified: false,
        canTransact: false,
      },
    };
  }

  const investorProfileId = link.investorProfileId;
  const [onboarding, addresses, phones, emails, banks, nominees, account] = await Promise.all([
    db.investorOnboarding.findUnique({
      where: { investorProfileId },
      select: { stage: true, completedAt: true, lastError: true, nominationOptOutAt: true },
    }),
    db.address.count({ where: { investorProfileId } }),
    db.phoneNumber.count({ where: { investorProfileId } }),
    db.emailAddress.count({ where: { investorProfileId } }),
    db.bankAccount.count({ where: { investorProfileId } }),
    db.relatedParty.count({ where: { investorProfileId } }),
    db.mfInvestmentAccount.findFirst({
      where: { primaryInvestorProfileId: investorProfileId },
      select: {
        id: true,
        folioDefaults: {
          select: {
            communicationEmailAddressId: true,
            communicationPhoneNumberId: true,
            communicationAddressId: true,
            payoutBankAccountId: true,
          },
        },
        // A nomination is a slot row, not a column on the defaults.
        nominees: { select: { id: true }, take: 1 },
      },
    }),
  ]);

  const defaults = account?.folioDefaults;
  const folioDefaultsComplete = Boolean(
    defaults?.communicationEmailAddressId &&
      defaults.communicationPhoneNumberId &&
      defaults.communicationAddressId &&
      defaults.payoutBankAccountId,
  );

  // Asked of the same service the order endpoints assert against. Computing it
  // from the rows present here instead would tell the app it can transact and
  // then have the first order answer 409.
  const readiness = account ? await investmentReadiness(account.id) : null;

  // The same vocabulary `provisionInvestor` returns, derived from the rows that
  // exist rather than from a cursor — so a client can read it without a write,
  // and the two can never disagree about what the investor still owes.
  const accountMissing: string[] = [];
  if (addresses === 0) accountMissing.push("address");
  // A declared opt-out counts as answered. Without it there is no row to tell
  // "declined" from "not asked", and the KYC resume route reads this list.
  if ((account?.nominees.length ?? 0) === 0 && onboarding?.nominationOptOutAt == null) {
    accountMissing.push("nomination");
  }
  if (!defaults?.payoutBankAccountId) accountMissing.push("bankAccount");

  return {
    investorProfileId,
    stage: onboarding?.stage ?? null,
    completedAt: onboarding?.completedAt?.toISOString() ?? null,
    lastError: onboarding?.lastError ?? null,
    kyc,
    accountMissing,
    readiness: {
      hasProfile: true,
      hasAddress: addresses > 0,
      hasPhone: phones > 0,
      hasEmail: emails > 0,
      hasBankAccount: banks > 0,
      hasNominee: nominees > 0,
      hasInvestmentAccount: account !== null,
      folioDefaultsComplete,
      identityVerified: readiness?.identityVerified ?? false,
      payoutAccountVerified: readiness?.payoutAccountVerified ?? false,
      canTransact: folioDefaultsComplete && (readiness?.canTransact ?? false),
    },
  };
}


/**
 * Start a penny-drop verification of the investor's bank account.
 *
 * Mandatory in practice on the cybrillapoa gateway. An order whose payout
 * account is unverified is accepted, paid for and confirmed — and only then
 * fails at submission with `payout_account_verification_pending`, after the
 * investor's money has already moved. Verifying during onboarding is the only
 * point at which failure is cheap.
 *
 * Asynchronous: this returns `PENDING` and the result lands later. Poll
 * `refreshBankAccountVerification`.
 */
export async function verifyBankAccount(bankAccountId: string): Promise<BankAccountDto> {
  const bank = await db.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!bank) throw HttpError.notFound("No such bank account");

  // This tenant does not expose /v2/bank_account_verifications in the sandbox;
  // ONDC's SellerApp performs BAV itself when it reviews a new folio. Mirror
  // only the deterministic success patterns documented by FP, so the app can
  // gate checkout without pretending an arbitrary account passed.
  if (fpConfig().simulationEnabled) {
    const suffixScore = Number(bank.accountNumberLast4.slice(2));
    const confidence =
      bank.accountNumberLast4.startsWith("11") && suffixScore >= 91
        ? BavConfidence.VERY_HIGH
        : bank.accountNumberLast4.startsWith("12") && suffixScore >= 61 && suffixScore <= 90
          ? BavConfidence.HIGH
          : null;
    if (!confidence) {
      throw HttpError.badRequest(
        "This sandbox account number does not simulate successful bank verification. Add a unique test account ending in 1191–1199 (for example, 1193).",
      );
    }
    await db.bankAccount.update({
      where: { id: bank.id },
      data: {
        verificationStatus: BavStatus.COMPLETED,
        verificationConfidence: confidence,
        verificationReason: null,
        verifiedAt: new Date(),
      },
    });
    return getBankAccount(bank.id);
  }

  try {
    if (bank.verificationFpId && bank.verificationStatus === BavStatus.PENDING) {
      const current = await fpBankVerification.fetchBankAccountVerification(bank.verificationFpId);
      await syncBankAccountVerification(current);
      return getBankAccount(bank.id);
    }

    const result = await fpBankVerification.createBankAccountVerification(bank.fpId);
    await syncBankAccountVerification(result);
    return getBankAccount(bank.id);
  } catch (error) { fpErrorToHttpError(error); }
}

export async function refreshBankAccountVerification(bankAccountId: string): Promise<BankAccountDto> {
  const bank = await db.bankAccount.findUnique({
    where: { id: bankAccountId },
    select: { id: true, verificationFpId: true },
  });
  if (!bank) throw HttpError.notFound("No such bank account");
  if (fpConfig().simulationEnabled && !bank.verificationFpId) return getBankAccount(bank.id);
  if (!bank.verificationFpId) throw HttpError.conflict("Start bank verification first");
  try {
    await syncBankAccountVerification(
      await fpBankVerification.fetchBankAccountVerification(bank.verificationFpId),
    );
    return getBankAccount(bank.id);
  } catch (error) { fpErrorToHttpError(error); }
}

export async function getBankAccount(id: string): Promise<BankAccountDto> {
  const row = await db.bankAccount.findUnique({
    where: { id },
    select: {
      id: true,
      fpId: true,
      bankName: true,
      branchName: true,
      ifscCode: true,
      accountNumberLast4: true,
      type: true,
      primaryAccountHolderName: true,
      verificationStatus: true,
      verificationConfidence: true,
      verificationReason: true,
      payoutFor: { select: { id: true }, take: 1 },
    },
  });
  if (!row) throw HttpError.notFound("No such bank account");

  // A COMPLETED verification is not automatically a pass: FP can complete with
  // LOW or ZERO confidence, meaning the account probably is not the investor's.
  const usable = await bankIsVerified(id);

  return {
    id: row.id,
    fpId: row.fpId,
    bankName: row.bankName,
    branchName: row.branchName,
    ifscCode: row.ifscCode,
    accountNumberLast4: row.accountNumberLast4,
    type: row.type,
    accountHolderName: row.primaryAccountHolderName,
    isPayoutDefault: row.payoutFor.length > 0,
    verificationStatus: row.verificationStatus,
    verificationConfidence: row.verificationConfidence,
    verificationReason: row.verificationReason,
    usableForPayout: usable,
    // ONDC submission fails on an unverified payout account, including in the
    // sandbox, so the app must never present an unchecked account as ready.
    verificationRequired: payoutVerificationRequired(),
  };
}

export async function listBankAccounts(investorProfileId: string): Promise<BankAccountDto[]> {
  const rows = await db.bankAccount.findMany({
    where: { investorProfileId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return Promise.all(rows.map((row) => getBankAccount(row.id)));
}
