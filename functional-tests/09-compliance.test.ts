// FT-CMP: compliance alerts — a condition in the data raises a stored alert,
// staff actions on it are recorded with who did what, and the alert closes by
// itself once the condition clears.
//
// The condition used is a failed KYC. A real one needs the KRA to reject an
// investor, which cannot be triggered on demand, so the investor's admin
// snapshot (the read model the KYC rules scan) is set to FAILED directly.
// Everything after that — the scan, the alert, the audit trail, staff actions
// and auto-resolution — runs for real over HTTP.
import { beforeAll, describe, expect, test } from "bun:test";
import { expectError, expectStatus, signIn, type Client } from "./lib.ts";
import { onboardStaff } from "./staff.ts";

const { db } = await import("../src/db/client.ts");
const { runProjection } = await import("../src/services/admin-projection.service.ts");

let officer: Client;
let investor: Client;
let alertId: string;

async function scan(): Promise<{ raised: number; autoResolved: number; mode: string }> {
  const reply = await officer.post("/api/v1/admin/compliance/scan", {}, { idem: false });
  expectStatus(reply, 200);
  return reply.body.data;
}

async function alertsFor(userId: string): Promise<Array<{ id: string; kind: string; status: string; investor: { id: string } | null }>> {
  const reply = await officer.get("/api/v1/admin/compliance/alerts?limit=100&status=OPEN,ACKNOWLEDGED,RESOLVED,DISMISSED");
  expectStatus(reply, 200);
  return reply.body.data.items.filter((item: { investor: { id: string } | null }) => item.investor?.id === userId);
}

beforeAll(async () => {
  officer = await onboardStaff("SUPER_ADMIN");
  investor = await signIn();
  // The real projection builds this investor's snapshot from their real rows.
  await runProjection({ forceFull: true });
});

describe("FT-CMP compliance alerts are real and recorded", () => {
  test("FT-CMP-01 a clean investor raises no alert", async () => {
    await scan();
    expect(await alertsFor(investor.userId!)).toEqual([]);
  });

  test("FT-CMP-02 a failed KYC raises a stored alert with a DETECTED event", async () => {
    await db.investorJourneySnapshot.update({ where: { userId: investor.userId! }, data: { kycStatus: "FAILED" } });
    const run = await scan();
    expect(run.mode).toBe("ran");
    expect(run.raised).toBeGreaterThanOrEqual(1);

    const alerts = await alertsFor(investor.userId!);
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.kind).toBe("KYC_FAILED");
    expect(alerts[0]!.status).toBe("OPEN");
    alertId = alerts[0]!.id;

    const detail = await officer.get(`/api/v1/admin/compliance/alerts/${alertId}`);
    expectStatus(detail, 200);
    expect(detail.body.data.events.map((e: { type: string }) => e.type)).toEqual(["DETECTED"]);
  });

  test("FT-CMP-03 scanning again does not duplicate the alert", async () => {
    const run = await scan();
    expect(run.raised).toBe(0);
    expect((await alertsFor(investor.userId!)).length).toBe(1);
  });

  test("FT-CMP-04 staff actions are recorded with the staff member and their note", async () => {
    expectStatus(await officer.post(`/api/v1/admin/compliance/alerts/${alertId}/actions`, { type: "acknowledge" }, { idem: false }), 200);
    const noted = await officer.post(`/api/v1/admin/compliance/alerts/${alertId}/actions`, { type: "note", note: "Called the investor; redoing KYC." }, { idem: false });
    expectStatus(noted, 200);

    const events = noted.body.data.events as Array<{ type: string; staffName: string | null; note: string | null }>;
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["DETECTED", "ACKNOWLEDGED", "NOTE"]));
    const note = events.find((e) => e.type === "NOTE")!;
    expect(note.staffName).toBe("FT SUPER_ADMIN");
    expect(note.note).toBe("Called the investor; redoing KYC.");
    expect(noted.body.data.status).toBe("ACKNOWLEDGED");
    expect(noted.body.data.assignee?.name).toBe("FT SUPER_ADMIN");
  });

  test("FT-CMP-05 closing an alert requires a written reason", async () => {
    expectError(await officer.post(`/api/v1/admin/compliance/alerts/${alertId}/actions`, { type: "resolve" }, { idem: false }), 400);
  });

  test("FT-CMP-06 the alert resolves itself once the condition clears, and says so", async () => {
    await db.investorJourneySnapshot.update({ where: { userId: investor.userId! }, data: { kycStatus: "NOT_STARTED" } });
    const run = await scan();
    expect(run.autoResolved).toBeGreaterThanOrEqual(1);

    const detail = await officer.get(`/api/v1/admin/compliance/alerts/${alertId}`);
    expect(detail.body.data.status).toBe("RESOLVED");
    expect(detail.body.data.autoResolved).toBe(true);
    expect(detail.body.data.events.at(-1).type).toBe("AUTO_RESOLVED");
  });

  test("FT-CMP-07 staff without compliance.manage cannot see or act on alerts", async () => {
    const support = await onboardStaff("SUPPORT");
    expectError(await support.get("/api/v1/admin/compliance/alerts"), 403, "FORBIDDEN");
    expectError(await support.post(`/api/v1/admin/compliance/alerts/${alertId}/actions`, { type: "note", note: "x" }, { idem: false }), 403, "FORBIDDEN");
  });
});

