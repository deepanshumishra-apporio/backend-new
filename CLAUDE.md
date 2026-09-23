# backend — conventions

Bun + Express 5 + Prisma 7 + PostgreSQL (Neon), in front of Fintech Primitives
(FP / Cybrilla). Read `README.md` for setup.

## FP owns the regulated data

Investor profiles, KYC, folios, orders, mandates and payments live in FP. This
database holds our own tables plus a **mirror** of FP's objects — every model
with an `fpId`.

- Upsert mirrored rows on `fpId`; it is the idempotency anchor. Never insert
  blind, and never invent a mirrored row's state locally — it changes only when
  FP says so, via an API response or a webhook.
- `fpOldId` is FP's legacy numeric id and is **not** redundant: the Payments and
  Mandates APIs address purchases and bank accounts by that integer.
- FP-mirroring enums `@map` to FP's exact wire strings, so a DB value reads like
  an API payload. Do not "normalise" them to SCREAMING_SNAKE.
- FP uses different vocabularies for the same idea in different objects
  (`house_wife` on `investor_profile`, `housewife` on `kyc_request`). Keep the
  separate enums. Merging them corrupts one of the payloads.
- Order creation is **not** idempotent at FP. `sourceRefId` — unique across
  purchases, redemptions and switches — is what makes a retry safe.
- SEBI requires 2FA consent before an order reaches the RTA. Verify a
  `PhoneVerification` with purpose `TRANSACTION_APPROVAL` first, then send the
  consent; the OTP goes to the contact registered on the folio, or to the
  account's folio defaults for a fresh purchase.
- Never derive holdings by summing our own order rows. Allotment happens at the
  AMC net of stamp duty; only FP's holdings report is authoritative.
- Never store a full bank account number. FP holds it; we keep the last four
  digits and a fingerprint (`BankAccount.accountNumberFingerprint`).

## Calling FP

- **All calls go through `src/integrations/fp/`.** Never `fetch` FP directly —
  the transport owns the token cache, the tenant header, retry and error
  translation. Add a typed wrapper in `resources/` instead.
- **Retry is GET-only by default.** Do not set `retry: true` on a write. A
  retried POST that actually succeeded upstream places a second order.
- **This platform is ONDC only.** Orders and plans go out with `gateway: "ondc"`,
  from `FP_ORDER_GATEWAY`, which accepts nothing else. **`cybrillapoa` is not an
  alias** — FP routes it separately, its orders are refused by the ONDC payment
  provider (`422 Provider ONDC not configured`) and never allotted. Rows already
  stored as `CYBRILLAPOA` stay readable; check the route with `isOndcRoute`
  (`src/utils/gateway.ts`), never by comparing to one value.
- **There is one purchase sequence**, in `order.service.ts`; read its header
  before touching it:

      create → `under_review` → poll → `pending` → consent *alone* → payment
      → confirm

  Consent always travels alone — FP rejects `state` and `consent` together.
  Confirm always needs a payment behind it. There is **no settlement step**:
  settlement reports money collected outside FP, which is an RTA idea, and
  `/v2/mf_settlement_details` is blocked in the transport.
- **The ONDC gateway has two different names on `/api/pg`,** and each half
  rejects the other's:

  | call | `provider_name` |
  |---|---|
  | `POST /api/pg/mandates` | `CYBRILLAPOA` |
  | `POST /api/pg/payments/*` | `ONDC` |

  Both are in `resources/payments.ts` as `ONDC_MANDATE_PROVIDER` /
  `ONDC_PAYMENT_PROVIDER`, and the transport enforces the right one per path.
  Everything above the FP client says `CYBRILLAPOA` — our name for the gateway.
- **Read a pre-verification's verdict from `readiness.status`,** never from the
  envelope. The top-level `status` stays `accepted` for minutes after every
  field verdict has landed and sometimes never advances, and `completed_at`
  stays null with it. Gating on either makes the check unsatisfiable and kills
  the whole transacting surface silently. `investor-readiness.service.ts` is the
  single place this is decided — `/investors/onboarding` and every order, plan
  and payment all ask it, so they cannot disagree.
- **Verify the payout bank account during onboarding.** On ONDC an unverified
  account lets an order be reviewed, paid for and confirmed, then fails it at
  submission with `payout_account_verification_pending` — after the investor's
  money has moved. Verification is a POA pre-verification penny-drop, read back
  through `usableForPayout`. `FP_REQUIRE_PAYOUT_ACCOUNT_VERIFICATION=false`
  exists only because the sandbox partner never returns a penny-drop verdict at
  all; it must never be set in production.
- **Sandbox PAN patterns** (two independent checks, both must pass): 5th
  character `A` = aadhaar not linked, `I` = invalid, anything else = verified;
  digits `3751` = KYC compliant, `3753` = not in any KRA. `AAAPB3751C` works;
  the reference's own `AAAPA3751A` does not.
