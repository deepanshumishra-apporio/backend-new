// Mirror investment accounts, their folio defaults and nominees, folios, and
// the holdings projection.
import { db } from "../../db/client.ts";
import {
  BankAccountType,
  HoldingPattern,
  IdentityProofType,
  NominationsInfoVisibility,
} from "../../../generated/prisma/enums.ts";
import {
  fpAmount,
  fpDate,
  fpDateTime,
  fpEnum,
  fpEnumOr,
  fpInt,
  fpJson,
  fpNav,
  fpPercent,
  fpStringArray,
  fpText,
  fpUnits,
} from "../../utils/fp-mapping.ts";
import type {
  FpFolio,
  FpFolioDefaults,
  FpHoldingsReport,
  FpInvestmentAccount,
} from "../../integrations/fp/fp.types.ts";

function unknownValue(field: string) {
  return (value: string) => console.warn(`[fp-sync] unmapped ${field}: "${value}"`);
}

/** Resolve an FP child-object id to our local row id, when it is set. */
async function localId(
  finder: (fpId: string) => Promise<{ id: string } | null>,
  fpId: string | null | undefined,
): Promise<string | null> {
  if (!fpId) return null;
  return (await finder(fpId))?.id ?? null;
}

export async function syncInvestmentAccount(
  account: FpInvestmentAccount,
): Promise<{ id: string }> {
  const primary = await db.investorProfile.findUnique({
    where: { fpId: account.primary_investor ?? "" },
    select: { id: true },
  });
  if (!primary) {
    throw new Error(`Investment account ${account.id} references an unmirrored primary investor`);
  }

  // Second and third holders are the joint subdomain: FP already reports them,
  // so mirror them when present rather than silently dropping them.
  const second = account.second_investor
    ? await db.investorProfile.findUnique({
        where: { fpId: account.second_investor },
        select: { id: true },
      })
    : null;
  const third = account.third_investor
    ? await db.investorProfile.findUnique({
        where: { fpId: account.third_investor },
        select: { id: true },
      })
    : null;

  const data = {
    fpOldId: fpInt(account.old_id),
    primaryInvestorProfileId: primary.id,
    secondInvestorProfileId: second?.id ?? null,
    thirdInvestorProfileId: third?.id ?? null,
    primaryInvestorPan: fpText(account.primary_investor_pan, 10),
    secondInvestorPan: fpText(account.second_investor_pan, 10),
    thirdInvestorPan: fpText(account.third_investor_pan, 10),
    holdingPattern: fpEnumOr(
      HoldingPattern,
      account.holding_pattern,
      HoldingPattern.SINGLE,
      unknownValue("holding_pattern"),
    ),
    fpCreatedAt: fpDateTime(account.created_at),
    syncedAt: new Date(),
  };

  const row = await db.mfInvestmentAccount.upsert({
    where: { fpId: account.id },
    update: data,
    create: { fpId: account.id, ...data },
    select: { id: true },
  });

  if (account.folio_defaults) {
    await syncFolioDefaults(row.id, account.folio_defaults);
  }
  return row;
}

