// The FP integration's public surface.
//
// Services import from here, never from the files underneath, so the internal
// layout stays free to change.
export { fpConfig, fpPreVerifyConfig, hasPreVerifyConfig, resetFpConfig } from "./fp.config.ts";
export type { FpConfig, FpPreVerifyConfig } from "./fp.config.ts";

export {
  FpApiError,
  FpTransportError,
  isFpError,
  toHttpError as fpErrorToHttpError,
} from "./fp.errors.ts";
export type { FpError, FpFieldError } from "./fp.errors.ts";

export { getAccessToken, invalidateAccessToken } from "./fp.token.ts";
export type { FpRealm } from "./fp.token.ts";
export { fpList, fpRequest } from "./fp.http.ts";
export type { FpMethod, FpRequestOptions } from "./fp.http.ts";

export * as fpIdentity from "./resources/identity.ts";
export * as fpProfiles from "./resources/profiles.ts";
export * as fpAccounts from "./resources/accounts.ts";
export * as fpOrders from "./resources/orders.ts";
export * as fpPlans from "./resources/plans.ts";
export * as fpPayments from "./resources/payments.ts";
export * as fpCatalogue from "./resources/catalogue.ts";
export * as fpEvents from "./resources/events.ts";
export * as fpPreVerification from "./resources/preverification.ts";
export * as fpKycForms from "./resources/kyc-forms.ts";
export * as fpBankVerification from "./resources/bank-verification.ts";
export * as fpSimulation from "./resources/simulation.ts";

export type * from "./fp.types.ts";
