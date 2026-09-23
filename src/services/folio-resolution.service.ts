// Which folio a new purchase or SIP goes into.
//
// A folio belongs to one investor at one AMC, not to one scheme. The first
// investment with an AMC is sent without a folio and the AMC opens one; every
// later investment with that AMC — another SIP in the same fund, a top-up, a
// different scheme of the same fund house — must carry that folio number, or
// the AMC opens a second folio for the same investor. Correcting that later is
// a manual consolidation request at the registrar.
//
// The caller is not trusted to remember. The app only sends a folio when the
// investor starts from a holding, so a SIP started from the fund's own page was
// silently opening a new folio every time. This module decides instead:
//
//   1. a folio the caller named is kept, once it is proven to be the
//      investor’s (`assertInvestmentReady`) and at this scheme’s fund house
//      (`assertFolioAtSchemeAmc`);
//   2. otherwise the account's existing non-demat folio at the scheme's AMC is
//      used — preferring one that already holds this scheme;
//   3. otherwise, if a fresh order at this AMC has been paid for and is waiting
//      for allotment, refuse: the folio does not exist yet, and sending this
//      order without one would open a duplicate. The investor retries once the
//      first order is allotted;
//   4. otherwise this really is the first investment with the AMC: no folio.
//
// Every account on this platform is an individual, single-holder account
// (`assertInvestmentReady` enforces it), so one account is one PAN, one holding
// pattern and one tax status. Matching folios within the account is therefore
// the same as matching them on those, which is what the AMC does.
import { MfOrderState, OrderGateway } from "../../generated/prisma/enums.ts";
import { db } from "../db/client.ts";
import { fpAccounts, fpErrorToHttpError } from "../integrations/fp/index.ts";
import { HttpError } from "../utils/http-error.ts";
import { syncFolio } from "./fp-sync/index.ts";

/**
 * Fresh orders whose folio is about to exist. Only states where the money has
 * already moved: an unpaid `pending` order may never be paid, and blocking on
 * it would stop the investor until it expired.
 */
const AWAITING_ALLOTMENT = [MfOrderState.CONFIRMED, MfOrderState.SUBMITTED];

export interface FolioCandidate {
  number: string;
  /** The folio already holds (or has bought) the scheme being purchased. */
  holdsScheme: boolean;
  createdAt: Date;
}

/**
 * Choose one folio among the account's folios at an AMC.
 *
 * Two folios at one AMC means a duplicate was opened in the past. Keep adding
 * to the one that already holds this scheme so the position is not split
 * further; otherwise the oldest, which is the one the AMC treats as primary.
 */