async function syncFolioDefaults(
  mfInvestmentAccountId: string,
  defaults: FpFolioDefaults,
): Promise<void> {
  const findEmail = (fpId: string) =>
    db.emailAddress.findUnique({ where: { fpId }, select: { id: true } });
  const findPhone = (fpId: string) =>
    db.phoneNumber.findUnique({ where: { fpId }, select: { id: true } });
  const findAddress = (fpId: string) =>
    db.address.findUnique({ where: { fpId }, select: { id: true } });
  const findBank = (fpId: string) =>
    db.bankAccount.findUnique({ where: { fpId }, select: { id: true } });
  const findDemat = (fpId: string) =>
    db.dematAccount.findUnique({ where: { fpId }, select: { id: true } });

  const data = {
    communicationEmailAddressId: await localId(findEmail, defaults.communication_email_address),
    communicationPhoneNumberId: await localId(findPhone, defaults.communication_mobile_number),
    communicationAddressId: await localId(findAddress, defaults.communication_address),
    overseasCommunicationAddressId: await localId(
      findAddress,
      defaults.overseas_communication_address,
    ),
    payoutBankAccountId: await localId(findBank, defaults.payout_bank_account),
    dematAccountId: await localId(findDemat, defaults.demat_account),
    nominationsInfoVisibility: fpEnum(
      NominationsInfoVisibility,
      defaults.nominations_info_visibility,
      unknownValue("nominations_info_visibility"),
    ),
    syncedAt: new Date(),
  };

  await db.mfFolioDefaults.upsert({
    where: { mfInvestmentAccountId },
    update: data,
    create: { mfInvestmentAccountId, ...data },
  });

  const slots: [number, string | null, number | null, string | null | undefined, string | null | undefined][] =
    [
      [
        1,
        defaults.nominee1,
        defaults.nominee1_allocation_percentage,
        defaults.nominee1_identity_proof_type,
        defaults.nominee1_guardian_identity_proof_type,
      ],
      [
        2,
        defaults.nominee2,
        defaults.nominee2_allocation_percentage,
        defaults.nominee2_identity_proof_type,
        defaults.nominee2_guardian_identity_proof_type,
      ],
      [
        3,
        defaults.nominee3,
        defaults.nominee3_allocation_percentage,
        defaults.nominee3_identity_proof_type,
        defaults.nominee3_guardian_identity_proof_type,
      ],
    ];

  for (const [slot, relatedPartyFpId, allocation, proofType, guardianProofType] of slots) {
    if (!relatedPartyFpId) {
      // A cleared slot must remove the row, or a removed nominee lingers.
      await db.mfInvestmentAccountNominee.deleteMany({ where: { mfInvestmentAccountId, slot } });
      continue;
    }
    const party = await db.relatedParty.findUnique({
      where: { fpId: relatedPartyFpId },
      select: { id: true },
    });
    if (!party) {
      console.warn(`[fp-sync] nominee ${relatedPartyFpId} is not mirrored; skipping slot ${slot}`);
      continue;
    }
    const nomineeData = {
      relatedPartyId: party.id,
      allocationPercentage: fpPercent(allocation) ?? "0.00",
      identityProofType: fpEnum(IdentityProofType, proofType, unknownValue("proof type")),
      guardianIdentityProofType: fpEnum(
        IdentityProofType,
        guardianProofType,
        unknownValue("guardian proof type"),
      ),
      syncedAt: new Date(),
    };
    await db.mfInvestmentAccountNominee.upsert({
      where: { mfInvestmentAccountId_slot: { mfInvestmentAccountId, slot } },
      update: nomineeData,
      create: { mfInvestmentAccountId, slot, ...nomineeData },
    });
  }
}

export async function syncFolio(
  folio: FpFolio,
  mfInvestmentAccountId: string,
): Promise<{ id: string }> {
  const data = {
    mfInvestmentAccountId,
    ...(folio.id ? { fpId: folio.id } : {}),
    amcCode: fpText(folio.amc, 20),
    holdingPattern: fpEnum(HoldingPattern, folio.holding_pattern, unknownValue("holding_pattern")),
    dpId: fpText(folio.dp_id, 20),
    clientId: fpText(folio.client_id, 20),
    primaryInvestorName: fpText(folio.primary_investor_name, 150),
    primaryInvestorPan: fpText(folio.primary_investor_pan, 10),
    primaryInvestorDob: fpDate(folio.primary_investor_dob),
    primaryInvestorGender: fpText(folio.primary_investor_gender, 20),
    secondaryInvestorName: fpText(folio.secondary_investor_name, 150),
    secondaryInvestorPan: fpText(folio.secondary_investor_pan, 10),
    secondaryInvestorDob: fpDate(folio.secondary_investor_dob),
    secondaryInvestorGender: fpText(folio.secondary_investor_gender, 20),
    thirdInvestorName: fpText(folio.third_investor_name, 150),
    thirdInvestorPan: fpText(folio.third_investor_pan, 10),
    thirdInvestorDob: fpDate(folio.third_investor_dob),
    thirdInvestorGender: fpText(folio.third_investor_gender, 20),
    // The RTA's own vocabulary, kept as text rather than force-fitted.
    primaryInvestorTaxStatus: fpText(folio.primary_investor_tax_status, 60),
    primaryInvestorOccupation: fpText(folio.primary_investor_occupation, 60),
    guardianName: fpText(folio.guardian_name, 150),
    guardianPan: fpText(folio.guardian_pan, 10),
    guardianDob: fpDate(folio.guardian_dob),
    guardianGender: fpText(folio.guardian_gender, 20),
    guardianRelationship: fpText(folio.guardian_relationship, 60),
    emailAddresses: fpStringArray(folio.email_addresses),
    mobileNumbers: fpStringArray(folio.mobile_numbers),
    annexure: fpJson(folio.annexure),
    syncedAt: new Date(),
  };

  const row = await db.mfFolio.upsert({
    where: { mfInvestmentAccountId_number: { mfInvestmentAccountId, number: folio.number } },
    update: data,
    create: { number: folio.number, ...data },
    select: { id: true },
  });

  const nominees: [number, FpFolio["nominee1"], number | string | null][] = [
    [1, folio.nominee1, folio.nominee1_allocation_percentage],
    [2, folio.nominee2, folio.nominee2_allocation_percentage],
    [3, folio.nominee3, folio.nominee3_allocation_percentage],
  ];
  for (const [slot, nominee, allocation] of nominees) {
    if (!nominee) {
      await db.mfFolioNominee.deleteMany({ where: { mfFolioId: row.id, slot } });
      continue;
    }
    const nomineeData = {
      name: fpText(nominee.name, 150),
      dateOfBirth: fpDate(nominee.dob),
      relationship: fpText(nominee.relationship, 60),
      guardianName: fpText(nominee.guardian, 150),
      guardianRelationship: fpText(nominee.guardian_relationship, 60),
      allocationPercentage: fpPercent(allocation),
      syncedAt: new Date(),
    };
    await db.mfFolioNominee.upsert({
      where: { mfFolioId_slot: { mfFolioId: row.id, slot } },
      update: nomineeData,
      create: { mfFolioId: row.id, slot, ...nomineeData },
    });
  }

  for (const payout of folio.payout_details ?? []) {
    if (!payout.scheme) continue;
    const payoutData = {
      schemeCode: fpText(payout.scheme_code, 20),
      bankAccountName: fpText(payout.bank_account?.name, 150),
      bankAccountNumberMasked: fpText(payout.bank_account?.number, 40),
      bankAccountType: fpEnum(
        BankAccountType,
        payout.bank_account?.account_type,
        unknownValue("payout account_type"),
      ),
      bankIfsc: fpText(payout.bank_account?.ifsc, 11),
      syncedAt: new Date(),
    };
    await db.mfFolioSchemePayout.upsert({
      where: { mfFolioId_schemeIsin: { mfFolioId: row.id, schemeIsin: payout.scheme } },
      update: payoutData,
      create: { mfFolioId: row.id, schemeIsin: payout.scheme, ...payoutData },
    });
  }

  return row;
}

