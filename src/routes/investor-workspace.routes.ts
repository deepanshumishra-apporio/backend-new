import { Router } from "express";
import { db } from "../db/client.ts";
import { investorId } from "../middleware/investor-auth.ts";
import { getOnboardingStatus, listProfilesForUser } from "../services/investor.service.ts";
import { getScheme } from "../services/scheme.service.ts";
import { HttpError } from "../utils/http-error.ts";

/** Authenticated mobile resume data. Explicit selects keep provider PII private. */
export const investorWorkspaceRouter = Router();
investorWorkspaceRouter.get("/workspace", async (req, res) => {
  const userId = investorId(req);
  const [profiles, onboarding, resources] = await Promise.all([
    listProfilesForUser(userId), getOnboardingStatus(userId),
    db.investorProfile.findMany({
      where: { userLinks: { some: { userId, relationship: "SELF" } } },
      select: { id: true,
        addresses: { select: { id: true, line1: true, postalCode: true } },
        phoneNumbers: { select: { id: true, number: true } },
        emailAddresses: { select: { id: true, email: true } },
        relatedParties: { select: { id: true, name: true, relationship: true } },
        primaryFor: { where: { holdingPattern: "SINGLE" }, select: { id: true } },
      },
    }),
  ]);
  res.json({ data: { profiles, onboarding, resources } });
});

investorWorkspaceRouter.get("/watchlist", async (req, res) => {
  const rows = await db.watchlistItem.findMany({ where: { userId: investorId(req) },
    select: { scheme: { select: { isin: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
  res.json({ data: await Promise.all(rows.map(row => getScheme(row.scheme.isin))) });
});
investorWorkspaceRouter.put("/watchlist/:isin", async (req, res) => {
  const isin = req.params.isin.toUpperCase();
  if (!/^INF[A-Z0-9]{9}$/.test(isin)) throw HttpError.badRequest("Invalid ISIN");
  const scheme = await db.mfScheme.findUnique({ where: { isin }, select: { id: true } });
  if (!scheme) throw HttpError.notFound("Scheme not found");
  const userId = investorId(req);
  await db.watchlistItem.upsert({ where: { userId_schemeId: { userId, schemeId: scheme.id } },
    create: { userId, schemeId: scheme.id }, update: {} });
  res.json({ data: { isin, saved: true } });
});
investorWorkspaceRouter.delete("/watchlist/:isin", async (req, res) => {
  await db.watchlistItem.deleteMany({ where: { userId: investorId(req), scheme: { isin: req.params.isin } } });
  res.json({ data: { saved: false } });
});