export function pickFolio(candidates: readonly FolioCandidate[]): string | undefined {
  const sorted = [...candidates].sort(
    (a, b) => Number(b.holdsScheme) - Number(a.holdsScheme) || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return sorted[0]?.number;
}

/**
 * The folio a new purchase or SIP into `isin` must carry, or undefined for the
 * first investment at that AMC. See the module header.
 */
export async function resolvePurchaseFolio(
  mfInvestmentAccountId: string,
  isin: string,
  requested?: string,
): Promise<string | undefined> {
  if (requested) {
    await assertFolioAtSchemeAmc(mfInvestmentAccountId, requested, isin);
    return requested;
  }

  const scheme = await db.mfScheme.findUnique({
    where: { isin },
    select: { amcId: true, amc: { select: { code: true } } },
  });
  // Unknown scheme: scheme validation rejects it with a proper message.
  if (!scheme) return undefined;

  let folio = await findAmcFolio(mfInvestmentAccountId, isin, scheme.amcId, scheme.amc.code);
  if (folio) return folio;

  // An order at this AMC was allotted into a folio we have not mirrored yet —
  // the folio list is only pulled on a portfolio refresh. Mirror it now rather
  // than open a second one.
  const allotted = await db.mfPurchase.findFirst({
    where: { mfInvestmentAccountId, folioNumber: { not: null }, scheme: { amcId: scheme.amcId } },
    select: { folioNumber: true },
  });
  if (allotted?.folioNumber) {
    await mirrorFolio(mfInvestmentAccountId, allotted.folioNumber);
    folio = await findAmcFolio(mfInvestmentAccountId, isin, scheme.amcId, scheme.amc.code);
    if (folio) return folio;
    throw HttpError.conflict(
      "Your folio with this fund house is still being registered. Try again in a few minutes.",
      { folioNumber: allotted.folioNumber },
    );
  }

  const awaiting = await db.mfPurchase.findFirst({
    where: {
      mfInvestmentAccountId,
      folioNumber: null,
      state: { in: AWAITING_ALLOTMENT },
      // Orders on the old `cybrillapoa` gateway are never allotted (see
      // utils/gateway.ts), so no folio is coming from them; waiting on one would
      // block the investor at this AMC indefinitely.
      gateway: { not: OrderGateway.CYBRILLAPOA },
      scheme: { amcId: scheme.amcId },
    },
    select: { id: true },
  });
  if (awaiting) {
    throw HttpError.conflict(
      "Your first investment with this fund house is still being allotted, and its folio number is not " +
        "issued yet. Place this order once it is allotted so it goes into the same folio.",
      { pendingOrderId: awaiting.id },
    );
  }

  return undefined;
}

/**
 * Refuse a folio that belongs to a different fund house than the scheme.
 *
 * A folio is one investor at one AMC, so every order on it — lumpsum, SIP,
 * redemption, switch, SWP, STP — must be for a scheme of that AMC. `assertInvestmentReady`
 * only proves the folio is the investor's; a caller naming their HDFC folio for
 * an ICICI fund passed it and met FP's refusal, or worse on a purchase, a folio
 * mix-up the registrar has to unpick.
 *
 * The folio's AMC is read from what we know about it: FP's `amc` code on the
 * folio, else the schemes it holds or has been allotted. A folio we know
 * nothing about passes through — FP is the authority, and a thin mirror must
 * not block a valid order.
 */
export async function assertFolioAtSchemeAmc(
  mfInvestmentAccountId: string,
  folioNumber: string,
  isin: string,
): Promise<void> {
  const [scheme, folio, held] = await Promise.all([
    db.mfScheme.findUnique({ where: { isin }, select: { amcId: true, amc: { select: { code: true, name: true } } } }),
    db.mfFolio.findUnique({
      where: { mfInvestmentAccountId_number: { mfInvestmentAccountId, number: folioNumber } },
      select: { amcCode: true, purchases: { select: { scheme: { select: { amcId: true } } }, take: 20 } },
    }),
    db.mfHolding.findMany({ where: { mfInvestmentAccountId, folioNumber }, select: { schemeIsin: true } }),
  ]);
  // Unknown scheme or folio: scheme validation and `assertInvestmentReady` say so.
  if (!scheme || !folio) return;

  const refuse = () => {
    throw HttpError.badRequest(
      `Folio ${folioNumber} is not with ${scheme.amc.name}. A folio belongs to one fund house, ` +
        "so orders for this fund must use your folio with that fund house.",
      { folioNumber, isin },
    );
  };

  if (folio.amcCode && scheme.amc.code) {
    if (folio.amcCode.toUpperCase() !== scheme.amc.code.toUpperCase()) refuse();
    return;
  }

  const heldAmcs = held.length
    ? await db.mfScheme.findMany({ where: { isin: { in: held.map((h) => h.schemeIsin) } }, select: { amcId: true } })
    : [];
  const knownAmcs = new Set([...folio.purchases.flatMap((p) => (p.scheme ? [p.scheme.amcId] : [])), ...heldAmcs.map((s) => s.amcId)]);
  if (knownAmcs.size > 0 && !knownAmcs.has(scheme.amcId)) refuse();
}

/** The account's existing non-demat folio at an AMC, among those mirrored. */
async function findAmcFolio(
  mfInvestmentAccountId: string,
  isin: string,
  amcId: string,
  amcCode: string | null,
): Promise<string | undefined> {
  // The AMC's schemes this account has ever held, by holdings report or order.
  // `MfHolding.schemeIsin` is not a foreign key, so it is matched by value.
  const held = await db.mfHolding.findMany({
    where: { mfInvestmentAccountId },
    select: { folioNumber: true, schemeIsin: true },
  });
  const amcIsins = new Set(
    (
      await db.mfScheme.findMany({
        where: { amcId, isin: { in: [...new Set(held.map((h) => h.schemeIsin))] } },
        select: { isin: true },
      })
    ).map((s) => s.isin),
  );
  const heldAtAmc = held.filter((h) => amcIsins.has(h.schemeIsin));

  const folios = await db.mfFolio.findMany({
    where: {
      mfInvestmentAccountId,
      // A demat position has no folio to add to; its orders go by demat account.
      dpId: null,
      OR: [
        { number: { in: heldAtAmc.map((h) => h.folioNumber) } },
        { purchases: { some: { scheme: { amcId } } } },
        ...(amcCode ? [{ amcCode }] : []),
      ],
    },
    select: { number: true, createdAt: true, purchases: { where: { schemeIsin: isin }, select: { id: true }, take: 1 } },
  });

  return pickFolio(
    folios.map((f) => ({
      number: f.number,
      createdAt: f.createdAt,
      holdsScheme: f.purchases.length > 0 || heldAtAmc.some((h) => h.folioNumber === f.number && h.schemeIsin === isin),
    })),
  );
}

/**
 * Pull one folio from FP into the mirror.
 *
 * Called when an order reports a folio number we have no row for: the consent
 * for the next order on that folio needs its registered contacts, and
 * `assertInvestmentReady` refuses a folio that is not mirrored.
 */
export async function mirrorFolio(mfInvestmentAccountId: string, folioNumber: string): Promise<void> {
  const exists = await db.mfFolio.findUnique({
    where: { mfInvestmentAccountId_number: { mfInvestmentAccountId, number: folioNumber } },
    select: { id: true },
  });
  if (exists) return;

  const account = await db.mfInvestmentAccount.findUnique({
    where: { id: mfInvestmentAccountId },
    select: { fpId: true },
  });
  if (!account) return;

  try {
    const folios = await fpAccounts.listFolios({ mf_investment_account: account.fpId, folio_number: folioNumber });
    for (const folio of folios) {
      if (folio.number === folioNumber) await syncFolio(folio, mfInvestmentAccountId);
    }
  } catch (error) {
    fpErrorToHttpError(error);
  }
}
