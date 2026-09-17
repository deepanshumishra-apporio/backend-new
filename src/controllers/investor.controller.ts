import type { Request, Response } from "express";
import * as investorService from "../services/investor.service.ts";
import { kycProfilePrefill } from "../services/kyc-prefill.service.ts";
import { provisionInvestor } from "../services/investor-provisioning.service.ts";
import {
  asBody,
  clientIpv4,
  oneOf,
  optionalDate,
  optionalString,
  optionalStringArray,
  requiredDate,
  requiredDecimal,
  requiredPan,
  requiredString,
  IFSC_PATTERN,
} from "../utils/validate.ts";
import { HttpError } from "../utils/http-error.ts";
import { investorId } from "../middleware/investor-auth.ts";

// FP's vocabularies, listed here so a bad value is rejected before the call
// rather than coming back as an opaque upstream 400.
const TAX_STATUSES = ["resident_individual", "nri"] as const;
const GENDERS = ["male", "female", "transgender"] as const;
const OCCUPATIONS = [
  "business",
  "professional",
  "retired",
  "house_wife",
  "student",
  "public_sector_service",
  "private_sector_service",
  "government_service",
  "agriculture",
  "doctor",
  "forex_dealer",
  "service",
  "others",
] as const;
const SOURCES_OF_WEALTH = [
  "salary",
  "business",
  "gift",
  "ancestral_property",
  "rental_income",
  "prize_money",
  "royalty",
  "others",
] as const;
const INCOME_SLABS = [
  "upto_1lakh",
  "above_1lakh_upto_5lakh",
  "above_5lakh_upto_10lakh",
  "above_10lakh_upto_25lakh",
  "above_25lakh_upto_1cr",
  "above_1cr",
] as const;
const PEP_VALUES = ["pep_exposed", "pep_related", "not_applicable"] as const;
// `single`, not the KYC form's `unmarried`: /v2/investor_profiles answers
// "should be one of married, single, others" and rejects the whole create.
// The two vocabularies are mapped in `kycProfilePrefill`.
const MARITAL_STATUSES = ["married", "single", "others"] as const;
const BANK_ACCOUNT_TYPES = ["savings", "current", "nre", "nro"] as const;
const ADDRESS_NATURES = ["residential", "business_location"] as const;
const NOMINEE_RELATIONSHIPS = [
  "father",
  "mother",
  "court_appointed_legal_guardian",
  "aunt",
  "brother",
  "brother_in_law",
  "daughter",
  "daughter_in_law",
  "father_in_law",
  "grand_daughter",
  "grand_father",
  "grand_mother",
  "grand_son",
  "mother_in_law",
  "nephew",
  "niece",
  "sister",
  "sister_in_law",
  "son",
  "son_in_law",
  "spouse",
  "uncle",
  "others",
] as const;
const PROOF_TYPES = ["pan", "aadhaar", "driving_licence", "passport"] as const;
const VISIBILITY = ["show_all_nominee_names", "show_nomination_status"] as const;

type ProfileParams = { profileId: string };
type AccountParams = { accountId: string };

export async function createProfile(req: Request, res: Response) {
  const body = asBody(req.body);

  res.status(201).json({
    data: await investorService.createInvestorProfile({
      userId: investorId(req),
      name: requiredString(body, "name", { maxLength: 70 }),
      pan: requiredPan(body),
      dateOfBirth: requiredDate(body, "dateOfBirth"),
      taxStatus: oneOf(body, "taxStatus", TAX_STATUSES) as string,
      gender: oneOf(body, "gender", GENDERS, false),
      occupation: oneOf(body, "occupation", OCCUPATIONS, false),
      // Write-once at FP: accepted here only on create, never on an update.
      maritalStatus: oneOf(body, "maritalStatus", MARITAL_STATUSES, false),
      fatherName: optionalString(body, "fatherName", { maxLength: 70 }),
      motherName: optionalString(body, "motherName", { maxLength: 70 }),
      aadhaarLast4: optionalString(body, "aadhaarLast4", {
        pattern: /^\d{4}$/,
        patternHint: "aadhaarLast4 must be exactly the last 4 digits",
      }),
      citizenshipCountries: optionalStringArray(body, "citizenshipCountries"),
      countryOfBirth: optionalString(body, "countryOfBirth", { maxLength: 2 }),
      placeOfBirth: optionalString(body, "placeOfBirth", { maxLength: 120 }),
      nationalityCountry: optionalString(body, "nationalityCountry", { maxLength: 2 }),
      sourceOfWealth: oneOf(body, "sourceOfWealth", SOURCES_OF_WEALTH, false),
      incomeSlab: oneOf(body, "incomeSlab", INCOME_SLABS, false),
      pepDetails: oneOf(body, "pepDetails", PEP_VALUES, false),
      // Taken from the connection, not the body: client-supplied audit data is
      // worthless.
      ipAddress: clientIpv4({}, req.ip ?? req.socket.remoteAddress),
    }),
  });
}

