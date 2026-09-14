// Mirror FP identity objects: investor profiles, their contact details, bank
// accounts, nominees and demat accounts.
import { db } from "../../db/client.ts";
import {
  AddressNature,
  BankAccountType,
  BavConfidence,
  BavStatus,
  ContactBelongsTo,
  Gender,
  IncomeSlab,
  InvestorProfileType,
  MaritalStatus,
  Occupation,
  PepDetails,
  RelatedPartyContactSubject,
  RelatedPartyRelationship,
  SourceOfWealth,
  TaxIdType,
  TaxStatus,
} from "../../../generated/prisma/enums.ts";
import {
  bankAccountFingerprint,
  fpDate,
  fpDateTime,
  fpEnum,
  fpEnumOr,
  fpInt,
  fpStringArray,
  fpText,
  lastFour,
} from "../../utils/fp-mapping.ts";
import type { FpBankAccountVerification } from "../../integrations/fp/resources/bank-verification.ts";
import type {
  FpAddress,
  FpBankAccount,
  FpDematAccount,
  FpEmailAddress,
  FpInvestorProfile,
  FpPhoneNumber,
  FpRelatedParty,
  FpTaxResidency,
} from "../../integrations/fp/fp.types.ts";

function unknownValue(field: string) {
  return (value: string) => console.warn(`[fp-sync] unmapped ${field}: "${value}"`);
}

/** Local id of a mirrored profile, by FP id. */
async function profileIdByFpId(fpId: string): Promise<string> {
  const row = await db.investorProfile.findUnique({ where: { fpId }, select: { id: true } });
  if (!row) throw new Error(`Investor profile ${fpId} has not been mirrored yet`);
  return row.id;
}

export async function syncInvestorProfile(profile: FpInvestorProfile): Promise<{ id: string }> {
  const data = {
    type: fpEnumOr(
      InvestorProfileType,
      profile.type,
      InvestorProfileType.INDIVIDUAL,
      unknownValue("profile type"),
    ),
    taxStatus: fpEnum(TaxStatus, profile.tax_status, unknownValue("tax_status")),
    name: fpText(profile.name, 70),
    dateOfBirth: fpDate(profile.date_of_birth),
    gender: fpEnum(Gender, profile.gender, unknownValue("gender")),
    maritalStatus: fpEnum(MaritalStatus, profile.marital_status, unknownValue("marital_status")),
    occupation: fpEnum(Occupation, profile.occupation, unknownValue("occupation")),
    pan: fpText(profile.pan, 10),
    // Undocumented but returned by FP — see the schema comment.
    aadhaarLast4: lastFour(profile.aadhaar_number),
    fatherName: fpText(profile.father_name, 70),
    motherName: fpText(profile.mother_name, 70),
    citizenshipCountries: fpStringArray(profile.citizenship_countries),
    guardianName: fpText(profile.guardian_name, 80),
    guardianDateOfBirth: fpDate(profile.guardian_date_of_birth),
    guardianPan: fpText(profile.guardian_pan, 10),
    countryOfBirth: fpText(profile.country_of_birth, 2),
    placeOfBirth: fpText(profile.place_of_birth, 120),
    nationalityCountry: fpText(profile.nationality_country, 2),
    sourceOfWealth: fpEnum(SourceOfWealth, profile.source_of_wealth, unknownValue("wealth")),
    incomeSlab: fpEnum(IncomeSlab, profile.income_slab, unknownValue("income_slab")),
    pepDetails: fpEnum(PepDetails, profile.pep_details, unknownValue("pep_details")),
    ipAddress: fpText(profile.ip_address, 45),
    fpCreatedAt: fpDateTime(profile.created_at),
    syncedAt: new Date(),
  };

  const row = await db.investorProfile.upsert({
    where: { fpId: profile.id },
    update: data,
    create: { fpId: profile.id, ...data },
    select: { id: true },
  });

  await syncTaxResidencies(row.id, profile);
  return row;
}

/**
 * Replace the profile's tax residencies with what FP currently holds.
 *
 * FP exposes four numbered slots and a slot can be cleared, so a diff-and-
 * delete keeps our rows in step rather than accumulating stale ones.
 */
