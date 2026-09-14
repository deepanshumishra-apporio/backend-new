import { Router } from "express";
import * as scheme from "../controllers/scheme.controller.ts";

export const schemeRouter = Router();

// Express 5 forwards rejected promises to the error handler, so no wrapper.
// Schemes are addressed by ISIN — the identifier FP's order APIs take.
schemeRouter.get("/", scheme.list);
schemeRouter.get("/:isin", scheme.getOne);
schemeRouter.get("/:isin/nav", scheme.navHistory);
