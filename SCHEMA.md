# Schema reference

**Generated from `prisma/schema.prisma` — do not edit by hand.** Re-run `bun run docs:schema` after any schema change.

For the diagrams and the reasoning behind this shape, see [`ARCHITECTURE.md`](ARCHITECTURE.md). The schema file itself carries the commentary explaining *why* each decision was made.

48 models, 59 enums.

## Model inventory

`fpId` marks a model mirrored from FP; the rest are ours alone.

| Model | Table | Mirrors FP | Purpose |
|---|---|---|---|
| `User` | `users` | — | A login account on our platform. |
| `UserInvestorProfile` | `user_investor_profiles` | — | Which investor profiles a login account may act on, and in what capacity. |
| `InvestorOnboarding` | `investor_onboardings` | — | Where an investor is in the onboarding journey. |
| `FpFile` | `fp_files` | yes | A file uploaded to FP (POST /files) — signature, cancelled cheque, photo. |
| `KycCheck` | `kyc_checks` | yes | POST /api/kyc/check — the investor's KYC status at the KRAs. |
| `PreVerification` | `pre_verifications` | yes | Cybrilla partner-realm POST /poa/pre_verifications. |
| `PreVerificationBankResult` | `pre_verification_bank_results` | — | One result per bank entry in the provider response, including failed checks. |
| `KycRequest` | `kyc_requests` | yes | POST /v2/kyc_requests — a digital KYC application for a non-compliant PAN. |
| `KycRequestTaxResidency` | `kyc_request_tax_residencies` | — | kyc_request.non_indian_tax_residency_1..3, normalised. |
| `KycForm` | `kyc_forms` | yes | POST /poa/kyc_forms — digital KYC on the Cybrilla POA realm. |
| `IdentityDocument` | `identity_documents` | yes | A document pulled from DigiLocker for a KYC request. |
| `Esign` | `esigns` | yes | Aadhaar e-sign on a KYC application form. |
| `InvestorProfile` | `investor_profiles` | yes | POST /v2/investor_profiles — the investor's demographic record in FP. |
| `TaxResidency` | `tax_residencies` | — | investor_profile.first_tax_residency .. |
| `Address` | `addresses` | yes | POST /v2/addresses. |
| `PhoneNumber` | `phone_numbers` | yes | POST /v2/phone_numbers. |
| `EmailAddress` | `email_addresses` | yes | POST /v2/email_addresses. |
| `BankAccount` | `bank_accounts` | yes | POST /v2/bank_accounts. |
| `RelatedParty` | `related_parties` | yes | POST /v2/related_parties — a person related to the investor, used for nominations. |
| `RelatedPartyContact` | `related_party_contacts` | — | The identity-proof and contact block of a related party, or of that party's guardian when the party is a minor. |
| `DematAccount` | `demat_accounts` | yes | POST /v2/demat_accounts. |
| `Partner` | `partners` | yes | A sub-broker an order can be attributed to (FP `ptnr_…`). |
| `MfAmc` | `mf_amcs` | — | An asset management company. |
| `MfScheme` | `mf_schemes` | — | One tradeable scheme plan, identified by ISIN. |
| `MfSchemeThreshold` | `mf_scheme_thresholds` | — | Per-frequency limits for a scheme, from FP's *_frequency_specific_data. |
| `NavHistory` | `nav_history` | — | One NAV per scheme per day. |
| `WatchlistItem` | `watchlist_items` | — | Ours, not FP's — a scheme the investor is watching. |
| `MfInvestmentAccount` | `mf_investment_accounts` | yes | POST /v2/mf_investment_accounts — the container every order and folio hangs off. |
| `MfFolioDefaults` | `mf_folio_defaults` | — | FP's `folio_defaults` hash: which of the investor's several addresses, phone numbers, emails and bank accounts to stamp onto a new folio. |
| `MfInvestmentAccountNominee` | `mf_investment_account_nominees` | — | One of the up-to-three nominees in an account's folio defaults. |
| `MfFolio` | `mf_folios` | yes | A folio at the AMC. |
| `MfFolioNominee` | `mf_folio_nominees` | — | Nominee as registered on the folio at the AMC. |
| `MfFolioSchemePayout` | `mf_folio_scheme_payouts` | — | Payout bank account configured per scheme within a folio. |
| `MfHolding` | `mf_holdings` | — | Current position per (folio, scheme), from FP's holdings report. |
| `MfPurchase` | `mf_purchases` | yes | POST /v2/mf_purchases — lumpsum purchase, or an installment of a purchase plan when `plan` is set. |
| `MfRedemption` | `mf_redemptions` | yes | POST /v2/mf_redemptions. |
| `MfSwitch` | `mf_switches` | yes | POST /v2/mf_switches — redeem from one scheme and buy into another inside the same folio. |
| `MfPurchasePlan` | `mf_purchase_plans` | yes | POST /v2/mf_purchase_plans — a SIP when `systematic`, otherwise a scheduled series of lumpsum purchases. |
| `MfRedemptionPlan` | `mf_redemption_plans` | yes | POST /v2/mf_redemption_plans — an SWP when `systematic`. |
| `MfSwitchPlan` | `mf_switch_plans` | yes | POST /v2/mf_switch_plans — an STP when `systematic`. |
| `Mandate` | `mandates` | yes | POST /api/pg/mandates — the investor's standing authorisation to debit their bank account, for SIP installments and one-off purchases. |
| `Payment` | `payments` | yes | A payment collected for one or more purchase orders — netbanking/UPI redirect, or a debit against an approved mandate. |
| `PaymentPurchase` | `payment_purchases` | — | Which purchases a payment covers. |
| `MfSettlementDetail` | `mf_settlement_details` | yes | POST /v2/mf_settlement_details — proof that the investor's money reached the AMC, for orders paid outside FP. |
| `MfPayoutDetail` | `mf_payout_details` | yes | Where the proceeds of a successful redemption were paid. |
| `PhoneVerification` | `phone_verifications` | — | One OTP challenge for one phone number. |
| `FpWebhookEvent` | `fp_webhook_events` | — | Inbox for FP webhook deliveries (POST to our notification_webhooks URL). |
| `AuditLog` | `audit_logs` | — |  |

## Models

### User

Table `users`.

A login account on our platform. Not an FP object.  Mobile first: `phone` is the credential the MSG91 OTP flow verifies, so it is required and unique. Email is optional here even though FP requires one for KYC — it is collected during onboarding, not at signup.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `phone` | VarChar(20) | UK | E.164, always normalised (+919876543210). |
| `email` | VarChar(255)? | UK |  |
| `fullName` | VarChar(150)? |  |  |
| `role` | UserRole |  |  |
| `status` | UserStatus |  |  |
| `passwordHash` | VarChar(255)? |  | Null for OTP-only accounts. Argon2id — never a reversible encoding. |
| `emailVerifiedAt` | DateTime? |  |  |
| `phoneVerifiedAt` | DateTime? |  |  |
| `lastLoginAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `deletedAt` | DateTime? |  | Soft delete: financial records reference users with onDelete: Restrict, so an investor with history can never be hard-deleted. |

Relations: `profileLinks` → UserInvestorProfile, `uploadedFiles` → FpFile, `kycChecks` → KycCheck, `kycRequests` → KycRequest, `kycForms` → KycForm, `preVerifications` → PreVerification, `watchlist` → WatchlistItem, `auditLogs` → AuditLog.

Indexes:

- `@@index([status])`
- `@@index([deletedAt])`
- `@@index([createdAt])`

### UserInvestorProfile

Table `user_investor_profiles`.

Which investor profiles a login account may act on, and in what capacity.  Many-to-many on purpose. A guardian reaches their own profile plus each minor's; a joint holder reaches a profile they do not own. Both later subdomains are then a new `relationship` value and no schema change.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `userId` | Uuid |  |  |
| `investorProfileId` | Uuid |  |  |
| `relationship` | UserProfileRelationship |  |  |
| `isPrimary` | Boolean |  | The profile this account lands on after login. |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |

Relations: `user` → User, `investorProfile` → InvestorProfile.

Indexes:

- `@@unique([userId, investorProfileId])`
- `@@index([investorProfileId])`

### InvestorOnboarding

Table `investor_onboardings`.

Where an investor is in the onboarding journey.  A denormalised cursor, kept so the app can resume a half-finished signup in one read instead of probing eight tables. The rows themselves stay the source of truth: the onboarding service advances `stage` in the SAME transaction that writes the step it completed, and a repair job can always recompute it. Never branch on `stage` for a compliance decision — read the underlying row (KycCheck.isCompliant, MandateStatus.APPROVED) for that.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `investorProfileId` | Uuid | UK |  |
| `stage` | OnboardingStage |  |  |
| `lastError` | VarChar(500)? |  | Last failure shown to the investor, so a resumed session can explain itself. Free text from us, never a raw FP payload. |
| `startedAt` | DateTime |  |  |
| `completedAt` | DateTime? |  |  |
| `updatedAt` | DateTime |  |  |

Relations: `investorProfile` → InvestorProfile.

Indexes:

- `@@index([stage])`

### FpFile

Table `fp_files`.

A file uploaded to FP (POST /files) — signature, cancelled cheque, photo.  The bytes live in FP. We keep the id and enough metadata to render a list, and `fpUrl` only because FP returns it; treat it as short-lived.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `purpose` | FilePurpose |  |  |
| `filename` | VarChar(255)? |  |  |
| `contentType` | VarChar(120)? |  |  |
| `byteSize` | Int? |  |  |
| `fpUrl` | VarChar(1000)? |  |  |
| `uploadedByUserId` | Uuid? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `uploadedBy` → User, `signatureForProfiles` → InvestorProfile, `cancelledChequeFor` → BankAccount, `signatureForKyc` → KycRequest.

Indexes:

- `@@index([purpose])`
- `@@index([uploadedByUserId])`

### KycCheck

Table `kyc_checks`.

POST /api/kyc/check — the investor's KYC status at the KRAs.  Read isCompliant together with constraints before accepting investments. A false status does not always permit digital KYC: inspect action/reason. One row per provider check; refetch updates that projection. Separate check requests retain separate rows, but this is not immutable status history.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK | FP returns a bare UUID here, not a prefixed id. |
| `pan` | VarChar(10) |  | Full PAN. Unavoidable: it is the lookup key at the KRAs and the join key against migrated folios. Encrypt at rest at the database level. |
| `dateOfBirth` | Date? |  | Present only for the "fetch KYC data" variant, which also needs a DOB. |
| `isCompliant` | Boolean |  | FP's `status`: true = KYC compliant. |
| `action` | VarChar(60)? |  | FP's `action` / `reason`, e.g. "modify" / "onhold". Free text upstream. |
| `reason` | VarChar(120)? |  |  |
| `entityDetails` | JsonB? |  | KRA demographics (name, gender, father_name, both addresses, contacts). Json because the shape varies by KRA and by variant of the call, and we only ever echo it into a prefill form — nothing queries inside it. |
| `constraints` | JsonB? |  | Investment restrictions, e.g. an investment_limit cap. |
| `sources` | JsonB? |  | Which KRAs answered, and when. |
| `sourceRefId` | VarChar(120)? |  | FP's own reference to the upstream fetch. |
| `userId` | Uuid? |  |  |
| `investorProfileId` | Uuid? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `fpUpdatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `user` → User, `investorProfile` → InvestorProfile.

Indexes:

- `@@index([pan, createdAt(sort: Desc)])`
- `@@index([userId])`
- `@@index([investorProfileId])`

### PreVerification

Table `pre_verifications`.

