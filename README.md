# backend

Bun + Express 5 + Prisma 7 (PostgreSQL on Neon), in front of
[Fintech Primitives](https://fintechprimitives.com/docs/api/) (FP / Cybrilla).

```bash
bun install
cp .env.example .env   # then fill in DATABASE_URL and the FP_* credentials
bun run db:migrate:deploy
bun run db:seed
bun run dev
```

**Documentation**
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — diagrams: system context, layers, ER
  per domain, sequence flows for every journey, state machines
- [`SCHEMA.md`](SCHEMA.md) — generated reference for all 46 models and 57 enums
- [`CLAUDE.md`](CLAUDE.md) — the rules to follow when changing this code

## FP is the system of record

Everything regulated — investor profiles, KYC, folios, orders, mandates,
payments — lives in FP, reached at `https://s.finprim.com` with a tenant bearer
token and the `x-tenant-id` header. This database is two halves:

| | models | who owns the truth |
|---|---|---|
| Ours | `User`, `UserInvestorProfile`, `InvestorOnboarding`, `PhoneVerification`, `WatchlistItem`, `AuditLog`, `FpWebhookEvent` | us |
| Mirror | everything with an `fpId` | FP |

Rules for the mirrored half:

- **Upsert on `fpId`.** It is FP's identifier and the idempotency anchor of
  every sync. Never insert blind.
- **`fpOldId` is not redundant.** The Payments and Mandates APIs address
  purchases and bank accounts by that legacy integer, not by the `fpId` string.
- **Never invent state locally.** A mirrored row changes only when FP says so,
  through an API response or a webhook.
- **`syncedAt`** records the last reconciliation, so a stale projection is
  detectable rather than silently wrong.

Scope modelled today is the individual investor journey: KYC check → digital
KYC → investor profile with contacts, bank account and nominee → MF investment
account with folio defaults → folio → purchase / redemption / switch, lumpsum
and systematic → mandate and payment → holdings. The minor, joint, agent and
admin subdomains have seams in the schema (see the header of
`prisma/schema.prisma`) so none of them needs a destructive migration.

### Enum values are FP's wire strings

FP-mirroring enums use value-level `@map`, so the Postgres label is byte
identical to the JSON FP sends — `'resident_individual'`, not
`'RESIDENT_INDIVIDUAL'`. Reading a row then matches reading an API payload.
Enums that are ours alone carry no `@map`; the absence of one tells you FP has
no such concept.

Two traps the schema deliberately preserves rather than tidies away:

- FP spells the same job `house_wife` on `investor_profile` and `housewife` on
  `kyc_request`. Hence both `Occupation` and `KycOccupationType`. Merging them
  would corrupt one of the two payloads.
- The v1 catalogue (`/api/oms/fund_schemes`) shouts its enums while the v2
  object APIs use lower case. `MfScheme` follows v2 and the catalogue sync
  lower-cases on ingest — the one place a stored value is not byte-identical to
  its payload.

## Prisma setup

Prisma 7 differs from v6 in ways that matter here:

| | v6 | this project (v7) |
|---|---|---|
| Generator | `prisma-client-js` | `prisma-client`, explicit `output` |
| Client location | `node_modules` | `generated/prisma/` (gitignored) |
| Database access | bundled query engine | driver adapter (`@prisma/adapter-pg` → `pg`) |
| Connection URL | `datasource.url` in schema | `prisma.config.ts` |
| Env loading | automatic | explicit (Bun loads `.env` for us) |

### Layout

```
prisma/schema.prisma     models, enums, indexes
prisma/migrations/       committed migration history
prisma/seed.ts           idempotent seed (upserts)
prisma/seed-data/        committed FP sandbox catalogue snapshot + its refresher
prisma.config.ts         CLI config — migrations, studio, seed
src/db/client.ts         the PrismaClient singleton the app imports
generated/prisma/        generated client (not committed)
```

### Commands

```bash
bun run db:migrate          # create + apply a migration (local only)
bun run db:migrate:deploy   # apply pending migrations (CI/CD, production)
bun run db:migrate:status   # what is pending
bun run db:generate         # regenerate the client after a schema change
bun run db:seed
bun run db:seed:refresh     # re-capture the FP catalogue snapshot (needs network)
bun run db:studio
```

Every script goes through `bunx --bun` so the CLI runs on Bun rather than
falling back to Node. Never run `db:migrate` against production — it can
prompt, reset, and needs a shadow database. Deploys use `db:migrate:deploy`.

## Two connection URLs

`DATABASE_URL` is the **pooled** endpoint and is what the application uses.
`DIRECT_DATABASE_URL` is the **non-pooled** endpoint and is what the Prisma CLI
uses for migrations — DDL and migration advisory locks need a real session,
which PgBouncer transaction-mode pooling does not provide.

`prisma.config.ts` configures the CLI only, so it picks `DIRECT_DATABASE_URL`
when that variable is set. The app never reads that file; it reads
`DATABASE_URL` in `src/db/client.ts`.

> The Prisma docs show a `datasource.directUrl` field in `defineConfig` for
> this. On 7.9.1 it did not take effect — pointing `DIRECT_DATABASE_URL` at a
> dead host still let migrate commands connect through the pooled URL. Hence
> selecting the URL by name instead of relying on that field.

## Gotchas worth knowing

**`prisma+postgres://` URLs do not work with this adapter.** `pg` does not
understand that protocol and does not error on it — it parses the URL into a
target with no user, no password and no database, so the pool fails later with
a confusing error. `src/db/client.ts` rejects it at startup instead. If you do
want that protocol, the adapter to use is `@prisma/adapter-ppg`.

**Prefer `sslmode=verify-full` over `sslmode=require`.** `pg` currently treats
`require` as full certificate verification, but that weakens to libpq semantics
(encrypt, do not verify) in pg v9. `channel_binding` is a libpq parameter and
is silently ignored by the JS driver.

**`env()` throws on unset variables.** In `prisma.config.ts`, referencing a
variable that is not set fails every CLI command with `PrismaConfigEnvError`,
so an optional variable must be resolved before it is passed to `env()`.

**One client per process.** Each `PrismaClient` owns a `pg` pool, so a second
instance doubles your connection count. `src/db/client.ts` caches the instance
on `globalThis` outside production so `bun --watch` reloads do not leak pools.

## Money in the schema

All monetary values are `Decimal`, never `Float` — binary floats cannot
represent decimal currency exactly and the error compounds. The column
conventions:

| | type |
|---|---|
| amounts (INR) | `Decimal(18, 2)` |
| fund units | `Decimal(18, 4)` — FP allots to 3dp |
| NAV / price | `Decimal(12, 4)` |
| percentages | `Decimal(6, 4)` |
| nominee allocation | `Decimal(5, 2)` |
| scheme multiples | `Decimal(18, 4)` — FP reports 0.001 on index funds |

Prisma returns these as `Decimal` objects, not numbers. Two consequences when
you build an API on top: do arithmetic with `Decimal` methods (`.plus`,
`.times`, `.div`), and format on the way out with `.toFixed(dp)` —
`JSON.stringify` calls `toJSON()`, which drops trailing zeros, so
`Decimal("100.00")` would otherwise serialise as `"100"`.

Primary keys are `uuid(7)`: time-ordered, so inserts append to the end of the
index instead of fragmenting it the way random `uuid(4)` does.

## Running it

```bash
bun run dev           # starts the server on PORT (default 3000)
curl localhost:3000/health

bun run test          # unit + schema; no network, runs in seconds
bun run test:e2e      # boots the app and walks the whole journey against FP
```

| suite | needs | covers |
|---|---|---|
| `test:unit` | nothing | validation, money and date formatting, phone normalisation, FP payload mapping, idempotency hashing, error envelope |
| `test:schema` | pglite | the pre-verification tables: ordering, foreign keys, retention |
| `test:e2e` | FP sandbox + database | every endpoint, in journey order, against the real thing |

`test:e2e` is the real test: it starts the app on an ephemeral port, talks to
the live FP sandbox and the configured database, and walks catalogue → session →
pre-verification → profile → contacts → bank account → investment account →
purchase → consent → mandate → payment → confirm → cancel → plans → portfolio →
webhooks, reporting what each endpoint actually did. It creates real objects in
the FP tenant, so never point it at production. Two things it cannot do for
real: MSG91 has no DLT template here, so it probes the OTP endpoints for their
expected failure and writes the verified-phone rows a session and a 2FA consent
spend; and it resets the per-IP rate-limit table between phases, then tests the
limiter deliberately at the end.

`index.ts` boots `src/app.ts`, which mounts the routers under `/api/v1`, then
the 404 handler, then the error handler — in that order. `errorHandler` must be
last: registered earlier, Express treats it as ordinary middleware and every
`HttpError` becomes a 500 with a stack trace in the body.

Everything under `/api/v1` except the catalogue, OTP, session and webhook routes
requires a bearer session: `POST /api/v1/sessions` exchanges a verified-phone
token for one. On top of that, `middleware/investor-ownership.ts` authorises
every `:profileId` / `:accountId` / `:orderId` in the path and every resource id
in a body or query against the session's user, `middleware/investor-command.ts`
requires an `Idempotency-Key` on every write and replays the stored response for
a repeat, and `middleware/api-security.ts` applies a per-IP window (120/min, 15
on the auth routes). A new `:somethingId` route parameter is **not** protected
until `ownResource` has a case for it.

Still missing before this faces the internet: `helmet`/`cors`, an edge rate
limit in front of `/api/v1/otp/*` rather than an in-process one, and TLS
termination.

## What the sandbox actually does

Everything below was verified against the `thestupidinvestor` sandbox, not read
off the reference. Several of these contradict, or are absent from, the docs.

**This platform is ONDC only.** The gateway is `cybrillapoa` — FP's ONDC
implementation, and the value the order APIs actually take (`ondc` is the
protocol name and is accepted as an alias for it). `FP_ORDER_GATEWAY` rejects
anything else at boot, and the RTA route is not implemented.

```
create   -> under_review
(FP reviews asynchronously: investor KYC + PAN verification)
         -> pending, or failed
PATCH consent (alone)
payment
PATCH state=confirmed
-> submitted -> successful
```

Rules, each confirmed by making FP reject the alternative:

- **Consent is PATCHed on its own.** With `state` alongside, FP rejects it
  outright.
- **There is no settlement step.** `/v2/mf_settlement_details` reports money
  collected outside FP, which only applies to the RTA route; ONDC always
  collects through FP's Payments API, and the transport refuses to write to that
  path at all.
- **Confirm needs a payment behind it**, and the service refuses locally first —
  FP's own error does not say which order or why.
- An order starts in **`under_review`** and is not payable until the review
  passes. Poll `POST /orders/:id/refresh`.
- **Cancel works on ONDC.** A consented `pending` order goes straight to
  `cancelled`, as long as no payment is in flight.

**Sandbox PAN simulation — this is the part that costs the most time.** Two
independent checks run against the PAN, and an order needs both to pass:

| Pattern | Meaning |
|---|---|
| `XXXP`**`A`**`NNNNX` | Aadhaar not linked → `pan_verification_failed` |
| `XXXP`**`I`**`NNNNX` | invalid PAN |
| `XXXP`**`x`**`NNNNX` | PAN verified (any other 5th letter) |
| `XXXPx`**`3751`**`X` | full KYC compliant |
| `XXXPx`**`3753`**`X` | not present in any KRA → `pan_kyc_incomplete` |

So a usable test PAN needs a 4th character `P`, a 5th character that is **not
A or I**, and the digits **3751** — for example **`AAAPB3751C`**. The reference's
own example PAN, `AAAPA3751A`, is KYC-compliant but fails PAN verification,
because its 5th character is `A`.

Other simulation levers: a bank account number matching `31XX` fails
verification, anything else passes; an order amount ending in **0** is
auto-succeeded at the RTA after submission, ending in **1** auto-failed.

**The ONDC gateway has two names on `/api/pg`, and each half rejects the
other's.** Mandates want `provider_name: "CYBRILLAPOA"` and answer *"Unexpected
value: ONDC"*; payments want `"ONDC"` and answer *"Should be either RAZORPAY or
BILLDESK or CAMSPAY or ONDC or IDFC or NCDEX"*. So the mandate and the payment
that debits it carry different provider names for the same gateway. Both live in
`resources/payments.ts`; the transport enforces the right one per path.

Mandate creation and authorisation work: `POST /payments/mandates` reaches
`CREATED` and `/authorize` returns a live bank URL. Approval happens at the
investor's bank, so a mandate cannot be driven to `APPROVED` from a test.

**Two provisioning blockers remain, both at Cybrilla, neither in the code:**

- **No payment provider on the ONDC route.** `POST /api/pg/payments/netbanking`
  answers `422 NO_PAYMENT_PROVIDER` — *"Provider ONDC not configured"*. Payment
  collection therefore cannot complete on this tenant, and nor can the confirm
  that needs it.
- **The POA penny-drop returns no verdict.** A pre-verification carrying a bank
  account is accepted, but `bank_accounts[].status` stays null indefinitely,
  with or without `verify_manually_if_required`. (FP's own
  `POST /v2/bank_account_verifications` is likewise unprovisioned — *"Tenant
  thestupidinvestor is not configured !!!"*.) Without a verdict, an ONDC order
  is reviewed, consented, **paid for** and confirmed, and only then fails at
  submission with `payout_account_verification_pending` — after the money has
  moved. The service verifies during onboarding, where failing is cheap, and
  exposes the result as `BankAccountDto.usableForPayout`.
  `FP_REQUIRE_PAYOUT_ACCOUNT_VERIFICATION=false` unblocks the sandbox and must
  never be set in production.

**Pre-verification: read `readiness.status`, not the envelope.** The top-level
`status` stays `"accepted"` and `completed_at` stays null for minutes after
every field verdict has landed, and on some records never advances at all. The
verdicts are authoritative; the envelope is not, and gating on it makes the
check unsatisfiable.

**The KRA lookup behind it is rate limited per PAN.** Once the budget is spent
the response is `readiness.status: null` with
`readinessCode: "kyc_rate_limit_exceeded"` — indistinguishable from "still
checking" unless you read the code. A null status carrying a code is a refusal,
not progress; `tests/e2e-ondc.ts` randomises its PAN per run for this reason.

**Consent must match the registered contact.** FP rejects a consent whose email
differs from `folio_defaults.communication_email_address` (or the folio's
registered address, for an existing folio). The service resolves it from stored
data and never accepts it from the caller — a caller who could name the contact
could route the investor's OTP elsewhere.

**Order creation is not idempotent.** Two identical POSTs create two orders and
debit the investor twice. `source_ref_id` is the only guard: FP answers
*"source_ref_id: should be unique"* on reuse. Every create sends one, and the
transport never auto-retries a write.

**`nominations_info_visibility` is mandatory once a nominee exists**, though the
reference marks it "upcoming" and optional. Without it the first order fails
with *"nomination_info_visibility should be set in case of skip nomination is
false"* — at order time, long after the nominee was added. The service defaults
it to `show_all_nominee_names`.

**The catalogue's capability flags do not agree with the order APIs.** Three
cases, all verified:

- **`sip_allowed` does not mean a SIP can be placed.** Both index funds in the
  test set advertise `sip_allowed: true` and publish an empty
  `sip_frequency_specific_data`, so FP rejects any SIP with *"selected frequency
  is not supported"*. `scheme-rules.service.ts` checks the local threshold rows
  first and returns the frequencies the scheme really offers.
- **`purchase_allowed` does not mean the scheme is purchasable.** The
  `DIV_REINVESTMENT` variant of a scheme carries `purchase_allowed: true`,
  `active: true` and a LUMPSUM threshold, and the order API still refuses it
  with *"scheme is not available for purchase"* — while the `GROWTH` variant of
  the same fund, identical in every other field, is accepted. Nothing local can
  predict this, so `tests/e2e-ondc.ts` works down a list of candidates rather
  than trusting the flag, and a client should be ready for the 400.
- **A daily plan takes no installment day.** Schemes publish `allowed_dates` for
  daily frequencies exactly as they do for monthly, but FP rejects a daily plan
  that carries one with *"installment_day should be null for the given
  frequency"*. `validatePlan` refuses it first, naming the frequency.

**A reviewed plan cannot be cancelled on ONDC.** Once a plan reaches
`review_completed`, FP answers *"Cancellation not allowed for plans in
REVIEW_COMPLETED state with CYBRILLAPOA gateway"*. It is confirmed, or left
unconfirmed; `cancelPlan` refuses locally with that instruction.

**KYC works — but on the partner realm, not the tenant realm.** There are two
independent KYC surfaces, and only one is available here:

| | tenant realm (`s.finprim.com`) | partner realm (`api.sandbox.cybrilla.com`) |
|---|---|---|
| status check | `/api/kyc/check` — **404, not provisioned** | `/poa/pre_verifications` — **works** |
| digital KYC | `/v2/kyc_requests` — **404 Couldn't find Tenant** | `/poa/kyc_forms` — **works** |
| credentials | tenant client | partner client (`cybrillarta`) |

So the earlier conclusion that "KYC is unavailable" was only half right: FP's own
KYC is not provisioned, but **Cybrilla POA's KYC Forms API is**, and that is a
complete digital-KYC journey — eligibility review, DigiLocker proof fetch,
signature upload, esign, KRA submission. It is implemented in
`resources/kyc-forms.ts` + `kyc.service.ts` and exposed at `/api/v1/kyc/*`.

Its lifecycle is `under_review → created → awaiting_esign → awaiting_submission
→ submitted`, with `failed` and a 7-day `expired`. Two things to know:

- **Eligibility is decided asynchronously, and now passes** — it did not when
  the sweep above this line was written, so treat an old "eligibility is not
  enabled" note as stale. `fresh` needs a PAN with no KYC, which in this sandbox
  is the digits **`3753`**: `BCDPE3753F` reaches `created` about three seconds
  after the 201, carrying an 18-entry `fields_needed`. A `3751` PAN is already
  KYC-compliant and has no business opening a fresh form. Always poll before
  showing the investor a form.
- **The form's vocabulary is not `investor_profile`'s.** Four values differ, and
  FP names the field only for the first three — an unknown *key* comes back as a
  bare `Invalid JSON payload` with nothing else in it.

  | field | what the form takes |
  |---|---|
  | `pep_details` | `no_exposure` / `pep` / `related_pep` — **not** the profile's `not_applicable` / `pep_exposed` / `pep_related` |
  | `residential_status` | `resident`, and only that — not `resident_individual` |
  | `phone_number.isd` | `+91` with the plus; a bare `91` is refused |
  | geolocation | the key is `geolocation`, **not** `geo_location` |

  With those right, one PATCH takes the form from 18 outstanding fields to
  `["address", "identity_proof", "signature"]` — the first two arrive from the
  DigiLocker fetch, the third from the signature upload.
- **There are no webhooks on this realm.** Eligibility, DigiLocker and esign all
  complete out of band, so the client polls `POST /kyc/forms/:id/refresh`.

Also on the partner token: **bank account lookup works** (`consent.mode` must be
exactly `"checkbox"`), and **customer data lookup does not** — *"Partner is not
whitelisted for ZTO usage"*.

The probe that established all this, for the record:

| call | tenant token | cybrillarta token |
|---|---|---|
| `POST s.finprim.com/api/kyc/check` | 404 *Not Found* (route exists, KRA source not configured) | 403 *Partner tokens are not allowed* |
| `POST s.finprim.com/v2/kyc_requests` | 404 *Couldn't find Tenant* | 403 *Partner tokens are not allowed in v2 authentication* |
| anything on `api.sandbox.cybrilla.com` outside `/poa/*` | 404 *Gateway: URL not available* | same |

The **cybrillarta credentials are a partner/POA token**, not a second tenant:
rejected by every v2 API, accepted on `/poa/*` and the lookup endpoints.
Pre-verification (`POST /poa/pre_verifications`) checks PAN — including Aadhaar
linkage — name, date of birth and a bank account by penny-drop. Read
`readiness.status`; the top-level `status` only acknowledges the request.

Ask Cybrilla to enable KYC checks and KYC requests on `thestupidinvestor` only
if you specifically need FP's tenant-realm KYC; the partner realm already covers
the journey.

**`investor_profile` carries five fields the reference never mentions.** FP both
returns and accepts `marital_status`, `father_name`, `mother_name`,
`aadhaar_number` (last 4 only) and `citizenship_countries` — verified by writing
them and reading them back. They are **write-once**: a second attempt answers
*"father_name is already set and cannot be modified"*. These are exactly the KRA
demographics a KYC check would have prefilled, so on a tenant without KYC they
are the only record of them — and they can only be captured at profile creation.
`POST /investors/profiles` accepts all five for that reason.

**Rate limits are low.** 25 requests/second in the sandbox, 20/second on list
endpoints. Seven back-to-back catalogue reads trip it, so the client paces bulk
work and backs off on 429 with jitter.

## API surface

```
GET    /health

GET    /api/v1/schemes                          catalogue, cursor-paginated
GET    /api/v1/schemes/:isin                    limits and thresholds
GET    /api/v1/schemes/:isin/nav

POST   /api/v1/otp/...                          phone verification (MSG91)

POST   /api/v1/kyc/readiness                    can this PAN transact?
GET    /api/v1/kyc/readiness/:id                poll it (asynchronous)
POST   /api/v1/kyc/forms                        start digital KYC
GET    /api/v1/kyc/forms/:id                    also PATCH to fill in fields
POST   /api/v1/kyc/forms/:id/refresh            poll — no webhooks on this realm
POST   /api/v1/kyc/forms/:id/retry-proof        new DigiLocker link

POST   /api/v1/investors/profiles               create investor profile
GET    /api/v1/investors/profiles?userId=
GET    /api/v1/investors/onboarding?userId=     resume a half-finished signup
POST   /api/v1/investors/profiles/:id/addresses
POST   /api/v1/investors/profiles/:id/phones
POST   /api/v1/investors/profiles/:id/emails
POST   /api/v1/investors/profiles/:id/bank-accounts
POST   /api/v1/investors/profiles/:id/nominees
POST   /api/v1/investors/profiles/:id/investment-accounts
PATCH  /api/v1/investors/investment-accounts/:id/folio-defaults

POST   /api/v1/orders/purchases                 then /consent, a payment, /confirm
POST   /api/v1/orders/purchases/:id/retry       reopen a failed order
POST   /api/v1/orders/purchases/:id/cancel
POST   /api/v1/orders/redemptions               then /confirm
POST   /api/v1/orders/switches                  then /confirm
GET    /api/v1/orders?mfInvestmentAccountId=
POST   /api/v1/orders/:id/refresh               pull current state from FP

POST   /api/v1/plans/sips                       also /swps and /stps
GET    /api/v1/plans?mfInvestmentAccountId=
POST   /api/v1/plans/:id/cancel

POST   /api/v1/payments/mandates                then /authorize, /refresh, /cancel
POST   /api/v1/payments/mandates/:id/pay        debit an approved mandate
POST   /api/v1/payments/netbanking              redirect-based collection

GET    /api/v1/portfolio/:accountId/summary     holdings, folios, returns,
POST   /api/v1/portfolio/:accountId/refresh     capital-gains

POST   /api/v1/webhooks/fp                      FP posts here
POST   /api/v1/webhooks/fp/process              operator, x-admin-secret
```

### The FP integration itself

```
src/integrations/fp/          token cache, retrying transport, typed resources
src/services/fp-sync/         FP payload -> our tables, upserting on fpId
src/services/*.service.ts     the journey: investor, order, plan, payment, portfolio
src/utils/fp-mapping.ts       wire values -> enums, Decimals, dates
```

Every FP call goes through `fpRequest`, which owns auth, the tenant header,
timeouts, retry and error translation. The retry policy defaults to **GET only**
— a retried POST that actually succeeded upstream would place a second order.

Still to build: registering the webhook subscriptions against a public URL
(`FP_WEBHOOK_EVENTS` lists what to subscribe to), a scheduled catalogue sync,
and scheduling `POST /webhooks/fp/process` rather than calling it by hand.

Configuration that is easy to miss, because the code needs it and nothing fails
until a specific endpoint is called:

| variable | without it |
|---|---|
| `CALLBACK_ALLOWED_ORIGINS` | every endpoint taking a callback URL — KYC forms, mandate postbacks — answers 503 |
| `MSG91_OTP_TEMPLATE_ID` | `/otp/*` and `/transaction-otp/*` answer 503, so no session and no 2FA consent |
| `FP_WEBHOOK_ADMIN_SECRET` | the webhook operator endpoints answer 503 |

