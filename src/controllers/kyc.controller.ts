import type { Request, Response } from "express";
import { KycFormType } from "../../generated/prisma/enums.ts";
import * as kycService from "../services/kyc.service.ts";
import {
  asBody,
  oneOf,
  optionalString,
  optionalStringArray,
  requiredDate,
  requiredPan,
  requiredString,
  IFSC_PATTERN,
} from "../utils/validate.ts";
import { HttpError } from "../utils/http-error.ts";
import { investorId } from "../middleware/investor-auth.ts";

const FORM_TYPES = ["FRESH", "MODIFY"] as const;
const GENDERS = ["male", "female", "transgender"] as const;
const MARITAL_STATUSES = ["married", "unmarried", "others"] as const;
// kyc forms use the KYC occupation vocabulary, not investor_profile's.
const OCCUPATIONS = [
  "business", "professional", "retired", "housewife", "student",
  "public_sector", "private_sector", "government_sector", "others",
  "public_sector_service", "private_sector_service", "government_service",
  "agriculture", "doctor", "forex_dealer", "service",
] as const;
const INCOME_SLABS = [
  "upto_1lakh", "above_1lakh_upto_5lakh", "above_5lakh_upto_10lakh",
  "above_10lakh_upto_25lakh", "above_25lakh_upto_1cr", "above_1cr",
] as const;
// FP's KYC-form vocabulary, which is not investor_profile's: it answers
// anything else with "Supports one of [no_exposure, pep, related_pep] and its
// case sensitive", so the profile spellings were rejected on every form.
const PEP_VALUES = ["no_exposure", "pep", "related_pep"] as const;
/** The only residential status this KYC form accepts today. */
const RESIDENTIAL_STATUSES = ["resident"] as const;
const ACCOUNT_TYPES = ["savings", "current", "nre_savings", "nro_savings"] as const;

/**
 * The KYC form rejects a coordinate carrying more than six decimal places —
 * *"geolocation values must not exceed 6 decimal places"* — and a device fix
 * carries far more, which failed the whole details submission. Six is about
 * 11cm, far finer than a check on where the form was filled in needs.
 */
const COORDINATE_DECIMALS = 6;

const toCoordinate = (value: number): number => Number(value.toFixed(COORDINATE_DECIMALS));

type FormParams = { formId: string };

/** Is this investor allowed to transact? Start here, before any KYC form. */
export async function checkReadiness(req: Request, res: Response) {
  const body = asBody(req.body);
  const accountNumber = optionalString(body, "bankAccountNumber", {
    pattern: /^\d{9,18}$/,
    patternHint: "bankAccountNumber must be 9-18 digits",
  });
  const ifscCode = optionalString(body, "bankIfscCode", {
    pattern: IFSC_PATTERN,
    patternHint: "bankIfscCode must be a valid IFSC",
  });
  const accountType = oneOf(body, "bankAccountType", ACCOUNT_TYPES, false);

  if ((accountNumber || ifscCode) && !(accountNumber && ifscCode && accountType)) {
    throw HttpError.badRequest(
      "bankAccountNumber, bankIfscCode and bankAccountType must be given together",
    );
  }

  res.status(201).json({
    data: await kycService.checkReadiness({
      userId: investorId(req),
      investorProfileId: optionalString(body, "investorProfileId"),
      pan: requiredPan(body),
      name: requiredString(body, "name", { maxLength: 70 }),
      dateOfBirth: requiredDate(body, "dateOfBirth"),
      ...(accountNumber && ifscCode && accountType
        ? { bankAccount: { accountNumber, ifscCode, accountType } }
        : {}),
    }),
  });
}

export async function getReadiness(req: Request<{ preVerificationId: string }>, res: Response) {
  res.json({ data: await kycService.getReadiness(req.params.preVerificationId) });
}

export async function startForm(req: Request, res: Response) {
  const body = asBody(req.body);
  const type = oneOf(body, "type", FORM_TYPES) as string;

  res.status(201).json({
    data: await kycService.startKycForm({
      type: type === "MODIFY" ? KycFormType.MODIFY : KycFormType.FRESH,
      pan: requiredPan(body),
      name: requiredString(body, "name", { maxLength: 70 }),
      dateOfBirth: requiredDate(body, "dateOfBirth"),
      proofCallbackUrl: requiredString(body, "proofCallbackUrl", { maxLength: 1000 }),
      esignCallbackUrl: requiredString(body, "esignCallbackUrl", { maxLength: 1000 }),
      userId: investorId(req),
      investorProfileId: optionalString(body, "investorProfileId"),
    }),
  });
}

