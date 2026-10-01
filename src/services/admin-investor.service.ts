// Investor records for the admin portal.
//
// The list reads `investor_journey_snapshots`, the read model the admin
// projection keeps current, so filtering and paging stay index-backed however
// many investors there are. The detail view derives its one investor live
// from `investorFacts` — the same definition the projection uses — and writes
// that row back to the snapshot, so a record someone just looked at is never
// stale in the list.
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { outstandingInvestorFields } from "../utils/kyc-steps.ts";
import { maskAccountNumber, maskPan } from "../utils/mask.ts";
import { refreshInvestors } from "./admin-projection.service.ts";
import { getInvestorInvestments } from "./admin-investor-portfolio.service.ts";
import { investorFacts, KYC_STALLED_HOURS, nextStepOf, type InvestorFactRow } from "./investor-facts.service.ts";
import type {
  AdminKycStatus,
  InvestorDetailDto,
  InvestorListDto,
  InvestorListItemDto,
  InvestorListQuery,
  JourneyStage,
  KycCompletedVia,
} from "../types/admin-investor.types.ts";
import type { StaffPrincipal } from "../types/staff.types.ts";

const money = (value: Prisma.Decimal | string | number | null | undefined) =>
  new Prisma.Decimal(value ?? 0).toFixed(2);

const snapshotSelect = {
  userId: true, name: true, email: true, phone: true, pan: true, userStatus: true, stage: true,
  kycStatus: true, kycVia: true, kycFormStatus: true, kycProofStatus: true, kycSignatureProvided: true,
  kycFieldsNeeded: true, investedAmount: true, currentValue: true, activeSips: true, sipMonthlyAmount: true,
  nextSipDate: true, signedUpAt: true, lastLoginAt: true, lastActivityAt: true,
} as const satisfies Prisma.InvestorJourneySnapshotSelect;

type SnapshotRow = Prisma.InvestorJourneySnapshotGetPayload<{ select: typeof snapshotSelect }>;