/**
 * What the investor already answered during KYC, in the profile's vocabulary.
 *
 * `null` when there is nothing to carry over. The client fills its form with
 * this; it never creates the profile on the investor's behalf, because FP
 * freezes most of these fields the moment the profile exists.
 */
export async function getProfilePrefill(req: Request, res: Response) {
  res.json({ data: await kycProfilePrefill(investorId(req)) });
}

/**
 * Build as much of the investor account as the answers so far allow.
 *
 * Called after each identity-journey screen rather than once at the end, so a
 * half-finished journey still leaves FP holding everything it was told. Safe to
 * repeat — see `investor-provisioning.service.ts`.
 */
export async function provision(req: Request, res: Response) {
  const body = asBody(req.body);
  const address = body["address"] == null ? null : asBody(body["address"]);
  const nominee = body["nominee"] == null ? null : asBody(body["nominee"]);

  res.json({
    data: await provisionInvestor({
      userId: investorId(req),
      sourceOfWealth: oneOf(body, "sourceOfWealth", SOURCES_OF_WEALTH, false),
      countryOfBirth: optionalString(body, "countryOfBirth", { maxLength: 2 }),
      ...(address && {
        address: {
          line1: requiredString(address, "line1", { maxLength: 120 }),
          line2: optionalString(address, "line2", { maxLength: 120 }),
          city: optionalString(address, "city", { maxLength: 60 }),
          state: optionalString(address, "state", { maxLength: 60 }),
          postalCode: requiredString(address, "postalCode", {
            pattern: /^\d{6}$/,
            patternHint: "postalCode must be a 6-digit Indian PIN code",
          }),
        },
      }),
      ...(nominee && {
        nominee: {
          name: requiredString(nominee, "name", { maxLength: 40 }),
          relationship: oneOf(nominee, "relationship", NOMINEE_RELATIONSHIPS) as string,
          dateOfBirth: optionalDate(nominee, "dateOfBirth"),
          pan: nominee["pan"] === undefined ? undefined : requiredPan(nominee),
        },
      }),
      ...(typeof body["nominationOptOut"] === "boolean" && {
        nominationOptOut: body["nominationOptOut"],
      }),
      bankAccountId: optionalString(body, "bankAccountId"),
      // From the connection, never the body.
      ipAddress: clientIpv4({}, req.ip ?? req.socket.remoteAddress),
    }),
  });
}

export async function getProfile(req: Request<ProfileParams>, res: Response) {
  res.json({ data: await investorService.getInvestorProfile(req.params.profileId) });
}

export async function listProfiles(req: Request, res: Response) {
  const userId = investorId(req);
  if (typeof userId !== "string") throw HttpError.badRequest("userId is required");
  res.json({ data: await investorService.listProfilesForUser(userId) });
}

export async function getOnboarding(req: Request, res: Response) {
  const userId = investorId(req);
  if (typeof userId !== "string") throw HttpError.badRequest("userId is required");
  res.json({ data: await investorService.getOnboardingStatus(userId) });
}

export async function addAddress(req: Request<ProfileParams>, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await investorService.addAddress(req.params.profileId, {
      line1: requiredString(body, "line1", { maxLength: 255 }),
      line2: optionalString(body, "line2", { maxLength: 255 }),
      line3: optionalString(body, "line3", { maxLength: 255 }),
      city: optionalString(body, "city", { maxLength: 100 }),
      state: optionalString(body, "state", { maxLength: 100 }),
      postalCode: requiredString(body, "postalCode", { maxLength: 10 }),
      country: requiredString(body, "country", { maxLength: 2 }),
      nature: oneOf(body, "nature", ADDRESS_NATURES),
    }),
  });
}

export async function addPhone(req: Request<ProfileParams>, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await investorService.addPhone(req.params.profileId, {
      isd: requiredString(body, "isd", { maxLength: 4 }),
      number: requiredString(body, "number", {
        pattern: /^[0-9-]{7,20}$/,
        patternHint: "number must be 7-20 digits",
      }),
      belongsTo: optionalString(body, "belongsTo"),
    }),
  });
}

export async function addEmail(req: Request<ProfileParams>, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await investorService.addEmail(req.params.profileId, {
      email: requiredString(body, "email", {
        maxLength: 255,
        // FP applies its own AMFI-mandated rules on top; this only catches the
        // obvious rubbish before a round trip.
        pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        patternHint: "email must be a valid address",
      }),
      belongsTo: optionalString(body, "belongsTo"),
    }),
  });
}

export async function addBankAccount(req: Request<ProfileParams>, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await investorService.addBankAccount(req.params.profileId, {
      accountNumber: requiredString(body, "accountNumber", {
        pattern: /^\d{9,18}$/,
        patternHint: "accountNumber must be 9-18 digits",
      }),
      accountHolderName: requiredString(body, "accountHolderName", { maxLength: 150 }),
      type: oneOf(body, "type", BANK_ACCOUNT_TYPES) as string,
      ifscCode: requiredString(body, "ifscCode", {
        pattern: IFSC_PATTERN,
        patternHint: "ifscCode must be a valid IFSC, e.g. HDFC0001330",
      }),
    }),
  });
}

