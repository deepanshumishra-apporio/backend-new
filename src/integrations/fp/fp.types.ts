// Wire types for FP payloads.
//
// These mirror what FP actually sends, NOT what our database stores: snake_case
// keys, numbers for money, ISO-with-offset strings for timestamps, and `null`
// for everything not yet known. Translation into our enums and Decimals happens
// in the sync layer, which is the only place allowed to know both shapes.
//
// Nullability here is FP's, and it is broad on purpose. An order has no
// `allotted_units` until the AMC processes it, and pretending otherwise would
// push an impossible state into the type system.

/** Every FP object carries a discriminating `object` field. */
export interface FpObject {
  object: string;
  id: string;
}

export interface FpPhone {
  isd: string;
  number: string;
}

export interface FpAddressHash {
  line1: string;
  line2: string | null;
  line3: string | null;
  city: string | null;
  state: string | null;
  postal_code: string;
  country: string;
}

/** 2FA consent captured before an order reaches the RTA. */
export interface FpConsent {
  email?: string | null;
  isd_code?: string | null;
  mobile?: string | null;
  otp?: string | null;
}

/**
 * A pause on a plan: installments dated between `from_date` and `to_date`
 * (inclusive) are generated and marked cancelled.
 *
 * States are upper-case on the wire (`PENDING`, `ACTIVE`, `COMPLETED`,
 * `CANCELLED`, `CANCELLATION_REQUESTED`, `FAILED`) although the reference
 * documents them lower-case; compare case-insensitively. The counts arrive as
 * numeric strings.
 */
export interface FpPlanSkipInstruction {
  object: "plan_skip_instruction";
  id: string;
  plan: string;
  state: string;
  remaining_installments: string | number;
  skipped_installments: string | number;
  created_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
  from_date: string;
  to_date: string | null;
}

/**
 * A change to an active plan — its amount or its mandate, never both. ONDC
 * only; it applies to installments not yet scheduled.
 */
export interface FpPlanModificationInstruction {
  object: "mf_plan_modification_instruction";
  id: string;
  plan: string;
  /** `created`, then `completed` or `failed`. */
  state: string;
  amount: { from: string; to: string } | null;
  payment_method: string | null;
  created_at: string;
  completed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
}

// ---------------------------------------------------------------------------
// KYC
// ---------------------------------------------------------------------------

export interface FpKycCheckEntityDetails {
  name?: string | null;
  gender?: string | null;
  date_of_birth?: string | null;
  father_name?: string | null;
  marital_status?: string | null;
  nationality?: string | null;
  residential_status?: string | null;
  correspondence_address?: Record<string, unknown> | null;
  permanent_address?: Record<string, unknown> | null;
  email?: string | null;
  mobile?: string | null;
}

export interface FpKycCheck {
  id: string;
  source_ref_id: string | null;
  pan: string;
  entity_details: FpKycCheckEntityDetails | null;
  /** true = KYC compliant. FP models this as a boolean, not a status enum. */
  status: boolean;
  constraints: { type: string; amount?: { value: number; currency: string } }[] | null;
  sources: { name: string; fetched_at: string }[] | null;
  created_at: string;
  updated_at: string;
  /** e.g. "modify" — what the investor must do to become compliant. */
  action: string | null;
  /** e.g. "onhold". */
  reason: string | null;
}

export type FpKycRequestStatus =
  | "pending"
  | "esign_required"
  | "submitted"
  | "successful"
  | "rejected"
  | "expired";