Cybrilla partner-realm POST /poa/pre_verifications. Separate from KycCheck: request completion, KRA readiness and PAN/bank verdicts are different facts. One row per provider request; retries create history, polling updates fpId. Use a separate database per environment/partner, as with the other FP mirrors.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `status` | VarChar(60) |  | Wire status: accepted or completed. Preserve unknown future states; only an explicitly verified verdict may grant readiness. |
| `investorIdentifier` | VarChar(10)? |  |  |
| `readinessStatus` | VarChar(60)? |  |  |
| `readinessCode` | VarChar(120)? |  |  |
| `readinessReason` | Text? |  |  |
| `readinessModification` | VarChar(120)? |  | Optional extension returned by some partner deployments. |
| `pan` | VarChar(10)? |  |  |
| `panStatus` | VarChar(60)? |  |  |
| `panCode` | VarChar(120)? |  |  |
| `panReason` | Text? |  |  |
| `name` | Text? |  |  |
| `nameStatus` | VarChar(60)? |  |  |
| `nameCode` | VarChar(120)? |  |  |
| `nameReason` | Text? |  |  |
| `dateOfBirth` | Date? |  |  |
| `dateOfBirthStatus` | VarChar(60)? |  |  |
| `dateOfBirthCode` | VarChar(120)? |  |  |
| `dateOfBirthReason` | Text? |  |  |
| `userId` | Uuid? |  | May precede profile creation. Links must come from trusted ownership context. |
| `investorProfileId` | Uuid? |  |  |
| `fpCreatedAt` | Timestamptz(3)? |  |  |
| `fpUpdatedAt` | Timestamptz(3)? |  |  |
| `completedAt` | Timestamptz(3)? |  |  |
| `createdAt` | Timestamptz(3) |  |  |
| `updatedAt` | Timestamptz(3) |  |  |
| `syncedAt` | Timestamptz(3) |  |  |

Relations: `user` → User, `investorProfile` → InvestorProfile, `bankResults` → PreVerificationBankResult.

Indexes:

- `@@index([investorIdentifier, createdAt(sort: Desc)])`
- `@@index([userId, createdAt(sort: Desc)])`
- `@@index([investorProfileId, createdAt(sort: Desc)])`
- `@@index([status, syncedAt])`

### PreVerificationBankResult

Table `pre_verification_bank_results`.

One result per bank entry in the provider response, including failed checks. Keep the checked account details even before a BankAccount exists in FP. Sensitive account data: encrypt database/backups and redact logs/API output.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `preVerificationId` | Uuid |  |  |
| `position` | Int |  | Zero-based position in bank_accounts; enforced nonnegative in migration SQL. |
| `status` | VarChar(60)? |  |  |
| `code` | VarChar(120)? |  |  |
| `reason` | Text? |  |  |
| `accountNumber` | Text |  |  |
| `ifscCode` | VarChar(11) |  |  |
| `accountType` | VarChar(60) |  | POA vocabulary includes nre_savings/nro_savings; not BankAccountType. |
| `bankAccountProofFpId` | VarChar(64)? |  | Partner-realm file reference, not a tenant-realm FpFile foreign key. |
| `manualVerificationApproved` | Boolean? |  | Request-only permission: never infer consent from a successful response. |
| `createdAt` | Timestamptz(3) |  |  |
| `updatedAt` | Timestamptz(3) |  |  |

Relations: `preVerification` → PreVerification.

Indexes:

- `@@unique([preVerificationId, position])`

### KycRequest

Table `kyc_requests`.

POST /v2/kyc_requests — a digital KYC application for a non-compliant PAN.  Lifecycle: pending -> esign_required -> submitted -> successful | rejected, with a hard 5-day expiry from creation. An expired request cannot be resumed; create a new one. `fieldsNeeded` is FP telling us what is still missing, and is what the app should drive its form off.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `status` | KycRequestStatus |  |  |
| `name` | VarChar(70) |  |  |
| `pan` | VarChar(10) |  |  |
| `dateOfBirth` | Date |  |  |
| `aadhaarLast4` | VarChar(4)? |  | Last 4 digits only — that is all FP accepts, and all we should hold. |
| `fatherName` | VarChar(70)? |  |  |
| `motherName` | VarChar(70)? |  |  |
| `spouseName` | VarChar(70)? |  |  |
| `gender` | Gender? |  |  |
| `maritalStatus` | MaritalStatus? |  |  |
| `residentialStatus` | ResidentialStatus? |  |  |
| `occupationType` | KycOccupationType? |  |  |
| `email` | VarChar(255) |  |  |
| `mobileIsd` | VarChar(4) |  |  |
| `mobileNumber` | VarChar(20) |  |  |
| `citizenshipCountries` | VarChar(2)[] |  | FP supports exactly one entry today but types it as an array. |
| `nationalityCountry` | VarChar(2)? |  |  |
| `countryOfBirth` | VarChar(2)? |  |  |
| `placeOfBirth` | VarChar(120)? |  |  |
| `incomeSlab` | IncomeSlab? |  |  |
| `pepDetails` | PepDetails? |  |  |
| `taxResidencyOtherThanIndia` | Boolean? |  | Must be declared explicitly; drives whether tax residencies are required. |
| `signatureFileId` | Uuid? |  |  |
| `identityProofId` | Uuid? |  |  |
| `addressProofId` | Uuid? |  |  |
| `addressProofType` | IdentityProofType? |  |  |
| `geoLatitude` | Decimal(9, 6)? |  | Where the investor was when they applied. Required by the KRAs. |
| `geoLongitude` | Decimal(9, 6)? |  |  |
| `fieldsNeeded` | VarChar(60)[] |  | FP's requirements.fields_needed — drive the form off this, not off a hardcoded list, because FP changes what it asks for. |
| `verificationStatus` | KycRequestStatus? |  | verification.status mirrors `status`; kept because FP sends both. |
| `verificationDetails` | JsonB? |  | verification.details_verbose: field -> { code, reason }. Json because the keys are field paths ("address.proof") chosen by FP. |
| `userId` | Uuid? |  |  |
| `investorProfileId` | Uuid? |  |  |
| `expiresAt` | DateTime |  |  |
| `esignRequiredAt` | DateTime? |  |  |
| `submittedAt` | DateTime? |  |  |
| `successfulAt` | DateTime? |  |  |
| `rejectedAt` | DateTime? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `fpUpdatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `signatureFile` → FpFile, `identityProof` → IdentityDocument, `addressProof` → IdentityDocument, `user` → User, `investorProfile` → InvestorProfile, `taxResidencies` → KycRequestTaxResidency, `esigns` → Esign, `documents` → IdentityDocument.

Indexes:

- `@@index([pan, createdAt(sort: Desc)])`
- `@@index([status])`
- `@@index([status, expiresAt])`
- `@@index([userId])`

### KycRequestTaxResidency

Table `kyc_request_tax_residencies`.

kyc_request.non_indian_tax_residency_1..3, normalised.  `slot` preserves which numbered field FP sent it in, so a PATCH can put it back where it came from.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `kycRequestId` | Uuid |  |  |
| `slot` | Int |  | 1-3. |
| `country` | VarChar(2) |  |  |
| `taxIdNumber` | VarChar(60) |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |

Relations: `kycRequest` → KycRequest.

Indexes:

- `@@unique([kycRequestId, slot])`

### KycForm

Table `kyc_forms`.

POST /poa/kyc_forms — digital KYC on the Cybrilla POA realm.  Distinct from KycRequest, which is the same idea on FP's tenant realm. They are not interchangeable: KycRequest needs the tenant to be provisioned for KYC, while this needs only the partner credentials, so on a tenant where `/v2/kyc_requests` answers "Couldn't find Tenant" this is the route that works. Both models exist because a deployment may have either, or both.  Eligibility is the usual failure and is decided from the PAN's real KYC status: FRESH needs a PAN with no KYC, MODIFY needs one already registered. The wrong choice settles to FAILED with `ineligible_for_*` in `reason`, so check a pre-verification before choosing.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `type` | KycFormType |  |  |
| `status` | KycFormStatus |  |  |
| `reason` | VarChar(120)? |  | FP's machine-readable failure cause, e.g. "ineligible_for_fresh_kyc". |
| `pan` | VarChar(10) |  |  |
| `name` | VarChar(70) |  |  |
| `dateOfBirth` | Date |  |  |
| `email` | VarChar(255)? |  |  |
| `mobileIsd` | VarChar(4)? |  |  |
| `mobileNumber` | VarChar(20)? |  |  |
| `proofFetchUrl` | VarChar(1000)? |  | DigiLocker link for the identity and address proof. Short-lived; reissue with the retry endpoint rather than storing it for long. |
| `proofStatus` | DocumentFetchStatus? |  |  |
| `proofCallbackUrl` | VarChar(1000)? |  | Where the investor returns to after DigiLocker and after esign. |
| `esignCallbackUrl` | VarChar(1000)? |  |  |
| `esignUrl` | VarChar(1000)? |  |  |
| `esignStatus` | EsignStatus? |  |  |
| `signatureProvided` | Boolean |  |  |
| `fieldsNeeded` | VarChar(60)[] |  | What FP still wants before the form can be esigned. Drive the form UI off this, not off a hardcoded list. |
| `userId` | Uuid? |  |  |
| `investorProfileId` | Uuid? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `fpUpdatedAt` | DateTime? |  |  |
| `reviewCompletedAt` | DateTime? |  |  |
| `awaitingEsignAt` | DateTime? |  |  |
| `awaitingSubmissionAt` | DateTime? |  |  |
| `submittedAt` | DateTime? |  |  |
| `failedAt` | DateTime? |  |  |
| `expiresAt` | DateTime? |  | Seven days from creation. An expired form cannot be resumed. |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `user` → User, `investorProfile` → InvestorProfile.

Indexes:

- `@@index([pan, createdAt(sort: Desc)])`
- `@@index([status])`
- `@@index([userId])`

### IdentityDocument

Table `identity_documents`.

A document pulled from DigiLocker for a KYC request.  `fetchRedirectUrl` expires an hour after issue — re-create the document rather than reusing a stale link.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `type` | IdentityDocumentType |  |  |
| `kycRequestId` | Uuid? |  |  |
| `fetchStatus` | DocumentFetchStatus |  |  |
| `fetchRedirectUrl` | VarChar(1000)? |  |  |
| `fetchPostbackUrl` | VarChar(1000)? |  |  |
| `numberLast4` | VarChar(4)? |  | Last 4 digits of the Aadhaar number, which is all FP returns. |
| `line1` | VarChar(255)? |  |  |
| `city` | VarChar(100)? |  |  |
| `pincode` | VarChar(10)? |  |  |
| `country` | VarChar(2)? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `kycRequest` → KycRequest, `identityProofFor` → KycRequest, `addressProofFor` → KycRequest.

Indexes:

- `@@index([kycRequestId])`
- `@@index([fetchStatus])`

### Esign

Table `esigns`.

Aadhaar e-sign on a KYC application form.  Several esigns can exist for one request: `redirectUrl` may be reused, but a fresh esign is the safe answer to an abandoned attempt.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `kycRequestId` | Uuid |  |  |
| `type` | VarChar(30)? |  |  |
| `status` | EsignStatus |  |  |
| `redirectUrl` | VarChar(1000)? |  |  |
| `postbackUrl` | VarChar(1000)? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `kycRequest` → KycRequest.

Indexes:

- `@@index([kycRequestId])`
- `@@index([status])`

### InvestorProfile

Table `investor_profiles`.

POST /v2/investor_profiles — the investor's demographic record in FP.  PAN is indexed but NOT unique: FP lists profiles by PAN, so one PAN can carry several profiles (an individual and, later, the same person as guardian on a minor's profile). Several fields are write-once in FP — `taxStatus`, `dateOfBirth`, `pan`, `countryOfBirth` — and the service layer must refuse to PATCH them rather than let FP reject the call.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `type` | InvestorProfileType |  |  |
| `taxStatus` | TaxStatus? |  |  |
| `name` | VarChar(70)? |  |  |
| `dateOfBirth` | Date? |  |  |
| `gender` | Gender? |  |  |
| `maritalStatus` | MaritalStatus? |  |  |
| `occupation` | Occupation? |  |  |
| `pan` | VarChar(10)? |  | Full PAN — required by FP and the folio join key. See KycCheck.pan. |
| `aadhaarLast4` | VarChar(4)? |  | Last 4 digits only, which is all FP holds. |
| `fatherName` | VarChar(70)? |  |  |
| `motherName` | VarChar(70)? |  |  |
| `citizenshipCountries` | VarChar(2)[] |  |  |
| `guardianName` | VarChar(80)? |  |  |
| `guardianDateOfBirth` | Date? |  |  |
| `guardianPan` | VarChar(10)? |  |  |
| `countryOfBirth` | VarChar(2)? |  | ANSI 2-letter country codes throughout. |
| `placeOfBirth` | VarChar(120)? |  |  |
| `nationalityCountry` | VarChar(2)? |  |  |
| `sourceOfWealth` | SourceOfWealth? |  | For a minor this holds the GUARDIAN's source of wealth and income slab, per FP's rule for the minor tax statuses. |
| `incomeSlab` | IncomeSlab? |  |  |
| `pepDetails` | PepDetails? |  |  |
| `signatureFileId` | Uuid? |  |  |
| `employerProfileId` | Uuid? |  | FP beta: the investor profile id of the investor's employer. |
| `ipAddress` | VarChar(45)? |  | IP the profile was created from. FP stores it for audit; so do we. |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `signatureFile` → FpFile, `employerProfile` → InvestorProfile, `employees` → InvestorProfile, `onboarding` → InvestorOnboarding, `userLinks` → UserInvestorProfile, `taxResidencies` → TaxResidency, `addresses` → Address, `phoneNumbers` → PhoneNumber, `emailAddresses` → EmailAddress, `bankAccounts` → BankAccount, `relatedParties` → RelatedParty, `dematAccounts` → DematAccount, `kycChecks` → KycCheck, `kycRequests` → KycRequest, `kycForms` → KycForm, `preVerifications` → PreVerification, `primaryFor` → MfInvestmentAccount, `secondFor` → MfInvestmentAccount, `thirdFor` → MfInvestmentAccount.

Indexes:

- `@@index([pan])`
- `@@index([type])`
- `@@index([createdAt])`

### TaxResidency

Table `tax_residencies`.

investor_profile.first_tax_residency .. fourth_tax_residency, normalised.  At least one is mandatory to submit FATCA, whatever the tax status. FP can default slot 1 to India + PAN via `use_default_tax_residences`, which is an input flag only and so has no column here.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `investorProfileId` | Uuid |  |  |
| `slot` | Int |  | 1-4, matching FP's first_/second_/third_/fourth_ fields. |
| `country` | VarChar(2) |  |  |
| `taxIdType` | TaxIdType |  |  |
| `taxIdNumber` | VarChar(60) |  |  |
| `applicableFrom` | Date? |  | FP takes 2099-12-31 for "no end date known". |
| `applicableTo` | Date? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |

Relations: `investorProfile` → InvestorProfile.

Indexes:

- `@@unique([investorProfileId, slot])`

### Address

Table `addresses`.

POST /v2/addresses. Write-once in FP: every field is immutable once set, so a correction means a new address object.  For country = IN, FP derives city and state from the postal code.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `investorProfileId` | Uuid |  |  |
| `line1` | VarChar(255) |  |  |
| `line2` | VarChar(255)? |  |  |
| `line3` | VarChar(255)? |  |  |
| `city` | VarChar(100)? |  |  |
| `state` | VarChar(100)? |  |  |
| `postalCode` | VarChar(10) |  |  |
| `country` | VarChar(2) |  |  |
| `nature` | AddressNature? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `investorProfile` → InvestorProfile, `communicationFor` → MfFolioDefaults, `overseasCommunicationFor` → MfFolioDefaults.

Indexes:

- `@@index([investorProfileId])`

### PhoneNumber

Table `phone_numbers`.

POST /v2/phone_numbers. Write-once in FP apart from `belongsTo`.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `investorProfileId` | Uuid |  |  |
| `isd` | VarChar(4) |  | ISD code, with or without a leading "+". Max 4 chars including the sign. |
| `number` | VarChar(20) |  |  |
| `belongsTo` | ContactBelongsTo? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `investorProfile` → InvestorProfile, `communicationFor` → MfFolioDefaults.

Indexes:

- `@@index([investorProfileId])`

### EmailAddress

Table `email_addresses`.

POST /v2/email_addresses. Write-once in FP apart from `belongsTo`.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `investorProfileId` | Uuid |  |  |
| `email` | VarChar(255) |  |  |
| `belongsTo` | ContactBelongsTo? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `investorProfile` → InvestorProfile, `communicationFor` → MfFolioDefaults.

Indexes:

- `@@index([investorProfileId])`

### BankAccount

Table `bank_accounts`.

POST /v2/bank_accounts.  The full account number is deliberately NOT stored. FP validates and holds it; downstream (Mandates, Payments) addresses the account by `fpOldId`. We keep the last four digits to render it and a fingerprint to answer "is this account already linked?" without holding the number itself.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `fpOldId` | Int? | UK | FP's numeric id. Mandates and Payments accept only this — not `fpId`. |
| `investorProfileId` | Uuid |  |  |
| `primaryAccountHolderName` | VarChar(150) |  |  |
| `accountNumberLast4` | VarChar(4) |  |  |
| `accountNumberFingerprint` | VarChar(64) |  | SHA-256 of the normalised account number + IFSC. Lets us dedupe and recognise a re-entered account without persisting the number. |
| `type` | BankAccountType |  |  |
| `ifscCode` | VarChar(11) |  |  |
| `bankName` | VarChar(150)? |  |  |
| `branchName` | VarChar(150)? |  |  |
| `branchAddress` | VarChar(300)? |  |  |
| `branchCity` | VarChar(100)? |  |  |
| `branchDistrict` | VarChar(100)? |  |  |
| `branchState` | VarChar(100)? |  |  |
| `branchContactNumber` | VarChar(30)? |  |  |
| `cancelledChequeFileId` | Uuid? |  |  |
| `verificationFpId` | VarChar(64)? | UK | FP's `bav_…` id, when a verification has been requested. |
| `verificationStatus` | BavStatus? |  |  |
| `verificationConfidence` | BavConfidence? |  | How sure FP is the account belongs to this investor. Only VERY_HIGH and HIGH should be treated as usable. |
| `verificationReason` | VarChar(60)? |  |  |
| `verifiedAt` | DateTime? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `investorProfile` → InvestorProfile, `cancelledChequeFile` → FpFile, `mandates` → Mandate, `payments` → Payment, `payoutFor` → MfFolioDefaults.

Indexes:

- `@@unique([investorProfileId, accountNumberFingerprint])`
- `@@index([investorProfileId])`

### RelatedParty

Table `related_parties`.

POST /v2/related_parties — a person related to the investor, used for nominations. Write-once in FP: a non-mandatory field can be added later but never changed afterwards.  A nominee only becomes a nominee when referenced from MfInvestmentAccountNominee; this record just describes the person.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `investorProfileId` | Uuid |  |  |
| `name` | VarChar(40) |  |  |
| `relationship` | RelatedPartyRelationship |  |  |
| `dateOfBirth` | Date? |  |  |
| `pan` | VarChar(10)? |  | FP accepts a PAN only if the party is 18 or older. |
| `guardianName` | VarChar(35)? |  | Guardian identity, required when the party is a minor. Their contact details live in RelatedPartyContact with subject = GUARDIAN. |
| `guardianPan` | VarChar(10)? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `investorProfile` → InvestorProfile, `contacts` → RelatedPartyContact, `nomineeFor` → MfInvestmentAccountNominee.

Indexes:

- `@@index([investorProfileId])`

### RelatedPartyContact

Table `related_party_contacts`.

The identity-proof and contact block of a related party, or of that party's guardian when the party is a minor.  FP repeats the same six fields twice on related_party, once bare and once `guardian_`-prefixed. One table keyed by `subject` models both without duplicating a dozen columns, and makes the minor case a row rather than a migration. FP requires at least one identity proof here before a new folio can be created.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `relatedPartyId` | Uuid |  |  |
| `subject` | RelatedPartyContactSubject |  |  |
| `aadhaarLast4` | VarChar(4)? |  | Last 4 digits only — all FP accepts. |
| `passportNumber` | VarChar(30)? |  |  |
| `drivingLicenceNumber` | VarChar(30)? |  |  |
| `emailAddress` | VarChar(255)? |  |  |
| `phoneIsd` | VarChar(4)? |  |  |
| `phoneNumber` | VarChar(20)? |  |  |
| `line1` | VarChar(255)? |  |  |
| `line2` | VarChar(255)? |  |  |
| `line3` | VarChar(255)? |  |  |
| `city` | VarChar(100)? |  |  |
| `state` | VarChar(100)? |  |  |
| `postalCode` | VarChar(10)? |  |  |
| `country` | VarChar(2)? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |

Relations: `relatedParty` → RelatedParty.

Indexes:

- `@@unique([relatedPartyId, subject])`

### DematAccount

Table `demat_accounts`.

POST /v2/demat_accounts. FP does not create the demat account; this links an existing one so folios opened against it are held in demat mode.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `investorProfileId` | Uuid |  |  |
| `dpId` | VarChar(20) |  |  |
| `clientId` | VarChar(20) |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `investorProfile` → InvestorProfile, `folioDefaults` → MfFolioDefaults.

Indexes:

- `@@unique([investorProfileId, dpId, clientId])`
- `@@index([investorProfileId])`

### Partner

Table `partners`.

A sub-broker an order can be attributed to (FP `ptnr_…`).  Orders already carry `partnerId` and `euin`, so attribution works before the agent subdomain exists. That subdomain adds agent logins, hierarchy and commissions around this record — not inside the order tables.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `name` | VarChar(200) |  |  |
| `arn` | VarChar(20)? |  | AMFI registration number of the distributor. |
| `euin` | VarChar(10)? |  | Default EUIN for orders routed through this partner. |
| `isActive` | Boolean |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `investmentAccounts` → MfInvestmentAccount, `purchases` → MfPurchase, `redemptions` → MfRedemption, `switches` → MfSwitch, `purchasePlans` → MfPurchasePlan, `redemptionPlans` → MfRedemptionPlan, `switchPlans` → MfSwitchPlan.

Indexes:

- `@@index([isActive])`

### MfAmc

Table `mf_amcs`.

An asset management company. Synced from GET /api/oms/amcs.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpAmcId` | Int? | UK | FP's numeric AMC id, used by the fund_schemes filters. Note GET /api/oms/amcs returns it as `amc_id`, not `id` as the reference implies — verified against the sandbox. |
| `name` | VarChar(200) | UK |  |
| `code` | VarChar(20)? | UK |  |
| `logoUrl` | VarChar(500)? |  |  |
| `isActive` | Boolean |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `schemes` → MfScheme.

