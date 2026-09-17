# ONDC / FINTECH PRIMITIVES CANONICAL BACKEND FLOW

This document is the canonical reference for this project.

Every AI coding agent and every developer working on the backend must read this document BEFORE modifying mutual-fund transaction logic.

If implementation conflicts with this document:

do not silently change either one.

Check current Fintech Primitives/Cybrilla POA documentation and actual sandbox behavior.

Update this document only after verification.

==================================================
CORE RULE
=========

Mobile application does not own transaction state machines.

Backend owns transaction orchestration.

Fintech Primitives / Cybrilla remains provider source of truth.

Mobile should receive:

status

displayStatus

nextAction

canRetry

failureCode

failureMessage

pollAfterMs

Provider callback does not automatically mean transaction success.

Always fetch/reconcile provider state.

==================================================
IDENTIFIERS
===========

Never confuse:

FP V2 IDs:

invp_xxx

bac_xxx

mfia_xxx

mfp_xxx

mfpp_xxx

with:

numeric old_id

Examples:

Bank account V2 operations normally use:

bac_xxx

Mandate bank_account_id may require:

bank old_id

Payment amc_order_ids require:

purchase old_id

Persist both.

==================================================
GATEWAY NAMES
=============

Scheme gateway lookup:

cybrillapoa

Order gateway:

ondc

Mandate provider:

CYBRILLAPOA

These values are not interchangeable.

==================================================
FULL ONBOARDING FLOW
====================

FP TOKEN

↓

KYC CHECK

POST /api/kyc/check

↓

KYC status true?

YES
↓

continue

NO
↓

POA / Digital KYC

↓

DigiLocker / proof

↓

signature / required KYC steps

↓

submit / poll

↓

re-check final KYC eligibility

↓

CREATE INVESTOR PROFILE

↓

CREATE:

Email

Mobile

Address

Bank Account

↓

VERIFY:

Email

Mobile

Bank ownership / BAV

↓

Nominee

OR

explicit nomination opt-out

↓

CREATE MF INVESTMENT ACCOUNT

↓

SET folio_defaults:

communication email

communication mobile

communication address

payout bank

nominee configuration where applicable

↓

INVESTMENT READINESS

Only after readiness succeeds may investment transactions begin.

==================================================
SCHEME FLOW
===========

Before every investment:

fetch current Cybrilla-POA-specific scheme details.

Use gateway-specific scheme data.

Never trust stale frontend constraints.

Validate transaction again immediately before financial POST.

Lumpsum:

active

lumpsum threshold

min

max

multiple

new/additional thresholds

SIP:

active

SIP threshold

amount

multiple

frequency

dates

minimum installments

Redemption:

withdrawal eligibility

units/amount constraints

==================================================
FRESH-FOLIO LUMPSUM
===================

Investment readiness

↓

Scheme preflight

↓

Nomination or explicit opt-out configured

↓

Fresh-folio nomination consent where required

↓

Create MF Purchase

gateway=ondc

↓

UNDER_REVIEW

↓

WAIT

↓

PENDING

OR FAILED

↓

If PENDING:

collect PURCHASE consent

↓

update purchase consent

↓

create payment according to verified ONDC payment strategy

↓

mark purchase CONFIRMED

↓

provider submits

↓

SUBMITTED

↓

investor completes payment when required

↓

reconcile payment

↓

provider/RTA processing

↓

SUCCESSFUL

OR FAILED

On success persist:

folio_number

allotted_units

purchased_amount

purchased_price

NAV/allotment details when available.

==================================================
ADDITIONAL PURCHASE
===================

Use existing eligible folio.

↓

Fetch scheme

↓

validate additional purchase thresholds

↓

create purchase using existing folio_number

↓

ONDC review

↓

PENDING

↓

PURCHASE consent

↓

payment

↓

CONFIRMED

↓

SUBMITTED

↓

SUCCESSFUL / FAILED

Do not repeat fresh-folio nomination consent solely because another purchase is being made into the existing folio.

==================================================
PAYMENT RETRY
=============

Payment FAILED

↓

check purchase remains actionable

↓

verify no SUCCESSFUL payment already exists

↓

verify no active payment is already processing

↓

create NEW payment

against SAME purchase

↓

complete payment

↓

reconcile provider

Do not recreate purchase.

Do not create two successful payments for the same purchase.

==================================================
MANDATE
=======

Bank must belong to investor.

Use correct numeric bank old_id where provider requires it.

↓

Create mandate

provider_name=CYBRILLAPOA

↓

AUTHORIZE

↓

redirect if required

↓

fetch/reconcile

↓

APPROVED?

YES
↓

usable

NO
↓

do not use for SIP/mandate debit

CREATED does not mean approved.

SUBMITTED does not mean approved.

Only APPROVED should be treated as ready where provider requires approval.

==================================================
SIP
===

Investment readiness

↓

SIP scheme preflight

↓

Nomination requirement satisfied

↓

APPROVED mandate

↓

Create Purchase Plan

systematic=true

gateway=ondc

payment_method=mandate

payment_source=approved mandate

↓

CREATED

