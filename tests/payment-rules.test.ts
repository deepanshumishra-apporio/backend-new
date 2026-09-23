// Offline tests for the payment-safety decisions.
//
// Run with: bun run test:unit
//
// No network and no database. These lock in the three rules that keep an
// investor from being debited twice or an order from being wrongly refused:
//   - when a failed create call is safe to release the money claim on,
//   - when the netbanking create POST may be retried,
//   - what an order's existing payments mean for a new payment attempt.
// The live journey is `test:e2e`; this suite catches a regression in these
// rules in a second rather than in a sandbox run.
import { describe, expect, test } from "bun:test";
import { FpApiError, FpTransportError } from "../src/integrations/fp/index.ts";
import { PaymentStatus } from "../generated/prisma/enums.ts";
import {
  classifyExistingPayments,
  createFailureCreatedNothing,
  isUnconfiguredProvider,
} from "../src/services/payment.service.ts";

const api = (status: number, code: string | null = null, message = "") =>
  new FpApiError(status, code, message);
const transport = () => new FpTransportError("timeout", "POST /api/pg/payments/netbanking", "req_1");

describe("createFailureCreatedNothing — when a failed create releases the claim", () => {
  test("an FP 4xx means FP received and rejected it: nothing created, release", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(createFailureCreatedNothing(api(status))).toBe(true);
    }
  });

  test("an FP 5xx is an unknown outcome: the payment may exist, keep the claim", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(createFailureCreatedNothing(api(status))).toBe(false);
    }
  });

  test("a 429 is not a verdict: keep the claim", () => {
    expect(createFailureCreatedNothing(api(429))).toBe(false);
  });

  test("a transport error is an unknown outcome: keep the claim", () => {
    expect(createFailureCreatedNothing(transport())).toBe(false);
  });

  test("a non-FP error is a guard that fired before sending: nothing created, release", () => {
    // A pre-send guard (e.g. wrong provider_name) throws a plain Error. This is
    // the ONLY reason a non-FP error may release — post-create bookkeeping runs
    // outside the release boundary, so a DB error can never reach here.
    expect(createFailureCreatedNothing(new Error("provider_name is not accepted"))).toBe(true);
  });
});

describe("isUnconfiguredProvider — when the netbanking POST may be retried", () => {
  test("matches FP's provider-not-configured answer only on a 4xx", () => {
    expect(isUnconfiguredProvider(api(422, "NO_PAYMENT_PROVIDER"))).toBe(true);
    expect(isUnconfiguredProvider(api(400, null, "Provider ONDC not configured"))).toBe(true);
  });

  test("never retries the POST on a 5xx or 429 carrying the same wording", () => {
    // The whole point: a 5xx/429 is an unknown outcome, so retrying the create
    // POST could debit twice. Matching on the message alone would allow it.
    expect(isUnconfiguredProvider(api(500, "NO_PAYMENT_PROVIDER"))).toBe(false);
    expect(isUnconfiguredProvider(api(503, null, "Provider ONDC not configured"))).toBe(false);
    expect(isUnconfiguredProvider(api(429, null, "provider ONDC not configured"))).toBe(false);
  });

  test("ignores unrelated errors", () => {
    expect(isUnconfiguredProvider(api(400, null, "amount is required"))).toBe(false);
    expect(isUnconfiguredProvider(transport())).toBe(false);
    expect(isUnconfiguredProvider(new Error("boom"))).toBe(false);
  });
});

describe("classifyExistingPayments — what an order's payments mean for a new one", () => {
  const { INITIATED, PENDING, SUBMITTED, APPROVED, SUCCESS, FAILED, REJECTED } = PaymentStatus;

  test("no payments: nothing blocks a first attempt", () => {
    expect(classifyExistingPayments([])).toBe("none");
  });

  test("any non-terminal payment is live and blocks a second attempt", () => {
    for (const status of [INITIATED, PENDING, SUBMITTED, APPROVED, SUCCESS]) {
      expect(classifyExistingPayments([status])).toBe("live");
    }
  });

  test("only terminal payments means the order failed and needs replacing", () => {
    expect(classifyExistingPayments([FAILED])).toBe("failed");
    expect(classifyExistingPayments([REJECTED])).toBe("failed");
    expect(classifyExistingPayments([FAILED, REJECTED])).toBe("failed");
  });

  test("a live payment wins even when a failed attempt is also present", () => {
    expect(classifyExistingPayments([FAILED, PENDING])).toBe("live");
    expect(classifyExistingPayments([REJECTED, SUCCESS])).toBe("live");
  });
});
