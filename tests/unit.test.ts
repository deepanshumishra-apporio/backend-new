// Offline tests for the logic that decides what reaches FP and what reaches
// the client.
//
// Run with: bun run test:unit
//
// No network and no database: everything here is a pure function or a module
// whose only input is a value. The live journey is `test:e2e`; this suite is
// what catches a validation or mapping regression in a second rather than in a
// four-minute sandbox run.
import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/utils/http-error.ts";
import {
  asBody,
  clientIpv4,
  oneOf,
  optionalDecimal,
  optionalStringArray,
  requiredDate,
  requiredDecimal,
  requiredInt,
  requiredIsin,
  requiredPan,
  requiredString,
  requiredStringArray,
  IFSC_PATTERN,
  IPV4_PATTERN,
  PAN_PATTERN,
} from "../src/utils/validate.ts";
import { fpFlatText, fpText, fpInt, fpDate, fpDateTime, fpEnum, fpEnumOr } from "../src/utils/fp-mapping.ts";
import { asAllocation, asAmount, asDate, asNav, asUnits } from "../src/utils/money.ts";
import { maskPhone, normalisePhone, toProviderFormat } from "../src/utils/phone.ts";
import { canonicalJson } from "../src/middleware/investor-command.ts";
import {
  ONDC_MANDATE_PROVIDER,
  ONDC_PAYMENT_PROVIDER,
} from "../src/integrations/fp/resources/payments.ts";

/** Assert that `fn` throws an HttpError with this status, and return it. */
function expectHttpError(fn: () => unknown, status: number): HttpError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
    return error as HttpError;
  }
  throw new Error("expected the call to throw, but it returned");
}

// ---------------------------------------------------------------------------

describe("request body validation", () => {
  test("rejects a body that is not a JSON object", () => {
    for (const body of [null, "string", 42, [], undefined]) {
      expectHttpError(() => asBody(body), 400);
    }
    expect(asBody({ a: 1 })).toEqual({ a: 1 });
  });

  test("requiredString trims, enforces length and reports the field", () => {
    expect(requiredString({ name: "  Tony  " }, "name")).toBe("Tony");
    expect(expectHttpError(() => requiredString({}, "name"), 400).message).toContain("name");
    // Whitespace only is absent, not present-but-empty.
    expectHttpError(() => requiredString({ name: "   " }, "name"), 400);
    expectHttpError(() => requiredString({ name: "abc" }, "name", { maxLength: 2 }), 400);
    expectHttpError(() => requiredString({ name: 5 }, "name"), 400);
  });

  test("requiredDecimal keeps the string form and never goes through a float", () => {
    expect(requiredDecimal({ amount: "1000.50" }, "amount", { maxDecimalPlaces: 2 })).toBe("1000.50");
    // Trailing zeros survive — they are the difference between 100.00 and 100.
    expect(requiredDecimal({ amount: "100.00" }, "amount", { maxDecimalPlaces: 2 })).toBe("100.00");
    expect(requiredDecimal({ amount: 1000 }, "amount")).toBe("1000");
    expectHttpError(() => requiredDecimal({ amount: "1000.555" }, "amount", { maxDecimalPlaces: 2 }), 400);
    expectHttpError(() => requiredDecimal({ amount: "-5" }, "amount"), 400);
    expectHttpError(() => requiredDecimal({ amount: "abc" }, "amount"), 400);
    expectHttpError(() => requiredDecimal({ amount: Infinity }, "amount"), 400);
    expect(optionalDecimal({}, "amount")).toBeUndefined();
  });

  test("requiredInt enforces bounds", () => {
    expect(requiredInt({ n: 12 }, "n", { min: 1, max: 1200 })).toBe(12);
    expect(requiredInt({ n: "12" }, "n")).toBe(12);
    expectHttpError(() => requiredInt({ n: 1.5 }, "n"), 400);
    expectHttpError(() => requiredInt({ n: 0 }, "n", { min: 1 }), 400);
    expectHttpError(() => requiredInt({ n: 2000 }, "n", { max: 1200 }), 400);
  });

  test("oneOf lists what it would have accepted", () => {
    expect(oneOf({ t: "web" }, "t", ["web", "mobile_app"] as const)).toBe("web");
    expect(oneOf({}, "t", ["web"] as const, false)).toBeUndefined();
    expectHttpError(() => oneOf({}, "t", ["web"] as const), 400);
    expect(expectHttpError(() => oneOf({ t: "x" }, "t", ["web"] as const), 400).message).toContain("web");
  });

  test("string arrays must be arrays of strings, and required ones non-empty", () => {
    expect(optionalStringArray({ ids: ["a"] }, "ids")).toEqual(["a"]);
    expectHttpError(() => optionalStringArray({ ids: [1] }, "ids"), 400);
    expectHttpError(() => optionalStringArray({ ids: "a" }, "ids"), 400);
    expectHttpError(() => requiredStringArray({ ids: [] }, "ids"), 400);
  });

  test("dates must be real calendar dates, not just well-shaped", () => {
    expect(requiredDate({ d: "1959-08-22" }, "d")).toBe("1959-08-22");
    // 31 February parses in JS and rolls over; the check catches that.
    expectHttpError(() => requiredDate({ d: "2024-02-31" }, "d"), 400);
    expectHttpError(() => requiredDate({ d: "22-08-1959" }, "d"), 400);
    expectHttpError(() => requiredDate({ d: "2024-13-01" }, "d"), 400);
  });
});