function snapshotToItem(row: SnapshotRow): InvestorListItemDto {
  const kycStatus = row.kycStatus as AdminKycStatus;
  return {
    id: row.userId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.userStatus,
    pan: maskPan(row.pan),
    stage: row.stage as JourneyStage,
    kycStatus,
    kycCompletedVia: row.kycVia as KycCompletedVia | null,
    kycNextStep: kycStatus === "IN_PROGRESS"
      ? nextStepOf({
          status: row.kycFormStatus, proofStatus: row.kycProofStatus,
          signatureProvided: row.kycSignatureProvided, fieldsNeeded: row.kycFieldsNeeded,
        })
      : null,
    investedAmount: money(row.investedAmount),
    currentValue: money(row.currentValue),
    activeSips: row.activeSips,
    sipMonthlyAmount: money(row.sipMonthlyAmount),
    nextSipDate: row.nextSipDate?.toISOString().slice(0, 10) ?? null,
    signedUpAt: row.signedUpAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}

function factToItem(row: InvestorFactRow): InvestorListItemDto {
  return {
    id: row.id,
    name: row.profile_name ?? row.fullName,
    email: row.email,
    phone: row.phone,
    status: row.status,
    pan: maskPan(row.pan),
    stage: row.stage,
    kycStatus: row.kyc_status,
    kycCompletedVia: row.kyc_via,
    kycNextStep: row.kyc_status === "IN_PROGRESS"
      ? nextStepOf({
          status: row.kf_status, proofStatus: row.kf_proof_status,
          signatureProvided: row.kf_signature, fieldsNeeded: row.kf_fields_needed,
        })
      : null,
    investedAmount: money(row.purchased_amount),
    currentValue: money(row.current_value),
    activeSips: Number(row.active_sips),
    sipMonthlyAmount: money(row.sip_monthly),
    nextSipDate: row.next_sip_date?.toISOString().slice(0, 10) ?? null,
    signedUpAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    lastActivityAt: row.last_activity_at.toISOString(),
  };
}

// --- list ------------------------------------------------------------------

export const encodeCursor = (row: { signedUpAt: Date; userId: string }) =>
  Buffer.from(`${row.signedUpAt.toISOString()}|${row.userId}`).toString("base64url");

/** "Stalled" depends on the clock, which changes no row, so it is judged here rather than stored. */
export const stalledWhere = (): Prisma.InvestorJourneySnapshotWhereInput => ({
  kycStatus: "IN_PROGRESS",
  kycMovedAt: { lt: new Date(Date.now() - KYC_STALLED_HOURS * 60 * 60 * 1000) },
});

function listWhere(query: InvestorListQuery): Prisma.InvestorJourneySnapshotWhereInput {
  const and: Prisma.InvestorJourneySnapshotWhereInput[] = [];
  if (query.stage?.length) and.push({ stage: { in: query.stage } });
  if (query.kycStatus?.length) and.push({ kycStatus: { in: query.kycStatus } });
  if (query.status?.length) and.push({ userStatus: { in: query.status } });
  if (query.kycStalled) and.push(stalledWhere());
  if (query.sipDueDays !== undefined) {
    const today = new Date(new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10));
    const until = new Date(today.getTime() + query.sipDueDays * 24 * 60 * 60 * 1000);
    and.push({ activeSips: { gt: 0 }, nextSipDate: { gte: today, lte: until } });
  }
  if (query.search) {
    const upper = query.search.toUpperCase();
    const digits = query.search.replace(/\D/g, "");
    and.push({
      OR: [
        { name: { contains: query.search, mode: "insensitive" } },
        { email: { contains: query.search, mode: "insensitive" } },
        { pan: upper },
        // Staff only ever see a masked PAN (XXXXXX234F), so its visible tail
        // has to be searchable on its own.
        ...(/^[A-Z0-9]{4,9}$/.test(upper) ? [{ pan: { endsWith: upper } }] : []),
        ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

export async function listInvestors(query: InvestorListQuery): Promise<InvestorListDto> {
  const where = listWhere(query);
  const page: Prisma.InvestorJourneySnapshotWhereInput = query.cursor
    ? {
        OR: [
          { signedUpAt: { lt: query.cursor.createdAt } },
          { signedUpAt: query.cursor.createdAt, userId: { lt: query.cursor.id } },
        ],
      }
    : {};

  const [rows, total] = await Promise.all([
    db.investorJourneySnapshot.findMany({
      where: { AND: [where, page] },
      orderBy: [{ signedUpAt: "desc" }, { userId: "desc" }],
      take: query.limit + 1,
      select: snapshotSelect,
    }),
    db.investorJourneySnapshot.count({ where }),
  ]);

  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items: items.map(snapshotToItem),
    total,
    nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
  };
}

// --- detail ----------------------------------------------------------------

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

export async function getInvestor(userId: string, viewer: StaffPrincipal): Promise<InvestorDetailDto> {
  const [row] = await db.$queryRaw<InvestorFactRow[]>`
    SELECT * FROM (${investorFacts(Prisma.sql`AND u.id = ${userId}::uuid`)}) f`;
  if (!row) throw HttpError.notFound("No investor with that id");
  // Bring this investor's snapshot row up to date with what we are about to show.
  await refreshInvestors([userId]);

  const profileId = row.profile_id;
  const [user, panCheck, forms, profile, banks, onboarding, account, firstPurchase, investments] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { emailVerifiedAt: true, phoneVerifiedAt: true, createdAt: true },
    }),
    db.preVerification.findFirst({
      where: {
        readinessStatus: { not: null },
        OR: [{ userId }, ...(profileId ? [{ investorProfileId: profileId }] : [])],
      },
      orderBy: [{ fpCreatedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: {
        readinessStatus: true, readinessCode: true, readinessReason: true,
        panStatus: true, panCode: true, nameStatus: true, nameCode: true,
        dateOfBirthStatus: true, dateOfBirthCode: true,
        completedAt: true, fpUpdatedAt: true, fpCreatedAt: true, createdAt: true,
      },
    }),
    db.kycForm.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, type: true, status: true, reason: true, proofStatus: true, esignStatus: true,
        signatureProvided: true, fieldsNeeded: true, createdAt: true, submittedAt: true, failedAt: true, expiresAt: true,
      },
    }),
    profileId
      ? db.investorProfile.findUnique({
          where: { id: profileId },
          select: {
            id: true, name: true, dateOfBirth: true, gender: true, occupation: true, taxStatus: true, incomeSlab: true,
            createdAt: true,
            addresses: { select: { city: true, state: true, postalCode: true, country: true } },
            relatedParties: {
              select: {
                name: true, relationship: true,
                nomineeFor: { select: { allocationPercentage: true } },
              },
            },
          },
        })
      : null,
    profileId
      ? db.bankAccount.findMany({
          where: { investorProfileId: profileId },
          orderBy: { createdAt: "asc" },
          select: {
            id: true, bankName: true, accountNumberLast4: true, ifscCode: true, type: true,
            verificationStatus: true, verificationConfidence: true, verifiedAt: true, createdAt: true,
            mandates: {
              orderBy: { createdAt: "desc" },
              select: { id: true, mandateType: true, mandateStatus: true, mandateLimit: true, approvedAt: true, createdAt: true },
            },
          },
        })
      : [],
    profileId
      ? db.investorOnboarding.findUnique({ where: { investorProfileId: profileId }, select: { nominationOptOutAt: true } })
      : null,
    row.account_id
      ? db.mfInvestmentAccount.findUnique({
          where: { id: row.account_id },
          select: {
            createdAt: true,
            folioDefaults: { select: { payoutBankAccountId: true } },
          },
        })
      : null,
    row.account_id
      ? db.mfPurchase.findFirst({
          where: { mfInvestmentAccountId: row.account_id, state: "SUCCESSFUL", succeededAt: { not: null } },
          orderBy: { succeededAt: "asc" },
          select: { succeededAt: true },
        })
      : null,
    getInvestorInvestments(row.account_id, profileId),
  ]);

  // Viewing an investor's KYC and bank details is PII access; staff reads are
  // audited like writes.
  await db.auditLog.create({
    data: {
      actorStaffId: viewer.staffId, action: "STAFF_VIEWED_INVESTOR",
      entityType: "user", entityId: userId,
    },
  });

  const payoutId = account?.folioDefaults?.payoutBankAccountId ?? null;
  const nominees = (profile?.relatedParties ?? [])
    .filter((party) => party.nomineeFor.length > 0)
    .map((party) => ({
      name: party.name,
      relationship: party.relationship,
      allocationPercentage: money(party.nomineeFor[0]?.allocationPercentage),
    }));


  const timeline: InvestorDetailDto["timeline"] = [];
  const add = (at: Date | null | undefined, event: string) => { if (at) timeline.push({ at: at.toISOString(), event }); };
  add(user.createdAt, "Signed up");
  add(panCheck ? panCheck.completedAt ?? panCheck.fpUpdatedAt ?? panCheck.fpCreatedAt ?? panCheck.createdAt : null,
    panCheck?.readinessStatus === "verified" ? "Latest PAN check passed" : "Latest PAN check not passed");
  for (const form of [...forms].reverse()) {
    add(form.createdAt, `KYC form opened (${form.type.toLowerCase()})`);
    add(form.submittedAt, "KYC form submitted");
    add(form.failedAt, "KYC form failed");
  }
  add(profile?.createdAt, "Investor profile created");
  for (const bank of banks) add(bank.verifiedAt, `Bank account ${maskAccountNumber(bank.accountNumberLast4)} verified`);
  add(account?.createdAt, "Investment account created");
  add(firstPurchase?.succeededAt, "First successful investment");
  const plans = [...investments.plans.sips, ...investments.plans.swps, ...investments.plans.stps];
  for (const plan of plans) {
    add(new Date(plan.createdAt), `${plan.kind} set up in ${plan.scheme}${plan.toScheme ? ` → ${plan.toScheme}` : ""}`);
    if (plan.cancelledAt) add(new Date(plan.cancelledAt), `${plan.kind} cancelled in ${plan.scheme}`);
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));

  return {
    summary: factToItem(row),
    user: {
      emailVerifiedAt: iso(user.emailVerifiedAt),
      phoneVerifiedAt: iso(user.phoneVerifiedAt),
      createdAt: user.createdAt.toISOString(),
    },
    kyc: {
      panCheck: panCheck && {
        at: (panCheck.completedAt ?? panCheck.fpUpdatedAt ?? panCheck.fpCreatedAt ?? panCheck.createdAt).toISOString(),
        readinessStatus: panCheck.readinessStatus,
        readinessCode: panCheck.readinessCode,
        readinessReason: panCheck.readinessReason,
        pan: { status: panCheck.panStatus, code: panCheck.panCode },
        name: { status: panCheck.nameStatus, code: panCheck.nameCode },
        dateOfBirth: { status: panCheck.dateOfBirthStatus, code: panCheck.dateOfBirthCode },
      },
      forms: forms.map((form) => ({
        id: form.id,
        type: form.type,
        status: form.status,
        reason: form.reason,
        nextStep: nextStepOf(form),
        proofStatus: form.proofStatus,
        esignStatus: form.esignStatus,
        signatureProvided: form.signatureProvided,
        outstandingFields: outstandingInvestorFields(form.fieldsNeeded),
        createdAt: form.createdAt.toISOString(),
        submittedAt: iso(form.submittedAt),
        failedAt: iso(form.failedAt),
        expiresAt: iso(form.expiresAt),
      })),
    },
    profile: profile && {
      id: profile.id,
      name: profile.name,
      dateOfBirth: profile.dateOfBirth?.toISOString().slice(0, 10) ?? null,
      gender: profile.gender,
      occupation: profile.occupation,
      taxStatus: profile.taxStatus,
      incomeSlab: profile.incomeSlab,
      addresses: profile.addresses,
    },
    bankAccounts: banks.map((bank) => ({
      id: bank.id,
      bankName: bank.bankName,
      accountNumber: maskAccountNumber(bank.accountNumberLast4),
      ifscCode: bank.ifscCode,
      type: bank.type,
      isPayout: bank.id === payoutId,
      verificationStatus: bank.verificationStatus,
      verificationConfidence: bank.verificationConfidence,
      verifiedAt: iso(bank.verifiedAt),
    })),
    nomination: { optedOut: onboarding?.nominationOptOutAt != null, nominees },
    mandates: banks
      .flatMap((bank) => bank.mandates)
      .map((m) => ({
        id: m.id, type: m.mandateType, status: m.mandateStatus, limit: money(m.mandateLimit),
        approvedAt: iso(m.approvedAt), createdAt: m.createdAt.toISOString(),
      })),
    investments,
    timeline,
  };
}
