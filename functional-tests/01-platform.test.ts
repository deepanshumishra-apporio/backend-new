// FT-PLAT: the HTTP surface every request crosses — health, headers, error
// envelope, body limits and the per-IP rate limiter.
import { describe, expect, test } from "bun:test";
import { Client, expectError, expectStatus } from "./lib.ts";

describe("FT-PLAT platform behaviour", () => {
  const client = new Client();

  test("FT-PLAT-01 health check answers 200 with the data envelope", async () => {
    const reply = await client.get("/health");
    expectStatus(reply, 200);
    expect(reply.body.data.status).toBe("ok");
  });

  test("FT-PLAT-02 security headers are set on every response", async () => {
    const reply = await client.get("/health");
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reply.headers.get("x-frame-options")).toBe("DENY");
    expect(reply.headers.get("referrer-policy")).toBe("no-referrer");
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.headers.get("x-powered-by")).toBeNull();
  });

  test("FT-PLAT-03 unknown route returns a 404 error envelope, not HTML", async () => {
    const reply = await client.get("/api/v1/does-not-exist");
    // Unknown paths below /api/v1 fall behind the session gate, so an anonymous
    // caller learns nothing about which routes exist.
    expect([401, 404]).toContain(reply.status);
    expect(reply.body).toHaveProperty("error");
    const outside = await client.get("/nothing-here");
    expectError(outside, 404, "NOT_FOUND");
  });

  test("FT-PLAT-04 malformed JSON is rejected with 400 INVALID_BODY", async () => {
    const reply = await client.call("POST", "/api/v1/otp/request", "{ not json", { headers: { "content-type": "application/json" } });
    expectError(reply, 400, "INVALID_BODY");
  });

  test("FT-PLAT-05 a body over 100kb is rejected with 413", async () => {
    const reply = await client.post("/api/v1/otp/request", { phone: "9".repeat(120_000) });
    expectError(reply, 413, "INVALID_BODY");
  });

  test("FT-PLAT-06 error responses never leak a stack trace", async () => {
    const reply = await client.call("POST", "/api/v1/otp/request", "{", { headers: { "content-type": "application/json" } });
    expect(JSON.stringify(reply.body)).not.toMatch(/at .*\.ts:\d+|node_modules/);
  });

  test("FT-PLAT-07 CORS preflight answers 204 with the allowed headers", async () => {
    const reply = await client.call("OPTIONS", "/api/v1/schemes", undefined, { headers: { origin: "http://localhost:8081" } });
    expectStatus(reply, 204);
    expect(reply.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    expect(reply.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");
  });

  test("FT-PLAT-08 auth endpoints are rate limited to 15 per minute per IP", async () => {
    const attacker = new Client();
    const statuses: number[] = [];
    for (let i = 0; i < 17; i += 1) {
      statuses.push((await attacker.post("/api/v1/otp/verify", { phone: "+919000000000", otp: "000000" })).status);
    }
    expect(statuses.slice(0, 15)).not.toContain(429);
    expect(statuses.slice(15)).toEqual([429, 429]);
    const limited = await attacker.post("/api/v1/otp/verify", { phone: "+919000000000", otp: "000000" });
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  test("FT-PLAT-09 the rate limit is per IP — another device is unaffected", async () => {
    const other = new Client();
    const reply = await other.post("/api/v1/otp/verify", { phone: "+919000000000", otp: "000000" });
    expect(reply.status).not.toBe(429);
  });
});