Indexes:

- `@@index([isActive])`

### MfScheme

Table `mf_schemes`.

One tradeable scheme plan, identified by ISIN.  ISIN is the wire identifier everywhere in FP's order APIs, which is why it carries a unique constraint and orders reference it directly. The threshold columns are not decoration: FP rejects an order whose amount falls outside them, so validate locally first and save the round trip.  One vocabulary wrinkle: the v1 catalogue (GET /api/oms/fund_schemes) shouts its enums — "EQUITY", "REGULAR", "GROWTH", "DEMAT_PHYSICAL" — while the v2 object APIs use lower case. These columns follow v2, so the catalogue sync lower-cases on ingest. That is the one place in this schema where the stored value is not byte-identical to the payload it came from.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `isin` | VarChar(12) | UK |  |
| `fpSchemeId` | Int? | UK | FP's numeric fund_scheme_id. |
| `amcId` | Uuid |  |  |
| `name` | VarChar(250) |  |  |
| `schemeCode` | VarChar(20)? |  | RTA's short code for the scheme, as it appears in folio payout details. |
| `amfiCode` | VarChar(20)? |  |  |
| `fpRtaId` | Int? |  |  |
| `category` | SchemeCategory |  |  |
| `planType` | SchemePlanType |  |  |
| `investmentOption` | SchemeInvestmentOption |  |  |
| `subCategory` | VarChar(120)? |  |  |
| `deliveryMode` | SchemeDeliveryMode? |  |  |
| `isActive` | Boolean |  |  |
| `closeEnded` | Boolean |  |  |
| `lockIn` | Boolean |  | FP reports lock-in as a flag plus a period; keep both. |
| `lockInPeriodDays` | Int? |  |  |
| `longTermPeriodDays` | Int? |  |  |
| `purchaseAllowed` | Boolean |  |  |
| `redemptionAllowed` | Boolean |  |  |
| `instantRedemptionAllowed` | Boolean |  |  |
| `switchInAllowed` | Boolean |  |  |
| `switchOutAllowed` | Boolean |  |  |
| `sipAllowed` | Boolean |  |  |
| `swpAllowed` | Boolean |  |  |
| `stpInAllowed` | Boolean |  |  |
| `stpOutAllowed` | Boolean |  |  |
| `minInitialInvestment` | Decimal(18, 2)? |  |  |
| `maxInitialInvestment` | Decimal(18, 2)? |  |  |
| `initialInvestmentMultiples` | Decimal(18, 2)? |  |  |
| `minAdditionalInvestment` | Decimal(18, 2)? |  |  |
| `maxAdditionalInvestment` | Decimal(18, 2)? |  |  |
| `additionalInvestmentMultiples` | Decimal(18, 2)? |  |  |
| `minWithdrawalAmount` | Decimal(18, 4)? |  |  |
| `maxWithdrawalAmount` | Decimal(18, 2)? |  |  |
| `withdrawalMultiples` | Decimal(18, 4)? |  |  |
| `minWithdrawalUnits` | Decimal(18, 4)? |  |  |
| `maxWithdrawalUnits` | Decimal(18, 4)? |  |  |
| `withdrawalUnitMultiples` | Decimal(18, 4)? |  |  |
| `minInstantWithdrawalAmount` | Decimal(18, 4)? |  | Instant redemption limits, set only where insta_redemption_allowed. |
| `instantWithdrawalMultiples` | Decimal(18, 4)? |  |  |
| `minSwitchInAmount` | Decimal(18, 4)? |  |  |
| `maxSwitchInAmount` | Decimal(18, 2)? |  |  |
| `switchInAmountMultiples` | Decimal(18, 4)? |  |  |
| `minSwitchOutAmount` | Decimal(18, 4)? |  |  |
| `maxSwitchOutAmount` | Decimal(18, 2)? |  |  |
| `switchOutAmountMultiples` | Decimal(18, 4)? |  |  |
| `minSwitchOutUnits` | Decimal(18, 4)? |  |  |
| `maxSwitchOutUnits` | Decimal(18, 4)? |  |  |
| `switchOutUnitMultiples` | Decimal(18, 4)? |  |  |
| `merged` | Boolean |  |  |
| `mergedToIsin` | VarChar(12)? |  |  |
| `mergerDate` | Date? |  |  |
| `expenseRatio` | Decimal(6, 4)? |  |  |
| `exitLoadPct` | Decimal(6, 4)? |  |  |
| `latestNav` | Decimal(12, 4)? |  | Denormalised copy of the newest NavHistory row, so a scheme list does not need a correlated subquery per row. NavHistory stays the source of truth. |
| `latestNavDate` | Date? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `amc` → MfAmc, `navHistory` → NavHistory, `thresholds` → MfSchemeThreshold, `watchlistedBy` → WatchlistItem, `purchases` → MfPurchase, `redemptions` → MfRedemption, `switchesOut` → MfSwitch, `switchesIn` → MfSwitch, `purchasePlans` → MfPurchasePlan, `redemptionPlans` → MfRedemptionPlan, `switchPlansOut` → MfSwitchPlan, `switchPlansIn` → MfSwitchPlan.

