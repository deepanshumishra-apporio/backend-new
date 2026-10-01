// "Where is this investor?" — the single definition.
//
// `investorFacts` derives each investor's KYC status and journey stage from
// the rows that exist, not from `InvestorOnboarding.stage`: that cursor never
// reaches KYC_CHECK, KYC_REQUEST, MANDATE or COMPLETED and only exists once a
// profile does, so it cannot answer "how many finished KYC".
//
// The identity verdict follows `investor-readiness.service.ts`: the newest
// pre-verification that carries a readiness verdict wins, and it passes only
// when readiness, PAN, name and DOB are all `verified`. Freshness is ignored,
// as `investmentReadiness` ignores it — an expired pass renews itself on the
// next order, so it is not "incomplete KYC".
//
// Two readers: the admin projection materialises it for every investor into
// `investor_journey_snapshots`, and the investor detail view runs it live for
// one. Both go through this query, so they cannot disagree.
import { Prisma } from "../../generated/prisma/client.ts";
import { kycNextAction } from "../utils/kyc-steps.ts";
import { monthlyFactorSql } from "../utils/plan-frequency.ts";
import type { AdminKycStatus, JourneyStage, KycCompletedVia, KycNextStep } from "../types/admin-investor.types.ts";

/** An open KYC form with no movement for this long counts as stalled. */
export const KYC_STALLED_HOURS = 48;

/**
 * One row per live investor with everything the admin views derive from.
 * `userWhere` narrows the users scanned (e.g. to one id) before the laterals run.
 */
export function investorFacts(userWhere: Prisma.Sql = Prisma.empty): Prisma.Sql {
  return Prisma.sql`
    WITH base AS (
      SELECT u.id, u."fullName", u.email, u.phone, u.status::text AS status,
             u."createdAt", u."lastLoginAt"
      FROM users u
      WHERE u.role = 'INVESTOR' AND u."deletedAt" IS NULL ${userWhere}
    ),
    link AS (
      SELECT DISTINCT ON (l."userId") l."userId", l."investorProfileId"
      FROM user_investor_profiles l
      JOIN base b ON b.id = l."userId"
      ORDER BY l."userId", l."isPrimary" DESC, l."createdAt" ASC
    ),
    raw AS (
      SELECT
        b.*,
        lk."investorProfileId" AS profile_id,
        ip.name AS profile_name,
        COALESCE(ip.pan, pv.pan, pv."investorIdentifier", kf.pan) AS pan,
        pv."readinessStatus" AS pv_readiness,
        (pv."readinessStatus" = 'verified' AND pv."panStatus" = 'verified'
          AND pv."nameStatus" = 'verified' AND pv."dateOfBirthStatus" = 'verified') AS pv_ok,
        pv.decided_at AS pv_at,
        kf.status::text AS kf_status,
        kf."proofStatus"::text AS kf_proof_status,
        kf."signatureProvided" AS kf_signature,
        kf."fieldsNeeded" AS kf_fields_needed,
        kf."createdAt" AS kf_created_at,
        GREATEST(kf."createdAt", kf."fpUpdatedAt", kf."reviewCompletedAt",
                 kf."awaitingEsignAt", kf."awaitingSubmissionAt") AS kf_moved_at,
        kf."submittedAt" AS kf_submitted_at,
        ia.id AS account_id,
        (ia."holdingPattern" = 'single'
          AND fd."communicationEmailAddressId" IS NOT NULL
          AND fd."communicationPhoneNumberId" IS NOT NULL
          AND fd."communicationAddressId" IS NOT NULL
          AND pb.id IS NOT NULL
          AND pb."verificationStatus" = 'completed'
          AND pb."verificationConfidence" IN ('very_high', 'high')) AS account_ready,
        COALESCE(pur.n, 0) AS purchases,
        COALESCE(pur.amount, 0) AS purchased_amount,
        pur.last_at AS last_purchase_at,
        COALESCE(sp.active_sips, 0) AS active_sips,
        COALESCE(sp.sip_monthly, 0) AS sip_monthly,
        sp.next_sip_date,
        COALESCE(hv.current_value, 0) AS current_value,
        ob."updatedAt" AS ob_updated_at
      FROM base b
      LEFT JOIN link lk ON lk."userId" = b.id
      LEFT JOIN investor_profiles ip ON ip.id = lk."investorProfileId"
      LEFT JOIN LATERAL (
        SELECT p.*, COALESCE(p."completedAt", p."fpUpdatedAt", p."fpCreatedAt", p."createdAt") AS decided_at
        FROM pre_verifications p
        WHERE p."readinessStatus" IS NOT NULL
          AND (p."userId" = b.id OR (lk."investorProfileId" IS NOT NULL AND p."investorProfileId" = lk."investorProfileId"))
        ORDER BY COALESCE(p."fpCreatedAt", p."createdAt") DESC
        LIMIT 1
      ) pv ON true
      LEFT JOIN LATERAL (
        SELECT f.* FROM kyc_forms f WHERE f."userId" = b.id ORDER BY f."createdAt" DESC LIMIT 1
      ) kf ON true
      LEFT JOIN investor_onboardings ob ON ob."investorProfileId" = lk."investorProfileId"
      LEFT JOIN LATERAL (
        SELECT a.id, a."holdingPattern" FROM mf_investment_accounts a
        WHERE a."primaryInvestorProfileId" = lk."investorProfileId"
        ORDER BY a."createdAt" ASC LIMIT 1
      ) ia ON true
      LEFT JOIN mf_folio_defaults fd ON fd."mfInvestmentAccountId" = ia.id
      LEFT JOIN bank_accounts pb ON pb.id = fd."payoutBankAccountId"
      LEFT JOIN LATERAL (
        SELECT count(*) AS n, sum(COALESCE(m."purchasedAmount", m.amount)) AS amount, max(m."createdAt") AS last_at
        FROM mf_purchases m
        WHERE m."mfInvestmentAccountId" = ia.id AND m.state = 'successful'
      ) pur ON true
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE p.state = 'active') AS active_sips,
               sum(p.amount * ${monthlyFactorSql(Prisma.sql`p.frequency`)}) FILTER (WHERE p.state = 'active') AS sip_monthly,
               min(p."nextInstallmentDate") FILTER (WHERE p.state = 'active') AS next_sip_date
        FROM mf_purchase_plans p
        WHERE p."mfInvestmentAccountId" = ia.id
      ) sp ON true
      LEFT JOIN LATERAL (
        SELECT sum(h."marketValue") AS current_value FROM mf_holdings h WHERE h."mfInvestmentAccountId" = ia.id
      ) hv ON true
    ),
    kyc AS (
      SELECT raw.*,
        CASE
          WHEN pv_ok OR kf_status = 'submitted' THEN 'COMPLETED'
          WHEN kf_status IN ('under_review', 'created', 'awaiting_esign', 'awaiting_submission') THEN 'IN_PROGRESS'
          WHEN kf_status = 'failed' THEN 'FAILED'
          WHEN kf_status = 'expired' THEN 'EXPIRED'
          WHEN pv_readiness IS NOT NULL THEN 'PAN_CHECK_FAILED'
          ELSE 'NOT_STARTED'
        END AS kyc_status,
        -- A submitted form is named first: it says we ran the KYC, even if the
        -- KRA has since registered it and the PAN check now passes too.
        CASE WHEN kf_status = 'submitted' THEN 'KYC_FORM' WHEN pv_ok THEN 'KRA' END AS kyc_via
      FROM raw
    )
    SELECT kyc.*,
      CASE
        WHEN purchases > 0 THEN 'INVESTED'
        WHEN account_ready AND pv_ok THEN 'READY_TO_INVEST'
        WHEN account_id IS NOT NULL THEN 'ACCOUNT_SETUP'
        WHEN profile_id IS NOT NULL THEN 'PROFILE'
        WHEN kyc_status = 'COMPLETED' THEN 'KYC_COMPLETED'
        WHEN kyc_status <> 'NOT_STARTED' THEN 'KYC'
        ELSE 'SIGNED_UP'
      END AS stage,
      (kyc_status = 'IN_PROGRESS' AND kf_moved_at < now() - make_interval(hours => ${KYC_STALLED_HOURS})) AS kyc_stalled,
      GREATEST("createdAt", "lastLoginAt", pv_at, kf_moved_at, kf_submitted_at, ob_updated_at, last_purchase_at) AS last_activity_at,
      -- The kyc_forms timestamp KYC was completed at, when known; for a KRA
      -- pass it is the verdict's time.
      CASE WHEN kf_status = 'submitted' THEN COALESCE(kf_submitted_at, kf_moved_at) WHEN pv_ok THEN pv_at END AS kyc_completed_at
    FROM kyc`;
}

