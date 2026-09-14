import { Router } from "express";
import * as kyc from "../controllers/kyc.controller.ts";
import { db } from "../db/client.ts";
import { fpKycForms, fpErrorToHttpError } from "../integrations/fp/index.ts";
import { syncKycForm } from "../services/fp-sync/kyc.sync.ts";
import { getForm } from "../services/kyc.service.ts";
import { HttpError } from "../utils/http-error.ts";

export const kycRouter = Router();

// Step 1 of the journey: can this PAN transact at all?
kycRouter.post("/readiness", kyc.checkReadiness);
kycRouter.get("/readiness/:preVerificationId", kyc.getReadiness);

// Step 2, only when readiness says no: the digital KYC form.
kycRouter.post("/forms", kyc.startForm);

kycRouter.get("/forms", kyc.listForms);

kycRouter.get("/forms/:formId", kyc.getForm);

kycRouter.patch("/forms/:formId", kyc.updateForm);

kycRouter.post("/forms/:formId/signature", async (req, res) => {

  const bytes: unknown = req.body;

  const mime = req.get("content-type")?.split(";")[0];

  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || !["image/png", "image/jpeg", "application/pdf"].includes(mime ?? "")) throw HttpError.badRequest("Send a PNG, JPEG or PDF signature as the binary request body");
  const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 : bytes.subarray(0, 5).toString() === "%PDF-";
  if (!valid) throw HttpError.badRequest("Signature content does not match Content-Type");
  const form = await db.kycForm.findUniqueOrThrow({ where: { id: req.params.formId } });
  if (form.status !== "CREATED") throw HttpError.conflict("KYC form is not open for signature upload");
  try {
    const result = await fpKycForms.uploadSignature(
      form.fpId, 
      new Blob([new Uint8Array(bytes)], 
      { 
        type: mime
      }), 
      `signature.${mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "pdf"}`);

    await syncKycForm(result, { 
      userId: form.userId, 
      investorProfileId: form.investorProfileId 
    });

    res.json({ data: await getForm(form.id) });

  } catch (error) { fpErrorToHttpError(error); }
});
// No webhooks exist for KYC forms on the partner realm, so the client polls.
kycRouter.post("/forms/:formId/refresh", kyc.refreshForm);
kycRouter.post("/forms/:formId/retry-proof", kyc.retryProofFetch);