/**
 * Replace the holdings projection for an investment account.
 *
 * Wholesale replacement, not a merge: FP recomputes this from RTA feeds, and a
 * position that has been fully redeemed simply stops appearing. Merging would
 * leave that stale row behind for ever, showing units the investor no longer
 * owns. Done in one transaction so a reader never sees a half-empty portfolio.
 */
export async function syncHoldings(
  report: FpHoldingsReport,
  mfInvestmentAccountId: string,
): Promise<number> {
  const rows: {
    folioNumber: string;
    schemeIsin: string;
    schemeName: string | null;
    units: string;
    redeemableUnits: string | null;
    unitsAsOn: Date | null;
    marketValue: string | null;
    redeemableMarketValue: string | null;
    marketValueAsOn: Date | null;
    investedValue: string | null;
    investedValueAsOn: Date | null;
    payoutAmount: string | null;
    payoutAsOn: Date | null;
    nav: string | null;
    navAsOn: Date | null;
  }[] = [];

  for (const folio of report.folios ?? []) {
    for (const scheme of folio.schemes ?? []) {
      if (!scheme.isin) continue;
      rows.push({
        folioNumber: folio.folio_number,
        schemeIsin: scheme.isin,
        schemeName: fpText(scheme.name, 250),
        units: fpUnits(scheme.holdings?.units) ?? "0.0000",
        redeemableUnits: fpUnits(scheme.holdings?.redeemable_units),
        unitsAsOn: fpDate(scheme.holdings?.as_on),
        marketValue: fpAmount(scheme.market_value?.amount),
        redeemableMarketValue: fpAmount(scheme.market_value?.redeemable_amount),
        marketValueAsOn: fpDate(scheme.market_value?.as_on),
        investedValue: fpAmount(scheme.invested_value?.amount),
        investedValueAsOn: fpDate(scheme.invested_value?.as_on),
        payoutAmount: fpAmount(scheme.payout?.amount),
        payoutAsOn: fpDate(scheme.payout?.as_on),
        nav: fpNav(scheme.nav?.value),
        navAsOn: fpDate(scheme.nav?.as_on),
      });
    }
  }

  await db.$transaction(async (tx) => {
    await tx.mfHolding.deleteMany({ where: { mfInvestmentAccountId } });
    if (rows.length === 0) return;

    const folios = await tx.mfFolio.findMany({
      where: { mfInvestmentAccountId },
      select: { id: true, number: true },
    });
    const folioIdByNumber = new Map(folios.map((folio) => [folio.number, folio.id]));

    await tx.mfHolding.createMany({
      data: rows.map((row) => ({
        mfInvestmentAccountId,
        mfFolioId: folioIdByNumber.get(row.folioNumber) ?? null,
        ...row,
      })),
    });
  });

  return rows.length;
}
