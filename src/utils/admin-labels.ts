// Display labels for the admin portal's derived statuses. Pure.
import type { AdminKycStatus, JourneyStage, KycNextStep } from "../types/admin-investor.types.ts";

export const KYC_STATUS_LABELS: Record<AdminKycStatus, string> = {
  NOT_STARTED: "Not started",
  PAN_CHECK_FAILED: "PAN check not passed",
  IN_PROGRESS: "In progress",
  FAILED: "Failed",
  EXPIRED: "Expired",
  COMPLETED: "Completed",
};

export const JOURNEY_STAGE_LABELS: Record<JourneyStage, string> = {
  SIGNED_UP: "Signed up",
  KYC: "KYC pending",
  KYC_COMPLETED: "KYC completed",
  PROFILE: "Profile created",
  ACCOUNT_SETUP: "Account setup",
  READY_TO_INVEST: "Ready to invest",
  INVESTED: "Invested",
};

export const KYC_NEXT_STEP_LABELS: Record<KycNextStep, string> = {
  PROVIDE_DETAILS: "Filling details",
  FETCH_PROOF: "Aadhaar (DigiLocker)",
  UPLOAD_SIGNATURE: "Signature",
  ESIGN: "e-Sign",
  WAITING_ON_PROVIDER: "Waiting on KRA / provider",
};

/** SCREAMING_SNAKE or snake_case → "Title case". */
export const humanise = (value: string) => {
  const text = value.toLowerCase().replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};
