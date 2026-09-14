# Investor schema implementation

Scope: individual investor database foundation. Existing FP models are retained;
this revision adds the missing partner pre-verification projection. It does not
enable minor, joint, distributor or administrative API journeys.

## Documentation reviewed

- [FP API reference](https://fintechprimitives.com/docs/api/): identity objects,
  KYC lifecycle, investor profiles and tax residencies.
- [KYC check guide](https://docs.fintechprimitives.com/identity/kyc-check):
  compliance status, restrictions and sandbox scenarios.
- [Investment accounts](https://docs.fintechprimitives.com/mf-transactions/investment-account/)
  and [required information](https://docs.fintechprimitives.com/mf-transactions/accounts/required-information/).
- [Cybrilla pre-verification](https://poa.cybrilla.com/docs/additional-apis/pre-verifications)
  and [KYC forms](https://poa.cybrilla.com/docs/additional-apis/kyc-forms).

## Data boundaries

| Responsibility | Models |
| --- | --- |
| Login and access relationships | User, UserInvestorProfile |
| Onboarding progress | InvestorOnboarding |
| Tenant KRA checks / applications | KycCheck, KycRequest |
| Partner checks / applications | PreVerification, PreVerificationBankResult, KycForm |
| Investor identity and FATCA | InvestorProfile, TaxResidency |
| Contacts, bank and nominees | Address, PhoneNumber, EmailAddress, BankAccount, RelatedParty |
| Investment ownership and defaults | MfInvestmentAccount, MfFolioDefaults, MfInvestmentAccountNominee |
| Provider transaction projections | Folios, holdings, orders, plans, mandates and payments |

Provider ids identify remote resources; local UUIDs identify relationships.
Repeated polling must update the same provider id. A new verification attempt
has its own row. An updated projection is not an immutable event history.

Pre-verification request completion is separate from readiness, PAN, name, DOB
and bank verdicts. Nullable verdicts represent unfinished or unrequested checks;
they must never be defaulted to success. Bank results are separate rows keyed
by request and response position. Store every returned result, not just index 0.
Partner file ids remain separate from tenant file records. Manual-review
approval is request evidence and cannot be inferred from the result.

## Extension points

- Minor: guardian identity fields and guardian access links exist. A future
  guardian journey needs explicit authority checks and majority transition rules.
- Joint: investment accounts already reference primary, second and third
  profiles and a holding pattern. Login-to-profile links alone must not grant
  authority to transact on a joint account.
- Agent: Partner and servicing-partner relations exist. Future delegated access
  needs grants and revocation; a distributor role alone is insufficient.
- Admin: existing roles and audit records provide a starting point. An admin
  subdomain is a routing/deployment decision, not a separate investor identity.

These are extension points, not a promise that future features need no migrations.
The current schema assumes one provider tenant/partner per database and separate
sandbox and production databases. Multiple provider tenants in one database
would require scoped provider-id uniqueness throughout the existing models.

## Migration and integration

`20260911120000_investor_pre_verification` adds two tables, foreign keys,
indexes and a nonnegative bank-result position check. It does not rewrite any
existing investor rows. Prior migrations are unchanged; some historical
migrations delete legacy data, so review the entire pending migration set
before deploying against an existing database.

The schema and generated client are ready for persistence integration. The
existing readiness service still calls the provider directly; writing these
tables is a subsequent service-layer step. That step must derive ownership from
authenticated context, preserve links when polling, update parent and bank
results atomically, and prevent older responses overwriting newer state.

The backend currently lacks authentication and per-investor authorization (see
README). Schema validation alone does not make it safe to expose publicly.
Database/backups need encryption and restricted access; schema comments do not
implement encryption. No API secrets are stored in these tables or documents.

Run `bun run db:validate`, `bun run db:generate`, `bun run docs:schema`,
`bunx --bun tsc --noEmit`, and `bun run test:schema`.
The database tests replay migrations in disposable in-memory PostgreSQL (PGlite).
They do not use DATABASE_URL or contact the sandbox.