export async function updateForm(req: Request<FormParams>, res: Response) {
  const body = asBody(req.body);
  const mobile = body["mobile"] == null ? {} : asBody(body["mobile"]);
  const geo = body["geolocation"] == null ? {} : asBody(body["geolocation"]);
  const phoneBody = {
    mobileIsd: mobile["isd"] ?? body["mobileIsd"],
    mobileNumber: mobile["number"] ?? body["mobileNumber"],
  };
  // "91" and "+91" both accepted; the service sends FP the one it takes.
  const isd = optionalString(phoneBody, "mobileIsd", {
    maxLength: 4,
    pattern: /^\+?\d{1,3}$/,
    patternHint: "mobileIsd must be a country calling code, e.g. +91",
  });
  const number = optionalString(phoneBody, "mobileNumber", {
    pattern: /^[0-9-]{7,20}$/,
    patternHint: "mobileNumber must be 7-20 digits",
  });
  const latitude = geo["latitude"] ?? body["latitude"];
  const longitude = geo["longitude"] ?? body["longitude"];
  const hasGeo = typeof latitude === "number" && typeof longitude === "number";
  const taxResidencies: Partial<import('../types/kyc.types.ts').UpdateKycFormInput> = {};
  for (const slot of [1, 2, 3] as const) {
    const key = `nonIndianTaxResidency${slot}` as const;
    if (body[key] != null) {
      const residency = asBody(body[key]);
      taxResidencies[key] = {
        // Lower case, as the form's own documented payloads spell country codes.
        country: requiredString(residency, 'country', { pattern: /^[A-Za-z]{2}$/ }).toLowerCase(),
        taxIdNumber: requiredString(residency, 'taxIdNumber', { maxLength: 100 }),
      };
    }
  }
  if ((latitude !== undefined || longitude !== undefined) &&
      (!hasGeo || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
       Math.abs(latitude as number) > 90 || Math.abs(longitude as number) > 180)) {
    throw HttpError.badRequest("Provide valid latitude and longitude");
  }

  res.json({
    data: await kycService.updateKycForm(req.params.formId, {
      ...taxResidencies,
      email: optionalString(body, "email", { maxLength: 255 }),
      ...(isd && number ? { mobile: { isd, number } } : {}),
      residentialStatus: oneOf(body, "residentialStatus", RESIDENTIAL_STATUSES, false),
      gender: oneOf(body, "gender", GENDERS, false),
      maritalStatus: oneOf(body, "maritalStatus", MARITAL_STATUSES, false),
      fatherName: optionalString(body, "fatherName", { maxLength: 70 }),
      spouseName: optionalString(body, "spouseName", { maxLength: 70 }),
      occupationType: oneOf(body, "occupationType", OCCUPATIONS, false),
      aadhaarLast4: optionalString(body, "aadhaarLast4", {
        pattern: /^\d{4}$/,
        patternHint: "aadhaarLast4 must be exactly the last 4 digits",
      }),
      countryOfBirth: optionalString(body, "countryOfBirth", { maxLength: 2 }),
      placeOfBirth: optionalString(body, "placeOfBirth", { maxLength: 60 }),
      incomeSlab: oneOf(body, "incomeSlab", INCOME_SLABS, false),
      pepDetails: oneOf(body, "pepDetails", PEP_VALUES, false),
      citizenshipCountries: optionalStringArray(body, "citizenshipCountries"),
      nationalityCountry: optionalString(body, "nationalityCountry", { maxLength: 2 }),
      ...(typeof body["taxResidencyOtherThanIndia"] === "boolean"
        ? { taxResidencyOtherThanIndia: body["taxResidencyOtherThanIndia"] }
        : {}),
      ...(hasGeo
        ? { geolocation: { latitude: toCoordinate(latitude), longitude: toCoordinate(longitude) } }
        : {}),
    }),
  });
}

export async function getForm(req: Request<FormParams>, res: Response) {
  res.json({ data: await kycService.getForm(req.params.formId) });
}

/** Eligibility, DigiLocker and esign all complete out of band, with no
 *  webhooks on this realm — so the client polls this. */
export async function refreshForm(req: Request<FormParams>, res: Response) {
  res.json({ data: await kycService.refreshForm(req.params.formId) });
}

export async function retryProofFetch(req: Request<FormParams>, res: Response) {
  res.json({ data: await kycService.retryProofFetch(req.params.formId) });
}

export async function listForms(req: Request, res: Response) {
  const userId = investorId(req);
  if (typeof userId !== "string") throw HttpError.badRequest("userId is required");
  res.json({ data: await kycService.listForms(userId) });
}