export async function createBankAccountLookup(req: Request<ProfileParams>, res: Response) {
  const body = asBody(req.body);
  if (body["consentAccepted"] !== true) {
    throw HttpError.badRequest("Consent is required to find a bank account by mobile number");
  }
  res.status(202).json({
    data: await investorService.createBankAccountLookup({
      userId: investorId(req),
      investorProfileId: req.params.profileId,
      ipAddress: clientIpv4({}, req.ip ?? req.socket.remoteAddress),
    }),
  });
}

export async function refreshBankAccountLookup(
  req: Request<{ lookupId: string }>,
  res: Response,
) {
  res.json({
    data: await investorService.refreshBankAccountLookup(investorId(req), req.params.lookupId),
  });
}

export async function linkBankAccountLookup(
  req: Request<{ lookupId: string }>,
  res: Response,
) {
  res.status(201).json({
    data: await investorService.linkBankAccountLookup(investorId(req), req.params.lookupId),
  });
}

export async function addNominee(req: Request<ProfileParams>, res: Response) {
  const body = asBody(req.body);
  res.status(201).json({
    data: await investorService.addNominee(req.params.profileId, {
      name: requiredString(body, "name", { maxLength: 40 }),
      relationship: oneOf(body, "relationship", NOMINEE_RELATIONSHIPS) as string,
      dateOfBirth: optionalDate(body, "dateOfBirth"),
      pan: body["pan"] === undefined ? undefined : requiredPan(body),
      guardianName: optionalString(body, "guardianName", { maxLength: 35 }),
      guardianPan:
        body["guardianPan"] === undefined ? undefined : requiredPan(body, "guardianPan"),
    }),
  });
}

/** Parse the folio-defaults hash shared by create-account and update. */
function parseFolioDefaults(body: Record<string, unknown>) {
  const rawNominees = body["nominees"];
  let nominees:
    | { relatedPartyId: string; allocationPercentage: string; identityProofType?: string }[]
    | undefined;

  if (rawNominees !== undefined) {
    if (!Array.isArray(rawNominees)) throw HttpError.badRequest("nominees must be an array");
    // FP has exactly three nominee slots.
    if (rawNominees.length > 3) throw HttpError.badRequest("At most three nominees are allowed");

    nominees = rawNominees.map((entry) => {
      const nominee = asBody(entry);
      const proofType = oneOf(nominee, "identityProofType", PROOF_TYPES, false);
      return {
        relatedPartyId: requiredString(nominee, "relatedPartyId"),
        allocationPercentage: requiredDecimal(nominee, "allocationPercentage", {
          maxDecimalPlaces: 2,
        }),
        ...(proofType && { identityProofType: proofType }),
      };
    });
  }

  return {
    emailAddressId: optionalString(body, "emailAddressId"),
    phoneNumberId: optionalString(body, "phoneNumberId"),
    addressId: optionalString(body, "addressId"),
    bankAccountId: optionalString(body, "bankAccountId"),
    dematAccountId: optionalString(body, "dematAccountId"),
    ...(nominees && { nominees }),
    nominationsInfoVisibility: oneOf(body, "nominationsInfoVisibility", VISIBILITY, false),
  };
}

export async function createInvestmentAccount(req: Request<ProfileParams>, res: Response) {
  const body = asBody(req.body);
  const hasDefaults = Object.keys(body).length > 0;
  res.status(201).json({
    data: await investorService.createInvestmentAccount(
      req.params.profileId,
      hasDefaults ? parseFolioDefaults(body) : undefined,
    ),
  });
}

export async function setFolioDefaults(req: Request<AccountParams>, res: Response) {
  const body = asBody(req.body);
  res.json({
    data: await investorService.setFolioDefaults(req.params.accountId, parseFolioDefaults(body)),
  });
}

export async function getInvestmentAccount(req: Request<AccountParams>, res: Response) {
  res.json({ data: await investorService.getInvestmentAccount(req.params.accountId) });
}


export async function listBankAccounts(req: Request<ProfileParams>, res: Response) {
  res.json({ data: await investorService.listBankAccounts(req.params.profileId) });
}

/**
 * Start a penny-drop verification of the account.
 *
 * On the cybrillapoa gateway this is not optional: an unverified payout account
 * lets an order be paid for and confirmed, then fails it at submission.
 */
export async function verifyBankAccount(req: Request<{ bankAccountId: string }>, res: Response) {
  res.status(202).json({ data: await investorService.verifyBankAccount(req.params.bankAccountId) });
}

/** Poll it — the penny-drop settles asynchronously. */
export async function refreshBankAccountVerification(
  req: Request<{ bankAccountId: string }>,
  res: Response,
) {
  res.json({
    data: await investorService.refreshBankAccountVerification(req.params.bankAccountId),
  });
}