export interface FpKycRequest extends FpObject {
  object: "kyc_request";
  status: FpKycRequestStatus;
  name: string;
  pan: string;
  aadhaar_number: string | null;
  father_name: string | null;
  mother_name: string | null;
  spouse_name: string | null;
  gender: string | null;
  date_of_birth: string;
  marital_status: string | null;
  residential_status: string | null;
  occupation_type: string | null;
  citizenship_countries: string[] | null;
  nationality_country: string | null;
  country_of_birth: string | null;
  place_of_birth: string | null;
  income_slab: string | null;
  pep_details: string | null;
  tax_residency_other_than_india: boolean | null;
  non_indian_tax_residency_1: FpNonIndianTaxResidency | null;
  non_indian_tax_residency_2: FpNonIndianTaxResidency | null;
  non_indian_tax_residency_3: FpNonIndianTaxResidency | null;
  email: string;
  mobile: FpPhone;
  signature: string | null;
  identity_proof: string | null;
  address: { proof: string | null; proof_type: string | null } | null;
  geolocation: { latitude: number; longitude: number } | null;
  requirements: { fields_needed: string[] } | null;
  verification: {
    status: FpKycRequestStatus | null;
    details: Record<string, string> | null;
    details_verbose: Record<string, { code: string; reason: string }> | null;
  } | null;
  created_at: string;
  updated_at: string;
  /** Five days after creation. An expired request cannot be resumed. */
  expires_at: string;
  esign_required_at: string | null;
  submitted_at: string | null;
  successful_at: string | null;
  rejected_at: string | null;
}

export interface FpNonIndianTaxResidency {
  country: string;
  taxid_number: string;
}

export interface FpIdentityDocument extends FpObject {
  object: "identity_document";
  type: string;
  kyc_request: string | null;
  fetch: {
    /** DigiLocker link. Expires an hour after issue. */
    redirect_url: string | null;
    postback_url: string | null;
    status: string | null;
  } | null;
  data: {
    number: string | null;
    line_1: string | null;
    city: string | null;
    pincode: string | null;
    country: string | null;
  } | null;
  created_at: string;
}

export interface FpEsign extends FpObject {
  object: "esign";
  type: string | null;
  kyc_request: string;
  redirect_url: string | null;
  postback_url: string | null;
  status: string;
  created_at: string;
}

export interface FpFile extends FpObject {
  object: "file";
  filename: string | null;
  content_type: string | null;
  purpose: string | null;
  byte_size: number | null;
  url: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Investor profile and children
// ---------------------------------------------------------------------------

export interface FpTaxResidency {
  country: string;
  taxid_type: string;
  taxid_number: string;
  applicable_from: string | null;
  applicable_to: string | null;
}

export interface FpInvestorProfile extends FpObject {
  object: "investor_profile";
  type: string;
  tax_status: string | null;
  name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  occupation: string | null;
  pan: string | null;

