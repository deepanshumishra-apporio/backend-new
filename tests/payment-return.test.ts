// Payment return URLs: where FP sends the investor after paying, and where we
// send them next. Offline, no mocks: these are pure functions of the environment.
import { afterEach, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Payment return URLs
// ---------------------------------------------------------------------------

const saved = { base: process.env["PUBLIC_API_BASE_URL"], redirect: process.env["PAYMENT_RETURN_REDIRECT_URL"], env: process.env.NODE_ENV };
afterEach(() => {
  process.env["PUBLIC_API_BASE_URL"] = saved.base;
  process.env["PAYMENT_RETURN_REDIRECT_URL"] = saved.redirect;
  process.env.NODE_ENV = saved.env;
});

test("postback URL points at our return endpoint, or is absent when unconfigured", async () => {
  const { paymentReturnUrl, paymentReturnRedirect } = await import("../src/services/payment.service.ts");
  process.env["PUBLIC_API_BASE_URL"] = "https://api.example.com/";
  expect(paymentReturnUrl("01a0-order")).toBe("https://api.example.com/api/v1/payments/return/01a0-order");
  process.env["PUBLIC_API_BASE_URL"] = "";
  expect(paymentReturnUrl("01a0-order")).toBeUndefined();

  process.env["PAYMENT_RETURN_REDIRECT_URL"] = "risips://payment-return";
  expect(paymentReturnRedirect("01a0-order")).toBe("risips://payment-return?orderId=01a0-order");
});

test("production refuses a plain-http public URL", async () => {
  const { paymentReturnUrl } = await import("../src/services/payment.service.ts");
  process.env.NODE_ENV = "production";
  process.env["PUBLIC_API_BASE_URL"] = "http://api.example.com";
  expect(() => paymentReturnUrl("x")).toThrow("https");
});