↓

gateway asynchronous review

↓

REVIEW_COMPLETED

OR FAILED

↓

After review is complete:

ensure SIP consent

↓

update plan:

state=confirmed

consent

↓

CONFIRMED

↓

SUBMITTED

↓

ACTIVE

Important:

ACTIVE plan does NOT mean all investments succeeded.

Every installment is a separate transaction.

==================================================
SIP INSTALLMENT
===============

ACTIVE SIP

↓

scheduled/generated installment

↓

mf_purchase installment exists

↓

mandate payment where current provider flow requires it

↓

payment processing

↓

installment purchase:

SUCCESSFUL

OR FAILED

Persist each installment independently.

A failed installment must not recreate the SIP plan.

Payment retry should operate against the same installment/order when provider permits it.

==================================================
PORTFOLIO / FOLIO
=================

Successful fresh purchase

↓

folio_number created/returned

↓

persist folio association

↓

persist units and purchase/allotment information

↓

portfolio should reconcile from provider/reporting state.

Do not manufacture folio balances from only local calculations if provider source exists.

==================================================
REDEMPTION
==========

Use eligible ONDC/Cybrilla-created folio when provider requires it.

↓

Check:

ownership

balance

units

scheme

withdrawal threshold

lock/lien status where available

↓

Create Redemption

gateway=ondc

↓

UNDER_REVIEW

↓

PENDING

OR FAILED

↓

If pending:

collect REDEMPTION consent

↓

CONFIRMED

↓

SUBMITTED

↓

SUCCESSFUL / FAILED

No incoming investment payment is created for redemption.

Payout uses the applicable registered payout bank.

==================================================
SWITCH
======

Use eligible source folio.

↓

validate source position

↓

validate destination scheme

↓

validate provider/gateway eligibility

↓

create switch

↓

follow ACTUAL Cybrilla sandbox state progression

↓

collect SWITCH consent at correct state

↓

confirm

↓

submitted

↓

successful / failed

Switch must remain feature-flagged if current tenant sandbox contract has not been verified.

==================================================
ASYNC RULE
==========

Never assume the state immediately after POST is final.

Financial flow must support:

webhooks/events

polling

reconciliation

missed callbacks

duplicate callbacks

out-of-order callbacks

mobile restarts

backend restarts.

==================================================
IDEMPOTENCY RULE
================

Commands that can create financial resources must be protected against duplicates.

At minimum:

purchase

payment where appropriate

mandate

SIP

redemption

switch

Repeated mobile tap must not create duplicate money movement.

==================================================
SANDBOX REFERENCE
=================

KYC compliant pattern:

XXXPX3751X

Example:

AAAPA3751A

DOB:

1955-10-25

KYC unavailable pattern:

XXXPX3753X

BAV without configured threshold:

ending 1193
→ completed / very_high

ending 1600
→ completed / zero

ending 2357
→ failed / expiry

ending 3157
→ failed / digital_verification_failure

If input-match threshold is configured, use documented 21XX behavior instead.

Do not assume which BAV mode applies.

Verify current tenant.

Sandbox scheme families intended for Cybrilla POA testing include:

ABSL

ICICI Prudential / Ipru

Always fetch and validate the actual current scheme before testing.

ONDC RTA order simulation:

valid amount ending 0
→ successful after successful submission

valid amount ending 1
→ failed after successful submission

The amount must still satisfy scheme rules.

==================================================
MANDATE / PAYMENT SIMULATION
============================

Sandbox provides simulation APIs for controlled testing.

Mandate simulation can represent states including:

CREATED

SUBMITTED

APPROVED

RECEIVED

REJECTED

Payment simulation supports statuses including:

SUBMITTED

APPROVED

REJECTED

INITIATED

PENDING

TIMEDOUT

SUCCESS

FAILED

Simulation functionality must never be enabled in production.

==================================================
CURRENT PROVIDER DOCUMENTATION CAUTION
======================================

Some current documentation around ONDC immediate SIP first-installment behavior is inconsistent.

Do not hardcode assumptions around:

generate_first_installment_now

generate_installment_now

until actual sandbox behavior for this tenant is contract-tested.

Document actual outcome.

Likewise, if payment sequencing documentation differs between provider pages, keep payment sequencing behind an abstraction and verify actual sandbox behavior.

==================================================
DEFINITION OF VERIFIED
======================

A feature is VERIFIED only when:

backend route works

request validation works

database state is correct

provider request is correct

provider response is persisted

provider state transition is correct

duplicate request is safe

failure state is handled

backend restart is safe

mobile can resume

live sandbox contract test has passed where provider access allows it.

Unit tests alone do not mean provider integration is verified.

==================================================
BEFORE EVERY NEW TASK
=====================

Before modifying ONDC backend code:

1. read this file,

2. read ROUTE_MATRIX.md,

3. read relevant FLOW_*.md,

4. read OPEN_ISSUES.md,

5. inspect existing implementation,

6. check latest provider documentation if behavior may have changed,

7. preserve verified behavior,

8. implement requested change,

9. run affected tests,

10. update documentation if behavior changed.