  // Undocumented but real: FP returns and accepts these five, verified against
  // the sandbox. They are the KRA demographics a KYC check would have
  // prefilled, which makes them the only place to hold that data on a tenant
  // where the KYC APIs are not provisioned.
  //
  // All five are WRITE-ONCE — "father_name is already set and cannot be
  // modified" — so they must be supplied at create time or not at all.
  /** Last 4 digits only. */
  aadhaar_number: string | null;
  citizenship_countries: string[] | null;
  father_name: string | null;
  mother_name: string | null;
  marital_status: string | null;
  guardian_name: string | null;
  guardian_date_of_birth: string | null;
  guardian_pan: string | null;
  signature: string | null;
  country_of_birth: string | null;
  place_of_birth: string | null;
  first_tax_residency: FpTaxResidency | null;
  second_tax_residency: FpTaxResidency | null;
  third_tax_residency: FpTaxResidency | null;
  fourth_tax_residency: FpTaxResidency | null;
  nationality_country: string | null;
  source_of_wealth: string | null;
  income_slab: string | null;
  pep_details: string | null;
  employer: string | null;
  ip_address: string | null;
  created_at: string;
}

export interface FpAddress extends FpObject {
  object: "address";
  profile: string;
  line1: string;
  line2: string | null;
  line3: string | null;
  city: string | null;
  state: string | null;
  postal_code: string;
  country: string;
  nature: string | null;
  created_at: string;
}

export interface FpPhoneNumber extends FpObject {
  object: "phone_number";
  profile: string;
  isd: string;
  number: string;
  belongs_to: string | null;
  created_at: string;
}

export interface FpEmailAddress extends FpObject {
  object: "email_address";
  profile: string;
  email: string;
  belongs_to: string | null;
  created_at: string;
}

export interface FpBankAccount extends FpObject {
  object: "bank_account";
  /** Mandates and Payments address the account by THIS, not by `id`. */
  old_id: number | null;
  profile: string;
  primary_account_holder_name: string;
  account_number: string;
  type: string;
  ifsc_code: string;
  bank_name: string | null;
  branch_name: string | null;
  branch_address: string | null;
  branch_contact_number: string | null;
  branch_city: string | null;
  branch_district: string | null;
  branch_state: string | null;
  cancelled_cheque: string | null;
  sole_proprietorship: string | null;
  created_at: string;
}

export interface FpRelatedParty extends FpObject {
  object: "related_party";
  profile: string;
  name: string;
  relationship: string;
  date_of_birth: string | null;
  pan: string | null;
  guardian_name: string | null;
  guardian_pan: string | null;
  created_at: string;
  aadhaar_number: string | null;
  passport_number: string | null;
  driving_licence_number: string | null;
  email_address: string | null;
  phone_number: FpPhone | null;
  address: FpAddressHash | null;
  guardian_aadhaar_number: string | null;
  guardian_passport_number: string | null;
  guardian_driving_licence_number: string | null;
  guardian_email_address: string | null;
  guardian_phone_number: FpPhone | null;
  guardian_address: FpAddressHash | null;
}

export interface FpDematAccount extends FpObject {
  object: "demat_account";
  profile: string;
  dp_id: string;
  client_id: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Investment account
// ---------------------------------------------------------------------------

export interface FpFolioDefaults {
  communication_email_address: string | null;
  communication_mobile_number: string | null;
  communication_address: string | null;
  overseas_communication_address: string | null;
  payout_bank_account: string | null;
  nominee1: string | null;
  nominee1_allocation_percentage: number | null;
  nominee2: string | null;
  nominee2_allocation_percentage: number | null;
  nominee3: string | null;
  nominee3_allocation_percentage: number | null;
  demat_account: string | null;
  nominee1_identity_proof_type?: string | null;
  nominee1_guardian_identity_proof_type?: string | null;
  nominee2_identity_proof_type?: string | null;
  nominee2_guardian_identity_proof_type?: string | null;
  nominee3_identity_proof_type?: string | null;
  nominee3_guardian_identity_proof_type?: string | null;
  nominations_info_visibility?: string | null;
}

export interface FpInvestmentAccount extends FpObject {
  object: "mf_investment_account";
  /** The holdings report addresses the account by this integer. */
  old_id: number | null;
  primary_investor_pan: string | null;
  second_investor_pan: string | null;
  third_investor_pan: string | null;
  primary_investor: string | null;
  second_investor: string | null;
  third_investor: string | null;
  holding_pattern: string;
  folio_defaults: FpFolioDefaults | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type FpOrderState =
  | "under_review"
  | "pending"
  | "confirmed"
  | "submitted"
  | "successful"
  | "failed"
  | "cancelled"
  | "reversed";

/** Fields every order type shares. */
interface FpOrderBase extends FpObject {
  /** The Payments API takes this as an `amc_order_ids` entry. */
  old_id: number | null;
  mf_investment_account: string;
  folio_number: string | null;
  state: FpOrderState;
  scheme?: string;
  gateway: string;
  plan: string | null;
  traded_on: string | null;
  scheduled_on: string | null;
  created_at: string;
  confirmed_at: string | null;
  submitted_at: string | null;
  succeeded_at: string | null;
  failed_at: string | null;
  reversed_at: string | null;
  cancelled_at: string | null;
  source_ref_id: string | null;
  user_ip: string | null;
  server_ip: string | null;
  euin: string | null;
  partner: string | null;
  failure_code: string | null;
  initiated_by: string | null;
  initiated_via: string | null;
}

export interface FpPurchase extends FpOrderBase {
  object: "mf_purchase";
  scheme: string;
  type: string | null;
  amount: number;
  allotted_units: number | null;
  purchased_amount: number | null;
  purchased_price: number | null;
  allotted_nav_date?: string | null;
  retried_at: string | null;
}

export interface FpRedemption extends FpOrderBase {
  object: "mf_redemption";
  scheme: string;
  /** Amount OR units. Both null means "redeem the whole holding". */
  amount: number | null;
  units: number | null;
  redeemed_amount: number | null;
  redeemed_units: number | null;
  redeemed_price: number | null;
  redeemed_nav_date: string | null;
  redemption_mode: string | null;
  redemption_bank_account_number: string | null;
  redemption_bank_account_ifsc_code: string | null;
}

export interface FpSwitch extends FpOrderBase {
  object: "mf_switch";
  switch_out_scheme: string;
  switch_in_scheme: string;
  amount: number | null;
  units: number | null;
  switched_out_units: number | null;
  switched_out_amount: number | null;
  switched_out_price: number | null;
  switched_in_units: number | null;
  switched_in_amount: number | null;
  switched_in_price: number | null;
}

// ---------------------------------------------------------------------------
// Transaction plans
// ---------------------------------------------------------------------------

export type FpPlanState =
  | "created"
  | "review_completed"
  | "confirmed"
  | "submitted"
  | "active"
  | "cancelled"
  | "completed"
  | "failed";

interface FpPlanBase extends FpObject {
  old_id?: number | null;
  mf_investment_account: string;
  folio_number: string | null;
  /** true registers a real SIP/SWP/STP; false is a scheduled series of lumpsums. */
  systematic: boolean;
  frequency: string;
  installment_day: number | null;
  requested_activation_date: string | null;
  number_of_installments: number;
  remaining_installments: number | null;
  start_date: string | null;
  end_date: string | null;
  next_installment_date: string | null;
  previous_installment_date: string | null;
  state: FpPlanState;
  auto_generate_installments?: boolean;
  gateway: string;
  source_ref_id: string | null;
  partner: string | null;
  euin: string | null;
  user_ip: string | null;
  server_ip: string | null;
  initiated_by: string | null;
  initiated_via: string | null;
  created_at: string;
  activated_at: string | null;
  cancelled_at: string | null;
  cancellation_scheduled_on: string | null;
  cancellation_code: string | null;
  auto_cancelled?: boolean | null;
  failed_at: string | null;
  completed_at: string | null;
  reason: string | null;
  consent: FpConsent | null;
}

export interface FpPurchasePlan extends FpPlanBase {
  object: "mf_purchase_plan";
  scheme: string;
  amount: number;
  payment_method: string | null;
  /** The mandate id, as a string, when payment_method is "mandate". */
  payment_source: string | null;
  purpose: string | null;
}

export interface FpRedemptionPlan extends FpPlanBase {
  object: "mf_redemption_plan";
  scheme: string;
  amount: number | null;
  units: number | null;
}

export interface FpSwitchPlan extends FpPlanBase {
  object: "mf_switch_plan";
  switch_out_scheme: string;
  switch_in_scheme: string;
  amount: number | null;
  units: number | null;
}

// ---------------------------------------------------------------------------
// Payout
// ---------------------------------------------------------------------------
//
// `mf_settlement_detail` is deliberately absent: it describes money collected
// outside FP, which is an RTA-route concept. ONDC collects through FP's own
// Payments API, and the transport blocks writes to that path.

export interface FpPayoutDetail extends FpObject {
  object: "mf_payout_detail";
  mf_redemption: string;
  amount: number | null;
  beneficiary_bank_account_number: string | null;
  beneficiary_bank_ifsc: string | null;
  beneficiary_bank_account_title: string | null;
  payout_processed_at: string | null;
  created_at: string;
  bank_rrn: string | null;
  utr_number: string | null;
}

// ---------------------------------------------------------------------------
// Mandates and payments (/api/pg — integer ids, upper-case enums)
// ---------------------------------------------------------------------------

export interface FpMandate {
  id: number;
  bank_account_id: number;
  mandate_ref: string | null;
  mandate_token: string | null;
  valid_from: string | null;
  valid_to?: string | null;
  mandate_limit: number;
  mandate_type: string;
  mandate_status: string;
  umrn: string | null;
  created_at: string;
  received_at: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  rejected_reason: string | null;
  provider_id: number | null;
  provider_name: string | null;
}

/** Create returns only the id; fetch the mandate to see the rest. */
export interface FpMandateCreated {
  id: number;
}

export interface FpMandateAuth {
  id: number;
  /** Provider page the investor must complete. Short-lived. */
  token_url: string;
}

export interface FpPayment {
  id: number;
  from_bank_account_id: number | null;
  mandate_id?: number | null;
  payment_type: string;
  status: string;
  amount: number;
  method: string | null;
  debit_date: string | null;
  amc_order_ids: number[];
  failure_code: string | null;
  failed_reason: string | null;
  created_at: string;
  submitted_at: string | null;
  debit_confirmed_at: string | null;
  failed_at: string | null;
  rejected_at?: string | null;
  transfer_initiated_at: string | null;
  settled_at: string | null;
  provider_name: string | null;
  late_auth?: boolean | null;
  refund_reference?: string | null;
  refund_reason?: string | null;
  refund_status?: string | null;
  refund_created_at?: string | null;
}

export interface FpPaymentCreated {
  id: number;
  /** Present for netbanking/UPI redirects, absent for mandate debits. */
  token_url?: string;
  sdk_options?: Record<string, unknown>;
  mandate_id?: number;
  amount?: number;
  amc_order_ids?: number[];
}

/** The /api/pg list endpoints use a Spring-style page envelope, not FP's list. */
export interface FpPage<T> {
  first: boolean;
  last: boolean;
  total_pages: number;
  total_elements: number;
  size: number;
  number: number;
  number_of_elements: number;
  mandates?: T[];
  payments?: T[];
}

// ---------------------------------------------------------------------------
// Folios and holdings
// ---------------------------------------------------------------------------

export interface FpFolioNominee {
  name: string | null;
  dob: string | null;
  relationship: string | null;
  guardian: string | null;
  guardian_relationship: string | null;
}

export interface FpFolioPayoutDetail {
  scheme: string;
  scheme_code: string | null;
  bank_account: {
    name: string | null;
    number: string | null;
    account_type: string | null;
    ifsc: string | null;
  } | null;
}

export interface FpFolio {
  object: "mf_folio";
  id?: string;
  amc: string | null;
  number: string;
  dp_id: string | null;
  client_id: string | null;
  primary_investor_pan: string | null;
  secondary_investor_pan: string | null;
  third_investor_pan: string | null;
  holding_pattern: string | null;
  primary_investor_name: string | null;
  secondary_investor_name: string | null;
  third_investor_name: string | null;
  primary_investor_dob: string | null;
  secondary_investor_dob: string | null;
  third_investor_dob: string | null;
  primary_investor_gender: string | null;
  secondary_investor_gender: string | null;
  third_investor_gender: string | null;
  primary_investor_tax_status: string | null;
  primary_investor_occupation: string | null;
  guardian_name: string | null;
  guardian_gender: string | null;
  guardian_pan: string | null;
  guardian_dob: string | null;
  guardian_relationship: string | null;
  nominee1: FpFolioNominee | null;
  nominee1_allocation_percentage: number | string | null;
  nominee2: FpFolioNominee | null;
  nominee2_allocation_percentage: number | string | null;
  nominee3: FpFolioNominee | null;
  nominee3_allocation_percentage: number | string | null;
  payout_details: FpFolioPayoutDetail[] | null;
  email_addresses: string[] | null;
  mobile_numbers: string[] | null;
  annexure?: Record<string, string> | null;
}

/** A figure plus the date it is as of — FP dates each one separately. */
interface FpAsOnAmount {
  as_on: string | null;
  amount: number | null;
  redeemable_amount?: number | null;
}

export interface FpHoldingScheme {
  isin: string;
  name: string | null;
  type: string | null;
  holdings: { as_on: string | null; units: number | null; redeemable_units: number | null } | null;
  market_value: FpAsOnAmount | null;
  invested_value: FpAsOnAmount | null;
  payout: FpAsOnAmount | null;
  nav: { as_on: string | null; value: number | null } | null;
}

export interface FpHoldingsReport {
  id: number | string;
  folios: { folio_number: string; schemes: FpHoldingScheme[] }[] | null;
}

/** Reports come back as a column/row matrix rather than objects. */
export interface FpTabularReport {
  object: "transaction_report";
  report: { type: string; standard?: { name: string; desc: string } };
  data: { columns: string[]; rows: unknown[][] };
  filter_by: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Events and webhooks
// ---------------------------------------------------------------------------

export interface FpEvent {
  object: "event";
  id: string;
  /** e.g. "mf_purchase.successful". */
  type: string;
  data: { object: Record<string, unknown>; previous_attributes: Record<string, unknown> | null };
  time: string;
}

export interface FpNotificationWebhook extends FpObject {
  object: "notification_webhook";
  event: string;
  url: string;
  status: string;
}