Indexes:

- `@@index([amcId])`
- `@@index([category, isActive])`
- `@@index([planType, investmentOption])`
- `@@index([isActive, sipAllowed])`

### MfSchemeThreshold

Table `mf_scheme_thresholds`.

Per-frequency limits for a scheme, from FP's *_frequency_specific_data.  A separate table because the limits are a matrix — SIP monthly and SIP quarterly have different minimums and different permitted dates — and flattening it into MfScheme would mean a column per combination.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `schemeId` | Uuid |  |  |
| `type` | SchemeThresholdType |  |  |
| `frequency` | SchemeThresholdFrequency |  | NOT_APPLICABLE for the one-off types (LUMPSUM, ADDITIONAL, WITHDRAWAL, SWITCH_IN, SWITCH_OUT); a real cadence for SIP, SWP and STP. |
| `amountMin` | Decimal(18, 2)? |  |  |
| `amountMax` | Decimal(18, 2)? |  |  |
| `amountMultiples` | Decimal(18, 2)? |  |  |
| `unitsMin` | Decimal(18, 4)? |  |  |
| `unitsMax` | Decimal(18, 4)? |  |  |
| `unitsMultiples` | Decimal(18, 4)? |  |  |
| `installmentsMin` | Int? |  |  |
| `allowedDates` | Int[] |  | Days of the month the AMC permits an installment on. Empty for DAILY. |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `scheme` → MfScheme.

Indexes:

- `@@unique([schemeId, type, frequency])`

### NavHistory

Table `nav_history`.

One NAV per scheme per day. The source of truth behind MfScheme.latestNav.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `schemeId` | Uuid |  |  |
| `navDate` | Date |  |  |
| `nav` | Decimal(12, 4) |  |  |
| `createdAt` | DateTime |  |  |

Relations: `scheme` → MfScheme.

Indexes:

- `@@unique([schemeId, navDate])`
- `@@index([navDate])`

### WatchlistItem

Table `watchlist_items`.

Ours, not FP's — a scheme the investor is watching.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `userId` | Uuid |  |  |
| `schemeId` | Uuid |  |  |
| `createdAt` | DateTime |  |  |

Relations: `user` → User, `scheme` → MfScheme.

Indexes:

- `@@unique([userId, schemeId])`
- `@@index([userId])`

### MfInvestmentAccount

Table `mf_investment_accounts`.

POST /v2/mf_investment_accounts — the container every order and folio hangs off. No investment account, no orders.  Holders are three explicit slots because that is how FP models them, and because the RTAs group folios by (PANs, holding pattern). Only the primary is set today; second and third are the joint subdomain, already typed.  `fpOldId` is not decoration — the holdings report addresses the account by that integer.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `fpOldId` | Int? | UK |  |
| `primaryInvestorProfileId` | Uuid |  |  |
| `secondInvestorProfileId` | Uuid? |  |  |
| `thirdInvestorProfileId` | Uuid? |  |  |
| `primaryInvestorPan` | VarChar(10)? |  | Denormalised from FP's response. Kept because folio migration matches on PAN before any profile exists to point at. |
| `secondInvestorPan` | VarChar(10)? |  |  |
| `thirdInvestorPan` | VarChar(10)? |  |  |
| `holdingPattern` | HoldingPattern |  |  |
| `servicingPartnerId` | Uuid? |  | Agent subdomain: which distributor services this account. |
| `fpCreatedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `primaryInvestorProfile` → InvestorProfile, `secondInvestorProfile` → InvestorProfile, `thirdInvestorProfile` → InvestorProfile, `servicingPartner` → Partner, `folioDefaults` → MfFolioDefaults, `nominees` → MfInvestmentAccountNominee, `folios` → MfFolio, `holdings` → MfHolding, `purchases` → MfPurchase, `redemptions` → MfRedemption, `switches` → MfSwitch, `purchasePlans` → MfPurchasePlan, `redemptionPlans` → MfRedemptionPlan, `switchPlans` → MfSwitchPlan.

Indexes:

- `@@index([primaryInvestorProfileId])`
- `@@index([primaryInvestorPan])`
- `@@index([holdingPattern])`

### MfFolioDefaults

Table `mf_folio_defaults`.

FP's `folio_defaults` hash: which of the investor's several addresses, phone numbers, emails and bank accounts to stamp onto a new folio.  A 1:1 table rather than fifteen columns on the account, because that is the shape FP sends and because these defaults must be set before the first order — a distinct row makes "not configured yet" unambiguous.  FP only honours folio defaults when the account was created from an investor profile id, not from a legacy investor id.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `mfInvestmentAccountId` | Uuid | UK |  |
| `communicationEmailAddressId` | Uuid? |  |  |
| `communicationPhoneNumberId` | Uuid? |  |  |
| `communicationAddressId` | Uuid? |  |  |
| `overseasCommunicationAddressId` | Uuid? |  |  |
| `payoutBankAccountId` | Uuid? |  | Where redemption proceeds and dividends land. |
| `dematAccountId` | Uuid? |  | Set this and new folios are held in demat mode; leave it null for physical mode. |
| `nominationsInfoVisibility` | NominationsInfoVisibility? |  | Whether the statement of account shows nominee names or just the status. |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfInvestmentAccount` → MfInvestmentAccount, `communicationEmailAddress` → EmailAddress, `communicationPhoneNumber` → PhoneNumber, `communicationAddress` → Address, `overseasCommunicationAddress` → Address, `payoutBankAccount` → BankAccount, `dematAccount` → DematAccount.

### MfInvestmentAccountNominee

Table `mf_investment_account_nominees`.

One of the up-to-three nominees in an account's folio defaults.  A row per slot instead of nominee1_*, nominee2_*, nominee3_* columns: the allocation percentages have to sum to 100, which is a query over rows, not a comparison of columns. FP requires a proof type for an adult nominee and a guardian proof type for a minor one; the matching number lives on the related party.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `mfInvestmentAccountId` | Uuid |  |  |
| `slot` | Int |  | 1-3, matching FP's nominee1 / nominee2 / nominee3. |
| `relatedPartyId` | Uuid |  |  |
| `allocationPercentage` | Decimal(5, 2) |  |  |
| `identityProofType` | IdentityProofType? |  |  |
| `guardianIdentityProofType` | IdentityProofType? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfInvestmentAccount` → MfInvestmentAccount, `relatedParty` → RelatedParty.

Indexes:

- `@@unique([mfInvestmentAccountId, slot])`
- `@@unique([mfInvestmentAccountId, relatedPartyId])`

### MfFolio

Table `mf_folios`.

A folio at the AMC. Read-only from our side: folios are created by the AMC when a fresh purchase succeeds, or arrive through FP's folio migration of RTA reporting files.  The holder columns are flattened copies of what the RTA reports, not pointers into our profile tables — a migrated folio can name a holder we have no profile for.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64)? | UK |  |
| `number` | VarChar(30) |  |  |
| `amcCode` | VarChar(20)? |  | FP's AMC code as reported on the folio. |
| `mfInvestmentAccountId` | Uuid |  |  |
| `holdingPattern` | HoldingPattern? |  |  |
| `dpId` | VarChar(20)? |  |  |
| `clientId` | VarChar(20)? |  |  |
| `primaryInvestorName` | VarChar(150)? |  |  |
| `primaryInvestorPan` | VarChar(10)? |  |  |
| `primaryInvestorDob` | Date? |  |  |
| `primaryInvestorGender` | VarChar(20)? |  |  |
| `secondaryInvestorName` | VarChar(150)? |  |  |
| `secondaryInvestorPan` | VarChar(10)? |  |  |
| `secondaryInvestorDob` | Date? |  |  |
| `secondaryInvestorGender` | VarChar(20)? |  |  |
| `thirdInvestorName` | VarChar(150)? |  |  |
| `thirdInvestorPan` | VarChar(10)? |  |  |
| `thirdInvestorDob` | Date? |  |  |
| `thirdInvestorGender` | VarChar(20)? |  |  |
| `primaryInvestorTaxStatus` | VarChar(60)? |  | The RTA's own tax-status and occupation vocabularies differ from the investor-profile enums (it reports "individual", "on_behalf_of_minor"), so these stay strings rather than being force-fitted. |
| `primaryInvestorOccupation` | VarChar(60)? |  |  |
| `guardianName` | VarChar(150)? |  |  |
| `guardianPan` | VarChar(10)? |  |  |
| `guardianDob` | Date? |  |  |
| `guardianGender` | VarChar(20)? |  |  |
| `guardianRelationship` | VarChar(60)? |  |  |
| `emailAddresses` | VarChar(255)[] |  | Contacts registered against the folio at the AMC. These decide where the 2FA consent OTP for an order on this folio must be sent. |
| `mobileNumbers` | VarChar(20)[] |  |  |
| `annexure` | JsonB? |  | FP lets us stash up to 5 key/value pairs against a folio. |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfInvestmentAccount` → MfInvestmentAccount, `nominees` → MfFolioNominee, `payoutDetails` → MfFolioSchemePayout, `holdings` → MfHolding, `purchases` → MfPurchase, `redemptions` → MfRedemption, `switches` → MfSwitch.

Indexes:

- `@@unique([mfInvestmentAccountId, number])`
- `@@index([number])`
- `@@index([primaryInvestorPan])`

### MfFolioNominee

Table `mf_folio_nominees`.