/** The columns of an `investorFacts` row that the services read. */
export interface InvestorFactRow {
  id: string;
  fullName: string | null;
  email: string | null;
  phone: string;
  status: string;
  createdAt: Date;
  lastLoginAt: Date | null;
  profile_id: string | null;
  profile_name: string | null;
  pan: string | null;
  pv_readiness: string | null;
  kf_status: string | null;
  kf_proof_status: string | null;
  kf_signature: boolean | null;
  kf_fields_needed: string[] | null;
  account_id: string | null;
  purchases: bigint | number;
  purchased_amount: Prisma.Decimal | string | number;
  active_sips: bigint | number;
  sip_monthly: Prisma.Decimal | string | number;
  next_sip_date: Date | null;
  current_value: Prisma.Decimal | string | number;
  kyc_status: AdminKycStatus;
  kyc_via: KycCompletedVia | null;
  stage: JourneyStage;
  kyc_stalled: boolean | null;
  last_activity_at: Date;
  kyc_completed_at: Date | null;
}

/**
 * The next step of an open form, via the same `kycNextAction` the app uses.
 * Raw SQL returns FP's wire values (`awaiting_esign`); the helper speaks the
 * Prisma names (`AWAITING_ESIGN`).
 */
export function nextStepOf(row: {
  status: string | null;
  proofStatus: string | null;
  signatureProvided: boolean | null;
  fieldsNeeded: string[] | null;
}): KycNextStep | null {
  const status = row.status?.toUpperCase();
  if (!status || !["UNDER_REVIEW", "CREATED", "AWAITING_ESIGN", "AWAITING_SUBMISSION"].includes(status)) return null;
  return (
    kycNextAction({
      status,
      proofStatus: row.proofStatus?.toUpperCase() ?? null,
      signatureProvided: Boolean(row.signatureProvided),
      fieldsNeeded: row.fieldsNeeded ?? [],
    }) ?? "WAITING_ON_PROVIDER"
  );
}