async function syncTaxResidencies(
  investorProfileId: string,
  profile: FpInvestorProfile,
): Promise<void> {
  const slots: [number, FpTaxResidency | null][] = [
    [1, profile.first_tax_residency],
    [2, profile.second_tax_residency],
    [3, profile.third_tax_residency],
    [4, profile.fourth_tax_residency],
  ];

  for (const [slot, residency] of slots) {
    if (!residency?.country || !residency.taxid_number) {
      await db.taxResidency.deleteMany({ where: { investorProfileId, slot } });
      continue;
    }
    const data = {
      country: residency.country,
      taxIdType: fpEnumOr(
        TaxIdType,
        residency.taxid_type,
        TaxIdType.OTHERS,
        unknownValue("taxid_type"),
      ),
      taxIdNumber: residency.taxid_number,
      applicableFrom: fpDate(residency.applicable_from),
      applicableTo: fpDate(residency.applicable_to),
    };
    await db.taxResidency.upsert({
      where: { investorProfileId_slot: { investorProfileId, slot } },
      update: data,
      create: { investorProfileId, slot, ...data },
    });
  }
}

export async function syncAddress(address: FpAddress): Promise<{ id: string }> {
  const investorProfileId = await profileIdByFpId(address.profile);
  const data = {
    investorProfileId,
    line1: address.line1,
    line2: fpText(address.line2, 255),
    line3: fpText(address.line3, 255),
    city: fpText(address.city, 100),
    state: fpText(address.state, 100),
    postalCode: address.postal_code,
    country: address.country,
    nature: fpEnum(AddressNature, address.nature, unknownValue("address nature")),
    fpCreatedAt: fpDateTime(address.created_at),
    syncedAt: new Date(),
  };

  return db.address.upsert({
    where: { fpId: address.id },
    update: data,
    create: { fpId: address.id, ...data },
    select: { id: true },
  });
}

export async function syncPhoneNumber(phone: FpPhoneNumber): Promise<{ id: string }> {
  const investorProfileId = await profileIdByFpId(phone.profile);
  const data = {
    investorProfileId,
    isd: phone.isd,
    number: phone.number,
    belongsTo: fpEnum(ContactBelongsTo, phone.belongs_to, unknownValue("belongs_to")),
    fpCreatedAt: fpDateTime(phone.created_at),
    syncedAt: new Date(),
  };

  return db.phoneNumber.upsert({
    where: { fpId: phone.id },
    update: data,
    create: { fpId: phone.id, ...data },
    select: { id: true },
  });
}

export async function syncEmailAddress(email: FpEmailAddress): Promise<{ id: string }> {
  const investorProfileId = await profileIdByFpId(email.profile);
  const data = {
    investorProfileId,
    email: email.email,
    belongsTo: fpEnum(ContactBelongsTo, email.belongs_to, unknownValue("belongs_to")),
    fpCreatedAt: fpDateTime(email.created_at),
    syncedAt: new Date(),
  };

  return db.emailAddress.upsert({
    where: { fpId: email.id },
    update: data,
    create: { fpId: email.id, ...data },
    select: { id: true },
  });
}

/**
 * Mirror a bank account WITHOUT its account number.
 *
 * FP holds the number and addresses the account by `old_id` afterwards, so we
 * keep the last four for display and a fingerprint for dedupe. This is the one
 * sync that deliberately drops a field FP sent us.
 */
export async function syncBankAccount(account: FpBankAccount): Promise<{ id: string }> {
  const investorProfileId = await profileIdByFpId(account.profile);
  const data = {
    investorProfileId,
    fpOldId: fpInt(account.old_id),
    primaryAccountHolderName: account.primary_account_holder_name,
    accountNumberLast4: lastFour(account.account_number) ?? "0000",
    accountNumberFingerprint: await bankAccountFingerprint(
      account.account_number,
      account.ifsc_code,
    ),
    type: fpEnumOr(
      BankAccountType,
      account.type,
      BankAccountType.SAVINGS,
      unknownValue("bank account type"),
    ),
    ifscCode: account.ifsc_code,
    bankName: fpText(account.bank_name, 150),
    branchName: fpText(account.branch_name, 150),
    branchAddress: fpText(account.branch_address, 300),
    branchCity: fpText(account.branch_city, 100),
    branchDistrict: fpText(account.branch_district, 100),
    branchState: fpText(account.branch_state, 100),
    branchContactNumber: fpText(account.branch_contact_number, 30),
    fpCreatedAt: fpDateTime(account.created_at),
    syncedAt: new Date(),
  };

  return db.bankAccount.upsert({
    where: { fpId: account.id },
    update: data,
    create: { fpId: account.id, ...data },
    select: { id: true },
  });
}