describe("domain identifiers", () => {
  test("a lowercase PAN is normalised, not rejected", () => {
    expect(requiredPan({ pan: "aaapb3751c" })).toBe("AAAPB3751C");
    expect(requiredPan({ pan: " AaApB3751c " })).toBe("AAAPB3751C");
  });

  test("a malformed PAN is still refused", () => {
    for (const pan of ["AAAP3751C", "AAAPB3751", "AAAPB37511C", "12345678AB"]) {
      expectHttpError(() => requiredPan({ pan }), 400);
    }
  });

  test("ISINs are normalised the same way", () => {
    expect(requiredIsin({ isin: "inf109kc19t7" })).toBe("INF109KC19T7");
    expectHttpError(() => requiredIsin({ isin: "US1091KC19T7" }), 400);
  });

  test("the sandbox PAN rules the test fixtures rely on", () => {
    // 4th char P (individual), 5th not A/I, digits 3751 (KYC compliant).
    expect(PAN_PATTERN.test("AAAPB3751C")).toBe(true);
    // The reference's own example: KYC compliant but aadhaar not linked.
    expect("AAAPA3751A"[4]).toBe("A");
  });

  test("IFSC and IPv4 patterns", () => {
    expect(IFSC_PATTERN.test("HDFC0001330")).toBe(true);
    expect(IFSC_PATTERN.test("HDFC1001330")).toBe(false);
    expect(IPV4_PATTERN.test("203.0.113.7")).toBe(true);
    expect(IPV4_PATTERN.test("256.0.0.1")).toBe(false);
    expect(IPV4_PATTERN.test("::1")).toBe(false);
  });
});

