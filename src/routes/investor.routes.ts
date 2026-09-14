import { Router } from "express";
import * as investor from "../controllers/investor.controller.ts";

export const investorRouter = Router();

// Express 5 forwards rejected promises to the error handler, so no wrapper.
investorRouter.post("/profiles", investor.createProfile);
investorRouter.get("/profiles", investor.listProfiles);
investorRouter.get("/onboarding", investor.getOnboarding);
investorRouter.get("/profiles/:profileId", investor.getProfile);

// Contact details. Each is write-once at FP, so there is no update route:
// a correction means creating a new object and repointing folio defaults.
investorRouter.post("/profiles/:profileId/addresses", investor.addAddress);
investorRouter.post("/profiles/:profileId/phones", investor.addPhone);
investorRouter.post("/profiles/:profileId/emails", investor.addEmail);
investorRouter.post("/profiles/:profileId/bank-accounts", investor.addBankAccount);
investorRouter.get("/profiles/:profileId/bank-accounts", investor.listBankAccounts);
investorRouter.post("/profiles/:profileId/nominees", investor.addNominee);

// Bank account verification (penny-drop). Required before a cybrillapoa order
// can be submitted, and asynchronous, so it is started and then polled.
investorRouter.post("/bank-accounts/:bankAccountId/verify", investor.verifyBankAccount);
investorRouter.post(
  "/bank-accounts/:bankAccountId/verification/refresh",
  investor.refreshBankAccountVerification,
);

investorRouter.post("/profiles/:profileId/investment-accounts", investor.createInvestmentAccount);
investorRouter.get("/investment-accounts/:accountId", investor.getInvestmentAccount);
investorRouter.patch("/investment-accounts/:accountId/folio-defaults", investor.setFolioDefaults);