Nominee as registered on the folio at the AMC.  Distinct from MfInvestmentAccountNominee: that is what we asked for, this is what the AMC recorded. Comparing the two is how nomination mismatches get found.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `mfFolioId` | Uuid |  |  |
| `slot` | Int |  | 1-3. |
| `name` | VarChar(150)? |  |  |
| `dateOfBirth` | Date? |  |  |
| `relationship` | VarChar(60)? |  |  |
| `guardianName` | VarChar(150)? |  |  |
| `guardianRelationship` | VarChar(60)? |  |  |
| `allocationPercentage` | Decimal(5, 2)? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfFolio` → MfFolio.

Indexes:

- `@@unique([mfFolioId, slot])`

### MfFolioSchemePayout

Table `mf_folio_scheme_payouts`.

Payout bank account configured per scheme within a folio.  `schemeIsin` is intentionally not a foreign key: a migrated folio can hold a scheme the catalogue sync has not reached yet, and dropping the payout row would be worse than lacking the constraint. Join on MfScheme.isin.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `mfFolioId` | Uuid |  |  |
| `schemeIsin` | VarChar(12) |  |  |
| `schemeCode` | VarChar(20)? |  |  |
| `bankAccountName` | VarChar(150)? |  |  |
| `bankAccountNumberMasked` | VarChar(40)? |  | As reported by the RTA — already masked at source ("SB 8132"). |
| `bankAccountType` | BankAccountType? |  |  |
| `bankIfsc` | VarChar(11)? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfFolio` → MfFolio.

Indexes:

- `@@unique([mfFolioId, schemeIsin])`
- `@@index([schemeIsin])`

### MfHolding

Table `mf_holdings`.

Current position per (folio, scheme), from FP's holdings report.  A projection, not a ledger: FP recomputes it from RTA feeds and we overwrite it wholesale. Never derive units by adding up our own order rows — allotment happens at the AMC, after stamp duty, and only the report is authoritative. Every figure carries its own as-on date because units, market value and NAV are as of different days.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `mfInvestmentAccountId` | Uuid |  |  |
| `mfFolioId` | Uuid? |  |  |
| `folioNumber` | VarChar(30) |  |  |
| `schemeIsin` | VarChar(12) |  | Not a foreign key, for the same reason as MfFolioSchemePayout.schemeIsin. |
| `schemeName` | VarChar(250)? |  |  |
| `units` | Decimal(18, 4) |  |  |
| `redeemableUnits` | Decimal(18, 4)? |  | Units free of lock-in and pending orders — what can actually be redeemed. |
| `unitsAsOn` | Date? |  |  |
| `marketValue` | Decimal(18, 2)? |  |  |
| `redeemableMarketValue` | Decimal(18, 2)? |  |  |
| `marketValueAsOn` | Date? |  |  |
| `investedValue` | Decimal(18, 2)? |  |  |
| `investedValueAsOn` | Date? |  |  |
| `payoutAmount` | Decimal(18, 2)? |  | Dividends already paid out on this position. |
| `payoutAsOn` | Date? |  |  |
| `nav` | Decimal(12, 4)? |  |  |
| `navAsOn` | Date? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfInvestmentAccount` → MfInvestmentAccount, `mfFolio` → MfFolio.

Indexes:

- `@@unique([mfInvestmentAccountId, folioNumber, schemeIsin])`
- `@@index([mfInvestmentAccountId])`
- `@@index([schemeIsin])`

### MfPurchase

Table `mf_purchases`.

POST /v2/mf_purchases — lumpsum purchase, or an installment of a purchase plan when `plan` is set.  RTA flow: created PENDING -> 2FA consent captured -> payment (or a reported settlement) -> CONFIRMED -> submitted to the RTA. `allottedUnits`, `purchasedAmount` and `purchasedPrice` stay null until the order succeeds: units are allotted at the applicable cut-off NAV, net of stamp duty.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `fpOldId` | Int? | UK | The Payments API takes this integer as an `amc_order_ids` entry. |
| `mfInvestmentAccountId` | Uuid |  |  |
| `schemeIsin` | VarChar(12) |  |  |
| `folioNumber` | VarChar(30)? |  | Null on a fresh purchase until the AMC creates the folio. |
| `mfFolioId` | Uuid? |  |  |
| `planId` | Uuid? |  |  |
| `type` | MfPurchaseType? |  |  |
| `state` | MfOrderState |  |  |
| `gateway` | OrderGateway |  |  |
| `amount` | Decimal(18, 2) |  |  |
| `allottedUnits` | Decimal(18, 4)? |  |  |
| `purchasedAmount` | Decimal(18, 2)? |  |  |
| `purchasedPrice` | Decimal(12, 4)? |  |  |
| `allottedNavDate` | Date? |  |  |
| `sourceRefId` | VarChar(64)? | UK | Our idempotency key, unique across all order types in FP. |
| `userIp` | VarChar(45)? |  | IP of the investor's device, and of our server. Both are reported to the RTA, so they are audit data, not diagnostics. |
| `serverIp` | VarChar(45)? |  |  |
| `euin` | VarChar(10)? |  |  |
| `partnerId` | Uuid? |  |  |
| `initiatedBy` | OrderInitiatedBy? |  |  |
| `initiatedVia` | OrderInitiatedVia? |  |  |
| `consentEmail` | VarChar(255)? |  | SEBI-mandated 2FA. The OTP goes to the contact registered on the folio, or to the account's folio defaults for a fresh purchase, and is verified through PhoneVerification before these are sent to FP. Write-once. |
| `consentIsdCode` | VarChar(4)? |  |  |
| `consentMobile` | VarChar(20)? |  |  |
| `consentAt` | DateTime? |  |  |
| `failureCode` | VarChar(60)? |  | FP's codes: payment_failure, order_expiry, order_failure_at_gateway, … |
| `failureReason` | VarChar(500)? |  |  |
| `scheduledOn` | Date? |  | The day the order goes to the gateway. Order expiry counts from here. |
| `tradedOn` | Date? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `confirmedAt` | DateTime? |  |  |
| `submittedAt` | DateTime? |  |  |
| `succeededAt` | DateTime? |  |  |
| `failedAt` | DateTime? |  |  |
| `retriedAt` | DateTime? |  |  |
| `reversedAt` | DateTime? |  |  |
| `cancelledAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfInvestmentAccount` → MfInvestmentAccount, `scheme` → MfScheme, `mfFolio` → MfFolio, `plan` → MfPurchasePlan, `partner` → Partner, `settlementDetail` → MfSettlementDetail, `payments` → PaymentPurchase.

Indexes:

- `@@index([mfInvestmentAccountId, fpCreatedAt(sort: Desc)])`
- `@@index([state, scheduledOn])`
- `@@index([schemeIsin])`
- `@@index([planId])`
- `@@index([folioNumber])`

### MfRedemption

Table `mf_redemptions`.

POST /v2/mf_redemptions.  Exactly one of `amount` and `units` is set. Both null is meaningful and not a bug: it redeems the entire holding.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `fpOldId` | Int? | UK |  |
| `mfInvestmentAccountId` | Uuid |  |  |
| `schemeIsin` | VarChar(12) |  |  |
| `folioNumber` | VarChar(30)? |  |  |
| `mfFolioId` | Uuid? |  |  |
| `planId` | Uuid? |  |  |
| `state` | MfOrderState |  |  |
| `gateway` | OrderGateway |  |  |
| `redemptionMode` | RedemptionMode |  |  |
| `amount` | Decimal(18, 2)? |  | Requested amount, or requested units — never both, possibly neither. |
| `units` | Decimal(18, 4)? |  |  |
| `redeemedAmount` | Decimal(18, 2)? |  |  |
| `redeemedUnits` | Decimal(18, 4)? |  |  |
| `redeemedPrice` | Decimal(12, 4)? |  |  |
| `redeemedNavDate` | Date? |  |  |
| `redemptionBankAccountNumber` | VarChar(20)? |  | Populated for INSTANT redemptions only; normal proceeds follow the folio's payout mandate. |
| `redemptionBankAccountIfsc` | VarChar(11)? |  |  |
| `sourceRefId` | VarChar(64)? | UK |  |
| `userIp` | VarChar(45)? |  |  |
| `serverIp` | VarChar(45)? |  |  |
| `euin` | VarChar(10)? |  |  |
| `partnerId` | Uuid? |  |  |
| `initiatedBy` | OrderInitiatedBy? |  |  |
| `initiatedVia` | OrderInitiatedVia? |  |  |
| `consentEmail` | VarChar(255)? |  |  |
| `consentIsdCode` | VarChar(4)? |  |  |
| `consentMobile` | VarChar(20)? |  |  |
| `consentAt` | DateTime? |  |  |
| `failureCode` | VarChar(60)? |  |  |
| `failureReason` | VarChar(500)? |  |  |
| `scheduledOn` | Date? |  |  |
| `tradedOn` | Date? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `confirmedAt` | DateTime? |  |  |
| `submittedAt` | DateTime? |  |  |
| `succeededAt` | DateTime? |  |  |
| `failedAt` | DateTime? |  |  |
| `reversedAt` | DateTime? |  |  |
| `cancelledAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfInvestmentAccount` → MfInvestmentAccount, `scheme` → MfScheme, `mfFolio` → MfFolio, `plan` → MfRedemptionPlan, `partner` → Partner, `payoutDetail` → MfPayoutDetail.

Indexes:

- `@@index([mfInvestmentAccountId, fpCreatedAt(sort: Desc)])`
- `@@index([state, scheduledOn])`
- `@@index([schemeIsin])`
- `@@index([planId])`
- `@@index([folioNumber])`

### MfSwitch

Table `mf_switches`.

POST /v2/mf_switches — redeem from one scheme and buy into another inside the same folio. Both legs are reported, at their own NAVs.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `fpOldId` | Int? | UK |  |
| `mfInvestmentAccountId` | Uuid |  |  |
| `switchOutSchemeIsin` | VarChar(12) |  |  |
| `switchInSchemeIsin` | VarChar(12) |  |  |
| `folioNumber` | VarChar(30)? |  |  |
| `mfFolioId` | Uuid? |  |  |
| `planId` | Uuid? |  |  |
| `state` | MfOrderState |  |  |
| `gateway` | OrderGateway |  |  |
| `amount` | Decimal(18, 2)? |  | Requested switch-out amount, or units — never both. |
| `units` | Decimal(18, 4)? |  |  |
| `switchedOutUnits` | Decimal(18, 4)? |  |  |
| `switchedOutAmount` | Decimal(18, 2)? |  |  |
| `switchedOutPrice` | Decimal(12, 4)? |  |  |
| `switchedInUnits` | Decimal(18, 4)? |  |  |
| `switchedInAmount` | Decimal(18, 2)? |  |  |
| `switchedInPrice` | Decimal(12, 4)? |  |  |
| `sourceRefId` | VarChar(64)? | UK |  |
| `userIp` | VarChar(45)? |  |  |
| `serverIp` | VarChar(45)? |  |  |
| `euin` | VarChar(10)? |  |  |
| `partnerId` | Uuid? |  |  |
| `initiatedBy` | OrderInitiatedBy? |  |  |
| `initiatedVia` | OrderInitiatedVia? |  |  |
| `consentEmail` | VarChar(255)? |  |  |
| `consentIsdCode` | VarChar(4)? |  |  |
| `consentMobile` | VarChar(20)? |  |  |
| `consentAt` | DateTime? |  |  |
| `failureCode` | VarChar(60)? |  |  |
| `failureReason` | VarChar(500)? |  |  |
| `scheduledOn` | Date? |  |  |
| `tradedOn` | Date? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `confirmedAt` | DateTime? |  |  |
| `submittedAt` | DateTime? |  |  |
| `succeededAt` | DateTime? |  |  |
| `failedAt` | DateTime? |  |  |
| `reversedAt` | DateTime? |  |  |
| `cancelledAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfInvestmentAccount` → MfInvestmentAccount, `switchOutScheme` → MfScheme, `switchInScheme` → MfScheme, `mfFolio` → MfFolio, `plan` → MfSwitchPlan, `partner` → Partner.

Indexes:

- `@@index([mfInvestmentAccountId, fpCreatedAt(sort: Desc)])`
- `@@index([state, scheduledOn])`
- `@@index([switchOutSchemeIsin])`
- `@@index([switchInSchemeIsin])`
- `@@index([planId])`

### MfPurchasePlan

Table `mf_purchase_plans`.

POST /v2/mf_purchase_plans — a SIP when `systematic`, otherwise a scheduled series of lumpsum purchases.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `fpOldId` | Int? | UK |  |
| `mfInvestmentAccountId` | Uuid |  |  |
| `schemeIsin` | VarChar(12) |  |  |
| `folioNumber` | VarChar(30)? |  |  |
| `amount` | Decimal(18, 2) |  |  |
| `systematic` | Boolean |  |  |
| `frequency` | PlanFrequency |  |  |
| `installmentDay` | Int? |  | Null for DAILY. 1-5 for the weekly/fortnightly cadences, 1-28 otherwise. |
| `numberOfInstallments` | Int |  |  |
| `remainingInstallments` | Int? |  |  |
| `state` | PlanState |  |  |
| `gateway` | OrderGateway |  |  |
| `autoGenerateInstallments` | Boolean |  | True delegates installment generation to FP. False means we call the installment API ourselves, and FP then leaves nextInstallmentDate null. |
| `generateFirstInstallmentNow` | Boolean |  | Generates the first installment immediately, bypassing the minimum gap. Purchase plans only. No payment is auto-created for that installment. |
| `paymentMethod` | PlanPaymentMethod? |  | Mandate that funds the installments. `paymentSourceRef` is FP's own reference to the instrument (the mandate's numeric id as a string), kept verbatim alongside our foreign key. |
| `paymentSourceRef` | VarChar(64)? |  |  |
| `mandateId` | Uuid? |  |  |
| `purpose` | PlanPurpose? |  |  |
| `requestedActivationDate` | Date? |  | A future date on which FP should start registering the plan. RTA only. |
| `startDate` | Date? |  |  |
| `endDate` | Date? |  |  |
| `nextInstallmentDate` | Date? |  |  |
| `previousInstallmentDate` | Date? |  |  |
| `sourceRefId` | VarChar(64)? | UK |  |
| `userIp` | VarChar(45)? |  |  |
| `serverIp` | VarChar(45)? |  |  |
| `euin` | VarChar(10)? |  |  |
| `partnerId` | Uuid? |  |  |
| `initiatedBy` | OrderInitiatedBy? |  |  |
| `initiatedVia` | OrderInitiatedVia? |  |  |
| `consentEmail` | VarChar(255)? |  |  |
| `consentIsdCode` | VarChar(4)? |  |  |
| `consentMobile` | VarChar(20)? |  |  |
| `consentAt` | DateTime? |  |  |
| `autoCancelled` | Boolean? |  | FP sets this when it cancels a plan itself, e.g. after consecutive failed installments. |
| `cancellationCode` | VarChar(60)? |  |  |
| `cancellationScheduledOn` | Date? |  |  |
| `reason` | VarChar(500)? |  | FP's free-text reason for the current state. |
| `fpCreatedAt` | DateTime? |  |  |
| `activatedAt` | DateTime? |  |  |
| `cancelledAt` | DateTime? |  |  |
| `failedAt` | DateTime? |  |  |
| `completedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfInvestmentAccount` → MfInvestmentAccount, `scheme` → MfScheme, `mandate` → Mandate, `partner` → Partner, `installments` → MfPurchase.

Indexes:

- `@@index([mfInvestmentAccountId])`
- `@@index([state, nextInstallmentDate])`
- `@@index([schemeIsin])`
- `@@index([mandateId])`

### MfRedemptionPlan

Table `mf_redemption_plans`.

POST /v2/mf_redemption_plans — an SWP when `systematic`.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `fpOldId` | Int? | UK |  |
| `mfInvestmentAccountId` | Uuid |  |  |
| `schemeIsin` | VarChar(12) |  |  |
| `folioNumber` | VarChar(30)? |  |  |
| `amount` | Decimal(18, 2)? |  | Per-installment amount, or units — never both. |
| `units` | Decimal(18, 4)? |  |  |
| `systematic` | Boolean |  |  |
| `frequency` | PlanFrequency |  |  |
| `installmentDay` | Int? |  |  |
| `numberOfInstallments` | Int |  |  |
| `remainingInstallments` | Int? |  |  |
| `state` | PlanState |  |  |
| `gateway` | OrderGateway |  |  |
| `autoGenerateInstallments` | Boolean |  |  |
| `requestedActivationDate` | Date? |  |  |
| `startDate` | Date? |  |  |
| `endDate` | Date? |  |  |
| `nextInstallmentDate` | Date? |  |  |
| `previousInstallmentDate` | Date? |  |  |
| `sourceRefId` | VarChar(64)? | UK |  |
| `userIp` | VarChar(45)? |  |  |
| `serverIp` | VarChar(45)? |  |  |
| `euin` | VarChar(10)? |  |  |
| `partnerId` | Uuid? |  |  |
| `initiatedBy` | OrderInitiatedBy? |  |  |
| `initiatedVia` | OrderInitiatedVia? |  |  |
| `consentEmail` | VarChar(255)? |  |  |
| `consentIsdCode` | VarChar(4)? |  |  |
| `consentMobile` | VarChar(20)? |  |  |
| `consentAt` | DateTime? |  |  |
| `autoCancelled` | Boolean? |  |  |
| `cancellationCode` | VarChar(60)? |  |  |
| `cancellationScheduledOn` | Date? |  |  |
| `reason` | VarChar(500)? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `activatedAt` | DateTime? |  |  |
| `cancelledAt` | DateTime? |  |  |
| `failedAt` | DateTime? |  |  |
| `completedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfInvestmentAccount` → MfInvestmentAccount, `scheme` → MfScheme, `partner` → Partner, `installments` → MfRedemption.

Indexes:

- `@@index([mfInvestmentAccountId])`
- `@@index([state, nextInstallmentDate])`
- `@@index([schemeIsin])`

### MfSwitchPlan

Table `mf_switch_plans`.

POST /v2/mf_switch_plans — an STP when `systematic`.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `fpOldId` | Int? | UK |  |
| `mfInvestmentAccountId` | Uuid |  |  |
| `switchOutSchemeIsin` | VarChar(12) |  |  |
| `switchInSchemeIsin` | VarChar(12) |  |  |
| `folioNumber` | VarChar(30)? |  |  |
| `amount` | Decimal(18, 2)? |  |  |
| `units` | Decimal(18, 4)? |  |  |
| `systematic` | Boolean |  |  |
| `frequency` | PlanFrequency |  |  |
| `installmentDay` | Int? |  |  |
| `numberOfInstallments` | Int |  |  |
| `remainingInstallments` | Int? |  |  |
| `state` | PlanState |  |  |
| `gateway` | OrderGateway |  |  |
| `autoGenerateInstallments` | Boolean |  |  |
| `requestedActivationDate` | Date? |  |  |
| `startDate` | Date? |  |  |
| `endDate` | Date? |  |  |
| `nextInstallmentDate` | Date? |  |  |
| `previousInstallmentDate` | Date? |  |  |
| `sourceRefId` | VarChar(64)? | UK |  |
| `userIp` | VarChar(45)? |  |  |
| `serverIp` | VarChar(45)? |  |  |
| `euin` | VarChar(10)? |  |  |
| `partnerId` | Uuid? |  |  |
| `initiatedBy` | OrderInitiatedBy? |  |  |
| `initiatedVia` | OrderInitiatedVia? |  |  |
| `consentEmail` | VarChar(255)? |  |  |
| `consentIsdCode` | VarChar(4)? |  |  |
| `consentMobile` | VarChar(20)? |  |  |
| `consentAt` | DateTime? |  |  |
| `autoCancelled` | Boolean? |  |  |
| `cancellationCode` | VarChar(60)? |  |  |
| `cancellationScheduledOn` | Date? |  |  |
| `reason` | VarChar(500)? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `activatedAt` | DateTime? |  |  |
| `cancelledAt` | DateTime? |  |  |
| `failedAt` | DateTime? |  |  |
| `completedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfInvestmentAccount` → MfInvestmentAccount, `switchOutScheme` → MfScheme, `switchInScheme` → MfScheme, `partner` → Partner, `installments` → MfSwitch.

Indexes:

- `@@index([mfInvestmentAccountId])`
- `@@index([state, nextInstallmentDate])`
- `@@index([switchOutSchemeIsin])`

### Mandate

Table `mandates`.

POST /api/pg/mandates — the investor's standing authorisation to debit their bank account, for SIP installments and one-off purchases.  Only an APPROVED mandate can fund a payment; creating a payment against any other status yields a FAILED payment. Cancelling a mandate fails the payments of every SIP still using it.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | Int | UK | FP's integer mandate id. |
| `bankAccountId` | Uuid |  |  |
| `mandateType` | MandateType |  |  |
| `mandateStatus` | MandateStatus |  |  |
| `mandateLimit` | Decimal(18, 2) |  | Per-debit ceiling. E_MANDATE tops out at ₹1 Cr; UPI autopay at ₹1 Lakh. |
| `mandateRef` | VarChar(64)? |  | Our reference passed to the payment provider, and the provider's own. |
| `mandateToken` | VarChar(120)? |  |  |
| `umrn` | VarChar(40)? |  | Unique Mandate Reference Number issued by NPCI once registered. |
| `validFrom` | Date? |  |  |
| `validTo` | Date? |  | Defaults to validFrom + 30 years, which is also the ceiling. |
| `providerName` | PaymentProvider? |  |  |
| `providerId` | Int? |  |  |
| `rejectedReason` | VarChar(500)? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `receivedAt` | DateTime? |  |  |
| `submittedAt` | DateTime? |  |  |
| `approvedAt` | DateTime? |  |  |
| `rejectedAt` | DateTime? |  |  |
| `cancelledAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `bankAccount` → BankAccount, `payments` → Payment, `purchasePlans` → MfPurchasePlan.

