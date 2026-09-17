# Sandbox: many investors, shared PAN + bank

`scripts/sandbox-multi-investor.ts` provisions several sandbox investors that
**share one PAN and one bank account** but each have a **distinct email +
mobile**, and drives every one to an order-ready state (`canTransact === true`).

It only builds the investor accounts an order needs. It writes **no order or
payment rows** and goes through the same service layer the HTTP API uses
(`createInvestorProfile`, `addBankAccount`, `verifyBankAccount`,
`createInvestmentAccount`, `investmentReadiness`), so nothing here is a path an
order does not already take. **Sandbox only** — it refuses to run unless
`simulationEnabled` is true, and must never point at production.

## Run

```bash
# 2 investors, shared PAN + shared bank (what you asked for)
bun run scripts/sandbox-multi-investor.ts

# more investors
COUNT=3 bun run scripts/sandbox-multi-investor.ts

# distinct compliant PAN per investor (fast, still one shared bank)
DISTINCT_PAN=1 COUNT=5 bun run scripts/sandbox-multi-investor.ts

# ALSO place a one-time order AND a SIP for each investor (full post-all-set flow)
TRANSACT=1 DISTINCT_PAN=1 COUNT=1 bun run scripts/sandbox-multi-investor.ts

# override the shared values
PAN=AAAPS3751A BANK=000000001193 BANK_IFSC=HDFC0001330 bun run scripts/sandbox-multi-investor.ts
```

## The full post-all-set flow (TRANSACT=1)

With `TRANSACT=1` the script continues past order-ready and runs the exact
sequence the screens use, end to end:

1. **One-time order** — `createPurchase` → poll to `PENDING` → mint a
   `TRANSACTION_APPROVAL` proof → `recordPurchaseConsent` → `createMandate` →
   `authorizeMandate` → **`simulateMandateSettlement` (APPROVED + UMRN)** →
   `payByMandate` → `confirmPurchase` → `SUBMITTED`.
2. **SIP** — `createSip` (with the approved mandate, a **MONTHLY** scheme) →
   poll → mint proof → `confirmPlan` → `CONFIRMED`.

Verified live: `1/1 placed an order · 1/1 placed a SIP`. The one step the app
does that the `e2e-ondc.ts` test does not is `simulateMandateSettlement` — a
mandate stays `CREATED` until approved, and without that the payment (and so the
order and the SIP) cannot complete. The mobile app approves it via
`POST /payments/mandates/:id/simulate`; this script calls the same service.

Each investor prints its user id, profile id, investment-account id and a final
`order-ready` / not line. The email is `sbx.<run>.<n>@example.com` and the phone
is `+919…` unique per run, so re-runs never collide.

## Highest-success values

| | Value | Why |
|---|---|---|
| **PAN** | `AAAPS3751A` | 5th char `S` passes PAN validation (only `A`/`I` fail); digits `3751` = already KYC-compliant, so **no KYC form is opened** and there is no one-live-form-per-PAN conflict. Every investor on it reaches order-ready through pre-verification alone. |
| **Bank account** | `000000001193` | Ends `1193`. The local penny-drop simulation scores `1191–1199` as `VERY_HIGH` (and `1261–1290` as `HIGH`); anything else is rejected. |
| **IFSC** | `HDFC0001330` | Any real IFSC FP resolves; this is the one the harness uses. |
| **Name / DOB** | anything except `Lord Voldemort` / `2000-01-01` | Those two are simulated mismatches. The script uses `Tony Sandbox` / `1985-04-12`. |

Verified against the live sandbox: 2 investors sharing `AAAPS3751A` +
`000000001193` both reached `order-ready`, and 2 investors on distinct compliant
PANs sharing the same bank also both reached `order-ready`.

## What is safe, and the one FP wall

- **Same bank account across investors: fully safe here.** Bank verification runs
  in-process (`simulationEnabled`), keyed on the account-number pattern, so the
  same account passes for every investor with no per-account cap.
- **Same PAN across investors: works, but rate-limited by FP.** The Cybrilla
  partner realm rate-limits the KRA lookup **per PAN**. Reusing one PAN for
  several investors in a short window can make the 2nd+ pre-verification come
  back `kyc_rate_limit_exceeded` (readiness null) for a few minutes. The script
  waits it out and retries, so shared-PAN runs still succeed but can be slow for
  larger `COUNT`. `DISTINCT_PAN=1` sidesteps this entirely and keeps the shared
  bank.

## Does this affect order placement?

No — in the sandbox. Each investor ends with a verified identity, a verified
payout bank and complete folio defaults, which is exactly the gate every order,
plan and payment asserts (`assertInvestmentReady`). In **production** the shared
bank account would fail the real penny-drop for a name that isn't the account
holder's, so this shared-bank shortcut is sandbox-only.