// --- the rules added for full coverage -----------------------------------------
//
// The mirror rows below are what the FP sync would have written for an investor
// who has been transacting for a while. They are written directly because these
// conditions (a payout that never arrived, a refund nobody started, a KRA
// verdict changing) cannot be produced on demand in the FP sandbox. The `ft_`
// FP ids exist only in this throwaway database.
describe("FT-CMP coverage rules raise the right alerts", () => {
  const ISIN = "INF109K01605";
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  const ref = () => `ft_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  let subject: Client;
  let ids: { profile: string; account: string; bigPurchase: string; redemption: string; failedPurchase: string; ticket: string };

  async function kindsFor(userId: string): Promise<Map<string, { id: string; status: string; severity: string }>> {
    const reply = await officer.get("/api/v1/admin/compliance/alerts?limit=100&status=OPEN,ACKNOWLEDGED,RESOLVED,DISMISSED");
    expectStatus(reply, 200);
    const mine = reply.body.data.items.filter((item: { investor: { id: string } | null }) => item.investor?.id === userId);
    return new Map(mine.map((item: { kind: string; id: string; status: string; severity: string }) => [item.kind, item]));
  }

  beforeAll(async () => {
    subject = await signIn();
    const pan = `ABCP${"FGHJK"[Math.floor(Math.random() * 5)]}${Math.floor(1000 + Math.random() * 8999)}Z`;
    const profile = await db.investorProfile.create({ data: { fpId: ref(), pan, pepDetails: "PEP_EXPOSED" }, select: { id: true } });
    await db.userInvestorProfile.create({ data: { userId: subject.userId!, investorProfileId: profile.id, relationship: "SELF" } });
    const account = await db.mfInvestmentAccount.create({ data: { fpId: ref(), primaryInvestorProfileId: profile.id }, select: { id: true } });
    // Holds units, with no folio defaults: no payout bank, no email or mobile.
    await db.mfHolding.create({ data: { mfInvestmentAccountId: account.id, folioNumber: "FT1001", schemeIsin: ISIN, units: "120.5", marketValue: "250000" } });
    // ₹20 lakh purchase that went through with no 2FA consent on record.
    const bigPurchase = await db.mfPurchase.create({ data: {
      fpId: ref(), mfInvestmentAccountId: account.id, schemeIsin: ISIN, amount: "2000000", state: "SUCCESSFUL",
      succeededAt: ago(10), createdAt: ago(10), fpCreatedAt: ago(10), consentAt: null,
    }, select: { id: true } });
    // Redeemed 7 days ago, 3 days after buying, and never paid out.
    const redemption = await db.mfRedemption.create({ data: {
      fpId: ref(), mfInvestmentAccountId: account.id, schemeIsin: ISIN, amount: "5000", state: "SUCCESSFUL",
      succeededAt: ago(7), createdAt: ago(7), fpCreatedAt: ago(7), consentAt: ago(7),
    }, select: { id: true } });
    // Paid for, then failed four days ago, with no refund.
    const failedPurchase = await db.mfPurchase.create({ data: {
      fpId: ref(), mfInvestmentAccountId: account.id, schemeIsin: ISIN, amount: "7500", state: "FAILED", consentAt: ago(5),
    }, select: { id: true } });
    const payment = await db.payment.create({ data: { fpId: Math.floor(Math.random() * 1e9), paymentType: "NETBANKING", amount: "7500", status: "SUCCESS" }, select: { id: true } });
    await db.paymentPurchase.create({ data: { paymentId: payment.id, mfPurchaseId: failedPurchase.id } });
    await db.$executeRaw`UPDATE mf_purchases SET "updatedAt" = ${ago(4)} WHERE id = ${failedPurchase.id}::uuid`;
    // The KRA's latest verdict on this PAN no longer passes.
    await db.preVerification.create({ data: { fpId: ref(), status: "completed", investorIdentifier: pan, readinessStatus: "kyc_on_hold", userId: subject.userId!, fpCreatedAt: ago(1) } });
    // A complaint raised 22 days ago and still open.
    const ticket = await subject.post("/api/v1/support/tickets", { subject: "Redemption money not received", category: "REDEMPTION", body: "It has been over a week." });
    expectStatus(ticket, 201);
    await db.supportTicket.update({ where: { id: ticket.body.data.id }, data: { createdAt: ago(22), slaDueAt: ago(20) } });
    // An FP webhook that has sat unprocessed for two hours.
    await db.fpWebhookEvent.create({ data: { fpEventId: `evt_${ref()}`, type: "mf_purchase.updated", payload: {}, receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    ids = { profile: profile.id, account: account.id, bigPurchase: bigPurchase.id, redemption: redemption.id, failedPurchase: failedPurchase.id, ticket: ticket.body.data.id };
    await scan();
  });

  test.each([
    ["REDEMPTION_PAYOUT_PENDING", "HIGH"],
    ["REFUND_PENDING", "HIGH"],
    ["CONSENT_MISSING", "HIGH"],
    ["KYC_NOT_COMPLIANT", "HIGH"],
    ["PEP_INVESTOR", "MEDIUM"],
    ["LARGE_TRANSACTION", "MEDIUM"],
    ["RAPID_ROUND_TRIP", "LOW"],
    ["COMPLAINT_OVERDUE", "HIGH"],
    ["PAYOUT_BANK_UNVERIFIED", "MEDIUM"],
    ["CONTACT_MISSING", "MEDIUM"],
  ])("FT-CMP-1x %s is raised (%s)", async (kind, severity) => {
    const alert = (await kindsFor(subject.userId!)).get(kind);
    expect(alert).toBeDefined();
    expect(alert!.status).toBe("OPEN");
    expect(alert!.severity).toBe(severity);
  });

  test("FT-CMP-20 stalled monitoring raises an alert with no investor", async () => {
    const reply = await officer.get("/api/v1/admin/compliance/alerts?limit=100&kind=MONITORING_STALE");
    expectStatus(reply, 200);
    const titles = reply.body.data.items.map((item: { title: string }) => item.title);
    expect(titles).toContain("FP updates are not being processed");
  });

  test("FT-CMP-21 fixing the data clears the alert by itself", async () => {
    await db.mfPayoutDetail.create({ data: { mfRedemptionId: ids.redemption, utrNumber: "UTR123456789", paidAt: ago(1) } });
    await scan();
    expect((await kindsFor(subject.userId!)).get("REDEMPTION_PAYOUT_PENDING")!.status).toBe("RESOLVED");
  });

  test("FT-CMP-22 a review alert stays open even when its condition goes away", async () => {
    await db.investorProfile.update({ where: { id: ids.profile }, data: { pepDetails: "NOT_APPLICABLE" } });
    await scan();
    expect((await kindsFor(subject.userId!)).get("PEP_INVESTOR")!.status).toBe("OPEN");
  });

  test("FT-CMP-23 a reviewed alert closed by staff is not reopened by the next scan", async () => {
    const large = (await kindsFor(subject.userId!)).get("LARGE_TRANSACTION")!;
    expectStatus(await officer.post(`/api/v1/admin/compliance/alerts/${large.id}/actions`, { type: "resolve", note: "Matches declared income; salary bonus." }, { idem: false }), 200);
    await db.$executeRaw`UPDATE compliance_alerts SET "resolvedAt" = ${ago(30)} WHERE id = ${large.id}::uuid`;
    await scan();
    expect((await kindsFor(subject.userId!)).get("LARGE_TRANSACTION")!.status).toBe("RESOLVED");
  });

  test("FT-CMP-25 the compliance report and its CSV export name the new alert types properly", async () => {
    const preview = await officer.get("/api/v1/admin/reports/compliance?limit=500");
    expectStatus(preview, 200);
    const kinds = new Set(preview.body.data.rows.map((row: { kind: string }) => row.kind));
    for (const name of ["Politically exposed person", "2FA consent missing", "Redemption not paid out", "Refund pending", "Large transaction", "Complaint overdue"]) {
      expect(kinds.has(name)).toBe(true);
    }
    const csv = await officer.get("/api/v1/admin/reports/compliance/export");
    expectStatus(csv, 200);
    expect(String(csv.body)).toContain("Politically exposed person");
  });

  test("FT-CMP-24 the investor can be reminded about things only they can fix", async () => {
    const contact = (await kindsFor(subject.userId!)).get("CONTACT_MISSING")!;
    expectStatus(await officer.post(`/api/v1/admin/compliance/alerts/${contact.id}/actions`, { type: "remind" }, { idem: false }), 200);
    const refund = (await kindsFor(subject.userId!)).get("REFUND_PENDING")!;
    expectError(await officer.post(`/api/v1/admin/compliance/alerts/${refund.id}/actions`, { type: "remind" }, { idem: false }), 400);
  });
});