export async function syncRelatedParty(party: FpRelatedParty): Promise<{ id: string }> {
  const investorProfileId = await profileIdByFpId(party.profile);
  const data = {
    investorProfileId,
    name: fpText(party.name, 40) ?? party.name,
    relationship: fpEnumOr(
      RelatedPartyRelationship,
      party.relationship,
      RelatedPartyRelationship.OTHERS,
      unknownValue("relationship"),
    ),
    dateOfBirth: fpDate(party.date_of_birth),
    pan: fpText(party.pan, 10),
    guardianName: fpText(party.guardian_name, 35),
    guardianPan: fpText(party.guardian_pan, 10),
    fpCreatedAt: fpDateTime(party.created_at),
    syncedAt: new Date(),
  };

  const row = await db.relatedParty.upsert({
    where: { fpId: party.id },
    update: data,
    create: { fpId: party.id, ...data },
    select: { id: true },
  });

  // FP repeats the same block twice, bare and `guardian_`-prefixed. One table
  // keyed by subject holds both.
  await upsertContact(row.id, RelatedPartyContactSubject.SELF, {
    aadhaar: party.aadhaar_number,
    passport: party.passport_number,
    drivingLicence: party.driving_licence_number,
    email: party.email_address,
    phone: party.phone_number,
    address: party.address,
  });
  await upsertContact(row.id, RelatedPartyContactSubject.GUARDIAN, {
    aadhaar: party.guardian_aadhaar_number,
    passport: party.guardian_passport_number,
    drivingLicence: party.guardian_driving_licence_number,
    email: party.guardian_email_address,
    phone: party.guardian_phone_number,
    address: party.guardian_address,
  });

  return row;
}

interface ContactBlock {
  aadhaar: string | null;
  passport: string | null;
  drivingLicence: string | null;
  email: string | null;
  phone: { isd: string; number: string } | null;
  address: {
    line1?: string | null;
    line2?: string | null;
    line3?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
}

async function upsertContact(
  relatedPartyId: string,
  subject: (typeof RelatedPartyContactSubject)[keyof typeof RelatedPartyContactSubject],
  block: ContactBlock,
): Promise<void> {
  const data = {
    aadhaarLast4: lastFour(block.aadhaar),
    passportNumber: fpText(block.passport, 30),
    drivingLicenceNumber: fpText(block.drivingLicence, 30),
    emailAddress: fpText(block.email, 255),
    phoneIsd: fpText(block.phone?.isd, 4),
    phoneNumber: fpText(block.phone?.number, 20),
    line1: fpText(block.address?.line1, 255),
    line2: fpText(block.address?.line2, 255),
    line3: fpText(block.address?.line3, 255),
    city: fpText(block.address?.city, 100),
    state: fpText(block.address?.state, 100),
    postalCode: fpText(block.address?.postal_code, 10),
    country: fpText(block.address?.country, 2),
  };

  // Nothing to record. Drop any row we wrote earlier so an emptied block does
  // not leave stale identity data behind.
  if (Object.values(data).every((value) => value === null)) {
    await db.relatedPartyContact.deleteMany({ where: { relatedPartyId, subject } });
    return;
  }

  await db.relatedPartyContact.upsert({
    where: { relatedPartyId_subject: { relatedPartyId, subject } },
    update: data,
    create: { relatedPartyId, subject, ...data },
  });
}

export async function syncDematAccount(account: FpDematAccount): Promise<{ id: string }> {
  const investorProfileId = await profileIdByFpId(account.profile);
  const data = {
    investorProfileId,
    dpId: account.dp_id,
    clientId: account.client_id,
    fpCreatedAt: fpDateTime(account.created_at),
    syncedAt: new Date(),
  };

  return db.dematAccount.upsert({
    where: { fpId: account.id },
    update: data,
    create: { fpId: account.id, ...data },
    select: { id: true },
  });
}


/**
 * Mirror a bank account verification onto the account it belongs to.
 *
 * Stored on BankAccount rather than in its own table: there is at most one
 * meaningful verification per account, and onboarding needs to read "is this
 * account usable?" without a join.
 */
export async function syncBankAccountVerification(
  verification: FpBankAccountVerification,
): Promise<{ id: string } | null> {
  const account = await db.bankAccount.findUnique({
    where: { fpId: verification.bank_account },
    select: { id: true },
  });
  if (!account) {
    console.warn(`[fp-sync] BAV ${verification.id} references an unmirrored bank account`);
    return null;
  }

  return db.bankAccount.update({
    where: { id: account.id },
    data: {
      verificationFpId: verification.id,
      verificationStatus: fpEnum(BavStatus, verification.status, unknownValue("bav status")),
      verificationConfidence: fpEnum(
        BavConfidence,
        verification.confidence,
        unknownValue("bav confidence"),
      ),
      verificationReason: fpText(verification.reason, 60),
      verifiedAt: fpDateTime(verification.completed_at),
      syncedAt: new Date(),
    },
    select: { id: true },
  });
}