Indexes:

- `@@index([bankAccountId])`
- `@@index([mandateStatus])`

### Payment

Table `payments`.

A payment collected for one or more purchase orders — netbanking/UPI redirect, or a debit against an approved mandate.  FP does not check whether a payment already exists for an order, so the PaymentPurchase link is what stops us paying twice: look for a live payment on the order before creating another.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | Int | UK | FP's integer payment id. |
| `paymentType` | PaymentType |  |  |
| `method` | PaymentMethod? |  |  |
| `status` | PaymentStatus |  |  |
| `amount` | Decimal(18, 2) |  |  |
| `mandateId` | Uuid? |  |  |
| `fromBankAccountId` | Uuid? |  |  |
| `provider` | PaymentProvider? |  |  |
| `debitDate` | Date? |  | Expected debit date on the investor's account. |
| `tokenUrl` | VarChar(1000)? |  | Provider redirect the investor must complete. Short-lived — re-create the payment rather than reusing a stale link. |
| `postbackReceivedAt` | DateTime? |  | Where the provider posted the browser back to us, and when. |
| `failureCode` | VarChar(60)? |  |  |
| `failedReason` | VarChar(500)? |  |  |
| `lateAuth` | Boolean? |  | Authorised after the cut-off. Such payments are usually refunded. |
| `refundReference` | VarChar(120)? |  |  |
| `refundReason` | VarChar(200)? |  |  |
| `refundStatus` | RefundStatus? |  |  |
| `refundCreatedAt` | DateTime? |  |  |
| `fpCreatedAt` | DateTime? |  |  |
| `submittedAt` | DateTime? |  |  |
| `debitConfirmedAt` | DateTime? |  |  |
| `transferInitiatedAt` | DateTime? |  |  |
| `settledAt` | DateTime? |  |  |
| `failedAt` | DateTime? |  |  |
| `rejectedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mandate` → Mandate, `fromBankAccount` → BankAccount, `purchases` → PaymentPurchase.

Indexes:

- `@@index([status])`
- `@@index([mandateId])`
- `@@index([fromBankAccountId])`
- `@@index([fpCreatedAt(sort: Desc)])`

### PaymentPurchase

Table `payment_purchases`.

Which purchases a payment covers.  Many-to-many because FP's `amc_order_ids` is a list: one netbanking redirect can settle up to ten orders in a cart, and a retried order can be paid by a second payment after the first failed.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `paymentId` | Uuid |  |  |
| `mfPurchaseId` | Uuid |  |  |
| `createdAt` | DateTime |  |  |

Relations: `payment` → Payment, `mfPurchase` → MfPurchase.

Indexes:

- `@@unique([paymentId, mfPurchaseId])`
- `@@index([mfPurchaseId])`

### MfSettlementDetail

Table `mf_settlement_details`.

POST /v2/mf_settlement_details — proof that the investor's money reached the AMC, for orders paid outside FP.  Required before such an order can be confirmed. The UTR and settlement time arrive later, in a second call, which is why both are nullable.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64) | UK |  |
| `mfPurchaseId` | Uuid | UK |  |
| `paymentType` | SettlementPaymentType |  |  |
| `utrNumber` | VarChar(60)? |  |  |
| `bankAccountNumber` | VarChar(20)? |  |  |
| `bankIfsc` | VarChar(11)? |  |  |
| `bankName` | VarChar(150)? |  |  |
| `bankAccountType` | BankAccountType? |  |  |
| `beneficiaryAccountNumber` | VarChar(30)? |  |  |
| `beneficiaryAccountTitle` | VarChar(150)? |  |  |
| `beneficiaryBankName` | VarChar(150)? |  |  |
| `settlementProcessedAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfPurchase` → MfPurchase.

