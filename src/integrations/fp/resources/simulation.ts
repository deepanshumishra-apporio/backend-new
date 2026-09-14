// Sandbox-only state simulation.
//
// In the sandbox nothing reaches a real RTA or a real bank, so orders sit in
// `pending` for ever and mandates never get approved. These endpoints push an
// object to the state a real counterparty would have produced, which is the
// only way to test the parts of the journey that come after submission.
//
// Every function here refuses to run outside the sandbox. That guard is not
// paranoia: the same code path in production would be an attempt to forge an
// order state, so it must be impossible by construction rather than by
// convention.
import { fpConfig } from "../fp.config.ts";
import { fpRequest } from "../fp.http.ts";

export type SimulatedOrderStatus =
  | "PAYMENT_CONFIRMED"
  | "SUBMITTED"
  | "SUCCESSFUL"
  | "FAILED"
  | "REVERSED";

export type SimulatedPaymentStatus =
  | "INITIATED"
  | "PENDING"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED"
  | "TIMEDOUT"
  | "SUCCESS"
  | "FAILED";

export type SimulatedMandateStatus =
  | "CREATED"
  | "RECEIVED"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED";

function assertSandbox(operation: string): void {
  if (!fpConfig().simulationEnabled) {
    throw new Error(`${operation} is a sandbox-only simulation and must never run in production`);
  }
}

/** Drive an order forward. Takes the order's NUMERIC id (`old_id`). */
export async function simulateOrder(
  amcOrderId: number,
  status: SimulatedOrderStatus,
  requestId?: string,
): Promise<{ message: string }> {
  assertSandbox("simulateOrder");
  return fpRequest<{ message: string }>({
    method: "POST",
    path: `/api/oms/simulate/orders/${amcOrderId}`,
    body: { status },
    retry: false,
    ...(requestId && { requestId }),
  });
}

export async function simulatePayment(
  paymentId: number,
  status: SimulatedPaymentStatus,
  requestId?: string,
): Promise<{ message: string }> {
  assertSandbox("simulatePayment");
  return fpRequest<{ message: string }>({
    method: "POST",
    path: `/api/pg/simulate/payments/${paymentId}`,
    body: { status },
    retry: false,
    ...(requestId && { requestId }),
  });
}

/**
 * Approve (or reject) a mandate.
 *
 * Run this before simulating a payment as APPROVED or SUCCESS — FP requires
 * the backing mandate to be APPROVED first.
 */
export async function simulateMandate(
  mandateId: number,
  status: SimulatedMandateStatus,
  requestId?: string,
): Promise<{ message: string }> {
  assertSandbox("simulateMandate");
  return fpRequest<{ message: string }>({
    method: "POST",
    path: `/api/pg/simulate/mandates/${mandateId}`,
    body: { status },
    retry: false,
    ...(requestId && { requestId }),
  });
}
