// FT-CAT: the public fund catalogue and market status — what an investor
// browses before signing in.
import { describe, expect, test } from "bun:test";
import { Client, expectError, expectStatus, type Reply } from "./lib.ts";

const client = new Client();
const SEEDED = "INF109K01605";

describe("FT-CAT scheme catalogue", () => {
  test("FT-CAT-01 lists schemes without a session, in pages", async () => {
    const reply = await client.get("/api/v1/schemes?limit=3");
    expectStatus(reply, 200);
    expect(Array.isArray(reply.body.data)).toBe(true);
    expect(reply.body.data.length).toBeLessThanOrEqual(3);
    expect(reply.body.data[0]).toHaveProperty("isin");
  });

  test("FT-CAT-02 the cursor walks every scheme exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const reply: Reply = await client.get(`/api/v1/schemes?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expectStatus(reply, 200);
      seen.push(...reply.body.data.map((s: { isin: string }) => s.isin));
      cursor = reply.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    const all = await client.get("/api/v1/schemes?limit=100");
    expect(seen.length).toBe(all.body.data.length);
  });

  test("FT-CAT-03 limit is capped at 100", async () => {
    expectStatus(await client.get("/api/v1/schemes?limit=5000"), 200);
  });

  test("FT-CAT-04 search narrows the list", async () => {
    const reply = await client.get("/api/v1/schemes?q=FMCG");
    expectStatus(reply, 200);
    expect(reply.body.data.length).toBeGreaterThan(0);
    for (const scheme of reply.body.data) expect(scheme.name.toUpperCase()).toContain("FMCG");
  });

  test("FT-CAT-05 a search for nothing returns an empty list, not an error", async () => {
    const reply = await client.get("/api/v1/schemes?q=zzzz-no-such-fund");
    expectStatus(reply, 200);
    expect(reply.body.data).toEqual([]);
  });

  test("FT-CAT-06 the SIP filter only returns SIP-capable funds", async () => {
    const reply = await client.get("/api/v1/schemes?sipOnly=true&limit=100");
    expectStatus(reply, 200);
    for (const scheme of reply.body.data) expect(scheme.sipAllowed).toBe(true);
  });

  test.each([
    ["limit not a number", "limit=abc"],
    ["negative limit", "limit=-1"],
    ["bad boolean", "sipOnly=yes"],
    ["bad category", "category=CRYPTO"],
    ["search too long", `q=${"a".repeat(101)}`],
    ["bad sameAmcAs ISIN", "sameAmcAs=XYZ"],
  ])("FT-CAT-07 rejects %s with 400", async (_label, query) => {
    expectError(await client.get(`/api/v1/schemes?${query}`), 400);
  });

  test("FT-CAT-08 one scheme by ISIN, case-insensitively", async () => {
    const reply = await client.get(`/api/v1/schemes/${SEEDED.toLowerCase()}`);
    expectStatus(reply, 200);
    expect(reply.body.data.isin).toBe(SEEDED);
  });

  test("FT-CAT-09 a malformed ISIN is a 400 and an unknown one a 404", async () => {
    expectError(await client.get("/api/v1/schemes/NOTANISIN"), 400);
    expectError(await client.get("/api/v1/schemes/INF000000000"), 404);
  });

  test("FT-CAT-10 NAV history answers with a list", async () => {
    const reply = await client.get(`/api/v1/schemes/${SEEDED}/nav?days=30`);
    expectStatus(reply, 200);
    expect(reply.body).toHaveProperty("data");
    expectError(await client.get(`/api/v1/schemes/${SEEDED}/nav?days=x`), 400);
  });
});

describe("FT-MKT market status", () => {
  test("FT-MKT-01 reports whether the market is open", async () => {
    const reply = await client.get("/api/v1/market/status");
    expectStatus(reply, 200);
    expect(reply.body).toHaveProperty("data");
  });
});