### MfPayoutDetail

Table `mf_payout_details`.

Where the proceeds of a successful redemption were paid.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpId` | VarChar(64)? | UK |  |
| `mfRedemptionId` | Uuid | UK |  |
| `amount` | Decimal(18, 2)? |  |  |
| `utrNumber` | VarChar(60)? |  |  |
| `bankAccountNumberMasked` | VarChar(40)? |  | Masked at source by the RTA. |
| `bankIfsc` | VarChar(11)? |  |  |
| `bankName` | VarChar(150)? |  |  |
| `status` | VarChar(40)? |  |  |
| `paidAt` | DateTime? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |
| `syncedAt` | DateTime |  |  |

Relations: `mfRedemption` → MfRedemption.

### PhoneVerification

Table `phone_verifications`.

One OTP challenge for one phone number.  The OTP itself is deliberately absent from this table — not even hashed. MSG91 generates and verifies it, so the code never touches our database or our logs. What we own here is everything MSG91 cannot enforce for us: resend cooldowns, send caps, attempt caps, lockout, and an audit trail.  With purpose = TRANSACTION_APPROVAL this is also the SEBI 2FA record behind an order's consent: verify the challenge first, then send the consent to FP.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `phone` | VarChar(20) |  | E.164, always normalised (+919876543210) so rate limits cannot be evaded by reformatting the same number. |
| `purpose` | OtpPurpose |  |  |
| `status` | OtpStatus |  |  |
| `providerRequestId` | VarChar(100)? |  | MSG91's request id, for correlating with their delivery logs. |
| `attempts` | Int |  | Wrong codes submitted against this challenge. |
| `sendCount` | Int |  | Deliveries for this challenge, including resends. |
| `expiresAt` | DateTime |  |  |
| `lastSentAt` | DateTime |  |  |
| `verifiedAt` | DateTime? |  |  |
| `lockedUntil` | DateTime? |  |  |
| `tokenHash` | VarChar(64)? | UK | Single-use proof that the caller controls this number, handed to a later signup / login / order-consent step. Stored as a SHA-256 hash: a database leak must not yield usable tokens. |
| `tokenExpiresAt` | DateTime? |  |  |
| `consumedAt` | DateTime? |  |  |
| `ipAddress` | VarChar(45)? |  |  |
| `userAgent` | VarChar(300)? |  |  |
| `createdAt` | DateTime |  |  |
| `updatedAt` | DateTime |  |  |

Indexes:

- `@@index([phone, purpose, createdAt(sort: Desc)])`
- `@@index([status, expiresAt])`

### FpWebhookEvent

Table `fp_webhook_events`.

Inbox for FP webhook deliveries (POST to our notification_webhooks URL).  Write the raw event first, acknowledge, then process asynchronously — a webhook handler that does work inline will time out and be redelivered. `fpEventId` is unique, so a redelivery collides instead of applying twice. The payload is retained because it is the only evidence of what FP told us and when, which is exactly what a reconciliation dispute needs.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `fpEventId` | VarChar(64) | UK | FP's `evt_…` id. The idempotency key for the whole pipeline. |
| `type` | VarChar(80) |  | e.g. "mf_purchase.successful", "kyc_request.rejected". |
| `objectType` | VarChar(40)? |  | Parsed out of `type` so events can be filtered by object. |
| `objectFpId` | VarChar(64)? |  | The `fpId` of the object the event concerns, for joining to our mirror. |
| `payload` | JsonB |  |  |
| `status` | WebhookProcessingStatus |  |  |
| `attempts` | Int |  |  |
| `lastError` | VarChar(1000)? |  |  |
| `occurredAt` | DateTime? |  | When FP says the event occurred, vs when it reached us. A large gap means a delivery backlog and a stale mirror. |
| `receivedAt` | DateTime |  |  |
| `processedAt` | DateTime? |  |  |

Indexes:

- `@@index([status, receivedAt])`
- `@@index([type, receivedAt(sort: Desc)])`
- `@@index([objectType, objectFpId])`

### AuditLog

Table `audit_logs`.

| Column | Type | Key | Notes |
|---|---|---|---|
| `id` | Uuid | PK |  |
| `actorId` | Uuid? |  | Kept as SetNull so purging an actor never destroys the audit trail. |
| `actorRole` | UserRole? |  | The actor's role at the time of the action — roles change, history must not. The admin subdomain reads this, not the current User.role. |
| `action` | VarChar(100) |  |  |
| `entityType` | VarChar(60) |  |  |
| `entityId` | VarChar(64)? |  |  |
| `metadata` | JsonB? |  |  |
| `ipAddress` | VarChar(45)? |  |  |
| `userAgent` | VarChar(300)? |  |  |
| `requestId` | VarChar(64)? |  |  |
| `createdAt` | DateTime |  |  |

Relations: `actor` → User.

Indexes:

- `@@index([actorId, createdAt])`
- `@@index([entityType, entityId])`
- `@@index([action, createdAt])`

## Enums

A `@map` value means the Postgres label is FP's exact wire string, so a row reads like an API payload. An enum with no mapped values is ours alone — FP has no such concept.

### UserRole

Postgres type `UserRole`. Ours.

`INVESTOR`, `DISTRIBUTOR`, `ADMIN`, `SUPPORT`

### UserStatus

Postgres type `UserStatus`. Ours.

`PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`, `CLOSED`

### UserProfileRelationship

How a login account relates to an investor profile.  One account can reach several profiles (a parent operating a minor's folios, one holder of a joint account) and one profile can be reachable by several accounts. That is why this is a join table and not a column.

Postgres type `UserProfileRelationship`. Ours.

`SELF`, `GUARDIAN`, `JOINT_HOLDER`, `POA`, `ADVISOR`

### OnboardingStage

Cursor for the stepped onboarding UI — see InvestorOnboarding.

Postgres type `OnboardingStage`. Ours.

`KYC_CHECK`, `KYC_REQUEST`, `PROFILE`, `CONTACT_DETAILS`, `BANK_ACCOUNT`, `NOMINEE`, `FATCA`, `INVESTMENT_ACCOUNT`, `MANDATE`, `COMPLETED`

### FilePurpose

Postgres type `FilePurpose`. Ours.

`SIGNATURE`, `CANCELLED_CHEQUE`, `PHOTO`, `IPV_VIDEO`, `IDENTITY_PROOF`, `ADDRESS_PROOF`, `OTHER`

### RelatedPartyContactSubject

Which side of a related party a contact block belongs to.

Postgres type `RelatedPartyContactSubject`. Ours.

`SELF`, `GUARDIAN`

### SchemeThresholdFrequency

Frequency dimension of MfSchemeThreshold.  A near-copy of PlanFrequency, plus NOT_APPLICABLE for the one-off threshold types that have no cadence (lumpsum, withdrawal, switch). It exists as its own enum so the column can be NOT NULL, which is what lets `(scheme, type, frequency)` be a real natural key: Prisma refuses a null inside a compound-unique `where`, so a nullable frequency could not be upserted — every catalogue sync would need a read-then-write instead.

Postgres type `scheme_threshold_frequency`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `NOT_APPLICABLE` | `not_applicable` |
| `DAILY` | `daily` |
| `CALENDAR_DAY_DAILY` | `calendar_day_daily` |
| `DAY_IN_A_WEEK` | `day_in_a_week` |
| `FOUR_TIMES_A_MONTH` | `four_times_a_month` |
| `DAY_IN_A_FORTNIGHT` | `day_in_a_fortnight` |
| `TWICE_A_MONTH` | `twice_a_month` |
| `MONTHLY` | `monthly` |
| `QUARTERLY` | `quarterly` |
| `HALF_YEARLY` | `half_yearly` |
| `YEARLY` | `yearly` |

### SchemeThresholdType

Transaction-type dimension of MfSchemeThreshold.

Postgres type `SchemeThresholdType`. Ours.

`LUMPSUM`, `ADDITIONAL`, `WITHDRAWAL`, `SWITCH_IN`, `SWITCH_OUT`, `SIP`, `SWP`, `STP`

### OtpPurpose

Postgres type `OtpPurpose`. Ours.

`PHONE_VERIFICATION`, `LOGIN`, `TRANSACTION_APPROVAL`

### OtpStatus

Postgres type `OtpStatus`. Ours.

`PENDING`, `VERIFIED`, `EXPIRED`, `FAILED`, `CANCELLED`

### WebhookProcessingStatus

Postgres type `WebhookProcessingStatus`. Ours.

`PENDING`, `PROCESSED`, `FAILED`, `IGNORED`

### InvestorProfileType

Postgres type `investor_profile_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `INDIVIDUAL` | `individual` |

### TaxStatus

FP accepts resident_individual and nri for an individual profile today. The minor statuses are referenced by FP's own source_of_wealth and income_slab rules, so they are declared here for the minor subdomain.

Postgres type `tax_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `RESIDENT_INDIVIDUAL` | `resident_individual` |
| `NRI` | `nri` |
| `RESIDENT_MINOR` | `resident_minor` |
| `NON_RESIDENT_MINOR_NRO` | `non_resident_minor_nro` |

### Gender

Postgres type `gender`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `MALE` | `male` |
| `FEMALE` | `female` |
| `TRANSGENDER` | `transgender` |

### MaritalStatus

Postgres type `marital_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `MARRIED` | `married` |
| `UNMARRIED` | `unmarried` |
| `OTHERS` | `others` |

### Occupation

investor_profile.occupation. Note the spelling differs from KycOccupationType — FP uses two vocabularies. Do not merge them.

Postgres type `occupation`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `BUSINESS` | `business` |
| `PROFESSIONAL` | `professional` |
| `RETIRED` | `retired` |
| `HOUSE_WIFE` | `house_wife` |
| `STUDENT` | `student` |
| `PUBLIC_SECTOR_SERVICE` | `public_sector_service` |
| `PRIVATE_SECTOR_SERVICE` | `private_sector_service` |
| `GOVERNMENT_SERVICE` | `government_service` |
| `AGRICULTURE` | `agriculture` |
| `DOCTOR` | `doctor` |
| `FOREX_DEALER` | `forex_dealer` |
| `SERVICE` | `service` |
| `OTHERS` | `others` |

### KycOccupationType

kyc_request.occupation_type. Same idea as Occupation, different spellings.

Postgres type `kyc_occupation_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `BUSINESS` | `business` |
| `PROFESSIONAL` | `professional` |
| `RETIRED` | `retired` |
| `HOUSEWIFE` | `housewife` |
| `STUDENT` | `student` |
| `PUBLIC_SECTOR` | `public_sector` |
| `PRIVATE_SECTOR` | `private_sector` |
| `GOVERNMENT_SECTOR` | `government_sector` |
| `OTHERS` | `others` |

### SourceOfWealth

Postgres type `source_of_wealth`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `SALARY` | `salary` |
| `BUSINESS` | `business` |
| `GIFT` | `gift` |
| `ANCESTRAL_PROPERTY` | `ancestral_property` |
| `RENTAL_INCOME` | `rental_income` |
| `PRIZE_MONEY` | `prize_money` |
| `ROYALTY` | `royalty` |
| `OTHERS` | `others` |

### IncomeSlab

Postgres type `income_slab`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `UPTO_1LAKH` | `upto_1lakh` |
| `ABOVE_1LAKH_UPTO_5LAKH` | `above_1lakh_upto_5lakh` |
| `ABOVE_5LAKH_UPTO_10LAKH` | `above_5lakh_upto_10lakh` |
| `ABOVE_10LAKH_UPTO_25LAKH` | `above_10lakh_upto_25lakh` |
| `ABOVE_25LAKH_UPTO_1CR` | `above_25lakh_upto_1cr` |
| `ABOVE_1CR` | `above_1cr` |

### PepDetails

Postgres type `pep_details`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `PEP_EXPOSED` | `pep_exposed` |
| `PEP_RELATED` | `pep_related` |
| `NOT_APPLICABLE` | `not_applicable` |

### ResidentialStatus

FP documents exactly one value for individual KYC today.

Postgres type `residential_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `RESIDENT_INDIVIDUAL` | `resident_individual` |

### TaxIdType

Tax identification type. FP allows the full list only when country = IN; for every other country the value must be TIN.