- **Never take consent contact details from the caller.** Resolve them from the
  folio, or the account's folio defaults. FP validates them, and a caller who
  could name the contact could redirect the investor's OTP.
- **Validate against `MfSchemeThreshold` before calling FP, and do not trust the
  catalogue's capability flags.** `sipAllowed` does not mean a SIP can be placed
  (a scheme can publish no frequencies at all), `purchaseAllowed` does not mean
  the order API will accept it, and a scheme publishes `allowedDates` for daily
  frequencies that FP then refuses to accept. The thresholds are the truth;
  the booleans are a hint.
- **Our catalogue's flags go stale; FP's live flags refuse.** Every order and
  plan asks FP first through `assertLiveCapability`
  (`scheme-availability.service.ts`), which writes the answer back, so a fund
  the AMC closed leaves the fund list. `GET /schemes/:isin` and the background
  loop refresh stale flags too. A live `false` refuses; a live `true` still has
  to pass the thresholds.
- **Never debit an installment that is not on `ondc`.** A `cybrillapoa` plan
  is never allotted, so collecting its mandate takes money for no units.
- **A claim on money is released only when FP definitely created nothing.**
  `paymentSubmission` is written before the FP call and kept on an unknown
  outcome — a second attempt could debit twice. But an FP 4xx, or a guard that
  fired before the request was sent, created nothing, and holding the claim
  there permanently bricks an order nobody charged. See
  `releaseClaimIfNothingHappened`.
- Services speak our vocabulary (`MONTHLY`); only the FP client speaks FP's
  (`monthly`). Translate at that boundary, not earlier.
- Catch nothing from FP in a controller. Services call `fpErrorToHttpError`,
  which turns a 4xx caused by the caller into a 4xx and everything else into a
  502 — we never blame the caller for FP being down.

## Allotment, folio and the background loop

- A purchase carries its `folio_number` (and units, NAV) only once it is
  `successful`. `applyPurchaseUpdate` (`order.service.ts`) is the one place a
  fetched purchase is applied; on first success it pulls folios + holdings so
  the next order at that AMC reuses the folio (`folio-resolution.service.ts`).
  Never apply a purchase with bare `syncPurchase` from a new path.
- UPI / netbanking payments default `payment_postback_url` to
  `/api/v1/payments/return/:orderId` (needs `PUBLIC_API_BASE_URL`). That route
  is public — FP redirects the investor's browser there — so it only pulls FP's
  state and returns no order data.
- `index.ts` starts `background-jobs.service.ts`: every
  `ORDER_RECONCILE_INTERVAL_MS` it re-reads paid, in-flight purchases and runs
  the webhook processor. Idempotent, so several instances may run it.

## Webhooks

- `receive` writes the raw event and returns; `processPending` does the work.
  Never process inline — FP's delivery timeout turns slow handlers into
  redeliveries exactly when the system is already loaded.
- The processor re-fetches each object from FP rather than trusting the event
  body. Deliveries arrive out of order, and applying a stale body walks the
  mirror backwards.
- FP does not sign its webhooks. Trust nothing in the body but the event id.

Prisma skills are installed in `.agents/skills/` (symlinked into `.claude/skills/`).
Consult them before answering Prisma questions — do not answer from memory, v7
changed a lot.

## Runtime

- **Bun, not Node.** Run scripts with `bun`, never `npm`/`node`.
- **All Prisma CLI commands go through `bunx --bun prisma …`** — without `--bun`
  the CLI shebang falls back to Node and does not load `.env`.
- Bun loads `.env` automatically. Do not add `dotenv`.
- Use the `db:*` scripts in `package.json` rather than raw CLI calls.

## Prisma

- Generator is `prisma-client` (not `prisma-client-js`), output
  `generated/prisma/`, gitignored. Import from `../../generated/prisma/client.ts`.
- **Run `bun run db:generate` after every schema change.** Nothing auto-generates.
- Connection URLs live in `prisma.config.ts`, not `schema.prisma`. The v7
  `datasource.url` / `directUrl` / `shadowDatabaseUrl` schema fields are gone.
- **`env()` throws on an unset variable.** Resolve optional vars before passing
  the name to `env()`, or every CLI command dies with `PrismaConfigEnvError`.
- `datasource.directUrl` in `defineConfig` did **not** work on 7.9.1.
  `prisma.config.ts` selects `DIRECT_DATABASE_URL` by name instead. Do not
  "simplify" that back.
- **One `PrismaClient` per process.** Import the singleton from
  `src/db/client.ts`. Never `new PrismaClient()` anywhere else — each instance
  owns a `pg` pool.
- `Prisma.validator()` no longer exists. Use `satisfies Prisma.XSelect`.
- Errors are on the namespace: `Prisma.PrismaClientKnownRequestError`.

