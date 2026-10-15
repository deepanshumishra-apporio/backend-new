// HTTP client and shared steps for the functional suite.
//
// Every call goes over the network to the app booted by setup.ts. A `Client`
// is one device: its own source IP (X-Forwarded-For, trusted from loopback
// only) and, once signed in, its own bearer token.
import { randomBytes } from "node:crypto";
import { expect } from "bun:test";

export const DEV_OTP = "246810";

const base = () => {
  const url = (globalThis as { __FT_BASE__?: string }).__FT_BASE__;
  if (!url) throw new Error("functional-tests/setup.ts was not preloaded");
  return url;
};

let ipSeq = 0;
/** A fresh documentation-range address (TEST-NET-2/3) per client. */
export function newIp(): string {
  ipSeq += 1;
  return `198.51.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

const usedPhones = new Set<string>();
/** A unique Indian mobile per call: +91, then 9, then 9 random digits. */
export function newPhone(): string {
  for (;;) {
    let digits = "9";
    while (digits.length < 10) digits += Math.floor(Math.random() * 10);
    const phone = `+91${digits}`;
    if (!usedPhones.has(phone)) { usedPhones.add(phone); return phone; }
  }
}

export const idemKey = () => randomBytes(18).toString("base64url");

export interface Reply<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface CallOptions {
  /** Idempotency-Key to send. Writes get a fresh one by default; `false` sends none. */
  idem?: string | false;
  headers?: Record<string, string>;
  /** Raw body (Buffer / string) instead of JSON. */
  raw?: string | Uint8Array;
}

export class Client {
  token: string | undefined;
  userId: string | undefined;
  constructor(readonly ip = newIp()) {}

  async call<T = any>(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<Reply<T>> {
    const headers: Record<string, string> = { "x-forwarded-for": this.ip, ...options.headers };
    if (this.token && !headers.authorization) headers.authorization = `Bearer ${this.token}`;
    const write = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    if (write && options.idem !== false) headers["idempotency-key"] = options.idem ?? idemKey();
    let payload: string | Uint8Array | undefined = options.raw;
    if (payload === undefined && body !== undefined) {
      headers["content-type"] ??= "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    const response = await fetch(`${base()}${path}`, { method, headers, body: payload, redirect: "manual" });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON body stays text */ }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  get<T = any>(path: string, options?: CallOptions) { return this.call<T>("GET", path, undefined, options); }
  post<T = any>(path: string, body?: unknown, options?: CallOptions) { return this.call<T>("POST", path, body ?? {}, options); }
  put<T = any>(path: string, body?: unknown, options?: CallOptions) { return this.call<T>("PUT", path, body ?? {}, options); }
  patch<T = any>(path: string, body?: unknown, options?: CallOptions) { return this.call<T>("PATCH", path, body ?? {}, options); }
  del<T = any>(path: string, options?: CallOptions) { return this.call<T>("DELETE", path, undefined, options); }
}

/** Assert status, printing the body when it is wrong — the body is the diagnosis. */
export function expectStatus(reply: Reply, status: number): void {
  if (reply.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${reply.status}: ${JSON.stringify(reply.body).slice(0, 600)}`);
  }
}

/** The `{ error: { code, message } }` envelope with this status. */
export function expectError(reply: Reply, status: number, code?: string): void {
  expectStatus(reply, status);
  expect(reply.body).toHaveProperty("error");
  expect(typeof reply.body.error.message).toBe("string");
  if (code) expect(reply.body.error.code).toBe(code);
}

/** Phone OTP → verification token → investor session, through the public API. */
export async function signIn(client = new Client(), phone = newPhone()): Promise<Client & { phone: string }> {
  expectStatus(await client.post("/api/v1/otp/request", { phone, purpose: "LOGIN" }), 202);
  const verified = await client.post("/api/v1/otp/verify", { phone, otp: DEV_OTP, purpose: "LOGIN" });
  expectStatus(verified, 200);
  const token = verified.body.data.verificationToken;
  expect(typeof token).toBe("string");
  const session = await client.post("/api/v1/sessions", { verificationToken: token });
  expectStatus(session, 201);
  client.token = session.body.data.accessToken;
  client.userId = session.body.data.userId;
  return Object.assign(client, { phone });
}

/** Poll until `done` returns a value, or fail with the last reply. */
export async function poll<T>(
  label: string,
  attempt: () => Promise<{ done: T | undefined; last: unknown }>,
  { tries = 30, delayMs = 3_000 } = {},
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i += 1) {
    const result = await attempt();
    last = result.last;
    if (result.done !== undefined) return result.done;
    await Bun.sleep(delayMs);
  }
  throw new Error(`${label}: gave up after ${tries} tries; last: ${JSON.stringify(last).slice(0, 600)}`);
}