Postgres type `tax_id_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `PASSPORT` | `passport` |
| `ELECTION_ID` | `election_id` |
| `PAN` | `pan` |
| `ID_CARD` | `id_card` |
| `DRIVING_LICENSE` | `driving_license` |
| `AADHAAR_LETTER` | `aadhaar_letter` |
| `NREGA_JOB_CARD` | `nrega_job_card` |
| `TIN` | `tin` |
| `NOT_CATEGORIZED` | `not_categorized` |
| `OTHERS` | `others` |

### AddressNature

Postgres type `address_nature`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `RESIDENTIAL` | `residential` |
| `BUSINESS_LOCATION` | `business_location` |
| `REGISTERED_OFFICE` | `registered_office` |

### ContactBelongsTo

Whose contact detail this is — FP's `belongs_to`.

Postgres type `contact_belongs_to`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `SELF` | `self` |
| `SPOUSE` | `spouse` |
| `DEPENDENT_CHILDREN` | `dependent_children` |
| `DEPENDENT_SIBLINGS` | `dependent_siblings` |
| `DEPENDENT_PARENTS` | `dependent_parents` |
| `GUARDIAN` | `guardian` |
| `PMS` | `pms` |
| `CUSTODIAN` | `custodian` |
| `POA` | `poa` |

### BavStatus

Outcome of a bank account penny-drop verification.

Postgres type `bav_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `PENDING` | `pending` |
| `COMPLETED` | `completed` |
| `FAILED` | `failed` |

### BavConfidence

How likely the account belongs to the investor. A COMPLETED verification can still come back LOW or ZERO, which is not a pass.

Postgres type `bav_confidence`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `VERY_HIGH` | `very_high` |
| `HIGH` | `high` |
| `UNCERTAIN` | `uncertain` |
| `LOW` | `low` |
| `VERY_LOW` | `very_low` |
| `ZERO` | `zero` |

### BankAccountType

Postgres type `bank_account_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `SAVINGS` | `savings` |
| `CURRENT` | `current` |
| `NRE` | `nre` |
| `NRO` | `nro` |

### RelatedPartyRelationship

related_party.relationship. FP's list has no NOMINEE value: a nominee is a related party referenced from MfInvestmentAccountNominee, and this field says how they are related to the investor.

Postgres type `related_party_relationship`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `FATHER` | `father` |
| `MOTHER` | `mother` |
| `COURT_APPOINTED_LEGAL_GUARDIAN` | `court_appointed_legal_guardian` |
| `AUNT` | `aunt` |
| `BROTHER` | `brother` |
| `BROTHER_IN_LAW` | `brother_in_law` |
| `DAUGHTER` | `daughter` |
| `DAUGHTER_IN_LAW` | `daughter_in_law` |
| `FATHER_IN_LAW` | `father_in_law` |
| `GRAND_DAUGHTER` | `grand_daughter` |
| `GRAND_FATHER` | `grand_father` |
| `GRAND_MOTHER` | `grand_mother` |
| `GRAND_SON` | `grand_son` |
| `MOTHER_IN_LAW` | `mother_in_law` |
| `NEPHEW` | `nephew` |
| `NIECE` | `niece` |
| `SISTER` | `sister` |
| `SISTER_IN_LAW` | `sister_in_law` |
| `SON` | `son` |
| `SON_IN_LAW` | `son_in_law` |
| `SPOUSE` | `spouse` |
| `UNCLE` | `uncle` |
| `OTHERS` | `others` |

### IdentityProofType

Identity proof declared for a nominee (or their guardian) on a folio.

Postgres type `identity_proof_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `PAN` | `pan` |
| `AADHAAR` | `aadhaar` |
| `DRIVING_LICENCE` | `driving_licence` |
| `PASSPORT` | `passport` |

### NominationsInfoVisibility

Postgres type `nominations_info_visibility`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `SHOW_ALL_NOMINEE_NAMES` | `show_all_nominee_names` |
| `SHOW_NOMINATION_STATUS` | `show_nomination_status` |

### KycFormType

Whether a KYC form opens a new KYC record or amends an existing one. FP decides eligibility from the PAN's real status, so this is not a free choice — see the KycForm model.

Postgres type `kyc_form_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `FRESH` | `fresh` |
| `MODIFY` | `modify` |

### KycFormStatus

Postgres type `kyc_form_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `UNDER_REVIEW` | `under_review` |
| `CREATED` | `created` |
| `AWAITING_ESIGN` | `awaiting_esign` |
| `AWAITING_SUBMISSION` | `awaiting_submission` |
| `SUBMITTED` | `submitted` |
| `FAILED` | `failed` |
| `EXPIRED` | `expired` |

### KycRequestStatus

Postgres type `kyc_request_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `PENDING` | `pending` |
| `ESIGN_REQUIRED` | `esign_required` |
| `SUBMITTED` | `submitted` |
| `SUCCESSFUL` | `successful` |
| `REJECTED` | `rejected` |
| `EXPIRED` | `expired` |

### IdentityDocumentType

Postgres type `identity_document_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `AADHAAR` | `aadhaar` |

### DocumentFetchStatus

Postgres type `document_fetch_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `PENDING` | `pending` |
| `SUCCESSFUL` | `successful` |
| `FAILED` | `failed` |
| `EXPIRED` | `expired` |

### EsignStatus

Postgres type `esign_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `PENDING` | `pending` |
| `SUCCESSFUL` | `successful` |
| `FAILED` | `failed` |

### SchemeCategory

Postgres type `scheme_category`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `EQUITY` | `equity` |
| `DEBT` | `debt` |
| `LIQUID` | `liquid` |
| `HYBRID` | `hybrid` |
| `OTHERS` | `others` |

### SchemePlanType

Postgres type `scheme_plan_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `REGULAR` | `regular` |
| `DIRECT` | `direct` |

### SchemeInvestmentOption

Postgres type `scheme_investment_option`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `GROWTH` | `growth` |
| `DIV_PAYOUT` | `div_payout` |
| `DIV_REINVESTMENT` | `div_reinvestment` |

### SchemeDeliveryMode

Postgres type `scheme_delivery_mode`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `PHYSICAL` | `physical` |
| `DEMAT` | `demat` |
| `DEMAT_PHYSICAL` | `demat_physical` |

### HoldingPattern

Postgres type `holding_pattern`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `SINGLE` | `single` |
| `JOINT` | `joint` |
| `EITHER_OR_SURVIVOR` | `either_or_survivor` |
| `ANYONE_OR_SURVIVOR` | `anyone_or_survivor` |
| `FIRST_OR_SURVIVOR` | `first_or_survivor` |

### OrderGateway

Which route an order takes to the AMC.  `cybrillapoa` is FP's ONDC implementation and is the value the API actually expects — `ondc` is also accepted but the documented gateway name for orders is cybrillapoa. Both are modelled so a mirrored order is never silently recorded as the wrong route.

Postgres type `order_gateway`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `RTA` | `rta` |
| `CYBRILLAPOA` | `cybrillapoa` |
| `ONDC` | `ondc` |

### MfOrderState

Shared lifecycle of mf_purchase / mf_redemption / mf_switch.  A pending order expires if it is not confirmed in time: T+7 working days for a purchase, T+1 for a redemption or switch, counted from `scheduledOn`. Expiry surfaces as FAILED with failureCode = order_expiry.

Postgres type `mf_order_state`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `UNDER_REVIEW` | `under_review` |
| `PENDING` | `pending` |
| `CONFIRMED` | `confirmed` |
| `SUBMITTED` | `submitted` |
| `SUCCESSFUL` | `successful` |
| `FAILED` | `failed` |
| `CANCELLED` | `cancelled` |
| `REVERSED` | `reversed` |

### MfPurchaseType

Postgres type `mf_purchase_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `PURCHASE` | `purchase` |
| `ADDITIONAL_PURCHASE` | `additional_purchase` |

### RedemptionMode

Postgres type `redemption_mode`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `NORMAL` | `normal` |
| `INSTANT` | `instant` |

### OrderInitiatedBy

Postgres type `order_initiated_by`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `INVESTOR` | `investor` |
| `DISTRIBUTOR` | `distributor` |

### OrderInitiatedVia

Postgres type `order_initiated_via`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `WEB` | `web` |
| `MOBILE_APP` | `mobile_app` |
| `MOBILE_APP_ANDROID` | `mobile_app_android` |
| `MOBILE_APP_IOS` | `mobile_app_ios` |
| `MOBILE_WEB` | `mobile_web` |
| `MOBILE_WEB_ANDROID` | `mobile_web_android` |
| `MOBILE_WEB_IOS` | `mobile_web_ios` |

### PlanState

Postgres type `plan_state`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `CREATED` | `created` |
| `REVIEW_COMPLETED` | `review_completed` |
| `CONFIRMED` | `confirmed` |
| `SUBMITTED` | `submitted` |
| `ACTIVE` | `active` |
| `CANCELLED` | `cancelled` |
| `COMPLETED` | `completed` |
| `FAILED` | `failed` |

### PlanFrequency

Installment cadence. `installmentDay` means different things per frequency: 1-5 (Mon-Fri) for the weekly and fortnightly cadences, 1-28 for the monthly and longer ones, and nothing at all for DAILY.

Postgres type `plan_frequency`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `DAILY` | `daily` |
| `CALENDAR_DAY_DAILY` | `calendar_day_daily` |
| `DAY_IN_A_WEEK` | `day_in_a_week` |
| `FOUR_TIMES_A_MONTH` | `four_times_a_month` |
| `DAY_IN_A_FORTNIGHT` | `day_in_a_fortnight` |
| `TWICE_A_MONTH` | `twice_a_month` |
| `MONTHLY` | `monthly` |
| `QUARTERLY` | `quarterly` |
| `HALF_YEARLY` | `half_yearly` |
| `YEARLY` | `yearly` |

### PlanPurpose

Postgres type `plan_purpose`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `CHILDREN_EDUCATION` | `children_education` |
| `CHILDREN_MARRIAGE` | `children_marriage` |
| `HOUSE` | `house` |
| `CAR` | `car` |
| `TRAVEL` | `travel` |
| `RETIREMENT` | `retirement` |
| `OTHERS` | `others` |

### PlanPaymentMethod

Postgres type `plan_payment_method`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `MANDATE` | `mandate` |

### MandateType

Postgres type `mandate_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `E_MANDATE` | `E_MANDATE` |
| `NACH` | `NACH` |
| `UPI` | `UPI` |

### MandateStatus

Postgres type `mandate_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `CREATED` | `CREATED` |
| `RECEIVED` | `RECEIVED` |
| `SUBMITTED` | `SUBMITTED` |
| `APPROVED` | `APPROVED` |
| `REJECTED` | `REJECTED` |
| `CANCELLED` | `CANCELLED` |

### PaymentProvider

Postgres type `payment_provider`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `RAZORPAY` | `RAZORPAY` |
| `BILLDESK` | `BILLDESK` |
| `CYBRILLAPOA` | `CYBRILLAPOA` |
| `ONDC` | `ONDC` |

### PaymentType

Postgres type `payment_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `NETBANKING` | `NETBANKING` |
| `NACH` | `NACH` |
| `ECS` | `ECS` |
| `CHEQUE` | `CHEQUE` |
| `AUTH_TRANSACTION` | `AUTH_TRANSACTION` |

### PaymentMethod

Postgres type `payment_method`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `NETBANKING` | `NETBANKING` |
| `UPI` | `UPI` |
| `EMANDATE` | `EMANDATE` |

### PaymentStatus

Postgres type `payment_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `INITIATED` | `INITIATED` |
| `PENDING` | `PENDING` |
| `SUBMITTED` | `SUBMITTED` |
| `APPROVED` | `APPROVED` |
| `REJECTED` | `REJECTED` |
| `SUCCESS` | `SUCCESS` |
| `FAILED` | `FAILED` |

### RefundStatus

Postgres type `refund_status`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `CREATED` | `CREATED` |
| `SUCCESSFUL` | `SUCCESSFUL` |
| `FAILED` | `FAILED` |

### SettlementPaymentType

How the investor's money reached the AMC, for settlement reporting.

Postgres type `settlement_payment_type`. Mirrors FP's wire values.

| TypeScript | Database / FP wire |
|---|---|
| `NETBANKING` | `netbanking` |
| `NACH` | `nach` |
| `NEFT` | `neft` |
| `RTGS` | `rtgs` |