## Two database URLs — do not mix them

| | endpoint | used by |
|---|---|---|
| `DATABASE_URL` | pooled (`-pooler` host) | the app, via `src/db/client.ts` |
| `DIRECT_DATABASE_URL` | non-pooled | Prisma CLI / migrations |

Migrations issue DDL and take advisory locks, which PgBouncer transaction-mode
pooling does not support.

- **`prisma+postgres://` URLs do not work here.** `pg` does not understand that
  protocol and does not error — it parses it into a target with no user, no
  password and no database. `src/db/client.ts` rejects it at startup.
- Use `sslmode=verify-full`, not `sslmode=require` (`pg` weakens `require` to
  unverified certs in v9). `channel_binding` is ignored by the JS driver.

## Migrations

- `db:migrate` (= `migrate dev`) is **local only**. Deploys run
  `db:migrate:deploy`. Never `migrate dev` against a shared database.
- Commit `prisma/migrations/`.
- `migrate reset` / `db push --force-reset` destroy data — ask first, every time.
- `prisma/seed.ts` must stay idempotent (upsert / `skipDuplicates`) and must run
  offline. Its scheme catalogue is a committed snapshot of the real FP sandbox
  records in `prisma/seed-data/`; refresh it with `bun run db:seed:refresh`.
  Seed real FP ids and real thresholds — FP rejects an order whose amount misses
  a multiple, so an invented limit makes the seeded scheme untestable.
- Do not seed investor profiles, investment accounts, folios or orders. A
  locally invented `fpId` poisons the first sync that tries to reconcile it.
- A compound unique cannot contain a nullable column: Prisma rejects a null
  inside a compound-unique `where`, so the row cannot be upserted. That is why
  `SchemeThresholdFrequency` has an explicit `NOT_APPLICABLE` member.



## Layout

```
src/controllers/   parse + validate input, shape the response
src/services/      Prisma queries, business rules, return DTOs
src/routes/        routers only
src/integrations/  outbound HTTP clients (MSG91, and FP next)
src/types/         shared interfaces
src/utils/         money, phone, http-error
src/db/client.ts   the Prisma singleton
```

Dependency direction is one-way: **routes → controllers → services → db**.
Controllers must not import `db`; services must not touch `req`/`res`; utils stay
pure. Fix the layering rather than adding an exception.

**Read the `api-structure` skill before adding any endpoint, service, or query.**
It has the layer contracts and a template for each file. Non-negotiables: no
`any`, explicit `select` on every query (never return whole rows), `{ data }` /
`{ error }` response envelope, `HttpError` for expected failures, and DTOs at the
service boundary — never return a Prisma model directly.

## Express 5

- Async handlers forward rejections automatically — no `asyncHandler` wrapper.
- `req.params` is only inferred for inline handlers. A standalone controller
  needs `Request<{ id: string }>`.
- Register the error handler last, after the 404 handler.

## Before saying it works

- `bunx tsc --noEmit` must be clean.
- `bun run test` must be clean — unit plus schema, no network, seconds.
- `bun run test:e2e` must be clean. It boots the app, walks the whole journey
  against the live FP sandbox, and is the only thing that proves a change to an
  FP-facing path still works — reading the code does not. It is also where FP's
  real behaviour gets discovered: every quirk in README's sandbox section was
  found by an assertion there failing.
- Verify database changes by running them, not by reading the code.
- **Never trust a client-supplied user id.** `requireSession` puts the
  authenticated user in `res.locals`; read it with `investorId(req)`. A `userId`
  in a body or query is only ever checked against that, never believed.
  Resource ids in the path are authorised by `protectParameters` — a new
  `:somethingId` parameter needs a case in `ownResource` or it is unguarded.

## KYC: two realms, pick the one you have

- FP's tenant-realm KYC (`/api/kyc/check`, `/v2/kyc_requests`) and Cybrilla
  POA's partner-realm KYC (`/poa/pre_verifications`, `/poa/kyc_forms`) are
  **different APIs on different hosts with different credentials**. They are not
  interchangeable and both are implemented — `KycRequest` mirrors the first,
  `KycForm` the second.
- On this sandbox the tenant realm is not provisioned (404 / "Couldn't find
  Tenant") and the partner realm works. Lead with `kyc.service.ts`.
- The partner token is rejected by every v2 API with "Partner tokens are not
  allowed". Only `/poa/*` and the lookup endpoints accept it. Pass
  `realm: "preverify"` on those calls.
- KYC-form eligibility is asynchronous: a create returns `under_review` and
  settles a moment later. Never show the investor a form off the create
  response — poll first.
- There are **no webhooks on the partner realm**. KYC form progress is polled.
- Lookup APIs require `consent.mode` to be exactly `"checkbox"`.