describe("client IP", () => {
  test("prefers the first x-forwarded-for entry", () => {
    expect(clientIpv4({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, "10.0.0.9")).toBe("203.0.113.7");
  });

  test("falls back to the socket, unwrapping IPv4-mapped IPv6", () => {
    expect(clientIpv4({}, "::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  test("never returns a non-IPv4 — FP rejects the order without one", () => {
    expect(clientIpv4({ "x-forwarded-for": "not-an-ip" }, "::1")).toBe("127.0.0.1");
    expect(clientIpv4({}, undefined)).toBe("127.0.0.1");
  });
});

describe("money formatting", () => {
  test("trailing zeros survive the API boundary", () => {
    // JSON.stringify calls Decimal.toJSON(), which drops them — hence toFixed.
    expect(asAmount("100.00" as never)).toBe("100.00");
    expect(asAmount("100" as never)).toBe("100.00");
    expect(asUnits("512.694" as never)).toBe("512.6940");
    expect(asNav("9.7524" as never)).toBe("9.7524");
    expect(asAllocation("100" as never)).toBe("100.00");
  });

  test("null and undefined stay null, they do not become zero", () => {
    expect(asAmount(null)).toBeNull();
    expect(asAmount(undefined)).toBeNull();
    expect(asDate(null)).toBeNull();
  });

  test("dates render as yyyy-mm-dd", () => {
    expect(asDate(new Date("2026-09-11T18:30:00.000Z"))).toBe("2026-09-11");
  });
});

describe("phone normalisation", () => {
  test("one number has exactly one stored form", () => {
    const forms = ["+919876543210", "919876543210", "9876543210", "+91 98765 43210", "098765-43210"];
    for (const form of forms) expect(normalisePhone(form)).toBe("+919876543210");
  });

  test("MSG91 wants the number without the plus", () => {
    expect(toProviderFormat("+919876543210")).toBe("919876543210");
  });

  test("masking keeps enough to recognise and not enough to dial", () => {
    const masked = maskPhone("+919876543210");
    expect(masked).toContain("3210");
    expect(masked).not.toContain("98765");
  });

  test("a number that is not a 10-digit Indian mobile is refused", () => {
    for (const bad of ["12345", "+441234567890", "1234567890"]) {
      expectHttpError(() => normalisePhone(bad), 400);
    }
  });
});

describe("FP payload mapping", () => {
  test("fpText drops non-strings and truncates", () => {
    expect(fpText("  hello  ")).toBe("hello");
    expect(fpText("")).toBeNull();
    expect(fpText(42)).toBeNull();
    expect(fpText("abcdef", 3)).toBe("abc");
  });

  test("fpFlatText keeps a structured value instead of losing it", () => {
    // FP returns readiness.modification as an object on some records; writing
    // that to a text column threw and surfaced as a 500 on every poll.
    expect(fpFlatText({ status: "failed", requested_at: "2026-09-11" })).toBe(
      '{"status":"failed","requested_at":"2026-09-11"}',
    );
    expect(fpFlatText("plain")).toBe("plain");
    expect(fpFlatText(null)).toBeNull();
    expect(fpFlatText(undefined)).toBeNull();
    expect(fpFlatText(true)).toBe("true");
    expect(fpFlatText({ a: "x".repeat(200) }, 20)?.length).toBe(20);
  });

  test("fpFlatText survives a value it cannot serialise", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(fpFlatText(cyclic)).toBeNull();
  });

  test("fpInt accepts integers in either form and nothing else", () => {
    expect(fpInt(42)).toBe(42);
    expect(fpInt("42")).toBe(42);
    expect(fpInt(4.2)).toBeNull();
    expect(fpInt("4.2")).toBeNull();
    expect(fpInt(null)).toBeNull();
  });

  test("dates and timestamps", () => {
    expect(fpDate("2026-09-11")?.toISOString().slice(0, 10)).toBe("2026-09-11");
    expect(fpDate("not a date")).toBeNull();
    expect(fpDate(null)).toBeNull();
    expect(fpDateTime("2026-09-11T17:29:37+05:30")?.toISOString()).toBe("2026-09-11T11:59:37.000Z");
    expect(fpDateTime("")).toBeNull();
  });

  test("an unmapped enum value is reported, not silently coerced", () => {
    const Colours = { RED: "red", BLUE: "blue" } as const;
    const seen: string[] = [];
    expect(fpEnum(Colours, "red", (v) => seen.push(v))).toBe("red");
    expect(fpEnum(Colours, "green", (v) => seen.push(v))).toBeNull();
    expect(seen).toEqual(["green"]);
    // The "Or" form falls back but still reports, so a new FP value is visible.
    expect(fpEnumOr(Colours, "green", Colours.RED, (v) => seen.push(v))).toBe("red");
    expect(seen).toEqual(["green", "green"]);
  });

  test("an inherited key from an FP payload is not an enum value", () => {
    // "constructor" indexes to Object's constructor on any plain object. Without
    // an own-property check that function reaches Prisma as a column value.
    const Colours = { RED: "red" } as const;
    expect(fpEnum(Colours, "constructor")).toBeNull();
    expect(fpEnum(Colours, "toString")).toBeNull();
    expect(fpEnumOr(Colours, "constructor", Colours.RED)).toBe("red");
  });
});

describe("idempotency request hashing", () => {
  test("key order does not change the hash input", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test("nested objects are canonicalised too", () => {
    expect(canonicalJson({ o: { y: 1, x: 2 } })).toBe(canonicalJson({ o: { x: 2, y: 1 } }));
  });

  test("array order DOES change it — [a,b] is not [b,a]", () => {
    expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
  });

  test("a different value is a different request", () => {
    expect(canonicalJson({ amount: "1000" })).not.toBe(canonicalJson({ amount: "1000.00" }));
  });

  test("undefined and null are distinguishable", () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("HttpError", () => {
  test("carries a status, a stable code and optional details", () => {
    const error = HttpError.conflict("Nope", { state: "PENDING" });
    expect(error.status).toBe(409);
    expect(error.code).toBe("CONFLICT");
    expect(error.details).toEqual({ state: "PENDING" });
  });

  test("the constructors map to the statuses the API documents", () => {
    expect(HttpError.badRequest("x").status).toBe(400);
    expect(HttpError.notFound().status).toBe(404);
    expect(HttpError.tooManyRequests("x").status).toBe(429);
    expect(HttpError.badGateway("x").status).toBe(502);
    expect(HttpError.serviceUnavailable("x").status).toBe(503);
  });
});

describe("ONDC provider vocabulary", () => {
  test("the two halves of /api/pg do not share a name for the gateway", () => {
    // Each rejects the other's value. Unifying them is a hard 400 either way.
    expect(ONDC_MANDATE_PROVIDER).toBe("CYBRILLAPOA");
    expect(ONDC_PAYMENT_PROVIDER).toBe("ONDC");
    expect(ONDC_MANDATE_PROVIDER).not.toBe(ONDC_PAYMENT_PROVIDER);
  });
});
